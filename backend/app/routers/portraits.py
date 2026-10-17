"""候选形象接口：提交生成候选图、补三视图。

统一走 Job 生命周期（queued → running → succeeded / failed），
任务本身的状态查询 / 取消 / 重试在 /api/jobs 下：

  POST /api/portraits         提交「生成 N 张候选形象」
  POST /api/portraits/views   用选定的候选图作参考，生成侧面 / 背面
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException

from .. import jobs as jobs_service
from ..config import settings
from ..library import get_voice
from ..portraits import VIEW_PROMPTS, provider_url_of, quote_candidates
from ..schemas import PortraitJobRequest, ViewsJobRequest

log = logging.getLogger("portraits")
router = APIRouter(prefix="/portraits", tags=["portraits"])


def require_key() -> None:
    if not settings.api_key_configured:
        raise HTTPException(
            status_code=503,
            detail={"error": {"code": "CONFIG_ERROR", "message": "未配置 THANK_YOU_AI_KEY，无法生成形象"}},
        )


@router.post("", status_code=202)
async def create_portrait_job(payload: PortraitJobRequest) -> dict:
    """提交一次候选形象生成。立刻返回 queued 任务，前端轮询 /api/jobs/{id}。"""
    require_key()

    count = max(1, min(6, payload.count or settings.portrait_count))

    # 生成的是「某个声音的形象」，所以声音必须存在
    voice = await get_voice(payload.voice_id, "")
    if voice is None:
        raise HTTPException(
            status_code=404,
            detail={"error": {"code": "NOT_FOUND", "message": f"声音 {payload.voice_id} 不存在"}},
        )

    # 先估价：把预计消耗随任务一起返回，前端可以如实告诉用户这次生成要花多少点数
    estimate = await quote_candidates(count)

    job = await jobs_service.create_job(
        "portrait",
        {
            "voice_id": payload.voice_id,
            "voice_name": voice["name"],
            "prompt": payload.prompt.strip(),
            "count": count,
            "variant": payload.variant,
            "kind": "candidates",
            "model": settings.portrait_model,
            "estimated_points": estimate,
        },
    )
    jobs_service.spawn(
        jobs_service.run_portrait_job(
            job["id"], prompt=payload.prompt, count=count, variant=payload.variant
        )
    )
    return {"job": job, "poll_url": f"/api/jobs/{job['id']}", "estimated_points": estimate}


@router.post("/views", status_code=202)
async def create_views_job(payload: ViewsJobRequest) -> dict:
    """用选定的正面候选图作参考，生成侧面 / 背面，保持同一人物。

    - 给了 job_id：参考图从这条候选任务的 provider_urls 里取（创建流程）；
    - 没给 job_id：必须直接给 reference_url（保存过的形象后续补视图）。
    """
    require_key()

    source: dict | None = None
    if payload.job_id:
        source = await jobs_service.get_job(payload.job_id)
        if source is None:
            raise HTTPException(
                status_code=404,
                detail={"error": {"code": "NOT_FOUND", "message": f"任务 {payload.job_id} 不存在"}},
            )

    reference_url = payload.reference_url or (provider_url_of(source, payload.index) if source else "") or ""
    if not reference_url:
        raise HTTPException(
            status_code=409,
            detail={
                "error": {
                    "code": "REFERENCE_MISSING",
                    "message": "这张候选图没有可用的上游地址作参考，请先重新生成候选图",
                }
            },
        )

    views = [v for v in (payload.views or ["side", "back"]) if v in VIEW_PROMPTS]
    if not views:
        raise HTTPException(
            status_code=422,
            detail={"error": {"code": "VALIDATION_ERROR", "message": "views 只能是 side / back"}},
        )

    src_input = (source or {}).get("input") or {}
    job = await jobs_service.create_job(
        "portrait",
        {
            "voice_id": src_input.get("voice_id") or payload.voice_id,
            "prompt": src_input.get("prompt") or payload.prompt,
            "kind": "views",
            "source_job_id": payload.job_id,
            "source_index": payload.index,
            "views": views,
            "count": len(views),
            # 记下来：重试时要接着用同一张参考图，不用再问前端要一次
            "reference_url": reference_url,
            "model": settings.views_model,
        },
    )
    jobs_service.spawn(
        jobs_service.run_views_job(
            job["id"], reference_url=reference_url, views=views, index=payload.index
        )
    )
    return {
        "job": job,
        "poll_url": f"/api/jobs/{job['id']}",
        "estimated_points": await quote_candidates(len(views), model=settings.views_model),
    }
