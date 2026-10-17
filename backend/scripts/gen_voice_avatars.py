"""为声音库补齐头像：没有头像的声音逐个走 POST /api/portraits 生成 1 张候选图，
成功后把 `/api/jobs/{id}/image/0` 绑定进 store 的 voice_avatars 集合。

用法（backend venv）:
    python scripts/gen_voice_avatars.py [--dry-run] [--only voice_001,voice_002]

- 提示词按每个声音的人设（性别/风格标签/语言）手工定制，服务端会自动追加
  「半身像/影棚光线/写实摄影」的定妆照风格后缀（app.portraits.STYLE_SUFFIX）。
- 严禁否定式元指令（no_output 照样扣点）。
- 成本：nano-banana 6 点/张，20 个声音 ≈ 120 点；失败的任务不扣点。
- 幂等：已有 avatar_url 的声音直接跳过。
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.store import store  # noqa: E402

API = "http://localhost:8000"

# 每个声音的形象设定：只描述「要什么」，风格后缀由服务端管线追加
PERSONA_PROMPTS: dict[str, str] = {
    "voice_001": "一位温暖知性的年轻女性，书卷气，柔和的微笑，米色针织衫，讲故事的人",
    "voice_002": "一位三十多岁的成熟男性，轮廓分明，沉稳的目光，深色休闲西装，纪录片解说员气质",
    "voice_003": "一位活泼明亮的年轻女性，灿烂的笑容，时尚明快的穿搭，广告女星气质",
    "voice_004": "一位二十岁出头的阳光男性，精神利落的短发，连帽卫衣，电竞主播气质",
    "voice_019": "一位宁静温和的女性，素雅棉麻衣着，平缓温柔的神情，冥想引导师气质",
    "voice_020": "一位亲和有趣的男性，俏皮的表情，休闲T恤，配音演员气质",
    "voice_005": "一位温柔亲切的年轻中国女性，仪表干净，浅色衬衫，智能助手气质",
    "voice_006": "一位沉稳大方的中国男性，正装衬衫，新闻主播气质",
    "voice_007": "一位可爱明朗的年轻日本女性，元气笑容，时尚休闲装，声优气质",
    "voice_008": "一位沉静斯文的日本男性，清爽衬衫，温和的眼神，旁白解说气质",
    "voice_009": "一位热情亲和的西班牙女性，自信的微笑，明媚穿搭，广告模特气质",
    "voice_010": "一位粗犷有型的西班牙男性，络腮胡，皮夹克，游戏角色配音演员气质",
    "voice_011": "一位优雅精致的法国女性，得体的妆容，丝质衬衫，有声书朗读者气质",
    "voice_012": "一位温和儒雅的法国男性，休闲西装，播客主持人气质",
    "voice_013": "一位清爽干练的德国女性，简洁白衬衫，知性亲和，讲师气质",
    "voice_014": "一位友好随和的德国男性，浅色休闲装，可靠温和，智能助手气质",
    "voice_015": "一位清新自然的年轻韩国女性，元气淡妆，日常时尚穿搭，Vlog 博主气质",
    "voice_016": "一位气场十足的韩国女性，干练短发，时尚西装，广告预告片配音员气质",
    "voice_017": "一位活力四射的巴西女性，热情的笑容，明亮色彩的穿搭，电商主播气质",
    "voice_018": "一位温暖厚重的巴西男性，亲和的笑容，休闲衬衫，讲故事的人",
}


def http_json(method: str, path: str, body: dict | None = None, timeout: int = 30) -> dict:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        f"{API}{path}",
        data=data,
        method=method,
        headers={"Content-Type": "application/json"} if data else {},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


async def bind(voice_id: str, job_id: str) -> None:
    await store.init()
    doc = {"id": voice_id, "job_id": job_id, "url": f"/api/jobs/{job_id}/image/0"}
    # 头像与任务解耦：图片先拷进声音自己的媒体目录，删任务不影响头像
    from app.creation_media import snapshot_voice_avatar

    await store.upsert("voice_avatars", "id", voice_id, snapshot_voice_avatar(doc))


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true", help="只打印将要生成的提示词，不花钱")
    parser.add_argument("--only", default="", help="逗号分隔的 voice_id 列表，只处理这些")
    args = parser.parse_args()

    lib = http_json("GET", "/api/voices")["voices"]
    targets = [v for v in lib if not v.get("avatar_url")]
    if args.only:
        allow = {x.strip() for x in args.only.split(",") if x.strip()}
        targets = [v for v in targets if v["id"] in allow]

    missing_prompt = [v["id"] for v in targets if v["id"] not in PERSONA_PROMPTS]
    if missing_prompt:
        print(f"!! 这些声音没有定制提示词，跳过: {missing_prompt}")
        targets = [v for v in targets if v["id"] in PERSONA_PROMPTS]

    print(f"待生成 {len(targets)} 个头像，预计消耗 {len(targets) * 6} 点")
    ok, fail = 0, 0
    for i, v in enumerate(targets, 1):
        vid = v["id"]
        prompt = PERSONA_PROMPTS[vid]
        print(f"[{i}/{len(targets)}] {vid} {v['name']}: {prompt}")
        if args.dry_run:
            continue
        try:
            resp = http_json("POST", "/api/portraits", {"voice_id": vid, "prompt": prompt, "count": 1})
        except Exception as exc:  # noqa: BLE001
            print(f"    提交失败: {exc}")
            fail += 1
            continue
        job_id = resp["job"]["id"]
        deadline = time.time() + 300
        status = "queued"
        while time.time() < deadline:
            await asyncio.sleep(5)
            job = http_json("GET", f"/api/jobs/{job_id}")
            status = job["status"]
            if status in ("succeeded", "failed", "cancelled"):
                break
        if status == "succeeded":
            await bind(vid, job_id)
            ok += 1
            print(f"    OK  {job_id}  (已绑定 avatar_url)")
        else:
            fail += 1
            print(f"    FAIL  {job_id}  status={status}")

    print(f"\n完成: 成功 {ok} / 失败 {fail}")


if __name__ == "__main__":
    asyncio.run(main())
