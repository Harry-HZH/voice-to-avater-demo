"""任务状态机测试。

覆盖 INTERVIEW.md 要求的状态流转：
    queued → running → succeeded / failed，且**结束状态不能再变**。
不调用真实 AI 服务（上游已在 conftest 中替换为假实现）。
"""

from __future__ import annotations

import asyncio

from app import jobs as jobs_mod


def run(coro):
    return asyncio.run(coro)


def test_job_starts_queued(clean_env):
    async def go():
        return await jobs_mod.create_job("tts", {"voice_id": "voice_001", "text": "hi"})

    job = run(go())
    assert job["status"] == "queued"
    assert job["error"] is None
    assert job["output"] is None
    assert job["id"].startswith("job_")


def test_tts_job_success_writes_output_and_file(clean_env):
    async def go():
        job = await jobs_mod.create_job("tts", {"voice_id": "voice_001", "text": "hello"})
        await jobs_mod.run_tts_job(job["id"], provider_voice_id="good_voice", text="hello")
        return await jobs_mod.get_job(job["id"])

    done = run(go())
    assert done["status"] == "succeeded"
    assert done["error"] is None
    assert done["output"]["audio_url"] == f"/api/jobs/{done['id']}/audio"
    assert done["output"]["provider_url"].startswith("https://")

    audio = jobs_mod.preview_audio_path(done["id"])
    assert audio.exists() and audio.stat().st_size > 0, "合成结果应落盘，才能被 /audio 取回"


def test_tts_job_failure_sets_error_and_keeps_output_empty(clean_env, fake_provider):
    fake_provider["fail"] = True

    async def go():
        job = await jobs_mod.create_job("tts", {"voice_id": "voice_001", "text": "hi"})
        await jobs_mod.run_tts_job(job["id"], provider_voice_id="good_voice", text="hi")
        return await jobs_mod.get_job(job["id"])

    done = run(go())
    assert done["status"] == "failed"
    assert done["error"]["code"] == "PROVIDER_FAILED"
    assert done["error"]["message"]
    assert done["output"] is None
    assert not jobs_mod.preview_audio_path(done["id"]).exists()


def test_status_transitions_in_order(clean_env):
    async def go():
        job = await jobs_mod.create_job("tts", {})
        seen = [job["status"]]
        for st in ("running", "succeeded"):
            updated = await jobs_mod.patch_job(job["id"], status=st)
            seen.append(updated["status"])
        return seen

    assert run(go()) == ["queued", "running", "succeeded"]


def test_terminal_state_cannot_change(clean_env):
    """结束状态不能再变，但非状态字段仍可更新。"""

    async def go():
        job = await jobs_mod.create_job("tts", {})
        await jobs_mod.patch_job(job["id"], status="running")
        await jobs_mod.patch_job(job["id"], status="failed", error={"code": "X", "message": "boom"})
        # 终态之后试图改回 running —— 必须被忽略
        await jobs_mod.patch_job(job["id"], status="running")
        after = await jobs_mod.get_job(job["id"])
        # 补充一个字段（比如写回产物）应该仍然允许
        await jobs_mod.patch_job(job["id"], output={"audio_url": "/x"})
        after2 = await jobs_mod.get_job(job["id"])
        return after, after2

    after, after2 = run(go())
    assert after["status"] == "failed", "succeeded/failed 之后不能再改状态"
    assert after2["status"] == "failed"
    assert after2["error"]["code"] == "X"
    assert after2["output"] == {"audio_url": "/x"}


def test_unknown_job_returns_none(clean_env):
    assert run(jobs_mod.get_job("job_not_exist")) is None


def test_job_list_filters(clean_env):
    async def go():
        a = await jobs_mod.create_job("tts", {})
        b = await jobs_mod.create_job("portrait", {})
        await jobs_mod.patch_job(b["id"], status="running")
        tts = await jobs_mod.list_jobs(job_type="tts")
        running = await jobs_mod.list_jobs(status="running")
        return a, b, tts, running

    a, b, tts, running = run(go())
    assert [j["id"] for j in tts] == [a["id"]]
    assert [j["id"] for j in running] == [b["id"]]
