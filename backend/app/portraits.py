"""候选形象与三视图的真实生成（ThankYou 文生图 / 以图生图）。

流程：
  1. 用户从某个声音出发，写一句形象描述（可选）；
  2. 后端把它拼成一条「人像摄影」提示词，用文生图模型并发出 N 张候选；
  3. 每张生成完就下载到 backend/data/portraits/，由本后端提供图片（不依赖第三方 CDN）；
  4. 用户选定一张后，可以用它作为参考图生成侧面 / 背面，
     保持同一人物（image-to-image，参考图直接用上游产物地址）。

为什么要把产物落到本地：
  - 上游产物地址会过期，且第三方 CDN 在本机不一定可达；
  - 任务重试时可以直接复用已生成的那几张，不重复花点数。

成本控制：
  - 生成前先调 /generate/quote 估价，把预计消耗写进任务的 output；
  - 每个候选只在「还没生成成功」时才真正调用上游（`ensure_candidate`），
    所以重试 / 补图不会把已经成功的张数再买一遍。
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
from pathlib import Path

from .config import PORTRAIT_DIR, settings
from .thankyou import ThankYouError, client

log = logging.getLogger("portraits")

# 拼在用户描述后面的固定「定妆照」要求：保证生成结果能直接当形象用。
#
# 注意：**不要**在这里写「不要水印 / 不要文字」这类元指令。
# 实测 nano-banana 遇到这种否定式元指令会直接回「did not produce an image」
# （上游错误码 no_output），而且失败同样扣点数。描述「要什么」比「不要什么」可靠。
STYLE_SUFFIX = (
    "，半身像，浅灰色纯色背景，柔和均匀的影棚光线，正面看向镜头，"
    "写实摄影风格，商业人像质感，构图干净"
)

# 同一轮的 N 张候选要能看出区别，否则「选一张」没有意义。
# 只调镜头与神态，不动用户给出的性别/年龄/外貌线索。
VARIATION_HINTS = (
    "",
    "，略微侧身，表情更放松自然",
    "，更近的景别，神情更沉稳",
)

# 三视图：以正面图作参考，只换视角，明确要求保持五官与服装一致
VIEW_PROMPTS = {
    "side": "同一个人的侧面视角照片，保持五官、发型与服装完全一致，面朝画面左侧，半身像，浅灰色纯色背景，柔和影棚光线，写实摄影风格",
    "back": "同一个人的背面视角照片，保持发型、体型与服装完全一致，背对镜头，半身像，浅灰色纯色背景，柔和影棚光线，写实摄影风格",
}


# ---------- 提示词 ----------


def build_candidate_prompt(user_prompt: str, index: int) -> str:
    """用户描述 + 定妆照要求 + 该候选的差异化提示。"""
    base = (user_prompt or "").strip() or "一位适合做口播形象的人物"
    hint = VARIATION_HINTS[index % len(VARIATION_HINTS)]
    return f"{base}{hint}{STYLE_SUFFIX}"


def build_view_prompt(view: str) -> str:
    return VIEW_PROMPTS[view]


def seed_for(job_id: str, index: int, variant: int) -> int:
    """同一提示词下「换一批」要能换出新图，所以把变体号混进随机种子。"""
    digest = hashlib.sha1(f"{job_id}|{index}|{variant}".encode()).hexdigest()
    return int(digest[:6], 16)


# ---------- 本地文件 ----------


def image_path(job_id: str, index: int) -> Path:
    return PORTRAIT_DIR / f"{job_id}_{index}.jpg"


def image_url(job_id: str, index: int) -> str:
    """相对地址：前端自己拼 API_BASE，避免后端猜自己的公网地址。"""
    return f"/api/jobs/{job_id}/image/{index}"


def image_ready(job_id: str, index: int) -> bool:
    p = image_path(job_id, index)
    return p.exists() and p.stat().st_size > 0


def read_provider_urls(job: dict) -> list[str | None]:
    out = job.get("output") or {}
    urls = out.get("provider_urls") or []
    return list(urls)


def provider_url_of(job: dict, index: int) -> str | None:
    """取某个候选图的上游地址（三视图作参考图时要用）。"""
    urls = read_provider_urls(job)
    if 0 <= index < len(urls):
        return urls[index]
    return None


def clear_images(job_id: str) -> int:
    """删掉某个任务已缓存的候选图。只有「换一批」才需要——重试要复用已成功的那些。"""
    removed = 0
    for p in PORTRAIT_DIR.glob(f"{job_id}_*"):
        try:
            p.unlink()
            removed += 1
        except OSError:  # pragma: no cover - 删不掉不影响主流程
            log.warning("删除缓存图片失败：%s", p)
    return removed


# ---------- 估价 ----------


async def quote_candidates(count: int, *, model: str | None = None) -> float | None:
    """估价：返回预计消耗点数；估价失败不影响生成（返回 None）。"""
    model = model or settings.portrait_model
    try:
        q = await client.quote(model, {"prompt": "portrait", "aspect_ratio": settings.portrait_aspect_ratio})
    except ThankYouError as exc:
        log.warning("估价失败（不影响生成）：%s %s", exc.code, exc.message)
        return None
    unit = q.get("estimated_cost")
    if isinstance(unit, (int, float)):
        return float(unit) * count
    return None


# ---------- 单张生成 ----------


async def _generate_one(
    *, model: str, payload: dict, dest: Path, sem: asyncio.Semaphore
) -> str:
    """提交 → 等终态 → 下载。返回上游产物地址。"""
    async with sem:
        gen = await client.run(model, payload)
    url = client.first_url(gen)
    if not url:
        raise ThankYouError("EMPTY_OUTPUT", "生成成功但没有返回图片地址")
    await client.download(url, dest)
    return url


async def ensure_candidate(
    job_id: str, index: int, *, prompt: str, variant: int, sem: asyncio.Semaphore
) -> tuple[Path, str]:
    """确保某个候选图存在（已存在直接复用），返回本地路径与上游地址。

    上游偶尔会抽风返回 no_output（提示词没问题也发生，约 3% 概率）。
    seed 是确定性哈希——不换 seed 的话重试永远踩同一个坑，
    所以对这类瞬时失败自动换一个 seed 再试一次。
    """
    dest = image_path(job_id, index)
    if dest.exists() and dest.stat().st_size > 0:
        return dest, ""

    base_seed = seed_for(job_id, index, variant)
    for attempt in range(2):
        payload = {
            "prompt": prompt,
            "aspect_ratio": settings.portrait_aspect_ratio,
            "seed": base_seed + attempt * 7919,
        }
        try:
            url = await _generate_one(model=settings.portrait_model, payload=payload, dest=dest, sem=sem)
            log.info("候选图已生成 %s#%d (%.1f KB)", job_id, index, dest.stat().st_size / 1024)
            return dest, url
        except ThankYouError as exc:
            # no_output / 空产物是上游瞬时问题，换个 seed 值得再试一次；其他错误直接抛
            if attempt == 0 and exc.code in ("no_output", "EMPTY_OUTPUT"):
                log.warning("候选 %s#%d 上游 no_output，换 seed 重试一次", job_id, index)
                continue
            raise
    raise ThankYouError("no_output", "unreachable")  # for type checkers


async def ensure_view(reference_url: str, job_id: str, index: int, view: str, *, sem: asyncio.Semaphore) -> str:
    """以正面候选图为参考生成某个视角的补图，返回上游地址。

    与 ensure_candidate 同理：no_output 是上游瞬时抽风，自动重试一次。
    """
    dest = image_path(job_id, index)
    if dest.exists() and dest.stat().st_size > 0:
        return ""

    payload = {
        "prompt": build_view_prompt(view),
        "aspect_ratio": settings.portrait_aspect_ratio,
        "reference_assets": [{"role": "reference", "asset_type": "image", "url": reference_url}],
    }
    for attempt in range(2):
        try:
            return await _generate_one(model=settings.views_model, payload=payload, dest=dest, sem=sem)
        except ThankYouError as exc:
            if attempt == 0 and exc.code in ("no_output", "EMPTY_OUTPUT"):
                log.warning("补图 %s#%s 上游 no_output，自动重试一次", job_id, view)
                continue
            raise
    raise ThankYouError("no_output", "unreachable")  # for type checkers
