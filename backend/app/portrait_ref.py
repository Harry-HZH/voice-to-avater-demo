"""把「我们这边的角色形象」变成「上游能用的引用」。

上游只认两种东西：公网 http(s) 地址，或它自己发出的 file_id。
而我们的形象图可能以三种形态存在：

  - 候选形象任务里记下的**上游产物地址**（最省事，直接用）；
  - 本地缓存的那张 jpg（上游够不着，必须先传上去换 file_id）；
  - 前端手里的一张地址（可能是上游地址，也可能是本后端 /api/jobs/{id}/image/{i} 路径）。

出片（首次生成）和重试都要走这段逻辑，所以单独抽出来 —— 两边各写一份必然会跑偏。
失败一律抛 ThankYouError，由调用方决定映射成什么 HTTP 状态码。
"""

from __future__ import annotations

import logging
import re
from pathlib import Path

from .media import image_content_type, image_extension
from .portraits import image_path, provider_url_of
from .store import store
from .thankyou import ThankYouError, client

log = logging.getLogger("portrait_ref")

# 本后端提供的形象图地址长这样（候选图 / 三视图都是它）
_LOCAL_IMAGE_RE = re.compile(r"^/api/jobs/([^/]+)/image/(\d+)$")


def local_image_path(raw: str) -> Path | None:
    """把本后端的图片路径还原成本地文件。找不到就返回 None。"""
    matched = _LOCAL_IMAGE_RE.match(raw)
    if not matched:
        return None
    path = image_path(matched.group(1), int(matched.group(2)))
    return path if path.exists() and path.stat().st_size > 0 else None


async def _upload_local_image(path: Path) -> dict:
    """传本地图换一个**公网地址**。

    引用要用 `url` 而不是 `file_id`：实测把上传拿到的 file_id 喂给
    `reference_assets`，上游会同报 `invalid_param:reference_assets.0`（即便字节已经
    PUT 上去、公开地址已经 200），而换成同一个文件的 `url` 就通过。所以上传的意义
    就是把本地文件变成一个**上游抓得到的地址**。
    """
    try:
        # 类型与文件名都按内容判断：这些图其实是 PNG，只是存成了 .jpg
        info = await client.upload_file(
            path,
            content_type=image_content_type(path),
            filename=f"{path.stem}{image_extension(path)}",
        )
    except ThankYouError as exc:
        raise ThankYouError(exc.code, f"形象图上传失败：{exc.message}", exc.status) from exc
    url = info.get("url")
    if not url:
        raise ThankYouError("UPLOAD_FAILED", "形象图上传失败，请稍后重试", 502)
    return {"url": url}


async def resolve_portrait_ref(
    *,
    image_url: str | None = None,
    source_job_id: str | None = None,
    source_index: int = 0,
) -> dict:
    """返回 `{"url": ...}` 或 `{"file_id": ...}`。

    优先级：
      1. `image_url` 是 http(s) 地址 → 直接当 url 引用；
      2. `image_url` 是本后端的图片路径 → 从本地缓存取图传上去换 file_id；
      3. `source_job_id` → 取那条候选形象任务里记下的上游产物地址；
      4. 上游地址取不到（会过期）但本地缓存还在 → 传本地那张。
    """
    if image_url:
        if re.match(r"^https?://", image_url):
            return {"url": image_url}
        local = local_image_path(image_url)
        if local is not None:
            return await _upload_local_image(local)
        raise ThankYouError("VALIDATION_ERROR", "形象图地址无法识别，请重新选一张形象", 422)

    if not source_job_id:
        raise ThankYouError("VALIDATION_ERROR", "需要 source_job_id 或 image_url 指定角色形象", 422)

    source = await store.get("jobs", "id", source_job_id)
    if source is None:
        raise ThankYouError("NOT_FOUND", f"来源任务 {source_job_id} 不存在", 404)

    url = provider_url_of(source, source_index)
    if url:
        return {"url": url}

    local = image_path(source_job_id, source_index)
    if local.exists() and local.stat().st_size > 0:
        log.info("形象图的上游地址已过期，改用本地缓存 %s", local.name)
        return await _upload_local_image(local)

    raise ThankYouError(
        "PORTRAIT_UNAVAILABLE", "这张形象图已经不可用了，请回到形象页重新选一张", 409
    )


async def resolve_portrait_ref_from_job(job: dict) -> dict:
    """从一条已有任务的 input 里还原形象引用（重试时用）。"""
    inp = job.get("input") or {}
    return await resolve_portrait_ref(
        image_url=inp.get("image_url"),
        source_job_id=inp.get("source_job_id"),
        source_index=int(inp.get("source_index") or 0),
    )
