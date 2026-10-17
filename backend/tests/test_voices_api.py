"""声音库与语音合成接口测试（含输入验证）。不调用真实 AI 服务。"""

from __future__ import annotations

from conftest import make_sample

from app.seeds import SEED_VOICES


def test_health_reports_state(client):
    d = client.get("/api/health").json()
    assert d["status"] == "ok"
    assert d["store_backend"] == "json"  # 测试里强制 JSON 存储
    assert d["voices_total"] == len(SEED_VOICES) == 20
    assert d["samples_ready"] == 0


def test_list_voices_has_real_binding_and_sample_url(client):
    r = client.get("/api/voices")
    assert r.status_code == 200
    d = r.json()
    assert d["total"] == 20

    aria = next(v for v in d["voices"] if v["id"] == "voice_001")
    assert aria["name"] == "Aria"
    assert aria["language"] == "en"
    assert aria["provider_voice_id"], "每个声音都要绑定真实音色，否则无法生成音源"
    assert aria["provider"] == "fish-audio"
    assert aria["sample_url"].endswith("/api/voices/voice_001/sample")
    assert aria["sample_ready"] is False

    # 20 个声音都应该有真实音色绑定，且样本地址各不相同
    assert all(v["provider_voice_id"] for v in d["voices"])
    assert len({v["sample_url"] for v in d["voices"]}) == 20


def test_voices_have_eight_languages(client):
    d = client.get("/api/voices").json()
    langs = {v["language"] for v in d["voices"]}
    assert langs == {"en", "zh", "ja", "es", "fr", "de", "ko", "pt"}


def test_language_and_tag_filters(client):
    d = client.get("/api/voices", params={"language": "zh"}).json()
    assert {v["language"] for v in d["voices"]} == {"zh"}
    assert d["total"] == 2

    d2 = client.get("/api/voices", params={"tag": "narration"}).json()
    assert all("narration" in v["tags"] for v in d2["voices"])
    assert d2["total"] >= 1


def test_search_filter(client):
    d = client.get("/api/voices", params={"q": "mei"}).json()
    assert [v["id"] for v in d["voices"]] == ["voice_005"]

    # 描述也能命中
    d2 = client.get("/api/voices", params={"q": "meditation"}).json()
    assert any(v["id"] == "voice_019" for v in d2["voices"])


def test_voice_detail_and_404(client):
    ok = client.get("/api/voices/voice_002")
    assert ok.status_code == 200 and ok.json()["name"] == "Max"

    missing = client.get("/api/voices/voice_999")
    assert missing.status_code == 404
    assert missing.json()["detail"]["error"]["code"] == "NOT_FOUND"


def test_sample_202_when_generating(client):
    """音源未就绪 → 202 并提示稍后重试，而不是 404 或空响应。"""
    r = client.get("/api/voices/voice_001/sample")
    assert r.status_code == 202
    body = r.json()
    assert body["status"] == "generating"
    assert body["retry_after"] == 5
    assert r.headers["retry-after"] == "5"


def test_sample_200_returns_audio_when_ready(client):
    make_sample("voice_001")
    r = client.get("/api/voices/voice_001/sample")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("audio/mpeg")
    assert len(r.content) > 0
    assert r.headers.get("cache-control")


def test_sample_404_for_unknown_voice(client):
    r = client.get("/api/voices/voice_999/sample")
    assert r.status_code == 404
    assert r.json()["detail"]["error"]["code"] == "NOT_FOUND"


def test_preview_rejects_empty_text(client):
    """输入验证：空文案必须被拒。"""
    r = client.post("/api/voices/voice_001/preview", json={"text": ""})
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "VALIDATION_ERROR"


def test_preview_rejects_missing_field(client):
    r = client.post("/api/voices/voice_001/preview", json={})
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "VALIDATION_ERROR"


def test_preview_rejects_too_long_text(client):
    r = client.post("/api/voices/voice_001/preview", json={"text": "x" * 2001})
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "VALIDATION_ERROR"


def test_preview_404_for_unknown_voice(client):
    r = client.post("/api/voices/voice_999/preview", json={"text": "hi"})
    assert r.status_code == 404


def test_preview_accepts_and_queues_job(client):
    r = client.post("/api/voices/voice_005/preview", json={"text": "你好，这是一段测试。"})
    assert r.status_code == 202
    job = r.json()["job"]
    assert job["type"] == "tts"
    assert job["status"] == "queued"
    assert job["input"]["voice_id"] == "voice_005"
    assert job["input"]["text"] == "你好，这是一段测试。"
    assert r.json()["poll_url"] == f"/api/jobs/{job['id']}"

    # 任务确实进了任务中心
    listed = client.get("/api/jobs", params={"type": "tts"}).json()["jobs"]
    assert any(j["id"] == job["id"] for j in listed)


def test_import_voice_from_catalog(client):
    r = client.post(
        "/api/voices/import",
        json={"provider_voice_id": "cat_1", "name": "Demo One", "language": "en"},
    )
    assert r.status_code == 201
    imported = r.json()
    assert imported["source"] == "catalog"
    assert imported["provider_voice_id"] == "cat_1"
    assert imported["id"].startswith("imp_")

    d = client.get("/api/voices").json()
    assert d["total"] == 21
    assert any(v["id"] == imported["id"] for v in d["voices"])


def test_import_is_idempotent(client):
    payload = {"provider_voice_id": "cat_3", "name": "Demo Three", "language": "en"}
    first = client.post("/api/voices/import", json=payload).json()
    second = client.post("/api/voices/import", json=payload).json()
    assert first["id"] == second["id"]
    assert client.get("/api/voices").json()["total"] == 21


def test_import_requires_provider_voice_id(client):
    r = client.post("/api/voices/import", json={"name": "x"})
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "VALIDATION_ERROR"


def test_catalog_proxy_pagination_and_language_filter(client):
    d = client.get("/api/catalog/voices", params={"page": 1, "page_size": 2}).json()
    assert d["total"] == 3
    assert len(d["voices"]) == 2
    assert d["languages"] == {"en": 2, "zh": 1}
    assert d["voices"][0]["provider_voice_id"] == "cat_1"
    assert d["voices"][0]["has_preview"] is True

    zh = client.get("/api/catalog/voices", params={"language": "zh"}).json()
    assert zh["total"] == 1
    assert zh["voices"][0]["name"] == "示例二号"

    q = client.get("/api/catalog/voices", params={"q": "demo"}).json()
    assert q["total"] == 2

    more = client.get("/api/catalog/voices", params={"page": 2, "page_size": 2}).json()
    assert len(more["voices"]) == 1


def test_job_audio_404_when_missing(client):
    r = client.get("/api/jobs/job_nope/audio")
    assert r.status_code == 404
    assert r.json()["detail"]["error"]["code"] == "NOT_FOUND"
