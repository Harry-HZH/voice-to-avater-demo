"""台词音轨的合成与缓存（「先试听、再出片」的那一步）。

为什么要把 TTS 单独拆出来、还让用户先点一次「试听」：

    视频模型按**输出秒数**计费，720p 是 20 点/秒 —— 一条 10 秒的成片就是 200 点。
    而 TTS 一条只要 1.5 点，差了两个数量级。

    所以流程做成两段：先花 1.5 点把台词合成出来，用户能听到、能看到**真实秒数**，
    再决定要不要花那 200 点出片。费用是算出来的，不是猜出来的。

缓存键是 (音色, 台词) 的哈希，所以「试听过了再出片」不会把 TTS 买第二遍 ——
出片直接复用这份 mp3（见 videos.run_speak_job）。
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
from pathlib import Path

from .config import SPEECH_DIR, settings
from .media import mp3_duration
from .thankyou import ThankYouError, client

log = logging.getLogger("speech")

_locks: dict[str, asyncio.Lock] = {}


def _lock_for(key: str) -> asyncio.Lock:
    if key not in _locks:
        _locks[key] = asyncio.Lock()
    return _locks[key]


def speech_key(voice_id: str, text: str) -> str:
    """(音色, 台词) → 稳定 key。同一个声音说同一句话永远命中同一份音轨。"""
    digest = hashlib.sha1(f"{voice_id}\x00{text}".encode("utf-8")).hexdigest()
    return f"sp_{digest[:16]}"


def speech_path(key: str) -> Path:
    return SPEECH_DIR / f"{key}.mp3"


def speech_ready(key: str) -> bool:
    path = speech_path(key)
    return path.exists() and path.stat().st_size > 0


async def synthesize_speech(
    *,
    voice_id: str,
    text: str,
    provider_voice_id: str,
    force: bool = False,
) -> dict:
    """合成台词音轨，落本地缓存，返回 {key, path, duration}。

    并发对同一 key 的调用会串行化 —— 前端试听和提交出片可能前后脚打到，
    没必要让上游同一个请求跑两遍（白花点数）。
    """
    key = speech_key(voice_id, text)
    dest = speech_path(key)
    async with _lock_for(key):
        if dest.exists() and dest.stat().st_size > 0 and not force:
            return {"key": key, "path": dest, "duration": mp3_duration(dest), "cached": True}

        if not settings.api_key_configured:
            raise ThankYouError(
                "CONFIG_ERROR", "未配置 THANK_YOU_AI_KEY，无法合成语音", status=503
            )

        gen = await client.run(
            settings.tts_model, {"text": text, "voice_id": provider_voice_id, "format": "mp3"}
        )
        url = client.first_url(gen)
        if not url:
            raise ThankYouError("EMPTY_OUTPUT", "语音合成完成但没有返回音频")

        await client.download(url, dest)
        duration = mp3_duration(dest)
        log.info(
            "台词音轨已生成 %s（%.1f KB，%s 秒）", key, dest.stat().st_size / 1024, duration or "?"
        )
        return {"key": key, "path": dest, "duration": duration, "cached": False}


async def ensure_speech(*, voice_id: str, text: str, provider_voice_id: str) -> dict:
    """确保音轨存在（已有就直接复用）。"""
    if speech_ready(speech_key(voice_id, text)):
        # 缓存命中时不必拿锁，读一下时长就行
        key = speech_key(voice_id, text)
        return {"key": key, "path": speech_path(key), "duration": mp3_duration(speech_path(key)), "cached": True}
    return await synthesize_speech(
        voice_id=voice_id, text=text, provider_voice_id=provider_voice_id
    )


def clear_speech(key: str) -> bool:
    path = speech_path(key)
    if not path.exists():
        return False
    path.unlink(missing_ok=True)
    return True
