"""试听音源的生成与缓存。

问题：seed 数据里 20 个声音的 sample_url 是占位音乐，目录里的 preview_audio_url
      又托管在 platform.r2.fish.audio（本机不可达，且是第三方 CDN）。

做法：用该声音绑定的真实 Fish Audio 音色，调 fish-audio/text-to-speech 合成一句
      「自我介绍」，把 mp3 下载到 backend/data/samples/ 缓存，再由本后端流式提供。
      这样音源是真实人声、可控、可离线复用，且不依赖第三方 CDN 的可用性。

成本：每条约 0.05 点（1 句短文本），20 条约 1 点。生成一次长期有效。
"""

from __future__ import annotations

import asyncio
import json
import logging
from pathlib import Path
from typing import Sequence

from .seeds import SAMPLE_TEXT
from .config import SAMPLE_DIR, settings
from .thankyou import ThankYouError, client

log = logging.getLogger("samples")

BINDINGS_FILE = SAMPLE_DIR / "bindings.json"
_locks: dict[str, asyncio.Lock] = {}


def _lock_for(key: str) -> asyncio.Lock:
    if key not in _locks:
        _locks[key] = asyncio.Lock()
    return _locks[key]


def sample_path(key: str) -> Path:
    return SAMPLE_DIR / f"{key}.mp3"


def sample_ready(key: str) -> bool:
    p = sample_path(key)
    return p.exists() and p.stat().st_size > 0


def read_bindings() -> dict:
    if BINDINGS_FILE.exists():
        try:
            return json.loads(BINDINGS_FILE.read_text(encoding="utf-8"))
        except (ValueError, OSError):
            return {}
    return {}


def write_binding(key: str, provider_voice_id: str, provider_voice_name: str = "") -> None:
    data = read_bindings()
    data[key] = {"provider_voice_id": provider_voice_id, "provider_voice_name": provider_voice_name}
    BINDINGS_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")


def sample_text_for(language: str, name: str) -> str:
    return SAMPLE_TEXT.get(language, SAMPLE_TEXT["en"]).format(name=name)


async def ensure_sample(
    key: str,
    *,
    text: str,
    provider_voice_id: str,
    fallbacks: Sequence[str] = (),
    force: bool = False,
) -> Path:
    """确保 key 的试听音频存在，返回本地路径。并发调用同一 key 会串行化。"""
    dest = sample_path(key)
    if dest.exists() and dest.stat().st_size > 0 and not force:
        return dest

    async with _lock_for(key):
        if dest.exists() and dest.stat().st_size > 0 and not force:
            return dest

        candidates = [provider_voice_id, *[c for c in fallbacks if c != provider_voice_id]]
        errors: list[str] = []
        for vid in candidates:
            try:
                gen = await client.run(
                    settings.tts_model, {"text": text, "voice_id": vid, "format": "mp3"}
                )
            except ThankYouError as exc:
                errors.append(f"{vid}: {exc.code} {exc.message}")
                log.warning("音色 %s 合成失败，尝试下一个候选：%s", vid, exc.message)
                continue

            url = client.first_url(gen)
            if not url:
                errors.append(f"{vid}: 未返回音频地址")
                continue

            try:
                await client.download(url, dest)
            except ThankYouError as exc:
                errors.append(f"{vid}: {exc.code} {exc.message}")
                continue

            write_binding(key, vid)
            log.info("试听音频已生成：%s (%s, %.1f KB)", key, vid, dest.stat().st_size / 1024)
            return dest

        raise ThankYouError(
            "SAMPLE_GENERATION_FAILED",
            f"声音 {key} 的所有候选音色都失败：{' | '.join(errors) or '无候选'}",
        )


async def generate_all(force: bool = False, only: Sequence[str] | None = None) -> dict:
    """批量生成种子声音的试听音频。供 scripts/build_samples.py 调用。"""
    from .seeds import SEED_VOICES

    targets = [v for v in SEED_VOICES if not only or v.id in only or v.name in only]
    done, skipped, failed = [], [], []

    for v in targets:
        if sample_ready(v.id) and not force:
            skipped.append(v.id)
            continue
        try:
            await ensure_sample(
                v.id,
                text=v.sample_text(),
                provider_voice_id=v.provider_voice_id,
                fallbacks=v.fallbacks,
                force=force,
            )
            done.append(v.id)
        except Exception as exc:  # noqa: BLE001 - 批量任务要跑完全部
            failed.append((v.id, str(exc)))
            log.error("生成 %s 失败：%s", v.id, exc)

    return {"generated": done, "skipped": skipped, "failed": failed}
