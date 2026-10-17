"""试听音源的生成逻辑测试：候选降级、缓存复用、全部失败。

不调用真实 AI 服务（上游已在 conftest 中替换为假实现）。
"""

from __future__ import annotations

import asyncio

import pytest

from app.samples import (
    ensure_sample,
    generate_all,
    read_bindings,
    sample_path,
    sample_ready,
    sample_text_for,
)
from app.thankyou import ThankYouError


def run(coro):
    return asyncio.run(coro)


def test_sample_text_matches_language():
    assert sample_text_for("zh", "Mei").startswith("你好，我是Mei")
    assert "sample of my voice" in sample_text_for("en", "Aria")
    assert sample_text_for("ja", "Yui").startswith("こんにちは")
    # 未知语言回退到英文模板，而不是抛错
    assert sample_text_for("xx", "Zed").startswith("Hi, I'm Zed")


def test_generates_and_caches(clean_env, fake_provider):
    path = run(
        ensure_sample("voice_001", text="hello", provider_voice_id="good_a", fallbacks=("good_b",))
    )
    assert path.exists() and path.stat().st_size > 0
    assert sample_ready("voice_001")
    assert len(fake_provider["calls"]) == 1
    assert fake_provider["calls"][0]["payload"]["voice_id"] == "good_a"
    assert fake_provider["calls"][0]["model"] == "fish-audio/text-to-speech"

    # 第二次直接读缓存，不再打上游
    run(ensure_sample("voice_001", text="hello", provider_voice_id="good_a"))
    assert len(fake_provider["calls"]) == 1

    # 记录实际生效的绑定
    assert read_bindings()["voice_001"]["provider_voice_id"] == "good_a"


def test_falls_back_to_next_candidate(clean_env, fake_provider):
    run(
        ensure_sample(
            "voice_001", text="hello", provider_voice_id="bad_primary", fallbacks=("good_backup",)
        )
    )
    tried = [c["payload"]["voice_id"] for c in fake_provider["calls"]]
    assert tried == ["bad_primary", "good_backup"], "主音色失败后应自动降级"
    assert read_bindings()["voice_001"]["provider_voice_id"] == "good_backup"


def test_all_candidates_fail_raises(clean_env, fake_provider):
    with pytest.raises(ThankYouError) as exc:
        run(
            ensure_sample(
                "voice_001", text="hi", provider_voice_id="bad_a", fallbacks=("bad_b", "bad_c")
            )
        )
    assert exc.value.code == "SAMPLE_GENERATION_FAILED"
    assert not sample_path("voice_001").exists()


def test_force_regenerates(clean_env, fake_provider):
    run(ensure_sample("voice_001", text="one", provider_voice_id="good_a"))
    run(ensure_sample("voice_001", text="two", provider_voice_id="good_a", force=True))
    assert len(fake_provider["calls"]) == 2
    assert fake_provider["calls"][1]["payload"]["text"] == "two"


def test_generate_all_skips_existing_and_reports_failures(clean_env, fake_provider, monkeypatch):
    """批量生成：已存在的跳过、成功的记录、失败的汇总上报（不中断整批）。"""
    import dataclasses

    import app.seeds as seeds

    # 让 voice_003 的所有候选都不可用，验证失败被收集而不是中断整批
    patched = []
    for v in list(seeds.SEED_VOICES)[:4]:
        if v.id == "voice_003":
            v = dataclasses.replace(v, provider_voice_id="bad", fallbacks=("bad2",))
        patched.append(v)
    monkeypatch.setattr(seeds, "SEED_VOICES", tuple(patched))

    # 预先造好第一条，应该被跳过
    run(ensure_sample("voice_001", text="pre", provider_voice_id="good_a"))
    before = len(fake_provider["calls"])

    result = run(generate_all())
    assert "voice_001" in result["skipped"]
    assert "voice_003" in [vid for vid, _ in result["failed"]]
    assert set(result["generated"]) == {"voice_002", "voice_004"}
    assert len(fake_provider["calls"]) > before
