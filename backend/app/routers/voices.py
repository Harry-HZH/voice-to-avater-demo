"""声音库接口：列表、详情、试听音源、任意文案合成。"""

from __future__ import annotations

import logging

from fastapi import APIRouter, BackgroundTasks, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse

from .. import jobs as jobs_service
from ..config import settings
from ..library import add_imported_voice, get_voice, list_library, resolve_binding
from ..samples import ensure_sample, sample_path
from ..schemas import ImportVoiceRequest, VoicePreviewRequest
from ..thankyou import ThankYouError

log = logging.getLogger("voices")
router = APIRouter(prefix="/voices", tags=["voices"])

_generating: set[str] = set()


def _base(request: Request) -> str:
    """让返回的音频地址是绝对地址，前端 <audio> 可直接播放。"""
    return str(request.base_url).rstrip("/")


@router.get("")
async def voices(
    request: Request,
    q: str | None = None,
    language: str | None = None,
    tag: str | None = None,
) -> dict:
    items = await list_library(_base(request))
    if language:
        items = [v for v in items if v["language"] == language]
    if tag:
        items = [v for v in items if tag in (v.get("tags") or [])]
    if q:
        needle = q.strip().lower()
        items = [
            v
            for v in items
            if needle in v["name"].lower()
            or needle in v["description"].lower()
            or any(needle in t.lower() for t in v.get("tags") or [])
        ]
    return {
        "voices": items,
        "total": len(items),
        "samples_ready": sum(1 for v in items if v["sample_ready"]),
    }


@router.post("/import", status_code=201)
async def import_voice(payload: ImportVoiceRequest, request: Request, tasks: BackgroundTasks) -> dict:
    """从 ThankYou 音色目录挑一个音色，加入我的声音库（试听音频后台生成）。"""
    name = payload.name or payload.provider_voice_id
    doc = await add_imported_voice(
        provider_voice_id=payload.provider_voice_id,
        name=name,
        language=payload.language or "en",
        description=payload.description or "",
        tags=payload.tags,
    )
    voice = await get_voice(doc["id"], _base(request))
    if voice and not voice["sample_ready"]:
        tasks.add_task(_warm_sample, doc["id"])
    return voice or doc


@router.get("/{voice_id}")
async def voice_detail(voice_id: str, request: Request) -> dict:
    voice = await get_voice(voice_id, _base(request))
    if voice is None:
        raise HTTPException(
            status_code=404, detail={"error": {"code": "NOT_FOUND", "message": f"声音 {voice_id} 不存在"}}
        )
    return voice


async def _warm_sample(voice_id: str) -> None:
    """后台预热试听音频，失败只记日志，不影响主流程。"""
    if voice_id in _generating or sample_path(voice_id).exists():
        return
    _generating.add(voice_id)
    try:
        binding = await resolve_binding(voice_id)
        if not binding or not binding.get("provider_voice_id"):
            return
        await ensure_sample(
            voice_id,
            text=binding["sample_text"],
            provider_voice_id=binding["provider_voice_id"],
            fallbacks=binding.get("fallbacks") or (),
        )
    except ThankYouError as exc:
        log.warning("预热试听音频失败 %s：%s %s", voice_id, exc.code, exc.message)
    finally:
        _generating.discard(voice_id)


@router.api_route("/{voice_id}/sample", methods=["GET", "HEAD"])
async def voice_sample(voice_id: str, tasks: BackgroundTasks):
    """试听音源。已就绪直接返回 mp3；未就绪则返回 202 并在后台生成。

    显式支持 HEAD：前端探测音源是否就绪时避免下载整个文件。
    """
    binding = await resolve_binding(voice_id)
    if binding is None:
        raise HTTPException(
            status_code=404, detail={"error": {"code": "NOT_FOUND", "message": f"声音 {voice_id} 不存在"}}
        )

    path = sample_path(voice_id)
    if path.exists() and path.stat().st_size > 0:
        return FileResponse(
            path,
            media_type="audio/mpeg",
            filename=f"{voice_id}.mp3",
            headers={"Cache-Control": "public, max-age=86400"},
        )

    if not settings.api_key_configured:
        raise HTTPException(
            status_code=503,
            detail={"error": {"code": "CONFIG_ERROR", "message": "未配置 THANK_YOU_AI_KEY，无法生成试听音频"}},
        )

    tasks.add_task(_warm_sample, voice_id)
    return JSONResponse(
        status_code=202,
        content={
            "status": "generating",
            "voice_id": voice_id,
            "message": "试听音频正在生成，请稍后重试",
            "retry_after": 5,
        },
        headers={"Retry-After": "5"},
    )


@router.post("/{voice_id}/preview", status_code=202)
async def voice_preview(voice_id: str, payload: VoicePreviewRequest) -> dict:
    """用这个声音合成任意文案（真实 TTS）。走 Job 生命周期，前端轮询取结果。"""
    binding = await resolve_binding(voice_id)
    if binding is None:
        raise HTTPException(
            status_code=404, detail={"error": {"code": "NOT_FOUND", "message": f"声音 {voice_id} 不存在"}}
        )
    if not settings.api_key_configured:
        raise HTTPException(
            status_code=503,
            detail={"error": {"code": "CONFIG_ERROR", "message": "未配置 THANK_YOU_AI_KEY"}},
        )

    provider_voice_id = binding.get("provider_voice_id")
    if not provider_voice_id:
        raise HTTPException(
            status_code=409,
            detail={"error": {"code": "VOICE_NOT_BOUND", "message": "该声音尚未绑定底层音色"}},
        )

    job = await jobs_service.create_job(
        "tts",
        {"voice_id": voice_id, "text": payload.text, "provider_voice_id": provider_voice_id},
    )
    # 立刻返回 queued，后台跑；不阻塞请求
    jobs_service.spawn(
        jobs_service.run_tts_job(job["id"], provider_voice_id=provider_voice_id, text=payload.text)
    )
    return {"job": job, "poll_url": f"/api/jobs/{job['id']}"}


@router.post("/{voice_id}/sample/regenerate", status_code=202)
async def regenerate_sample(voice_id: str, tasks: BackgroundTasks) -> dict:
    """重新生成试听音频（音源听起来不对或想换文案时）。"""
    binding = await resolve_binding(voice_id)
    if binding is None:
        raise HTTPException(
            status_code=404, detail={"error": {"code": "NOT_FOUND", "message": f"声音 {voice_id} 不存在"}}
        )
    provider_voice_id = binding.get("provider_voice_id")
    if not provider_voice_id:
        raise HTTPException(
            status_code=409, detail={"error": {"code": "VOICE_NOT_BOUND", "message": "该声音尚未绑定底层音色"}}
        )

    tasks.add_task(
        _regen,
        voice_id,
        binding["sample_text"],
        provider_voice_id,
        tuple(binding.get("fallbacks") or ()),
    )
    return {"status": "regenerating", "voice_id": voice_id, "retry_after": 10}


async def _regen(voice_id: str, text: str, provider_voice_id: str, fallbacks: tuple[str, ...]) -> None:
    try:
        await ensure_sample(
            voice_id, text=text, provider_voice_id=provider_voice_id, fallbacks=fallbacks, force=True
        )
    except ThankYouError as exc:
        log.warning("重新生成试听失败 %s：%s", voice_id, exc.message)
