"""任务（Job）服务：统一 queued → running → succeeded / failed 生命周期。

对应 INTERVIEW.md 第 4 节的 Job 约定：结束状态不可再变；
失败时 error 为 {code, message}。语音合成（tts）也走这套，便于前端统一处理等待与失败。

生成候选形象 / 补三视图也走这套：前端只需要「提交任务 → 轮询 → 拿结果」，
不用关心后端是串行还是并发生成、产物落在哪里。
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from datetime import datetime, timezone

from .config import SAMPLE_DIR, settings
from .portraits import (
    build_candidate_prompt,
    clear_images,
    ensure_candidate,
    ensure_view,
    image_url,
    quote_candidates,
)
from .store import store
from .thankyou import ThankYouError, client

log = logging.getLogger("jobs")

# 后台任务的强引用：asyncio 只持弱引用，不存着可能被 GC 掉
_background: set[asyncio.Task] = set()


def spawn(coro) -> None:
    """跑一个后台协程，并保证它不会被垃圾回收。"""
    task = asyncio.create_task(coro)
    _background.add(task)
    task.add_done_callback(_background.discard)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


async def create_job(job_type: str, job_input: dict) -> dict:
    job = {
        "id": f"job_{uuid.uuid4().hex[:12]}",
        "type": job_type,
        "status": "queued",
        "input": job_input,
        "output": None,
        "error": None,
        "created_at": now_iso(),
        "updated_at": now_iso(),
    }
    await store.insert("jobs", job)
    return job


TERMINAL = {"succeeded", "failed", "canceled"}


async def patch_job(job_id: str, **patch) -> dict | None:
    """更新任务。结束状态不可再变（INTERVIEW.md：queued → running → succeeded/failed）。"""
    job = await store.get("jobs", "id", job_id)
    if job is None:
        return None
    if job.get("status") in TERMINAL and patch.get("status") not in (None, job["status"]):
        log.warning(
            "任务 %s 已是终态 %s，忽略状态变更 → %s", job_id, job["status"], patch.get("status")
        )
        patch.pop("status", None)
        if not patch:
            return job
    patch["updated_at"] = now_iso()
    return await store.update("jobs", "id", job_id, patch)


async def get_job(job_id: str) -> dict | None:
    return await store.get("jobs", "id", job_id)


async def list_jobs(job_type: str | None = None, status: str | None = None, limit: int = 50) -> list[dict]:
    jobs = await store.list("jobs", type=job_type, status=status)
    return jobs[:limit]


def preview_audio_path(job_id: str):
    return SAMPLE_DIR / f"preview_{job_id}.mp3"


async def delete_job(job_id: str) -> bool:
    """删除任务记录。产物文件由路由层负责清理（各类型产物的位置只有那边知道全）。"""
    return await store.delete("jobs", "id", job_id)


async def run_tts_job(job_id: str, *, provider_voice_id: str, text: str) -> None:
    """后台执行语音合成。状态流转 queued → running → succeeded / failed。"""
    await patch_job(job_id, status="running")
    try:
        gen = await client.run(settings.tts_model, {"text": text, "voice_id": provider_voice_id, "format": "mp3"})
        url = client.first_url(gen)
        if not url:
            raise ThankYouError("EMPTY_OUTPUT", "生成成功但没有返回音频地址")

        dest = preview_audio_path(job_id)
        await client.download(url, dest)

        await patch_job(
            job_id,
            status="succeeded",
            output={
                # 给前端的地址指向本后端，避免依赖第三方 CDN
                "audio_url": f"/api/jobs/{job_id}/audio",
                "provider_url": url,
                "duration_hint": None,
            },
            error=None,
        )
        log.info("语音合成完成 %s (%.1f KB)", job_id, dest.stat().st_size / 1024)
    except ThankYouError as exc:
        log.warning("语音合成失败 %s：%s %s", job_id, exc.code, exc.message)
        await patch_job(job_id, status="failed", error=exc.to_dict())
    except Exception as exc:  # noqa: BLE001 - 兜底，保证任务一定到终态
        log.exception("语音合成异常 %s", job_id)
        await patch_job(
            job_id, status="failed", error={"code": "INTERNAL_ERROR", "message": str(exc)}
        )


# ---------- 候选形象 / 三视图 ----------


async def _stopped(job_id: str) -> bool:
    """任务是否已经被取消（前端取消 = failed + CANCELED）。"""
    job = await get_job(job_id)
    return job is None or job.get("status") in TERMINAL


async def run_portrait_job(
    job_id: str, *, prompt: str, count: int | None = None, variant: int = 0
) -> None:
    """生成 N 张候选形象。

    - N 张并发跑（受 settings.portrait_concurrency 限制），每张完成就更新一次进度，
      所以前端的进度条是真实推进的，不是假动画；
    - 已存在本地的那几张直接复用（重试时不会重复花钱）；
    - 只要有一张失败，整个任务判失败，但成功的张数保留在 output 里，
      重试时只补失败的那几张。
    """
    count = count or settings.portrait_count
    if await _stopped(job_id):
        log.info("候选形象任务已取消，不再开始 %s", job_id)
        return
    await patch_job(job_id, status="running", progress=0, error=None)

    estimate = await quote_candidates(count)
    sem = asyncio.Semaphore(max(1, settings.portrait_concurrency))

    # 复用上一次已经生成好的：provider_urls 与本地文件一起判断
    old = await get_job(job_id)
    old_urls = list(((old or {}).get("output") or {}).get("provider_urls") or [])
    urls: list[str | None] = [old_urls[i] if i < len(old_urls) else None for i in range(count)]

    done = 0
    failures: list[ThankYouError] = []

    async def one(i: int) -> tuple[int, str, ThankYouError | None]:
        try:
            _, url = await ensure_candidate(
                job_id, i, prompt=build_candidate_prompt(prompt, i), variant=variant, sem=sem
            )
            return i, url, None
        except ThankYouError as exc:
            return i, "", exc
        except Exception as exc:  # noqa: BLE001 - 单张失败不影响其他张
            return i, "", ThankYouError("INTERNAL_ERROR", str(exc))

    tasks = [asyncio.create_task(one(i)) for i in range(count)]
    try:
        for fut in asyncio.as_completed(tasks):
            if await _stopped(job_id):
                log.info("候选形象任务已取消，停止收尾 %s", job_id)
                return
            i, url, err = await fut
            if err is not None:
                failures.append(err)
                log.warning("候选 %d 生成失败：%s %s", i, err.code, err.message)
            elif url:
                urls[i] = url
            done += 1
            await patch_job(job_id, progress=round(done / count * 100))
    finally:
        for t in tasks:
            if not t.done():
                t.cancel()

    image_urls = [image_url(job_id, i) for i in range(count)]
    output = {
        "image_urls": image_urls,
        "provider_urls": urls,
        "count": count,
        "model": settings.portrait_model,
        "estimated_points": estimate,
    }

    if failures:
        first = failures[0]
        await patch_job(
            job_id,
            status="failed",
            output=output,
            error={
                "code": first.code,
                "message": f"{len(failures)}/{count} 张生成失败：{first.message}",
            },
        )
        return

    await patch_job(job_id, status="succeeded", output=output, error=None)


async def run_views_job(
    job_id: str, *, reference_url: str, views: list[str], index: int = 0
) -> None:
    """用选定的正面候选图作参考，生成侧面 / 背面（保持同一人物）。"""
    if await _stopped(job_id):
        log.info("补图任务已取消，不再开始 %s", job_id)
        return
    await patch_job(job_id, status="running", progress=0, error=None)
    sem = asyncio.Semaphore(max(1, settings.portrait_concurrency))

    view_urls: dict[str, str] = {}
    provider: dict[str, str | None] = {}
    failures: list[ThankYouError] = []
    done = 0

    async def one(i: int, view: str) -> tuple[int, str, str, ThankYouError | None]:
        try:
            url = await ensure_view(reference_url, job_id, i, view, sem=sem)
            return i, view, url, None
        except ThankYouError as exc:
            return i, view, "", exc
        except Exception as exc:  # noqa: BLE001
            return i, view, "", ThankYouError("INTERNAL_ERROR", str(exc))

    tasks = [asyncio.create_task(one(i, v)) for i, v in enumerate(views)]
    try:
        for fut in asyncio.as_completed(tasks):
            if await _stopped(job_id):
                log.info("补图任务已取消 %s", job_id)
                return
            i, view, url, err = await fut
            if err is not None:
                failures.append(err)
                log.warning("补图 %s 失败：%s %s", view, err.code, err.message)
            else:
                view_urls[view] = image_url(job_id, i)
                provider[view] = url or None
            done += 1
            await patch_job(job_id, progress=round(done / max(1, len(views)) * 100))
    finally:
        for t in tasks:
            if not t.done():
                t.cancel()

    output = {
        "view_urls": view_urls,
        "provider_urls": provider,
        "reference_url": reference_url,
        "source_index": index,
        "model": settings.views_model,
    }
    if failures:
        first = failures[0]
        await patch_job(
            job_id,
            status="failed",
            output=output,
            error={"code": first.code, "message": first.message},
        )
        return
    await patch_job(job_id, status="succeeded", output=output, error=None)


async def restart_portrait_job(
    job_id: str, *, prompt: str | None = None, variant: int | None = None, count: int | None = None
) -> dict | None:
    """重新跑一条候选形象任务：换一批时清缓存，重试时保留已成功的图。"""
    job = await get_job(job_id)
    if job is None or job.get("type") != "portrait":
        return None

    old_variant = int((job.get("input") or {}).get("variant") or 0)
    new_variant = old_variant if variant is None else int(variant)
    if new_variant != old_variant:
        removed = clear_images(job_id)
        log.info("换一批候选图：清掉 %s 的 %d 张缓存", job_id, removed)

    patch = {
        "status": "running",
        "progress": 0,
        "output": None,
        "error": None,
    }
    new_input = {
        **job.get("input", {}),
        "prompt": prompt if prompt is not None else (job.get("input") or {}).get("prompt"),
        "variant": new_variant,
        "count": count or (job.get("input") or {}).get("count") or settings.portrait_count,
    }
    patch["input"] = new_input
    updated = await store.update("jobs", "id", job_id, {**patch, "updated_at": now_iso()})
    return updated
