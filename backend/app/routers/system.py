"""系统接口：健康检查、用量、模型清单。"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from ..seeds import SEED_VOICES
from ..config import settings
from ..samples import sample_ready
from ..store import store
from ..thankyou import ThankYouError, client

router = APIRouter(tags=["system"])


@router.get("/health")
async def health() -> dict:
    ready = sum(1 for v in SEED_VOICES if sample_ready(v.id))
    return {
        "status": "ok",
        "store_backend": store.backend_name,
        "api_key_configured": settings.api_key_configured,
        "voices_total": len(SEED_VOICES),
        "samples_ready": ready,
    }


@router.get("/usage")
async def usage(days: int = 30) -> dict:
    try:
        return await client.usage(days=days)
    except ThankYouError as exc:
        raise HTTPException(
            status_code=exc.status or 502, detail={"error": exc.to_dict()}
        ) from exc


@router.get("/models")
async def models(operation: str | None = None) -> dict:
    try:
        items = await client.list_models()
    except ThankYouError as exc:
        raise HTTPException(
            status_code=exc.status or 502, detail={"error": exc.to_dict()}
        ) from exc
    if operation:
        items = [m for m in items if m.get("operation") == operation]
    return {"models": items}
