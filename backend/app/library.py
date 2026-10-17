"""声音库装配：把种子人设与导入音色统一成对外的 Voice 结构。"""

from __future__ import annotations

from typing import Any

from .seeds import PersonaVoice, SEED_VOICES, BY_ID
from .samples import read_bindings, sample_ready, sample_text_for
from .store import store


def _seed_voice(v: PersonaVoice, base: str, voice_avatars: dict[str, dict] | None = None) -> dict[str, Any]:
    binding = read_bindings().get(v.id, {})
    av = (voice_avatars or {}).get(v.id) or {}
    return {
        "id": v.id,
        "name": v.name,
        "language": v.language,
        "tags": list(v.tags),
        "description": v.description,
        "owner": v.owner,
        "sample_url": f"{base}/api/voices/{v.id}/sample",
        "source": "seed",
        "provider_voice_id": binding.get("provider_voice_id") or v.provider_voice_id,
        "provider": "fish-audio",
        "sample_ready": sample_ready(v.id),
        # 声音头像：生成过就带出来（相对地址，前端 absUrl() 补域名），没有为 None 走水彩占位
        "avatar_url": av.get("url"),
    }


def _stored_voice(v: dict, base: str, voice_avatars: dict[str, dict] | None = None) -> dict[str, Any]:
    vid = v["id"]
    av = (voice_avatars or {}).get(vid) or {}
    return {
        "id": vid,
        "name": v.get("name", vid),
        "language": v.get("language", "en"),
        "tags": v.get("tags", []),
        "description": v.get("description", ""),
        "owner": v.get("owner", "me"),
        "sample_url": f"{base}/api/voices/{vid}/sample",
        "source": "catalog",
        "provider_voice_id": v.get("provider_voice_id"),
        "provider": v.get("provider", "fish-audio"),
        "sample_ready": sample_ready(vid),
        "avatar_url": av.get("url"),
    }


async def list_library(base: str) -> list[dict]:
    """我的声音库 = 20 个种子人设 + 从音色目录导入的音色。"""
    voice_avatars = {d["id"]: d for d in await store.list("voice_avatars")}
    voices = [_seed_voice(v, base, voice_avatars) for v in SEED_VOICES]
    voices.extend(_stored_voice(v, base, voice_avatars) for v in await store.list("voices"))
    return voices


async def get_voice(voice_id: str, base: str) -> dict | None:
    for v in await list_library(base):
        if v["id"] == voice_id:
            return v
    return None


async def resolve_binding(voice_id: str) -> dict[str, Any] | None:
    """取生成所需的绑定信息：provider voice_id、候选、试听文本。"""
    persona: PersonaVoice | None = BY_ID.get(voice_id)
    if persona is not None:
        binding = read_bindings().get(voice_id, {})
        return {
            "key": voice_id,
            "name": persona.name,
            "language": persona.language,
            "sample_text": persona.sample_text(),
            "provider_voice_id": binding.get("provider_voice_id") or persona.provider_voice_id,
            "fallbacks": list(persona.fallbacks),
        }

    stored = await store.get("voices", "id", voice_id)
    if stored is None:
        return None
    return {
        "key": voice_id,
        "name": stored.get("name", voice_id),
        "language": stored.get("language", "en"),
        "sample_text": sample_text_for(stored.get("language", "en"), stored.get("name", voice_id)),
        "provider_voice_id": stored.get("provider_voice_id"),
        "fallbacks": [],
    }


async def add_imported_voice(
    *,
    provider_voice_id: str,
    name: str,
    language: str,
    description: str = "",
    tags: list[str] | None = None,
) -> dict:
    """把一个目录音色加入我的声音库（同 provider_voice_id 幂等）。"""
    existing = await store.list("voices")
    for v in existing:
        if v.get("provider_voice_id") == provider_voice_id:
            return v

    # 本地 id 用 imp_ 前缀，和种子 voice_xxx 区分开
    short = provider_voice_id[:8]
    voice_id = f"imp_{short}"
    suffix = 1
    ids = {v["id"] for v in existing}
    while voice_id in ids:
        voice_id = f"imp_{short}_{suffix}"
        suffix += 1

    doc = {
        "id": voice_id,
        "name": name,
        "language": language,
        "tags": tags or ["imported"],
        "description": description or f"从音色目录导入 · {name}",
        "owner": "me",
        "provider_voice_id": provider_voice_id,
        "provider": "fish-audio",
    }
    await store.insert("voices", doc)
    return doc
