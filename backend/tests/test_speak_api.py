"""让角色开口说话：任务链路、试点试听、费用与重试语义。

不调用真实 AI 服务：上游在 conftest 里被整体替换成假实现。
重点验证：

  - **试听过的台词不会再买一次 TTS** —— 这是整个功能省钱的核心（1.5 点 vs 几百点）；
  - 费用是算出来的：音轨几秒就乘几秒，超上限直接拦在提交之前；
  - 两个说话模型的入参写法不同（prompt 是否必填、是否按帧数出片），
    换模型不能悄悄坏掉；
  - 进度与阶段名是真实透传的，不是假动画；
  - 重试只重跑「出片」那一段，不重买音轨。
"""

from __future__ import annotations

import asyncio

import pytest

from app import jobs as jobs_mod
from app import media, videos as videos_mod
from app.config import settings
from app.speech import speech_key, speech_path
from tests.conftest import make_mp3_bytes, make_mp4_bytes, make_speech

SCRIPT = "大家好，我是这个角色，今天想和你聊几句。"
TTFS = settings.tts_model  # noqa: N806 - 便于断言用


def run(coro):
    return asyncio.run(coro)


def tts_calls(fake_provider) -> list[dict]:
    return [c for c in fake_provider["calls"] if c["model"] == settings.tts_model]


def video_calls(fake_provider) -> list[dict]:
    return [c for c in fake_provider["calls"] if c["model"] == settings.speak_model]


# ---------- 时长解析（费用全建立在这上面，必须先准） ----------


def test_mp3_duration_is_exact(tmp_path):
    """128 kbps 恒定码率：字节数 / 16000 = 秒数。"""
    for seconds in (1.0, 4.5, 12.0):
        p = tmp_path / "a.mp3"
        p.write_bytes(make_mp3_bytes(seconds))
        assert media.mp3_duration(p) == pytest.approx(seconds, abs=0.01)


def test_mp3_duration_skips_id3_tag(tmp_path):
    """真实 TTS 产物开头常带 ID3v2 标签，不跳过就会读错时长。"""
    p = tmp_path / "id3.mp3"
    tag = b"ID3\x04\x00\x00" + b"\x00\x00\x00\x40" + b"\x00" * 0x40
    p.write_bytes(tag + make_mp3_bytes(2.0))
    assert media.mp3_duration(p) == pytest.approx(2.0, abs=0.01)


def test_mp4_duration(tmp_path):
    p = tmp_path / "v.mp4"
    p.write_bytes(make_mp4_bytes(7.5))
    assert media.mp4_duration(p) == pytest.approx(7.5, abs=0.01)


def test_duration_of_garbage_is_none(tmp_path):
    """读不出来就说读不出来 —— 宁可没有数，也不能给用户一个错的估价。"""
    p = tmp_path / "x.mp3"
    p.write_bytes(b"not audio at all")
    assert media.probe_duration(p) is None
    assert media.probe_duration(tmp_path / "missing.mp3") is None


def test_points_are_linear_in_seconds():
    assert settings.speak_points(5) == 100
    assert settings.speak_points(10) == 200
    assert settings.speak_points(None) is None
    assert settings.speak_points(0) is None


# ---------- 图片真实类型（扩展名不可信） ----------


def test_image_content_type_reads_magic_bytes(tmp_path):
    """按内容判断，不看扩展名。

    上游文生图返回的是 PNG，我们却按 .jpg 存 —— 只看扩展名就会把 PNG 说成 JPEG，
    传给模型换来一句「参数组合不支持」。
    """
    png = tmp_path / "a.jpg"  # 名字骗人，内容是 PNG
    png.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * 32)
    assert media.image_content_type(png) == "image/png"
    assert media.image_extension(png) == ".png"

    jpg = tmp_path / "b.bin"
    jpg.write_bytes(b"\xff\xd8\xff\xe0" + b"\x00" * 32)
    assert media.image_content_type(jpg) == "image/jpeg"

    webp = tmp_path / "c.dat"
    webp.write_bytes(b"RIFF" + b"\x00\x00\x00\x00" + b"WEBP" + b"\x00" * 8)
    assert media.image_content_type(webp) == "image/webp"

    weird = tmp_path / "d.jpg"
    weird.write_bytes(b"totally not an image")
    assert media.image_content_type(weird) == "application/octet-stream"


# ---------- 组装入参 ----------


def test_default_model_payload_uses_heygen_roles():
    """heygen：音轨 role 必须叫 source_audio（不是 audio），不需要 num_frames，支持竖屏。

    这条是逐个变量真跑二分出来的：写 `audio` 时上游只回
    `The parameter combination is not supported.`，换成 `source_audio` 立刻出片。
    估价接口对 `audio` 也放行，所以只能靠真跑来发现 —— 更该钉死在测试里。

    引用一律用 `url`（上传的意义就是把本地文件变成上游抓得到的地址）——
    实测喂 file_id 会被上游判 `invalid_param`，即便字节已经 PUT 上去。
    """
    payload = videos_mod.build_speak_payload(
        model="heygen/avatar4/avatar",
        image_ref={"url": "https://x/face.jpg"},
        audio_ref={"url": "https://x/voice.mp3"},
        script=SCRIPT,
        aspect_ratio="9:16",
        seconds=6.0,
    )
    assert payload["reference_assets"] == [
        {"role": "reference", "asset_type": "image", "url": "https://x/face.jpg"}
    ]
    assert payload["source_audio_assets"] == [
        {"role": "source_audio", "asset_type": "audio", "url": "https://x/voice.mp3"}
    ]
    assert payload["aspect_ratio"] == "9:16"
    assert "num_frames" not in payload


def test_no_spec_uses_the_rejected_audio_role():
    """`audio` 这个 role 名被上游拒过，别再写回来。

    它不会报「参数名不对」，只报「参数组合不支持」，而且估价接口照样放行 ——
    没有这条守卫，很容易有人觉得 `audio` 更自然就改回去，然后又一次靠真跑才发现。
    """
    for model, spec in videos_mod.MODEL_SPECS.items():
        assert spec.audio_role == "source_audio", f"{model} 的音轨 role 写回了被拒的 {spec.audio_role}"
    assert videos_mod.DEFAULT_SPEC.audio_role == "source_audio"


def test_infinitalk_payload_uses_source_audio_role_and_frames():
    """infinitalk：音轨 role 必须叫 source_audio，且 prompt 必填、按帧数出片。

    这三条哪一条错了，上游都只给一个 compile_failed 的糊脸错误 ——
    所以值得钉死在测试里。
    """
    payload = videos_mod.build_speak_payload(
        model="infinitalk/avatar",
        image_ref={"url": "https://x/face.jpg"},
        audio_ref={"url": "https://x/voice.mp3"},
        script=SCRIPT,
        aspect_ratio="9:16",  # 这个模型不支持宽高比，不该出现在入参里
        seconds=6.0,
    )
    assert payload["source_audio_assets"][0]["role"] == "source_audio"
    assert payload["reference_assets"][0]["role"] == "reference"
    assert payload["prompt"]
    assert payload["num_frames"] == int(6.0 * settings.speak_fps)
    assert "aspect_ratio" not in payload


def test_num_frames_rounds_up_and_clamps():
    """帧数宁多勿少：给少了台词念到一半视频就结束（尾音被吞）。"""
    spec = videos_mod.spec_for("infinitalk/avatar")
    assert videos_mod.num_frames_for(5.02, spec) == 126  # 向上取整
    assert videos_mod.num_frames_for(0.1, spec) == 41  # 下限
    assert videos_mod.num_frames_for(999, spec) == 721  # 上限
    assert videos_mod.num_frames_for(6.0, videos_mod.spec_for("heygen/avatar4/avatar")) is None


# ---------- 试听 ----------


def test_preview_returns_real_duration_and_points(client):
    r = client.post("/api/speak/preview", json={"voice_id": "voice_001", "script": SCRIPT})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["duration"] == pytest.approx(3.0, abs=0.05)
    assert body["estimated_points"] == settings.speak_points(3.0)
    assert body["audio_url"].startswith("/api/speak/audio/")
    assert body["over_limit"] is False

    # 音轨真的能取回来（且支持 HEAD —— 前端探测会先发 HEAD）
    assert client.get(body["audio_url"]).status_code == 200
    assert client.head(body["audio_url"]).status_code == 200


def test_preview_is_cached_and_costs_tts_only_once(client, fake_provider):
    """同一段台词试听两次只花一次 TTS。"""
    first = client.post("/api/speak/preview", json={"voice_id": "voice_001", "script": SCRIPT})
    second = client.post("/api/speak/preview", json={"voice_id": "voice_001", "script": SCRIPT})
    assert first.status_code == second.status_code == 200
    assert second.json()["cached"] is True
    assert len(tts_calls(fake_provider)) == 1


def test_preview_flags_over_limit(client, clean_env):
    """台词太长要提前说清楚 —— 出片是按秒计费的，30 秒就是 600 点。"""
    long_script = "这是一段特别长的台词。" * 20
    make_speech("voice_001", long_script, settings.speak_max_seconds + 5)
    r = client.post("/api/speak/preview", json={"voice_id": "voice_001", "script": long_script})
    body = r.json()
    assert body["over_limit"] is True
    assert body["max_seconds"] == settings.speak_max_seconds


def test_preview_rejects_unknown_voice(client):
    r = client.post("/api/speak/preview", json={"voice_id": "voice_nope", "script": SCRIPT})
    assert r.status_code == 404
    assert r.json()["detail"]["error"]["code"] == "NOT_FOUND"


def test_preview_rejects_empty_script(client):
    r = client.post("/api/speak/preview", json={"voice_id": "voice_001", "script": ""})
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "VALIDATION_ERROR"


def test_audio_endpoint_rejects_bad_key(client):
    assert client.get("/api/speak/audio/../../etc/passwd").status_code in (404, 422)
    assert client.get("/api/speak/audio/sp_zzzz").status_code == 422


# ---------- 完整任务 ----------


async def _source_portrait_job() -> dict:
    """先造一条"生成过候选形象"的任务，好让说话任务有上游图片地址可引用。"""
    job = await jobs_mod.create_job(
        "portrait", {"voice_id": "voice_001", "prompt": "一位女性", "count": 3, "variant": 0}
    )
    await jobs_mod.run_portrait_job(job["id"], prompt="一位女性", count=3, variant=0)
    return await jobs_mod.get_job(job["id"])


async def _run_speak(*, audio_seconds: float = 6.0, script: str = SCRIPT) -> dict:
    """跑完整链路。先预置音轨，模拟「用户已经点过试听」。"""
    make_speech("voice_001", script, audio_seconds)
    source = await _source_portrait_job()
    job = await jobs_mod.create_job(
        "speak",
        {
            "voice_id": "voice_001",
            "voice_name": "Aria",
            "script": script,
            "source_job_id": source["id"],
            "source_index": 1,
            "duration": audio_seconds,
        },
    )
    await videos_mod.run_speak_job(
        job["id"],
        portrait_ref={"url": "https://example.test/face.jpg"},
        voice_id="voice_001",
        script=script,
        provider_voice_id="pv_aria",
        model=settings.speak_model,
    )
    return await jobs_mod.get_job(job["id"])


def test_speak_job_success_caches_video_locally(clean_env):
    done = run(_run_speak())

    assert done["status"] == "succeeded"
    assert done["error"] is None
    assert done["progress"] == 100
    assert done["output"]["video_url"] == f"/api/jobs/{done['id']}/video"
    assert done["output"]["audio_url"] == f"/api/jobs/{done['id']}/voice"
    assert done["output"]["duration"] == pytest.approx(6.0, abs=0.05)
    assert done["output"]["estimated_points"] == 120
    assert done["output"]["local_cached"] is True
    # 成片真的落在本地（不依赖第三方 CDN，也不会因为上游地址过期而失效）
    assert videos_mod.final_path(done["id"]).stat().st_size > 0
    # 读得出成片时长
    assert done["output"]["output_duration"] == pytest.approx(3.0, abs=0.05)


def test_speak_reuses_preview_audio_and_does_not_rebuy_tts(clean_env, fake_provider):
    """核心的钱：试听过就绝不再买一次 TTS。"""
    run(_run_speak())
    assert len(tts_calls(fake_provider)) == 0, "音轨已缓存，不该再调 TTS"


def test_speak_synthesizes_when_not_previewed(clean_env, fake_provider):
    """没试听也能直接出片，现场合成音轨。"""
    source = run(_source_portrait_job())
    job = run(
        jobs_mod.create_job(
            "speak", {"voice_id": "voice_001", "script": SCRIPT, "source_job_id": source["id"]}
        )
    )
    run(
        videos_mod.run_speak_job(
            job["id"],
            portrait_ref={"url": "https://example.test/face.jpg"},
            voice_id="voice_001",
            script=SCRIPT,
            provider_voice_id="pv_aria",
            model=settings.speak_model,
        )
    )
    assert len(tts_calls(fake_provider)) == 1
    assert (run(jobs_mod.get_job(job["id"])) or {})["status"] == "succeeded"


def test_video_endpoint_404_before_ready(clean_env):
    job = run(jobs_mod.create_job("speak", {"voice_id": "voice_001", "script": SCRIPT}))
    assert not videos_mod.final_path(job["id"]).exists()


def test_speak_failure_lands_in_terminal_state_with_code(clean_env, fake_provider):
    fake_provider["fail"] = True
    done = run(_run_speak())

    assert done["status"] == "failed"
    assert done["error"]["code"] == "PROVIDER_FAILED"
    assert done["output"] is None or not done["output"].get("video_url")


def test_cancelled_job_stops_before_spending(clean_env, fake_provider):
    """取消后后台协程不能再往下跑 —— 出片是几百点，不能白烧。"""
    make_speech("voice_001", SCRIPT, 6.0)
    source = run(_source_portrait_job())
    job = run(
        jobs_mod.create_job(
            "speak", {"voice_id": "voice_001", "script": SCRIPT, "source_job_id": source["id"]}
        )
    )
    run(jobs_mod.patch_job(job["id"], status="failed", error={"code": "CANCELED", "message": "已取消"}))

    run(
        videos_mod.run_speak_job(
            job["id"],
            portrait_ref={"url": "https://example.test/face.jpg"},
            voice_id="voice_001",
            script=SCRIPT,
            provider_voice_id="pv_aria",
            model=settings.speak_model,
        )
    )
    assert len(video_calls(fake_provider)) == 0
    assert (run(jobs_mod.get_job(job["id"])) or {})["error"]["code"] == "CANCELED"


def test_cancelled_job_is_not_revived_by_late_writes(clean_env, fake_provider):
    """取消后，后台协程残留的进度 / 结果写入不得把任务复活。

    真实时序：用户在上游轮询期间点了取消（任务 → failed/CANCELED），
    几分钟后协程跑完 `_patch(status="succeeded")` —— 没有终态保护的话
    取消状态就被悄悄覆盖，前端看着像「取消了还在排队/生成」。
    """
    make_speech("voice_001", SCRIPT, 6.0)
    source = run(_source_portrait_job())
    job = run(
        jobs_mod.create_job(
            "speak", {"voice_id": "voice_001", "script": SCRIPT, "source_job_id": source["id"]}
        )
    )
    run(jobs_mod.patch_job(job["id"], status="failed", error={"code": "CANCELED", "message": "已取消"}))

    # 模拟后台协程在取消之后陆续到达的三类写入
    run(videos_mod._patch(job["id"], progress=50, stage="让角色开口"))
    run(videos_mod._patch(job["id"], status="succeeded", progress=100, output={"video_url": "/x"}))
    run(videos_mod._patch(job["id"], status="failed", error={"code": "X", "message": "晚到的失败"}))

    final = run(jobs_mod.get_job(job["id"]))
    assert final["status"] == "failed"
    assert final["error"]["code"] == "CANCELED"
    assert final["output"] is None
    assert "progress" not in final


def test_cancel_during_upstream_poll_stops_waiting(clean_env, fake_provider, monkeypatch):
    """取消要真的取消：上游轮询途中点取消 → 立刻停止等待，不再下载产物。

    上游请求本身停不下来（API 限制），但我们这边不该再傻等几分钟、
    更不该把一个用户已经不要的视频下载回来。
    """
    from app import thankyou

    make_speech("voice_001", SCRIPT, 6.0)
    source = run(_source_portrait_job())
    job = run(
        jobs_mod.create_job(
            "speak", {"voice_id": "voice_001", "script": SCRIPT, "source_job_id": source["id"]}
        )
    )

    polls = {"n": 0}

    async def fake_generate(model, payload, wait_seconds=None):
        fake_provider["calls"].append({"model": model, "payload": payload})
        return {"id": "gen_v", "status": "running", "progress": 0.0, "output": []}

    async def fake_get_generation(gid):
        polls["n"] += 1
        # 第一次轮询时模拟用户点了取消
        await jobs_mod.patch_job(job["id"], status="failed", error={"code": "CANCELED", "message": "已取消"})
        return {"id": gid, "status": "running", "progress": 0.1, "output": []}

    monkeypatch.setattr(thankyou.client, "generate", fake_generate)
    monkeypatch.setattr(thankyou.client, "get_generation", fake_get_generation)
    monkeypatch.setattr(settings, "poll_interval", 0.01)

    run(
        videos_mod.run_speak_job(
            job["id"],
            portrait_ref={"url": "https://example.test/face.jpg"},
            voice_id="voice_001",
            script=SCRIPT,
            provider_voice_id="pv_aria",
            model=settings.speak_model,
        )
    )

    # 只轮询了一次就被叫停；产物没下载；任务保持在 CANCELED
    assert polls["n"] == 1
    assert not videos_mod.final_path(job["id"]).exists()
    final = run(jobs_mod.get_job(job["id"]))
    assert final["status"] == "failed"
    assert final["error"]["code"] == "CANCELED"


# ---------- 进度与阶段 ----------


def test_progress_and_stage_are_passed_through(clean_env, fake_provider, monkeypatch):
    """视频要跑几分钟，光有百分比用户不知道卡在哪一步 —— 阶段名必须真实透传。"""
    from app import thankyou

    seen: list[str | None] = []
    state = {"phase": 0}
    holder = {"job_id": ""}

    async def fake_generate(model, payload, wait_seconds=None):
        fake_provider["calls"].append({"model": model, "payload": payload})
        return {"id": "gen_v", "status": "queued", "output": [], "error": None}

    async def fake_get_generation(generation_id):
        state["phase"] += 1
        job = await jobs_mod.get_job(holder["job_id"])
        seen.append(job["stage"] if job else None)
        if state["phase"] < 3:
            return {
                "id": generation_id,
                "status": "running",
                "progress": state["phase"] / 3,
                "output": [],
            }
        return {
            "id": generation_id,
            "status": "succeeded",
            "progress": 1.0,
            "output": [{"url": "https://example.test/out.mp4", "mime_type": "video/mp4"}],
        }

    monkeypatch.setattr(thankyou.client, "generate", fake_generate)
    monkeypatch.setattr(thankyou.client, "get_generation", fake_get_generation)
    monkeypatch.setattr(settings, "poll_interval", 0.0)

    make_speech("voice_001", SCRIPT, 4.0)
    source = run(_source_portrait_job())
    job = run(
        jobs_mod.create_job(
            "speak", {"voice_id": "voice_001", "script": SCRIPT, "source_job_id": source["id"]}
        )
    )
    holder["job_id"] = job["id"]

    run(
        videos_mod.run_speak_job(
            job["id"],
            portrait_ref={"url": "https://example.test/face.jpg"},
            voice_id="voice_001",
            script=SCRIPT,
            provider_voice_id="pv_aria",
            model=settings.speak_model,
        )
    )

    assert seen and all(s == "让角色开口" for s in seen), f"轮询期间阶段名不对：{seen}"
    done = run(jobs_mod.get_job(job["id"]))
    assert done["status"] == "succeeded"
    assert done["stage"] is None  # 终态不留阶段名
    assert done["progress"] == 100


def test_progress_stays_within_bounds(clean_env, monkeypatch):
    """进度只能单调往前走，且不能越界（前端进度条直接吃这个字段）。"""
    marks: list[float] = []
    original = videos_mod._patch

    async def spy(job_id, **fields):
        if "progress" in fields:
            marks.append(fields["progress"])
        return await original(job_id, **fields)

    monkeypatch.setattr(videos_mod, "_patch", spy)
    run(_run_speak())

    assert marks, "一次进度都没上报"
    assert all(0 <= m <= 100 for m in marks), marks
    assert marks == sorted(marks), f"进度倒退了：{marks}"
    assert marks[-1] == 100


# ---------- 形象图引用 ----------


def test_portrait_ref_prefers_upstream_url_of_source_job(clean_env, fake_provider):
    """能从来源任务取到上游地址时，不该再去传一次图。"""
    from app.portrait_ref import resolve_portrait_ref

    source = run(_source_portrait_job())
    before = len(fake_provider["uploads"])
    resolved = run(resolve_portrait_ref(source_job_id=source["id"], source_index=1))

    assert "url" in resolved
    assert resolved["url"].startswith("https://example.test/")
    assert len(fake_provider["uploads"]) == before, "有上游地址就不该再传一次"


def test_portrait_ref_falls_back_to_local_file(clean_env, fake_provider):
    """上游地址过期、只剩本地缓存时，要能把本地那张传上去。"""
    from app import portraits as portraits_mod
    from app.portrait_ref import resolve_portrait_ref

    job = run(jobs_mod.create_job("portrait", {"voice_id": "voice_001", "count": 1}))
    # 只留本地图，provider_urls 故意清空
    run(jobs_mod.patch_job(job["id"], output={"image_urls": [None], "provider_urls": [None]}))
    # 缓存文件按 .jpg 命名，但内容是 PNG —— 与真实产物一致
    portraits_mod.image_path(job["id"], 0).write_bytes(b"\x89PNG\r\n\x1a\n" + b"p" * 100)

    before = len(fake_provider["uploads"])
    resolved = run(resolve_portrait_ref(source_job_id=job["id"], source_index=0))
    assert "url" in resolved, "引用要用公网地址，不是 file_id"
    assert resolved["url"].startswith("https://example.test/")
    assert len(fake_provider["uploads"]) == before + 1

    declared = fake_provider["uploads"][-1]["content_type"]
    assert declared == "image/png", f"要按内容声明类型，不能写死 image/jpeg（实际声明了 {declared}）"
    assert fake_provider["uploads"][-1]["filename"].endswith(".png"), "文件名后缀也要跟内容一致"


def test_portrait_ref_missing_everything_raises(clean_env):
    from app.portrait_ref import resolve_portrait_ref
    from app.thankyou import ThankYouError

    with pytest.raises(ThankYouError) as exc:
        run(resolve_portrait_ref())
    assert exc.value.code == "VALIDATION_ERROR"


# ---------- 重试 ----------


def test_retry_only_reruns_video_and_keeps_audio(clean_env, fake_provider):
    """出片最容易挂。重试要复用音轨，只把出片那一段重跑。"""
    done = run(_run_speak())
    tts_before = len(tts_calls(fake_provider))
    videos_before = len(video_calls(fake_provider))

    run(
        videos_mod.run_speak_video_job(
            done["id"],
            portrait_ref={"url": "https://example.test/face.jpg"},
            script=SCRIPT,
            model=settings.speak_model,
        )
    )

    assert len(tts_calls(fake_provider)) == tts_before, "重试不该重新买音轨"
    assert len(video_calls(fake_provider)) == videos_before + 1
    again = run(jobs_mod.get_job(done["id"]))
    assert again["status"] == "succeeded"
    assert again["output"]["video_url"] == f"/api/jobs/{done['id']}/video"
    # 音轨还在，还能单独听
    assert videos_mod.voice_path(done["id"]).stat().st_size > 0


def test_can_retry_video_depends_on_local_audio(clean_env):
    job = run(jobs_mod.create_job("speak", {"voice_id": "voice_001", "script": SCRIPT}))
    assert videos_mod.can_retry_video(job["id"]) is False
    videos_mod.voice_path(job["id"]).parent.mkdir(parents=True, exist_ok=True)
    videos_mod.voice_path(job["id"]).write_bytes(make_mp3_bytes(2.0))
    assert videos_mod.can_retry_video(job["id"]) is True


def test_retry_endpoint_409_when_audio_gone(clean_env, client):
    job = run(jobs_mod.create_job("speak", {"voice_id": "voice_001", "script": SCRIPT}))
    r = client.post(f"/api/jobs/{job['id']}/retry")
    assert r.status_code == 409
    assert r.json()["detail"]["error"]["code"] == "RETRY_NOT_AVAILABLE"


def test_retry_endpoint_for_speak_reuses_saved_reference(clean_env, client):
    """重试不能要求前端再给一次形象图 —— input 里得记着出处。"""
    source = run(_source_portrait_job())
    job = run(
        jobs_mod.create_job(
            "speak",
            {
                "voice_id": "voice_001",
                "script": SCRIPT,
                "source_job_id": source["id"],
                "source_index": 2,
                "model": settings.speak_model,
            },
        )
    )
    videos_mod.voice_path(job["id"]).parent.mkdir(parents=True, exist_ok=True)
    videos_mod.voice_path(job["id"]).write_bytes(make_mp3_bytes(3.0))

    r = client.post(f"/api/jobs/{job['id']}/retry")
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "running"
    assert r.json()["stage"] == "让角色开口"


# ---------- 提交接口 ----------


def test_create_speak_job_rejects_too_long_script(client, clean_env):
    """超上限要在提交前拦下来，不能等扣完费才发现。"""
    long_script = "这是一段特别长的台词。" * 20
    make_speech("voice_001", long_script, settings.speak_max_seconds + 3)

    r = client.post("/api/speak", json={"voice_id": "voice_001", "script": long_script})
    assert r.status_code == 422
    assert r.json()["detail"]["error"]["code"] == "SCRIPT_TOO_LONG"


def test_create_speak_job_needs_a_portrait(client, clean_env):
    r = client.post("/api/speak", json={"voice_id": "voice_001", "script": SCRIPT})
    assert r.status_code == 422
    assert r.json()["detail"]["error"]["code"] == "VALIDATION_ERROR"


def test_create_speak_job_records_estimate_and_ref(client, clean_env):
    source = run(_source_portrait_job())
    make_speech("voice_001", SCRIPT, 5.0)

    r = client.post(
        "/api/speak",
        json={
            "voice_id": "voice_001",
            "script": SCRIPT,
            "source_job_id": source["id"],
            "source_index": 1,
            "avatar_id": "avatar_001",
            "avatar_name": "Aria 形象",
            "aspect_ratio": "9:16",
        },
    )
    assert r.status_code == 202, r.text
    job = r.json()["job"]
    assert job["type"] == "speak"
    assert job["input"]["avatar_name"] == "Aria 形象"
    assert job["input"]["source_index"] == 1
    assert job["input"]["duration"] == pytest.approx(5.0, abs=0.05)
    assert job["input"]["estimated_points"] == 100
    assert r.json()["estimated_points"] == 100


def test_quote_endpoint(client, clean_env):
    r = client.get("/api/speak/quote", params={"seconds": 8})
    assert r.status_code == 200
    assert r.json()["estimated_points"] == 160
    assert r.json()["points_per_second"] == settings.video_points_per_second


def test_speak_endpoint_is_registered(client, clean_env):
    """删掉 remix/uploads 之后，老端点必须真的消失，而不是留着半死不活。"""
    paths = client.get("/openapi.json").json()["paths"]
    assert "/api/speak" in paths
    assert "/api/speak/preview" in paths
    assert "/api/remix" not in paths
    assert "/api/uploads/video" not in paths


def test_retry_rejects_canceled_job(clean_env, client):
    """取消是用户的明确意图：取消的任务不接受重试（409 CANCELED_NOT_RETRYABLE）。

    不走「提交→取消」的 HTTP 时序——假上游秒完成，任务会在取消前就 succeeded。
    直接把任务置成取消终态，再打 retry 接口。
    """
    import asyncio
    from app import jobs as jobs_mod

    async def go():
        job = await jobs_mod.create_job("portrait", {"voice_id": "voice_001", "prompt": "x", "count": 1})
        await jobs_mod.patch_job(job["id"], status="failed", error={"code": "CANCELED", "message": "已取消生成，积分未扣除"})
        return job["id"]

    loop = asyncio.new_event_loop()
    try:
        job_id = loop.run_until_complete(go())
    finally:
        loop.close()

    resp = client.post(f"/api/jobs/{job_id}/retry", json={})

def test_retry_rejects_canceled_job(clean_env, client):
    """取消是用户的明确意图：取消的任务不接受重试（409 CANCELED_NOT_RETRYABLE）。

    不走「提交→取消」的 HTTP 时序——假上游秒完成，任务会在取消前就 succeeded。
    直接把任务置成取消终态，再打 retry 接口。
    """
    import asyncio
    from app import jobs as jobs_mod

    async def go():
        job = await jobs_mod.create_job("portrait", {"voice_id": "voice_001", "prompt": "x", "count": 1})
        await jobs_mod.patch_job(job["id"], status="failed", error={"code": "CANCELED", "message": "已取消生成，积分未扣除"})
        return job["id"]

    loop = asyncio.new_event_loop()
    try:
        job_id = loop.run_until_complete(go())
    finally:
        loop.close()

    resp = client.post(f"/api/jobs/{job_id}/retry", json={})
    assert resp.status_code == 409
    # HTTPException 会把 {"error": ...} 包在 detail 里
    assert resp.json()["detail"]["error"]["code"] == "CANCELED_NOT_RETRYABLE"
    final = client.get(f"/api/jobs/{job_id}").json()
    assert final["status"] == "failed"
    assert final["error"]["code"] == "CANCELED"
