"""创作接口：让角色开口说话。

只有一件事 —— 拿角色形象图 + 角色的音色，把一段台词变成会说话的视频。

拆成两个动作，是因为**钱差两个数量级**：

    POST /api/speak/preview   合成台词音轨（约 1.5 点），返回真实秒数与精确费用
    POST /api/speak           出片（秒数 × 20 点），后台跑，返回 queued 任务

用户先花 1.5 点把台词听一遍、看清「这条要 180 点」，再决定要不要出片。
试听的音轨会被出片直接复用（缓存键是音色 + 台词的哈希），不会把 TTS 买两遍。
"""

from __future__ import annotations

import logging
import re

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from .. import jobs as jobs_service
from ..config import settings
from ..library import resolve_binding
from ..media import mp3_duration
from ..portrait_ref import resolve_portrait_ref
from ..schemas import SpeakPreviewRequest, SpeakRequest
from ..speech import speech_key, speech_path, synthesize_speech
from ..thankyou import ThankYouError
from ..videos import run_speak_job

log = logging.getLogger("speak")
router = APIRouter(prefix="/speak", tags=["speak"])

JOB_TYPE = "speak"


def _fail(status: int, code: str, message: str) -> HTTPException:
    return HTTPException(status_code=status, detail={"error": {"code": code, "message": message}})


# ---------- 声音 ----------


async def _resolve_voice(voice_id: str) -> tuple[dict, str]:
    binding = await resolve_binding(voice_id)
    if binding is None:
        raise _fail(404, "NOT_FOUND", f"声音 {voice_id} 不存在")
    provider_voice_id = binding.get("provider_voice_id")
    if not provider_voice_id:
        raise _fail(409, "VOICE_NOT_BOUND", "该声音尚未绑定底层音色，无法合成语音")
    return binding, provider_voice_id


def _require_key() -> None:
    if not settings.api_key_configured:
        raise _fail(503, "CONFIG_ERROR", "未配置 THANK_YOU_AI_KEY，无法生成")


# ---------- 试听 ----------


@router.post("/preview")
async def preview_speech(payload: SpeakPreviewRequest) -> dict:
    """把台词合成成音轨并返回真实秒数 + 预估点数。

    这一步会真花钱（约 1.5 点），但换来的是后面那几百点的确定性。
    合成结果按 (音色, 台词) 缓存，出片时直接复用。
    """
    _require_key()
    _, provider_voice_id = await _resolve_voice(payload.voice_id)

    try:
        info = await synthesize_speech(
            voice_id=payload.voice_id,
            text=payload.script,
            provider_voice_id=provider_voice_id,
        )
    except ThankYouError as exc:
        raise _fail(exc.status or 502, exc.code, exc.message) from exc

    duration = info.get("duration")
    points = settings.speak_points(duration)
    over_limit = duration is not None and duration > settings.speak_max_seconds

    return {
        "key": info["key"],
        "audio_url": f"/api/speak/audio/{info['key']}",
        "duration": duration,
        "duration_known": duration is not None,
        "estimated_points": points,
        "resolution": settings.video_resolution,
        "max_seconds": settings.speak_max_seconds,
        "over_limit": over_limit,
        "cached": info.get("cached", False),
    }


@router.api_route("/audio/{key}", methods=["GET", "HEAD"])
async def speech_audio(key: str):
    """试听音轨。支持 HEAD：前端探测可用性会先发 HEAD。"""
    if not re.fullmatch(r"sp_[0-9a-f]{16}", key):
        raise _fail(422, "VALIDATION_ERROR", "音轨标识不合法")
    path = speech_path(key)
    if not path.exists() or path.stat().st_size == 0:
        raise _fail(404, "AUDIO_NOT_READY", "这条音轨还没合成好")
    return FileResponse(
        path,
        media_type="audio/mpeg",
        filename=f"{key}.mp3",
        headers={"Cache-Control": "public, max-age=86400"},
    )


# ---------- 出片 ----------


@router.post("", status_code=202)
async def create_speak_job(payload: SpeakRequest) -> dict:
    """提交一条「让角色说这段话」的任务，立刻返回 queued，后台跑。"""
    _require_key()
    binding, provider_voice_id = await _resolve_voice(payload.voice_id)

    # 先卡最贵的那个约束：台词太长意味着这条成片要几百点，
    # 而且这是用户改一句台词就能解决的。放在解析形象图之前，
    # 免得用户先被「缺形象图」这种次要问题挡住，改完才发现钱也不对。
    seconds = None
    key = speech_key(payload.voice_id, payload.script)
    cached_audio = speech_path(key)
    if cached_audio.exists() and cached_audio.stat().st_size > 0:
        # 台词试听过 → 音轨就在本地，量出来的是真数
        seconds = mp3_duration(cached_audio)
    elif payload.duration:
        seconds = payload.duration

    if seconds is not None and seconds > settings.speak_max_seconds:
        raise _fail(
            422,
            "SCRIPT_TOO_LONG",
            f"这段台词念出来约 {seconds:.1f} 秒，超过 {settings.speak_max_seconds} 秒上限。"
            "视频按秒计费，请把台词改短一些。",
        )

    try:
        portrait_ref = await resolve_portrait_ref(
            image_url=payload.image_url,
            source_job_id=payload.source_job_id,
            source_index=payload.source_index,
        )
    except ThankYouError as exc:
        raise _fail(exc.status or 422, exc.code, exc.message) from exc

    points = settings.speak_points(seconds)
    job = await jobs_service.create_job(
        JOB_TYPE,
        {
            "voice_id": payload.voice_id,
            "voice_name": binding.get("name"),
            "avatar_id": payload.avatar_id,
            "avatar_name": payload.avatar_name,
            "script": payload.script,
            "source_job_id": payload.source_job_id,
            "source_index": payload.source_index,
            # 记下地址本身：重试时不必再问前端要一遍形象（见 portrait_ref）
            "image_url": payload.image_url,
            "duration": seconds,
            "resolution": settings.video_resolution,
            "aspect_ratio": payload.aspect_ratio or settings.speak_aspect_ratio,
            "model": settings.speak_model,
            "estimated_points": points,
        },
    )

    jobs_service.spawn(
        run_speak_job(
            job["id"],
            portrait_ref=portrait_ref,
            voice_id=payload.voice_id,
            script=payload.script,
            provider_voice_id=provider_voice_id,
            model=settings.speak_model,
            aspect_ratio=payload.aspect_ratio,
        )
    )
    log.info(
        "提交说话任务 %s：角色 %s，台词 %s 字，预估 %s 秒 / %s 点",
        job["id"],
        payload.avatar_name or payload.source_job_id,
        len(payload.script),
        seconds or "?",
        points,
    )
    return {
        "job": job,
        "poll_url": f"/api/jobs/{job['id']}",
        "estimated_points": points,
    }


@router.get("/quote")
async def speak_quote(seconds: float = 0.0) -> dict:
    """按秒数算钱。前端拿到音轨时长后直接本地算也行，这里给服务端口径对齐用。"""
    duration = max(0.0, min(600.0, seconds))
    return {
        "duration": duration,
        "resolution": settings.video_resolution,
        "points_per_second": settings.video_points_per_second,
        "estimated_points": settings.speak_points(duration),
        "max_seconds": settings.speak_max_seconds,
        "model": settings.speak_model,
    }
