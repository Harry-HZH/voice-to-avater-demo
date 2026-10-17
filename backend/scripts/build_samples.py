"""预生成所有种子声音的试听音源。

用法（在 backend 目录下）：
    .venv/Scripts/python scripts/build_samples.py              # 只补缺失的
    .venv/Scripts/python scripts/build_samples.py --force      # 全部重生成
    .venv/Scripts/python scripts/build_samples.py --only Mei Hao

每条约消耗 0.05 点（短文本 TTS），20 条约 1 点。生成结果缓存在 data/samples/，
之后接口直接读本地文件，不再产生费用。
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.config import settings  # noqa: E402
from app.samples import generate_all  # noqa: E402
from app.thankyou import client  # noqa: E402


async def main() -> int:
    parser = argparse.ArgumentParser(description="生成声音库试听音源")
    parser.add_argument("--force", action="store_true", help="忽略缓存，全部重新生成")
    parser.add_argument("--only", nargs="*", default=None, help="只生成指定的声音 id 或名字")
    args = parser.parse_args()

    if not settings.api_key_configured:
        print("✗ 未配置 THANK_YOU_AI_KEY（backend/.env 或 voice-to-avater-demo/.env）")
        return 2

    print(f"模型：{settings.tts_model}")
    print("开始生成试听音源…\n")
    try:
        result = await generate_all(force=args.force, only=args.only)
    finally:
        await client.aclose()

    print(f"\n新生成 {len(result['generated'])}：{', '.join(result['generated']) or '-'}")
    print(f"已存在 {len(result['skipped'])}：{', '.join(result['skipped']) or '-'}")
    if result["failed"]:
        print(f"失败 {len(result['failed'])}：")
        for vid, err in result["failed"]:
            print(f"  - {vid}: {err}")
    return 1 if result["failed"] else 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
