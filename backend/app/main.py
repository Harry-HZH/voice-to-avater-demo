"""Voice to Avatar 后端（FastAPI）。

职责：
  1. 声音库：20 个种子人设 + 可从 ThankYou 音色目录导入的真实音色，
     每个声音都有**真实可播放的试听音源**（Fish Audio TTS 合成并本地缓存）。
  2. 语音合成：用任意声音把任意文案念出来，走 Job 生命周期。
  3. 候选形象：根据形象描述真实生成 N 张人像候选图（ThankYou 文生图），
     选定后可用它作参考图生成侧面 / 背面（image-to-image）。
  4. 音色目录：代理 ThankYou /open/v1/voices，支持浏览与导入。
  5. 创作：让角色开口说话 —— 角色形象 + 角色音色念一段台词 → 会说话的视频。
     台词先试听（约 1.5 点，能听到真实秒数），再决定要不要出片（20 点/秒）。

启动：
  cd backend
  python -m venv .venv && .venv/Scripts/pip install -r requirements.txt   # Windows
  .venv/Scripts/python -m uvicorn app.main:app --reload --port 8000
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .config import settings
from . import creation_media
from .routers import catalog, jobs, library, portraits, speak, system, voices
from .store import store
from .thankyou import client

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-7s %(name)s | %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("app")


@asynccontextmanager
async def lifespan(app: FastAPI):
    await store.init()
    if not settings.api_key_configured:
        log.warning("未配置 THANK_YOU_AI_KEY —— 生成类接口会返回 503（声音库列表仍可用）")
    # 历史创作还引用任务 URL 的，补做媒体快照（创作不与任务绑定）
    try:
        migrated = await creation_media.migrate_existing(await store.list("creations"))
        if migrated:
            log.info("已为 %d 条历史创作补做媒体快照", migrated)
    except Exception:
        log.exception("创作媒体快照迁移失败（不影响启动）")
    # 声音头像 / 角色三视图同理：引用任务 URL 的补做快照（删任务不影响头像与三视图）
    try:
        summary = await creation_media.migrate_media(
            await store.list("creations"),
            await store.list("voice_avatars"),
            await store.list("created_avatars"),
            await store.list("avatar_patches"),
        )
        if summary:
            log.info("媒体快照迁移完成: %s", summary)
    except Exception:
        log.exception("声音头像 / 三视图快照迁移失败（不影响启动）")
    yield
    await client.aclose()
    await store.close()


app = FastAPI(
    title="Voice to Avatar API",
    version="0.3.0",
    description="声音库（真实音源）+ 语音合成 + 候选形象 + 创作（让角色开口说话）；AI 能力由 ThankYou Open API 提供。",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list or ["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["Retry-After"],
)

app.include_router(system.router, prefix="/api")
app.include_router(voices.router, prefix="/api")
app.include_router(catalog.router, prefix="/api")
app.include_router(portraits.router, prefix="/api")
app.include_router(speak.router, prefix="/api")
app.include_router(jobs.router, prefix="/api")
app.include_router(creation_media.router, prefix="/api")
app.include_router(library.router, prefix="/api")


@app.exception_handler(RequestValidationError)
async def validation_handler(request: Request, exc: RequestValidationError) -> JSONResponse:
    """统一错误格式：{ error: { code, message } }（INTERVIEW.md 第 4 节）。"""
    first = exc.errors()[0] if exc.errors() else {}
    loc = ".".join(str(p) for p in first.get("loc", []) if p not in ("body", "query"))
    message = f"{loc}: {first.get('msg', '输入不合法')}" if loc else first.get("msg", "输入不合法")
    return JSONResponse(status_code=422, content={"error": {"code": "VALIDATION_ERROR", "message": message}})


@app.get("/")
async def root() -> dict:
    return {
        "service": "voice-to-avatar-api",
        "docs": "/docs",
        "endpoints": [
            "GET  /api/health",
            "GET  /api/voices",
            "GET  /api/voices/{id}",
            "GET  /api/voices/{id}/sample        # 真实试听音源 (mp3)",
            "POST /api/voices/{id}/preview       # 用该声音合成任意文案",
            "POST /api/voices/import             # 从音色目录导入",
            "GET  /api/catalog/voices            # 浏览 ThankYou 音色目录",
            "POST /api/portraits                 # 生成候选形象（真实文生图）",
            "POST /api/portraits/views           # 补侧面 / 背面（参考图 + 文字）",
            "POST /api/speak/preview              # 台词试听：出音轨 + 真实秒数 + 预估点数",
            "GET  /api/speak/audio/{key}          # 台词音轨 (mp3)",
            "GET  /api/speak/quote?seconds=       # 按秒数算钱",
            "POST /api/speak                      # 让角色开口说话（人物图 + 音轨 → 视频）",
            "GET  /api/jobs/{id}",
            "GET  /api/jobs/{id}/image/{index}   # 候选形象 / 三视图图片",
            "GET  /api/jobs/{id}/audio",
            "GET  /api/jobs/{id}/video           # 说话成片 (mp4)",
            "GET  /api/jobs/{id}/voice           # 成片的台词音轨",
            "POST /api/jobs/{id}/cancel          # 取消",
            "POST /api/jobs/{id}/retry           # 重试 / 换一批",
            "GET  /api/library                    # 用户产出库（角色/修改/创作记录）",
            "PUT  /api/library/created-avatars/{id} / DELETE",
            "PUT  /api/library/avatar-patches/{id} / DELETE",
            "PUT  /api/library/deleted-seeds/{id} / DELETE   # 删除/恢复种子角色",
            "PUT  /api/library/creations/{id} / DELETE",
        ],
    }
