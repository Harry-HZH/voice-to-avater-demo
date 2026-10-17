"""让角色开口说话：人物图 + 台词音轨 → 会说话的视频。

链路：

    台词 ──TTS(角色音色)──→ 音轨 mp3 ──┬─→ 本后端 /api/jobs/{id}/voice（可单独听）
                                        └─→ speak_model(人物图 + 音轨) → 成片 mp4

三个关键取舍：

1. **音轨先做、还单独给用户听一次。** 视频按输出秒数计费（720p 20 点/秒），
   而 TTS 一条只要 1.5 点。先花 1.5 点换来「真实秒数 + 精确费用」，再让用户
   决定要不要花那几百点 —— 所以试听音轨是被出片复用的（同一份 mp3，不重复买）。

2. **模型差异收敛在 MODEL_SPECS。** 模型对入参的写法有自己的脾气（音轨 role 必须叫
   `source_audio`、某些模型 prompt 必填、某些按帧数出片）。写错时上游不会说「参数名不对」，
   只给一句 `The parameter combination is not supported.` —— 而且它是**真跑才报**，
   `/generate/quote` 照样放行，所以换模型只改这张表，业务代码不感知。

3. **音轨落本地、成片也落本地。** 上游返回的产物地址带 expires_at 会过期，
   而且第三方 CDN 不一定可达；产物由本后端提供，重试也不必重跑已经成功的那段。
"""

from __future__ import annotations

import asyncio
import logging
import math
from dataclasses import dataclass
from pathlib import Path

from .config import VIDEO_DIR, settings
from .media import mp3_duration, mp4_duration
from .speech import ensure_speech
from .store import store
from .thankyou import ThankYouError, client

log = logging.getLogger("videos")

# 上游的状态枚举里既有 "succeeded" 也有 "completed"（还有 cancelled 的双写），
# 这里统一认全，避免因为一个拼写差异把已经出片的任务判成超时。
_TERMINAL = {"succeeded", "completed", "failed", "cancelled", "canceled", "partial_success"}
_OK = {"succeeded", "completed", "partial_success"}
_JOB_TERMINAL = {"succeeded", "failed", "canceled"}


# ---------- 模型差异 ----------


@dataclass(frozen=True)
class ModelSpec:
    """一个说话模型该怎么喂料。"""

    image_role: str = "reference"
    audio_role: str = "source_audio"
    # infinitalk 的 prompt 是必填（空字符串会被判 invalid_param）
    needs_prompt: bool = False
    # 按帧数出片的模型要自己算 num_frames，否则音频长了会被截断
    uses_frames: bool = False
    supports_aspect_ratio: bool = True


# **音轨 role 一律是 `source_audio`。** 这一条踩得很深：两个模型都试过写 `audio`，
# 上游立即回 `The parameter combination is not supported.` —— 既不说哪个字段错了，
# 也不说该写什么。更坑的是 `/generate/quote` 对 `audio` 也放行（估价通过、真跑才炸），
# 所以「先估价再生成」这条自检路径根本拦不住它。最后是靠逐个变量真跑二分才定位到：
# 换成 `source_audio` 立刻出片（720x1280，时长跟着音轨 2.52 秒）。
MODEL_SPECS: dict[str, ModelSpec] = {
    "heygen/avatar4/avatar": ModelSpec(image_role="reference", audio_role="source_audio"),
    "infinitalk/avatar": ModelSpec(
        image_role="reference", audio_role="source_audio", needs_prompt=True, uses_frames=True,
        supports_aspect_ratio=False,
    ),
}
# 没登记的模型按最常见的写法试；真出新模型时优先把它登记进来
DEFAULT_SPEC = ModelSpec()

# 上游只认这几个说法，写错就是 compile_failed
_ASPECT_RATIOS = {"16:9", "9:16", "4:5", "5:4", "1:1"}


def spec_for(model: str) -> ModelSpec:
    return MODEL_SPECS.get(model, DEFAULT_SPEC)


# ---------- 产物路径 ----------


def job_dir(job_id: str) -> Path:
    return VIDEO_DIR / job_id


def final_path(job_id: str) -> Path:
    """最终成片。"""
    return job_dir(job_id) / "final.mp4"


def voice_path(job_id: str) -> Path:
    """角色念的台词音轨（成片就是拿它驱动口型的）。"""
    return job_dir(job_id) / "voice.mp3"


def clear_videos(job_id: str) -> int:
    """清掉这个任务的所有产物，返回删除数量。"""
    removed = 0
    for path in job_dir(job_id).glob("*"):
        if path.is_file():
            path.unlink(missing_ok=True)
            removed += 1
    return removed


def _has(path: Path) -> bool:
    return path.exists() and path.stat().st_size > 0


async def _stopped(job_id: str) -> bool:
    job = await store.get("jobs", "id", job_id)
    return job is None or job.get("status") in _JOB_TERMINAL


async def _patch(job_id: str, **fields) -> None:
    """局部更新任务。videos 模块不依赖 jobs 服务，避免循环导入。

    终态保护与 jobs.patch_job 同口径：任务一旦取消/完成，后台协程残留的
    进度与结果写入一律丢弃 —— 否则用户取消后，几分钟后任务又被
    `_patch(status="succeeded")` 悄悄复活（取消重试路径不受影响：重试
    接口在调用前已先把状态置回 running）。
    """
    job = await store.get("jobs", "id", job_id)
    if job is None:
        return
    if job.get("status") in _JOB_TERMINAL:
        log.info("任务 %s 已是终态 %s，忽略后台写入（%s）", job_id, job["status"], fields.get("status") or "进度")
        return
    await store.update("jobs", "id", job_id, {**fields, "updated_at": _now_iso()})


def _now_iso() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


# ---------- 单次上游调用（带进度回调） ----------


async def _run(model: str, payload: dict, *, on_progress=None, job_id: str | None = None) -> dict:
    """提交并等到终态，过程中把上游的 progress 透传出去。

    不用 client.run 是因为它内部轮询时拿不到中间进度 —— 视频要跑几分钟，
    没有进度用户会以为卡死了。

    传了 job_id 时，轮询循环里会检查任务是否已被取消：是则立刻中止等待
    （上游那边停不下来，但我们这边不再傻等、也不再下载产物）。
    """
    gen = await client.generate(model, payload)
    gid = gen.get("id")
    if not gid:
        raise ThankYouError("EMPTY_RESPONSE", f"{model} 没有返回任务 id")

    if gen.get("status") not in _TERMINAL:
        deadline = asyncio.get_event_loop().time() + settings.poll_timeout
        while True:
            await asyncio.sleep(settings.poll_interval)
            gen = await client.get_generation(gid)
            if gen.get("status") in _TERMINAL:
                break
            if job_id is not None and await _stopped(job_id):
                log.info("上游生成 %s 期间任务 %s 被取消，中止等待", gid, job_id)
                raise ThankYouError("CANCELED", "已取消生成，积分未扣除")
            if on_progress is not None:
                try:
                    await on_progress(float(gen.get("progress") or 0.0), gen)
                except Exception:  # 进度上报绝不能把主流程带崩
                    log.debug("进度回调异常，忽略", exc_info=True)
            if asyncio.get_event_loop().time() > deadline:
                raise ThankYouError(
                    "UPSTREAM_TIMEOUT",
                    f"{model} 超过 {settings.poll_timeout:.0f} 秒仍未完成，任务 {gid} 还在跑",
                    status=504,
                )

    if gen.get("status") not in _OK:
        err = gen.get("error") or {}
        raise ThankYouError(
            str(err.get("code") or "GENERATION_FAILED"),
            str(err.get("message") or f"生成失败（status={gen.get('status')}）"),
        )
    return gen


# ---------- 组装入参 ----------


def _asset(role: str, asset_type: str, *, file_id: str | None = None, url: str | None = None) -> dict:
    ref: dict = {"role": role, "asset_type": asset_type}
    if file_id:
        ref["file_id"] = file_id
    if url:
        ref["url"] = url
    return ref


def num_frames_for(seconds: float | None, spec: ModelSpec) -> int | None:
    """音轨秒数 → 帧数。只有按帧出片的模型需要。

    宁可向上取整：帧数给少了，台词念到一半视频就结束了（尾音被吞），
    而多要一两帧只是一两秒的钱。
    """
    if not spec.uses_frames or not seconds or seconds <= 0:
        return None
    return max(41, min(721, math.ceil(seconds * settings.speak_fps)))


def build_speak_payload(
    *,
    model: str,
    image_ref: dict,
    audio_ref: dict,
    script: str,
    aspect_ratio: str | None = None,
    seconds: float | None = None,
) -> dict:
    """组装 speak_model 的入参。role 命名、prompt、帧数都按模型规格来。"""
    spec = spec_for(model)
    payload: dict = {
        "reference_assets": [_asset(spec.image_role, "image", **image_ref)],
        "source_audio_assets": [_asset(spec.audio_role, "audio", **audio_ref)],
    }
    if spec.needs_prompt or script:
        # 描述要什么，而不是不要什么 —— 否定式元指令会让人像模型直接不出图
        payload["prompt"] = f"一个人物正在对着镜头自然地说话：{script[:200]}"
    if spec.supports_aspect_ratio:
        ratio = aspect_ratio if aspect_ratio in _ASPECT_RATIOS else settings.speak_aspect_ratio
        payload["aspect_ratio"] = ratio
    frames = num_frames_for(seconds, spec)
    if frames:
        payload["num_frames"] = frames
    payload["resolution"] = settings.video_resolution
    return payload


# ---------- 缓存 ----------


async def _cache(url: str, dest: Path, *, required: bool) -> bool:
    """把上游产物落到本地。required=False 时失败只记日志，不影响任务成败。"""
    try:
        await client.download(url, dest)
        return True
    except ThankYouError as exc:
        if required:
            raise
        log.warning("产物缓存失败（不影响任务）%s：%s", dest.name, exc.message)
        return False


async def _local_audio(job_id: str, *, voice_id: str, script: str, provider_voice_id: str) -> Path:
    """拿到台词音轨的本地文件（试听时已经生成就直接复用）。"""
    info = await ensure_speech(
        voice_id=voice_id, text=script, provider_voice_id=provider_voice_id
    )
    dest = voice_path(job_id)
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest != info["path"]:
        # 复制一份进任务目录：任务产物自包含，回看时不会因为清缓存而丢
        dest.write_bytes(Path(info["path"]).read_bytes())
    return dest


# ---------- 完整链路 ----------


async def run_speak_job(
    job_id: str,
    *,
    portrait_ref: dict,
    voice_id: str,
    script: str,
    provider_voice_id: str,
    model: str,
    aspect_ratio: str | None = None,
) -> None:
    """完整跑一条「让角色开口说话」的任务。"""
    if await _stopped(job_id):
        log.info("任务已取消，不再开始 %s", job_id)
        return

    await _patch(job_id, status="running", stage="合成台词", progress=1, error=None)

    try:
        # 阶段一：音轨。多数情况下试听时已经生成过，这里直接命中缓存（不再花 TTS 的钱）
        audio = await _local_audio(
            job_id, voice_id=voice_id, script=script, provider_voice_id=provider_voice_id
        )
        seconds = mp3_duration(audio)
        points = settings.speak_points(seconds)
        await _patch(
            job_id,
            progress=20,
            stage="让角色开口",
            output={
                "audio_url": f"/api/jobs/{job_id}/voice",
                "duration": seconds,
                "estimated_points": points,
            },
        )

        if await _stopped(job_id):
            log.info("任务在出片前被取消 %s", job_id)
            return

        # 阶段二：音轨要当输入交给上游。上传只是手段 —— 目的是把它变成一个
        # 上游抓得到的地址（引用用 url，不是 file_id，见 portrait_ref 的说明）。
        audio_info = await client.upload_file(audio)

        payload = build_speak_payload(
            model=model,
            image_ref=portrait_ref,
            audio_ref={"url": audio_info.get("url")},
            script=script,
            aspect_ratio=aspect_ratio,
            seconds=seconds,
        )

        async def on_progress(p: float, _gen: dict) -> None:
            await _patch(job_id, progress=max(20, min(99, 20 + round(p * 79))))

        gen = await _run(model, payload, on_progress=on_progress, job_id=job_id)
        video_url = client.first_url(gen)
        if not video_url:
            raise ThankYouError("EMPTY_OUTPUT", "生成完成但没有返回视频")

        cached = await _cache(video_url, final_path(job_id), required=False)
        final_seconds = mp4_duration(final_path(job_id)) if cached else None

        output = {
            # 优先给本后端的地址（不依赖第三方 CDN，也不会过期）
            "video_url": f"/api/jobs/{job_id}/video" if cached else None,
            "provider_video_url": video_url,
            "audio_url": f"/api/jobs/{job_id}/voice" if _has(voice_path(job_id)) else None,
            "duration": seconds,
            "output_duration": final_seconds,
            "resolution": settings.video_resolution,
            "aspect_ratio": payload.get("aspect_ratio"),
            "model": model,
            "estimated_points": points,
            "local_cached": cached,
        }
        await _patch(job_id, status="succeeded", stage=None, progress=100, output=output, error=None)
        log.info("说话视频完成 %s（音轨 %s 秒，预估 %s 点，本地缓存 %s）", job_id, seconds or "?", points, cached)
    except ThankYouError as exc:
        log.warning("说话视频失败 %s：%s %s", job_id, exc.code, exc.message)
        await _patch(job_id, status="failed", stage=None, error=exc.to_dict())
    except Exception as exc:  # noqa: BLE001 - 兜底，保证任务一定到终态
        log.exception("说话视频异常 %s", job_id)
        await _patch(
            job_id, status="failed", stage=None, error={"code": "INTERNAL_ERROR", "message": str(exc)}
        )


# ---------- 只重跑出片（省钱路径） ----------


def can_retry_video(job_id: str) -> bool:
    """音轨还在本地，说明重试可以不重复买 TTS。"""
    return _has(voice_path(job_id))


async def run_speak_video_job(
    job_id: str,
    *,
    portrait_ref: dict,
    script: str,
    model: str,
    aspect_ratio: str | None = None,
) -> None:
    """只重跑出片那一段，复用本地已有的音轨。

    出片是最容易失败的一环（上游排队、参考图被判不合格）。重试时音轨不必重买，
    但出片本身该花的钱省不掉 —— 这一步是任务里真正的计费项。

    **这里故意不查 `_stopped`。** 它的唯一用途就是把一条已经结束的任务重新推起来，
    而 `_stopped` 把所有终态都当作「不该再跑」；先查就会直接 return，什么都不发生
    （这个坑在候选形象重试上踩过一次）。所以复活要显式做掉，取消语义由调用方
    在复活之前判定。
    """
    audio = voice_path(job_id)
    if not _has(audio):
        raise ThankYouError("NO_LOCAL_ASSETS", "本地没有可复用的台词音轨，需要重新生成")

    seconds = mp3_duration(audio)
    points = settings.speak_points(seconds)

    await _patch(job_id, status="running", stage="让角色开口", progress=20, error=None)
    try:
        audio_info = await client.upload_file(audio)
        payload = build_speak_payload(
            model=model,
            image_ref=portrait_ref,
            audio_ref={"url": audio_info.get("url")},
            script=script,
            aspect_ratio=aspect_ratio,
            seconds=seconds,
        )

        async def on_progress(p: float, _gen: dict) -> None:
            await _patch(job_id, progress=max(20, min(99, 20 + round(p * 79))))

        gen = await _run(model, payload, on_progress=on_progress, job_id=job_id)
        video_url = client.first_url(gen)
        if not video_url:
            raise ThankYouError("EMPTY_OUTPUT", "生成完成但没有返回视频")

        cached = await _cache(video_url, final_path(job_id), required=False)

        old = (await store.get("jobs", "id", job_id)) or {}
        output = {
            **((old.get("output") or {})),
            "video_url": f"/api/jobs/{job_id}/video" if cached else None,
            "provider_video_url": video_url,
            "audio_url": f"/api/jobs/{job_id}/voice",
            "duration": seconds,
            "output_duration": mp4_duration(final_path(job_id)) if cached else None,
            "resolution": settings.video_resolution,
            "aspect_ratio": payload.get("aspect_ratio"),
            "model": model,
            "estimated_points": points,
            "local_cached": cached,
        }
        await _patch(job_id, status="succeeded", stage=None, progress=100, output=output, error=None)
        log.info("出片重试成功 %s", job_id)
    except ThankYouError as exc:
        log.warning("出片重试失败 %s：%s %s", job_id, exc.code, exc.message)
        await _patch(job_id, status="failed", stage=None, error=exc.to_dict())
    except Exception as exc:  # noqa: BLE001
        log.exception("出片重试异常 %s", job_id)
        await _patch(
            job_id, status="failed", stage=None, error={"code": "INTERNAL_ERROR", "message": str(exc)}
        )
