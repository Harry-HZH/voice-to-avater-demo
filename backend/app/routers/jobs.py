"""任务接口：查询状态、取回产物（音频 / 图片 / 视频）、取消、重试。"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from .. import jobs as jobs_service
from ..config import settings
from ..jobs import delete_job, get_job, list_jobs, preview_audio_path, restart_portrait_job
from ..media import image_content_type, image_extension
from ..portrait_ref import resolve_portrait_ref_from_job
from ..portraits import clear_images, image_path
from ..schemas import RetryPortraitRequest
from ..thankyou import ThankYouError
from ..videos import (
    can_retry_video,
    clear_videos,
    final_path as final_video_path,
    run_speak_video_job,
    voice_path as voice_track_path,
)

router = APIRouter(prefix="/jobs", tags=["jobs"])

TERMINAL = jobs_service.TERMINAL


def _not_found(what: str = "任务") -> HTTPException:
    return HTTPException(
        status_code=404, detail={"error": {"code": "NOT_FOUND", "message": f"{what}不存在"}}
    )


@router.get("")
async def jobs(type: str | None = None, status: str | None = None, limit: int = 50) -> dict:
    return {"jobs": await list_jobs(job_type=type, status=status, limit=limit)}


@router.get("/{job_id}")
async def job_detail(job_id: str) -> dict:
    job = await get_job(job_id)
    if job is None:
        raise _not_found()
    return job


@router.delete("/{job_id}")
async def job_delete(job_id: str) -> dict:
    """删除一条任务记录（连同本地缓存的产物文件）。

    只允许删终态任务：还在跑的任务删了记录，后台协程收尾时会找不到目标，
    而且用户会失去「取消」的入口 —— 先取消再删除才是对的顺序。
    说话音轨的缓存按 `sha1(voice_id + 台词)` 共享，同一台词重生成还能复用，所以不动。
    """
    job = await get_job(job_id)
    if job is None:
        raise _not_found()
    if job.get("status") not in TERMINAL:
        raise HTTPException(
            status_code=409,
            detail={
                "error": {
                    "code": "JOB_NOT_TERMINAL",
                    "message": "任务还在进行中，先取消再删除",
                }
            },
        )
    clear_images(job_id)
    clear_videos(job_id)
    preview = preview_audio_path(job_id)
    if preview.exists():
        preview.unlink(missing_ok=True)
    deleted = await delete_job(job_id)
    return {"deleted": deleted, "id": job_id}


@router.get("/{job_id}/audio")
async def job_audio(job_id: str):
    job = await get_job(job_id)
    if job is None:
        raise _not_found()
    path = preview_audio_path(job_id)
    if not path.exists():
        raise HTTPException(
            status_code=404,
            detail={"error": {"code": "AUDIO_NOT_READY", "message": "音频尚未生成"}},
        )
    return FileResponse(path, media_type="audio/mpeg", filename=f"{job_id}.mp3")


@router.api_route("/{job_id}/image/{index}", methods=["GET", "HEAD"])
async def job_image(job_id: str, index: int):
    """候选形象 / 三视图的图片。产物落在本后端，前端不依赖第三方 CDN。"""
    if await get_job(job_id) is None:
        raise _not_found()
    path = image_path(job_id, index)
    if not path.exists() or path.stat().st_size == 0:
        raise HTTPException(
            status_code=404,
            detail={"error": {"code": "IMAGE_NOT_READY", "message": "这张图还没生成好"}},
        )
    # 媒体类型按内容判断：这些图其实是 PNG，只是当初按 .jpg 存的
    return FileResponse(
        path,
        media_type=image_content_type(path),
        filename=f"{job_id}_{index}{image_extension(path)}",
        headers={"Cache-Control": "public, max-age=86400"},
    )


@router.api_route("/{job_id}/video", methods=["GET", "HEAD"])
async def job_video(job_id: str):
    """创作成片。不支持 Range 请求（视频不长，够用）。

    显式支持 HEAD：前端 `<video>` 与存在性探测都会先发 HEAD。
    """
    if await get_job(job_id) is None:
        raise _not_found()
    path = final_video_path(job_id)
    if not path.exists() or path.stat().st_size == 0:
        raise HTTPException(
            status_code=404,
            detail={"error": {"code": "VIDEO_NOT_READY", "message": "成片还没生成好"}},
        )
    return FileResponse(
        path,
        media_type="video/mp4",
        filename=f"{job_id}.mp4",
        headers={"Cache-Control": "public, max-age=86400"},
    )


@router.api_route("/{job_id}/voice", methods=["GET", "HEAD"])
async def job_voice(job_id: str):
    """角色给这条成片配的音轨，可以单独听 / 单独下载。"""
    if await get_job(job_id) is None:
        raise _not_found()
    path = voice_track_path(job_id)
    if not path.exists() or path.stat().st_size == 0:
        raise HTTPException(
            status_code=404,
            detail={"error": {"code": "AUDIO_NOT_READY", "message": "配音还没生成好"}},
        )
    return FileResponse(path, media_type="audio/mpeg", filename=f"{job_id}.mp3")


@router.post("/{job_id}/cancel")
async def cancel_job(job_id: str) -> dict:
    """取消任务。

    上游生成请求无法真正中断，所以这里只是把任务置为终态（failed + CANCELED）：
    后台协程发现终态后不再收尾，产物也不会写进 output。
    """
    job = await get_job(job_id)
    if job is None:
        raise _not_found()
    if job.get("status") in TERMINAL:
        return job
    updated = await jobs_service.patch_job(
        job_id, status="failed", error={"code": "CANCELED", "message": "已取消生成，积分未扣除"}
    )
    return updated or job


@router.post("/{job_id}/retry")
async def retry_job(job_id: str, payload: RetryPortraitRequest | None = None) -> dict:
    """重试任务。

    候选形象：
      - 不传 variant：沿用原变体 → 已经生成成功的候选图会复用，只补失败的（不重复花钱）；
      - 传一个新 variant：视为「换一批」，先清掉缓存的候选图再整批重出。

    说话视频：只重跑「出片」那一段。台词音轨还在本地，不必重新买 TTS；
    出片本身该花的钱省不掉，但那才是这个任务真正的计费项。
    """
    job = await get_job(job_id)
    if job is None:
        raise _not_found()
    # 取消是用户的明确意图：取消的任务不接受重试，想再生成就重新发起
    if (job.get("error") or {}).get("code") == "CANCELED":
        raise HTTPException(
            status_code=409,
            detail={"error": {"code": "CANCELED_NOT_RETRYABLE", "message": "已取消的任务不能重试，请重新发起生成"}},
        )
    if not settings.api_key_configured:
        raise HTTPException(
            status_code=503,
            detail={"error": {"code": "CONFIG_ERROR", "message": "未配置 THANK_YOU_AI_KEY"}},
        )

    if job.get("type") == "speak":
        if not can_retry_video(job_id):
            raise HTTPException(
                status_code=409,
                detail={
                    "error": {
                        "code": "RETRY_NOT_AVAILABLE",
                        "message": "这条任务的台词音轨已不在本地，需要重新生成一遍",
                    }
                },
            )
        try:
            portrait_ref = await resolve_portrait_ref_from_job(job)
        except ThankYouError as exc:
            raise HTTPException(
                status_code=exc.status or 422,
                detail={"error": exc.to_dict()},
            ) from exc

        inp = job.get("input") or {}
        restarted = await jobs_service.patch_job(
            job_id, status="running", stage="让角色开口", progress=20, error=None
        )
        jobs_service.spawn(
            run_speak_video_job(
                job_id,
                portrait_ref=portrait_ref,
                script=inp.get("script") or "",
                model=inp.get("model") or settings.speak_model,
                aspect_ratio=inp.get("aspect_ratio"),
            )
        )
        return restarted or job

    if job.get("type") != "portrait":
        raise HTTPException(
            status_code=409,
            detail={"error": {"code": "UNSUPPORTED", "message": f"{job.get('type')} 任务暂不支持重试"}},
        )

    prompt = payload.prompt if payload else None
    variant = payload.variant if payload else None
    if payload and payload.count is not None:
        clear_images(job_id)

    updated = await restart_portrait_job(job_id, prompt=prompt, variant=variant, count=payload.count if payload else None)
    if updated is None:
        raise _not_found()

    inp = updated.get("input") or {}
    if inp.get("kind") == "views":
        # 补三视图重试：沿用同一张参考图，已生成成功的视角会复用
        reference = inp.get("reference_url") or ""
        if not reference:
            raise HTTPException(
                status_code=409,
                detail={"error": {"code": "REFERENCE_MISSING", "message": "缺少参考图，无法重新生成视图"}},
            )
        jobs_service.spawn(
            jobs_service.run_views_job(
                job_id,
                reference_url=reference,
                views=list(inp.get("views") or ["side", "back"]),
                index=int(inp.get("source_index") or 0),
            )
        )
    else:
        jobs_service.spawn(
            jobs_service.run_portrait_job(
                job_id,
                prompt=inp.get("prompt") or "",
                count=inp.get("count") or settings.portrait_count,
                variant=int(inp.get("variant") or 0),
            )
        )
    return updated
