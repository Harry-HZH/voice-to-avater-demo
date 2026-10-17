"""音色目录接口：浏览 ThankYou 的实时音色库（1000+ 真实 Fish Audio 音色）。

上游 /open/v1/voices 单页最多 50 条，且只支持 q（名称搜索）与分页。
为了支持「按语言筛选」，这里在首次访问时并行拉取一份完整快照并缓存，
之后的分页/筛选/搜索都在本地完成，避免每次浏览都打上游。
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections import Counter

from fastapi import APIRouter, HTTPException

from ..thankyou import ThankYouError, client

log = logging.getLogger("catalog")
router = APIRouter(prefix="/catalog", tags=["catalog"])

_TTL = 900.0  # 快照缓存 15 分钟
_snapshot: dict = {"at": 0.0, "voices": [], "total": 0}
_lock = asyncio.Lock()


async def _fetch_all() -> tuple[list[dict], int]:
    first = await client.list_voices(page=1, page_size=50)
    total = int(first.get("total") or 0)
    voices: list[dict] = list(first.get("voices") or [])
    page_size = 50
    pages = max(1, (min(total, 2000) + page_size - 1) // page_size)

    if pages > 1:
        async def one(p: int):
            try:
                return (await client.list_voices(page=p, page_size=page_size)).get("voices") or []
            except ThankYouError as exc:
                log.warning("拉取音色第 %s 页失败：%s", p, exc.message)
                return []

        rest = await asyncio.gather(*(one(p) for p in range(2, pages + 1)))
        for chunk in rest:
            voices.extend(chunk)

    seen, uniq = set(), []
    for v in voices:
        vid = v.get("voice_id")
        if vid and vid not in seen:
            seen.add(vid)
            uniq.append(v)
    return uniq, total


async def _get_snapshot(force: bool = False) -> list[dict]:
    fresh = time.time() - _snapshot["at"] < _TTL and _snapshot["voices"]
    if fresh and not force:
        return _snapshot["voices"]
    async with _lock:
        if time.time() - _snapshot["at"] < _TTL and _snapshot["voices"] and not force:
            return _snapshot["voices"]
        voices, total = await _fetch_all()
        _snapshot.update({"at": time.time(), "voices": voices, "total": total})
        log.info("音色目录快照已刷新：%s 条", len(voices))
        return voices


@router.get("/voices")
async def catalog_voices(
    q: str | None = None,
    language: str | None = None,
    page: int = 1,
    page_size: int = 20,
    refresh: bool = False,
) -> dict:
    try:
        voices = await _get_snapshot(force=refresh)
    except ThankYouError as exc:
        raise HTTPException(
            status_code=exc.status or 502, detail={"error": exc.to_dict()}
        ) from exc

    if language:
        voices = [v for v in voices if language in (v.get("languages") or [])]
    if q:
        needle = q.strip().lower()
        voices = [v for v in voices if needle in (v.get("name") or "").lower()]

    page = max(1, page)
    page_size = min(max(1, page_size), 100)
    start = (page - 1) * page_size
    items = [
        {
            "provider_voice_id": v["voice_id"],
            "name": v.get("name"),
            "languages": v.get("languages") or [],
            "provider": v.get("provider"),
            # 上游预览地址在第三方 CDN，前端不直连；导入后由后端生成缓存音源
            "has_preview": bool(v.get("preview_audio_url")),
        }
        for v in voices[start : start + page_size]
    ]

    langs = Counter(lg for v in voices for lg in (v.get("languages") or []))
    return {
        "voices": items,
        "total": len(voices),
        "page": page,
        "page_size": page_size,
        "languages": dict(langs.most_common(30)),
        "cached_at": _snapshot["at"],
    }
