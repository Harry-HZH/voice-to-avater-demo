"""候选形象（真实文生图）测试。

不调用真实 AI 服务：上游在 conftest 里被整体替换成假实现。
重点验证：
  - 任务生命周期与产物落盘；
  - 进度是「每张完成推进一次」，不是假动画；
  - **重试只补失败的那几张**（已经生成成功的不会重复花钱）；
  - 「换一批」会清掉缓存重新出图；
  - 取消后不再收尾；
  - 三视图用参考图生成，缺参考图时给出明确错误码。
"""

from __future__ import annotations

import asyncio

from app import jobs as jobs_mod
from app import portraits as portraits_mod


def run(coro):
    return asyncio.run(coro)


async def _make_candidates(prompt: str = "一位温和的女性", count: int = 3, variant: int = 0) -> dict:
    job = await jobs_mod.create_job(
        "portrait",
        {"voice_id": "voice_001", "prompt": prompt, "count": count, "variant": variant},
    )
    await jobs_mod.run_portrait_job(job["id"], prompt=prompt, count=count, variant=variant)
    return await jobs_mod.get_job(job["id"])


def test_portrait_job_success_keeps_images_locally(clean_env):
    done = run(_make_candidates())

    assert done["status"] == "succeeded"
    assert done["error"] is None
    assert done["progress"] == 100

    urls = done["output"]["image_urls"]
    assert urls == [f"/api/jobs/{done['id']}/image/{i}" for i in range(3)]
    assert all(portraits_mod.image_ready(done["id"], i) for i in range(3)), "产物要落盘才能被 /image 取回"
    assert all(u and u.startswith("https://") for u in done["output"]["provider_urls"])
    # 每张候选的提示词都不一样，否则「选一张」没意义
    assert done["output"]["estimated_points"] == 6.0 * 3


def test_each_candidate_prompt_differs(clean_env, fake_provider):
    run(_make_candidates())
    prompts = [c["payload"]["prompt"] for c in fake_provider["calls"] if c["payload"].get("prompt")]
    assert len(set(prompts)) == 3
    # 定妆照要求必须带上，保证结果能直接当形象用
    assert all("半身像" in p for p in prompts)


def test_variant_changes_seed(clean_env, fake_provider):
    """同一任务里 3 张候选种子各不相同；换一批后种子整体换掉。"""
    done = run(_make_candidates(variant=0))
    first = [c["payload"]["seed"] for c in fake_provider["calls"]]
    assert len(set(first)) == 3

    fake_provider["calls"].clear()

    async def go():
        await jobs_mod.restart_portrait_job(done["id"], variant=1)
        job = await jobs_mod.get_job(done["id"])
        await jobs_mod.run_portrait_job(
            done["id"], prompt=job["input"]["prompt"], count=3, variant=job["input"]["variant"]
        )

    run(go())
    second = [c["payload"]["seed"] for c in fake_provider["calls"]]
    assert len(second) == 3
    assert not (set(first) & set(second)), "「换一批」必须换随机种子，否则出图一样"


def test_partial_failure_marks_job_failed_but_keeps_succeeded_images(clean_env, fake_provider):
    fake_provider["fail_prompts"] = {"更近的景别"}
    done = run(_make_candidates())

    assert done["status"] == "failed"
    assert done["error"]["code"] == "VALIDATION_ERROR"
    assert "1/3" in done["error"]["message"]
    # 成功的两张照样落盘，重试时才不用重买
    assert portraits_mod.image_ready(done["id"], 0)
    assert not portraits_mod.image_ready(done["id"], 2)


def test_retry_reuses_succeeded_images(clean_env, fake_provider):
    fake_provider["fail_prompts"] = {"更近的景别"}
    done = run(_make_candidates())
    assert done["status"] == "failed"

    fake_provider["calls"].clear()
    fake_provider["fail_prompts"] = set()

    async def go():
        await jobs_mod.restart_portrait_job(done["id"])
        job = await jobs_mod.get_job(done["id"])
        await jobs_mod.run_portrait_job(
            done["id"], prompt=job["input"]["prompt"], count=3, variant=job["input"]["variant"]
        )
        return await jobs_mod.get_job(done["id"])

    retried = run(go())
    assert retried["status"] == "succeeded"
    assert len(fake_provider["calls"]) == 1, "只有失败的那张需要重新调用上游"


def test_change_variant_clears_cache(clean_env, fake_provider):
    done = run(_make_candidates())
    assert all(portraits_mod.image_ready(done["id"], i) for i in range(3))

    fake_provider["calls"].clear()

    async def go():
        await jobs_mod.restart_portrait_job(done["id"], variant=1)
        job = await jobs_mod.get_job(done["id"])
        await jobs_mod.run_portrait_job(
            done["id"], prompt=job["input"]["prompt"], count=3, variant=job["input"]["variant"]
        )
        return await jobs_mod.get_job(done["id"])

    assert run(go())["status"] == "succeeded"
    assert len(fake_provider["calls"]) == 3, "「换一批」要整批重出"


def test_cancel_stops_job_from_finishing(clean_env, fake_provider):
    async def go():
        job = await jobs_mod.create_job("portrait", {"voice_id": "voice_001", "prompt": "x", "count": 3})
        # 先标记成终态，模拟用户点了取消
        await jobs_mod.patch_job(job["id"], status="failed", error={"code": "CANCELED", "message": "已取消"})
        await jobs_mod.run_portrait_job(job["id"], prompt="x", count=3)
        return await jobs_mod.get_job(job["id"])

    after = run(go())
    assert after["status"] == "failed"
    assert after["error"]["code"] == "CANCELED"
    assert after["output"] is None, "取消后不应该再写入产物"


def test_views_job_uses_candidate_as_reference(clean_env, fake_provider):
    source = run(_make_candidates())
    reference = source["output"]["provider_urls"][0]

    async def go():
        job = await jobs_mod.create_job(
            "portrait", {"kind": "views", "source_job_id": source["id"], "views": ["side", "back"]}
        )
        await jobs_mod.run_views_job(job["id"], reference_url=reference, views=["side", "back"], index=0)
        return await jobs_mod.get_job(job["id"])

    done = run(go())
    assert done["status"] == "succeeded"
    assert done["output"]["view_urls"].keys() == {"side", "back"}
    assert all(portraits_mod.image_ready(done["id"], i) for i in (0, 1))
    # 补图必须是 image-to-image：带上了参考图
    refs = [c["payload"]["reference_assets"][0]["url"] for c in fake_provider["calls"] if "reference_assets" in c["payload"]]
    assert refs == [reference, reference]


def test_views_retry_reuses_finished_view(clean_env, fake_provider):
    """补图重试：已经成功的视角不重复生成，只补失败的那个。"""
    source = run(_make_candidates())
    reference = source["output"]["provider_urls"][0]

    async def make_views():
        job = await jobs_mod.create_job(
            "portrait",
            {
                "kind": "views",
                "source_job_id": source["id"],
                "source_index": 0,
                "views": ["side", "back"],
                "reference_url": reference,
            },
        )
        await jobs_mod.run_views_job(job["id"], reference_url=reference, views=["side", "back"], index=0)
        return await jobs_mod.get_job(job["id"])

    done = run(make_views())
    assert done["status"] == "succeeded"

    # 人为把背面那张删掉，再跑一次应该只重出背面
    portraits_mod.image_path(done["id"], 1).unlink()
    fake_provider["calls"].clear()

    async def retry():
        await jobs_mod.restart_portrait_job(done["id"])
        await jobs_mod.run_views_job(done["id"], reference_url=reference, views=["side", "back"], index=0)

    run(retry())

    image_calls = [c for c in fake_provider["calls"] if "reference_assets" in c["payload"]]
    assert len(image_calls) == 1, "只有缺失的那张需要重新调用上游"
    assert portraits_mod.image_ready(done["id"], 1)


def test_views_retry_endpoint_keeps_reference(client):
    """补图任务在 /retry 上也要能重跑，并且带着原来的参考图。

    注意：这里只看接口返回，不驱动后台任务 —— TestClient 的后台任务跑在它自己的
    event loop 里，测试线程再 asyncio.run 一个会去抢同一个 store 锁，容易互相卡住。
    """
    async def make_views():
        return await jobs_mod.create_job(
            "portrait",
            {
                "kind": "views",
                "source_job_id": "job_x",
                "source_index": 0,
                "views": ["side", "back"],
                "count": 2,
                "reference_url": "https://example.test/ref.jpg",
            },
        )

    views_id = run(make_views())["id"]
    retried = client.post(f"/api/jobs/{views_id}/retry")
    assert retried.status_code == 200
    body = retried.json()
    assert body["status"] == "running"
    assert body["input"]["kind"] == "views"
    assert body["input"]["reference_url"] == "https://example.test/ref.jpg"


# ---------- HTTP 层 ----------


def test_create_portrait_endpoint_validates_voice(client):
    assert client.post("/api/portraits", json={"voice_id": "voice_404", "prompt": "x"}).status_code == 404
    assert client.post("/api/portraits", json={"prompt": "x"}).status_code == 422


def test_create_portrait_endpoint_returns_job(client):
    r = client.post("/api/portraits", json={"voice_id": "voice_001", "prompt": "一位温和的女性"})
    assert r.status_code == 202
    body = r.json()
    assert body["job"]["status"] == "queued"
    assert body["job"]["input"]["voice_name"] == "Aria"
    assert body["poll_url"] == f"/api/jobs/{body['job']['id']}"
    assert body["estimated_points"] == 18.0  # 假实现里单张 6 点 × 3


def test_image_endpoint_404_before_ready(client):
    async def go():
        return await jobs_mod.create_job("portrait", {"voice_id": "voice_001", "prompt": "x"})

    pending = run(go())
    assert client.get(f"/api/jobs/{pending['id']}/image/0").status_code == 404
    assert client.get("/api/jobs/job_nope/image/0").status_code == 404


def test_image_endpoint_serves_generated_file(client, clean_env):
    job = run(_make_candidates())
    r = client.get(f"/api/jobs/{job['id']}/image/1")
    assert r.status_code == 200
    assert r.headers["content-type"] == "image/jpeg"
    assert r.content.startswith(b"\xff\xd8"), "应该回真实图片字节"


def test_cancel_endpoint_is_idempotent(client):
    job = run(_make_candidates())
    r = client.post(f"/api/jobs/{job['id']}/cancel")
    assert r.status_code == 200
    # 已经是终态（succeeded）就不再改，保持终态不可逆
    assert r.json()["status"] == "succeeded"


def test_retry_endpoint_rejects_non_portrait(client):
    async def go():
        return await jobs_mod.create_job("tts", {"voice_id": "voice_001", "text": "hi"})

    job = run(go())
    r = client.post(f"/api/jobs/{job['id']}/retry")
    assert r.status_code == 409
    assert r.json()["detail"]["error"]["code"] == "UNSUPPORTED"


def test_views_endpoint_requires_reference(client):
    job = run(_make_candidates())
    # 把 provider_urls 抹掉，模拟产物地址已不可用
    async def go():
        await jobs_mod.store.update("jobs", "id", job["id"], {"output": {"image_urls": []}})

    run(go())
    r = client.post("/api/portraits/views", json={"job_id": job["id"], "index": 0})
    assert r.status_code == 409
    assert r.json()["detail"]["error"]["code"] == "REFERENCE_MISSING"


def test_views_endpoint_accepts_explicit_reference(client):
    job = run(_make_candidates())
    r = client.post(
        "/api/portraits/views",
        json={"job_id": job["id"], "index": 1, "reference_url": "https://example.test/ref.jpg"},
    )
    assert r.status_code == 202
    assert r.json()["job"]["input"]["kind"] == "views"
    assert r.json()["job"]["input"]["source_index"] == 1


def test_views_endpoint_without_source_job(client):
    """保存过的形象后来补视图：手里只有参考图地址，没有候选任务。"""
    r = client.post(
        "/api/portraits/views",
        json={
            "index": 0,
            "views": ["side"],
            "reference_url": "https://example.test/front.jpg",
            "voice_id": "voice_001",
            "prompt": "一位温和的女性",
        },
    )
    assert r.status_code == 202
    inp = r.json()["job"]["input"]
    assert inp["kind"] == "views"
    assert inp["views"] == ["side"]  # 只要 side 就只出 side，不会顺手多花钱
    assert inp["source_job_id"] is None
    assert inp["reference_url"] == "https://example.test/front.jpg"
    assert inp["voice_id"] == "voice_001"


def test_views_endpoint_without_any_reference_is_rejected(client):
    """既没有候选任务也没有参考图 → 明确报 REFERENCE_MISSING，而不是空跑一张图。"""
    r = client.post("/api/portraits/views", json={"index": 0})
    assert r.status_code == 409
    assert r.json()["detail"]["error"]["code"] == "REFERENCE_MISSING"


def test_views_endpoint_unknown_source_job_is_404(client):
    r = client.post("/api/portraits/views", json={"job_id": "job_does_not_exist", "index": 0})
    assert r.status_code == 404
