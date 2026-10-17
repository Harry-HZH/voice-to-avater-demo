"""测试夹具。

原则（INTERVIEW.md 第 4 节）：**测试里不调用真实 AI 服务**。
这里把 ThankYou 客户端整体替换成假实现，所有测试都在内存与临时目录里跑。
"""

from __future__ import annotations

from pathlib import Path

import pytest


def make_mp3_bytes(seconds: float) -> bytes:
    """造一段**能被时长解析器读出正确秒数**的假 mp3。

    头部是真的 MPEG-1 Layer III 帧头（128 kbps / 44.1 kHz），所以
    media.mp3_duration 会按「码率恒定」算出 size*8/128000 秒 —— 128000/8 = 16000
    字节每秒。测试因此可以精确控制「台词有多长」，而不用碰真实 TTS。
    """
    header = b"\xff\xfb\x90\x00"
    size = max(len(header), int(round(seconds * 16000)))
    return header + b"\x00" * (size - len(header))


def make_mp4_bytes(seconds: float = 6.0) -> bytes:
    """造一个只含 ftyp + moov/mvhd 的最小 MP4，时长可读。"""
    timescale = 1000
    duration = int(round(seconds * timescale))
    mvhd = (
        b"\x00" + b"\x00\x00\x00"          # version 0 + flags
        + b"\x00" * 8                       # creation / modification
        + timescale.to_bytes(4, "big")      # raw[12:16]
        + duration.to_bytes(4, "big")       # raw[16:20]
        + b"\x00" * 80                      # 其余字段（体积不重要，够 100 字节即可）
    )
    mvhd_box = (len(mvhd) + 8).to_bytes(4, "big") + b"mvhd" + mvhd
    moov_box = (len(mvhd_box) + 8).to_bytes(4, "big") + b"moov" + mvhd_box
    ftyp = (24).to_bytes(4, "big") + b"ftyp" + b"mp42" + b"\x00\x00\x00\x00" + b"mp42" + b"isom"
    return ftyp + moov_box


SAMPLE_BYTES = make_mp3_bytes(3.0)
IMAGE_BYTES = b"\xff\xd8\xff\xe0" + b"fake-jpeg-payload" * 200
VIDEO_BYTES = make_mp4_bytes(3.0)


@pytest.fixture()
def fake_provider(monkeypatch):
    """把上游替换成假实现，记录调用并可控成功/失败。

    - `state["fail"] = True` → 一律失败；
    - payload 里 voice_id 以 `bad` 开头 → 失败（用来验证候选音色降级）；
    - `state["fail_prompts"]` 里出现的提示词 → 图片生成失败（用来验证部分失败与重试复用）。
    """
    from app import thankyou

    state = {"calls": [], "fail": False, "fail_prompts": set(), "uploads": []}

    # 视频类模型：会说话的形象（heygen/avatar4/avatar、infinitalk/avatar）。
    # 判定要排在 image 之前 —— 否则将来某个模型名里同时出现两个关键词就会串。
    _VIDEO_KEYS = ("avatar", "animate", "face-swap", "lip-sync", "video")

    async def _fake_run(model, payload):
        state["calls"].append({"model": model, "payload": payload})
        if state["fail"]:
            raise thankyou.ThankYouError("PROVIDER_FAILED", "模拟的上游失败")
        if str(payload.get("voice_id", "")).startswith("bad"):
            raise thankyou.ThankYouError("VOICE_UNAVAILABLE", "该音色不可用")
        prompt = str(payload.get("prompt") or "")
        if prompt and any(p in prompt for p in state["fail_prompts"]):
            raise thankyou.ThankYouError("VALIDATION_ERROR", "提示词包含不允许的内容")
        if any(k in model for k in _VIDEO_KEYS):
            return {
                "id": "gen_video",
                "status": "succeeded",
                "output": [{"url": "https://example.test/out.mp4", "mime_type": "video/mp4"}],
            }
        if "image" in model or "seedream" in model:
            return {
                "id": "gen_img",
                "status": "succeeded",
                "output": [{"url": f"https://example.test/{abs(hash(prompt)) % 10**6}.jpg", "mime_type": "image/jpeg"}],
            }
        return {
            "id": "gen_test",
            "status": "succeeded",
            "output": [{"url": "https://example.test/a.mp3", "mime_type": "audio/mpeg"}],
        }

    async def fake_run(model, payload):
        return await _fake_run(model, payload)

    async def fake_generate(model, payload, wait_seconds=None):
        """视频链路里 `videos._run` 走这个。直接给终态，测试就不必驱动轮询。"""
        gen = await _fake_run(model, payload)
        return {**gen, "progress": 1.0}

    async def fake_get_generation(generation_id: str):
        return {"id": generation_id, "status": "succeeded", "progress": 1.0, "output": []}

    async def fake_quote(model, payload):
        return {"quote_id": "quote_test", "model": model, "estimated_cost": 6.0, "currency": "points"}

    async def fake_download(url, dest: Path):
        dest = Path(dest)
        dest.parent.mkdir(parents=True, exist_ok=True)
        if str(dest).endswith(".jpg"):
            dest.write_bytes(IMAGE_BYTES)
        elif str(dest).endswith(".mp4"):
            dest.write_bytes(VIDEO_BYTES)
        else:
            dest.write_bytes(SAMPLE_BYTES)
        return dest

    async def fake_upload_file(path, *, content_type=None, filename=None, timeout=300.0):
        """上传素材到上游。假实现只记一笔，返回一个稳定的公网地址。

        真实实现是两段式（POST 预留 → PUT 字节 → HEAD 确认可抓取），
        它的细节由 tests/test_thankyou_upload.py 用 MockTransport 单独钉住；
        这里只负责给业务链路一个「上传成功」的替身。
        """
        src = Path(path)
        state["uploads"].append(
            {"path": str(src), "content_type": content_type, "filename": filename or src.name}
        )
        return {
            "file_id": f"file_{src.stem}",
            "url": f"https://example.test/{src.name}",
            "content_type": content_type or "application/octet-stream",
            "size_bytes": src.stat().st_size if src.exists() else 0,
        }

    async def fake_list_voices(page=1, page_size=50, q=None):
        return {
            "total": 3,
            "page": page,
            "page_size": page_size,
            "voices": [
                {"voice_id": "cat_1", "name": "Demo One", "languages": ["en"], "provider": "fish-audio", "preview_audio_url": "https://x/1.mp3"},
                {"voice_id": "cat_2", "name": "示例二号", "languages": ["zh"], "provider": "fish-audio", "preview_audio_url": ""},
                {"voice_id": "cat_3", "name": "Demo Three", "languages": ["en"], "provider": "fish-audio", "preview_audio_url": "https://x/3.mp3"},
            ],
        }

    monkeypatch.setattr(thankyou.client, "run", fake_run)
    monkeypatch.setattr(thankyou.client, "generate", fake_generate)
    monkeypatch.setattr(thankyou.client, "get_generation", fake_get_generation)
    monkeypatch.setattr(thankyou.client, "quote", fake_quote)
    monkeypatch.setattr(thankyou.client, "download", fake_download)
    monkeypatch.setattr(thankyou.client, "upload_file", fake_upload_file)
    monkeypatch.setattr(thankyou.client, "list_voices", fake_list_voices)
    return state


@pytest.fixture()
def clean_env(tmp_path, monkeypatch, fake_provider):
    """干净的运行环境：JSON 存储 + 临时音源/形象/音轨/成片目录，不碰真实数据。"""
    import app.jobs as jobs_mod
    import app.portraits as portraits_mod
    import app.samples as samples_mod
    import app.speech as speech_mod
    import app.store as store_mod
    import app.videos as videos_mod

    sample_dir = tmp_path / "samples"
    sample_dir.mkdir(parents=True, exist_ok=True)
    portrait_dir = tmp_path / "portraits"
    portrait_dir.mkdir(parents=True, exist_ok=True)
    speech_dir = tmp_path / "speech"
    speech_dir.mkdir(parents=True, exist_ok=True)
    video_dir = tmp_path / "videos"
    video_dir.mkdir(parents=True, exist_ok=True)

    monkeypatch.setattr(store_mod, "STORE_FILE", tmp_path / "store.json")
    monkeypatch.setattr(samples_mod, "SAMPLE_DIR", sample_dir)
    monkeypatch.setattr(samples_mod, "BINDINGS_FILE", sample_dir / "bindings.json")
    monkeypatch.setattr(jobs_mod, "SAMPLE_DIR", sample_dir)
    monkeypatch.setattr(portraits_mod, "PORTRAIT_DIR", portrait_dir)
    monkeypatch.setattr(speech_mod, "SPEECH_DIR", speech_dir)
    monkeypatch.setattr(videos_mod, "VIDEO_DIR", video_dir)

    async def no_mongo():
        return False

    monkeypatch.setattr(store_mod.store, "_try_mongo", no_mongo)
    monkeypatch.setattr(store_mod.store, "_mongo_db", None)
    monkeypatch.setattr(store_mod.store, "_mongo_client", None)
    store_mod.store._mem = {"jobs": [], "voices": []}

    # 同一进程里跑多个测试时，音轨的串行锁要清掉，否则会跨用例互等
    monkeypatch.setattr(speech_mod, "_locks", {})

    # 目录快照缓存是模块级的，测试之间要隔离
    import app.routers.catalog as catalog_router
    import app.routers.voices as voices_router

    monkeypatch.setattr(catalog_router, "_snapshot", {"at": 0.0, "voices": [], "total": 0})
    monkeypatch.setattr(voices_router, "_generating", set())

    return tmp_path


@pytest.fixture()
def client(clean_env):
    """带 lifespan 的 TestClient。"""
    from fastapi.testclient import TestClient

    from app.main import app

    with TestClient(app) as c:
        yield c


def make_sample(voice_id: str, size: int = 2048) -> Path:
    """在（被 patch 过的）音源目录里造一个假 mp3。"""
    import app.samples as samples_mod

    p = samples_mod.sample_path(voice_id)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(b"\xff\xfb\x90\x00" + b"x" * size)
    return p


def make_speech(voice_id: str, text: str, seconds: float) -> Path:
    """在音轨缓存目录里预置一份「某声音说某句话」的 mp3。

    用来模拟「用户已经点过试听」——出片时就会命中缓存、不再花 TTS 的钱。
    seconds 决定后面算出来的费用，所以测试可以精确地要一个贵或便宜的台词。
    """
    import app.speech as speech_mod

    p = speech_mod.speech_path(speech_mod.speech_key(voice_id, text))
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(make_mp3_bytes(seconds))
    return p
