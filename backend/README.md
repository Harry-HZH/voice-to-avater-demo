# Voice to Avatar 后端（FastAPI）

给前端提供**声音库 + 真实音源 + 候选形象生成 + 让角色开口说话**，AI 能力全部走 ThankYou Open API。

## 这个后端解决什么问题

前端原先的两块核心数据都是空的：

1. **音源**：20 个声音的 `sample_url` 全指向同一个占位音乐地址（不是人声），
   播放按钮只是切换布尔值 —— 「音源」全链路缺失。
2. **形象**：创建流程的 3 张候选图是水彩 SVG 占位图，进度条是本地定时器跑的假动画，
   跟 AI 没有任何关系。

现在：

- 每个声音都绑定到一个**真实的 Fish Audio 音色**，用 `fish-audio/text-to-speech`
  合成一句该语言的自我介绍缓存到本地，由 `/api/voices/{id}/sample` 提供真实人声；
- 候选形象是**真实文生图**（`google/nano-banana/text-to-image`），
  3 张并发跑、每张完成更新一次进度，产物落到本后端；选定后用**参考图 + 文字**
  生成侧面 / 背面（image-to-image），保持同一人物；
- **让角色开口说话**是真实生成：角色的形象图 + 台词音轨 → `heygen/avatar4/avatar`
  → 会说话的视频，产物落到本后端由 `/api/jobs/{id}/video` 提供。
  这一步是全项目最贵的一步（20 点/秒），所以先给你一个只要 1.5 点的试听，
  拿到真实秒数算清楚要花多少，再决定出不出片；
- 三者都走同一套任务生命周期：提交 → 轮询 → 产物取回，失败可重试、可取消。

## 快速开始

```bash
cd backend

# 1. 依赖（Python 3.11+）
python -m venv .venv
.venv/Scripts/pip install -r requirements.txt      # Windows
# source .venv/bin/activate && pip install -r requirements.txt   # macOS / Linux

# 2. 配置 API Key
cp .env.example .env
# 把 THANK_YOU_AI_KEY=tk_... 填进去；也可以直接用 voice-to-avater-demo/.env

# 3. 生成试听音源（一次性，20 条约 1 点）
.venv/Scripts/python scripts/build_samples.py

# 4. 启动
# ⚠️ 必须带 --host 0.0.0.0：uvicorn 默认只绑 127.0.0.1，而前端 frontend/.env
#    配置的是局域网 IP（EXPO_PUBLIC_API_BASE_URL，真机/浏览器都按它连），
#    漏掉会表现为前端一直报「无法连接后端」。
.venv/Scripts/python -m uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

启动后打开 http://localhost:8000/docs 看接口。

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 健康检查：存储后端、Key 是否配置、音源就绪数 |
| GET | `/api/voices` | 我的声音库（20 个种子人设 + 导入的音色），支持 `q` / `language` / `tag` |
| GET | `/api/voices/{id}` | 声音详情 |
| GET | `/api/voices/{id}/sample` | **真实试听音源**（mp3）。已就绪返回 200，未就绪返回 202 并在后台生成 |
| POST | `/api/voices/{id}/preview` | 用该声音合成任意文案，返回 queued 的 Job，前端轮询 |
| POST | `/api/voices/{id}/sample/regenerate` | 重新生成试听音源 |
| POST | `/api/voices/import` | 从音色目录导入一个音色到我的声音库 |
| GET | `/api/catalog/voices` | 浏览 ThankYou 音色目录（`q` / `language` / 分页） |
| POST | `/api/portraits` | **生成 N 张候选形象**（真实文生图），返回 queued 的 Job |
| POST | `/api/portraits/views` | 用选定的候选图作参考，生成侧面 / 背面（image-to-image；`job_id` 与 `reference_url` 二选一） |
| POST | `/api/speak/preview` | **试听台词**：只合成音轨（约 1.5 点），返回真实秒数 + 精确费用 + 要不要它超限。按 `sha1(voice_id + 台词)` 缓存，重复试听不再花钱 |
| GET | `/api/speak/audio/{key}` | 取回试听音轨（mp3） |
| POST | `/api/speak` | **让角色开口说话**：人物图 + 台词音轨 → 会说话的视频，返回 queued 的 Job |
| GET | `/api/speak/quote?seconds=` | 按秒估价（不调上游） |
| GET | `/api/jobs` · `/api/jobs/{id}` | 任务列表 / 详情 |
| GET | `/api/jobs/{id}/image/{index}` | 候选图 / 三视图图片（产物落在本后端，不依赖第三方 CDN） |
| GET | `/api/jobs/{id}/audio` | 取回合成好的音频 |
| GET | `/api/jobs/{id}/voice` | 说话任务的台词音轨（可单独播放） |
| GET | `/api/jobs/{id}/video` | 说话任务的成片（本后端缓存，不依赖上游临时地址） |
| POST | `/api/jobs/{id}/cancel` | 取消（上游无法中断，但结果不再采用） |
| DELETE | `/api/jobs/{id}` | 删除终态任务记录，**连同本地缓存的产物文件**；进行中的任务要先取消（409） |
| POST | `/api/jobs/{id}/retry` | 重试 / 换一批；说话任务重试会**复用已合成的音轨**，只重跑出片 |
| GET | `/api/library` | 用户产出库：角色 / 角色修改 / 删除的种子 / 创作记录（前端 localStorage 已退役，数据统一入库） |
| PUT/DELETE | `/api/library/created-avatars/{id}` | 用户新建角色的 upsert / 删除（连带清补丁） |
| PUT/DELETE | `/api/library/avatar-patches/{id}` | 对种子角色修改的 upsert / 撤销 |
| PUT/DELETE | `/api/library/deleted-seeds/{id}` | 删除种子角色 / 恢复 |
| PUT/DELETE | `/api/library/creations/{id}` | 创作记录的 upsert / 删除 |
| GET | `/api/usage` · `/api/models` | 用量 / 模型清单 |

错误统一为 `{ "error": { "code": "...", "message": "..." } }`。

## 候选形象是怎么来的

```
形象描述（用户输入中文即可）
        │  + 定妆照要求（半身 / 纯色背景 / 影棚光 / 正面 / 写实）
        │  + 该候选的差异化提示（只动镜头与神态，不动用户给的性别年龄）
        ▼
POST /api/portraits  ──►  create_job(type=portrait)  ──►  返回 queued + poll_url
        │
        ├─ 先 POST /open/v1/generate/quote 估价，把预计消耗写进任务
        ▼
3 张候选并发跑（Semaphore 限流），每张完成就 patch 一次 progress
        │                         model = google/nano-banana/text-to-image
        │                         input = { prompt, aspect_ratio: "3:4", seed }
        ▼
   轮询 /open/v1/generations/{id}  ──►  output[0].url（图）
        │
        ▼
 backend/data/portraits/{job_id}_{i}.jpg   ←── 本地缓存
        │
        ▼
 GET /api/jobs/{id}/image/{i}  ──►  前端 <img> 直接显示
```

「换一批」和「重试」在**费用上不是一回事**：

| 动作 | 后端行为 | 花费 |
|---|---|---|
| 重试（不传 variant） | 已成功的那几张直接复用本地文件，只补失败的 | 只付失败张数 |
| 换一批（传新 variant） | 先清掉缓存，再整批重出（seed 也换） | 3 张全价 |

### 踩过的坑：不要写否定式元指令

第一版提示词结尾带了「不要文字与水印」，上游直接回
`no_output: The model did not produce an image for this prompt`，**而且失败照样扣点数**。
改成只描述「要什么」（半身像 / 纯色背景 / 影棚光 / 写实摄影）后就稳定出图了。
现在拼提示词的地方（`app/portraits.py: STYLE_SUFFIX`）带了注释，别再加否定式元指令。

### 三视图为什么用参考图

侧面 / 背面如果只用文字重写一遍提示词，出来的会是「另一个人」。
所以补图走 image-to-image：把用户选中的那张候选的**上游产物地址**作为 `reference_assets` 传进去，
提示词只描述「换视角、保持五官发型服装一致」。

参考图有两种给法，`job_id` 与 `reference_url` 二选一：

- **`job_id` + `index`**：参考图由后端从那条候选任务的 `output.provider_urls` 里取。
  创建流程走这条，前端不用知道、也不该知道 provider 地址。
- **只给 `reference_url`**：形象早就保存了，之后在「编辑角色信息」页想补侧面 / 背面时走这条。
  `views` 也可以只传一个（如 `["side"]`），**不顺手多生成一张**，按需扣点。

注意参考图必须是**上游能抓到的公网地址**：本后端产物的 `/api/jobs/{id}/image/{n}` 是相对地址，
上游拉不到，所以前端不要拿它当 `reference_url`（用 `job_id` 那条路即可）。

## 音源是怎么来的

```
seed 人设（Aria / Mei / Yui…）
        │  按语言 + 性别 + 音色人工挑选，带多级候选
        ▼
真实 Fish Audio voice_id  ──►  POST /open/v1/generate
        │                        model = fish-audio/text-to-speech
        │                        input = { text: 该语言的自我介绍, voice_id }
        ▼
   轮询 /open/v1/generations/{id}  ──►  output[0].url（mp3）
        │
        ▼
 backend/data/samples/{voice_id}.mp3   ←── 本地缓存，之后零成本、可离线
        │
        ▼
 GET /api/voices/{id}/sample  ──►  前端 <audio> 直接播放
```

**为什么不直接用上游目录里的 `preview_audio_url`？** 实测它托管在
`platform.r2.fish.audio`，本机网络不可达（代理 502 / 直连超时）。自己生成并缓存到本后端，
音源可用性完全可控，也不受第三方 CDN 影响。代价是每条约 0.05 点，一次性。

## 说话视频是怎么来的

```
角色的形象图（真实人像，来源二选一：source_job_id + source_index / image_url）
        │
        │  台词（用户写的一句话）
        ▼
POST /api/speak/preview ──► fish-audio/text-to-speech ──► { key, duration, estimated_points }
        │                    （约 1.5 点，按 sha1(voice_id + 台词) 缓存，重复试听不花钱）
        │                    前端拿真实秒数算钱，让用户知道要花多少再决定出不出片
        ▼
POST /api/speak  ──►  先卡台词长度（>30 秒直接 422 SCRIPT_TOO_LONG）
        │             再解析形象图 ──► 本地图 / 上游地址 / 上游已过期 → 上传换 file_id
        ▼
  create_job(type=speak)  ──►  返回 queued + poll_url
        │
        ├─ 阶段「合成台词」：音轨已在缓存里就直接复用，否则现场合成（写入 data/speech/{key}.mp3）
        ├─ 阶段「让角色开口」：把音轨传给模型 → 轮询 /open/v1/generations/{id}
        ▼
 backend/data/videos/{job_id}/final.mp4     ←── 本地缓存
        │
        ▼
 GET /api/jobs/{id}/video  ──►  前端 <video> 直接播放
 GET /api/jobs/{id}/voice  ──►  台词音轨（可单独听）
```

### 两个模型的入参不一样，写错只报糊脸错误

| | `heygen/avatar4/avatar`（**默认**） | `infinitalk/avatar` |
|---|---|---|
| 图片 role | `reference` | `reference` |
| 音轨 role | **必须是 `source_audio`** | **必须是 `source_audio`** |
| `prompt` | 可选 | **必填**（空串也报错） |
| 时长控制 | 无参数，成片跟着音轨走 | 按 `num_frames`（默认 145，范围 41..721）→ **有截断台词的风险** |
| `aspect_ratio` | 支持（16:9 / 9:16 / 4:5 / 5:4 / 1:1 / auto） | 不支持 |

**`source_audio` 这个 role 名是逐个变量真跑二分出来的**，代价是踩了一路坑：
写 `audio` 时（看起来更自然）上游只回一句
`The parameter combination is not supported.`，不说哪个字段错、也不说该写什么；
更坑的是 **`/generate/quote` 对 `audio` 照样放行** —— 估价通过、真跑才炸，
所以「先估价再生成」这条自检路径根本拦不住它。`tests/test_speak_api.py`
里有一条守卫，禁止任何 spec 写回 `audio`。

所以默认选**没有时长参数、跟着音轨走**的 `heygen/avatar4/avatar`：不会把台词截断。
这些差异收敛在 `app/videos.py: MODEL_SPECS` 一张表里，并由 `tests/test_speak_api.py` 钉死 ——
换模型时改表即生效，不用满仓库找拼 payload 的地方。

### 素材怎么传给上游：两段式上传

本地产物（台词音轨、缓存下来的形象图）上游按普通 URL 取不到，必须先传上去。
上游的 `POST /open/v1/files` 实际是**两段式**（它部署的版本和它自己发布的
`openapi.json` 在下面每一处都不一致，所以每一条都值得写下来）：

1. `POST /files` 只是**预留位置**，表单除 `file` 外还要带 `content_type` 与
   `size_bytes`（文档只声明 `file` 必填，少传回 422），响应里会多给一个
   `upload_url`（文档里没有这个字段）；
2. **字节要自己 `PUT` 到 `upload_url`**，且必须带上与签名一致的 `Content-Type`
   （签名串是 `SignedHeaders=content-type;host`，不发就 403 `SignatureDoesNotMatch`），
   同时**不能带我们的 `Authorization`**（带了对象存储会当成 SigV4 解析，回
   `Missing x-amz-content-sha256`）。所以这一步用的是 `thankyou._raw_http()`
   —— 一个不带任何默认头的裸客户端；
3. 传完再 `HEAD` 一下确认**真的能抓到**：只 POST 不 PUT 也会返回成功和一个 `url`，
   但那个地址永远 404，而模型只会报「参数组合不支持」，跟真实原因差十万八千里。

引用时用返回的 **`url`**，不是 `file_id`：同一个文件，把 `file_id` 喂给
`reference_assets` 会被判 `invalid_param`（即便字节确实传上去了），换成 `url` 就通过。
另外**图片类型要按内容判断**：上游文生图返回的其实是 PNG，我们按 `{job}_{i}.jpg` 存、
又按 `image/jpeg` 声明，这个谎一路被 CDN 原样保留到 `Content-Type` 响应头
（`app/media.py: image_content_type` 现在按魔数判断）。

### 音轨为什么要缓存

出片是 **20 点/秒**（一条 15 秒 = 300 点），而 TTS 一条只要 **约 1.5 点** —— 差 100 倍。
所以：

- 试听与出片共用同一份音轨（键是 `sha1(voice_id + 台词)`），出片时**直接复用**，不重复买 TTS；
- 「重试」只重跑出片那一步，音轨从 `data/speech/` 里拿，改成只对付失败的那一步；
- 代价是试听那 1.5 点花在了「让用户知道要花多少钱」上，而不是花在盲付 300 点上。

## 费用与失败处理

- TTS 每条约 **0.05 点**（1 句短文本）。20 条试听 ≈ 1 点，生成一次长期有效。
- 文生图当前模型 **6 点/张**（`google/nano-banana/text-to-image`）：
  一次「3 张候选」= 18 点，补三视图 2 张 = 12 点。
  想要更好的人像细节可把 `PORTRAIT_MODEL` 换成 `bytedance/seedream/v4.5/text-to-image`（10 点/张）。
- 说话视频 **20 点/秒**（720p）、**30 点/秒**（1080p）—— 是整个项目里最贵的一步。
  一条 15 秒的成片 = 300 点，等于 50 张候选图。因此：
  - `/api/speak/quote?seconds=` 按秒精算（不调上游），前端在敲台词时就能给出数字；
  - `/api/generate/quote` 对视频**只返回固定 100 点的预估价，不按时长精算**，
    所以费用必须由我们自己按音轨秒数算（`settings.speak_points`），不能信那个数；
  - 台词超过 `settings.speak_max_seconds`（30 秒）时直接 422 拒绝 —— 这是最贵的一步，
    宁可挡在门口，也不让一次误操作烧掉四位数点数。
- **失败的生成不花钱**（`generations[].usage.credits_consumed = 0.0`）。
  这让「调不通就逐个变量真跑二分」变成一种可行且免费的排查手段 ——
  上面 `source_audio` 那个坑就是这么定位的：7 次失败全 0 点，只有成功那次才算钱。
- 生成前都会先估价：接口层封装了 `POST /open/v1/generate/quote`（`thankyou.quote`），
  预计消耗会写进 Job 的 `input.estimated_points` / `output.estimated_points`。
- 上游失败分三类并映射到 Job 的 `error.code`：
  - `UPSTREAM_TIMEOUT` / `UPSTREAM_UNREACHABLE`：网络层，自动重试 2 次（指数退避）；
  - `HTTP_4xx`：调用方问题（Key、余额、参数），不重试，直接失败；
  - 生成 `status=failed`：带上游的 `error.code` / `message` 透传给前端。
- 试听音源有**多级候选音色**：主音色失败会自动降级到备选，全失败才报错。
- 候选图允许**部分失败**：成功的张数留在 `output.image_urls` 里并落盘，
  任务判失败但重试只补失败的 —— 不会为已经成功的图再付一次钱。
- 说话任务的**取消不是空话**：每个阶段之间都查一次中止标记，取消后不再进入下一步 ——
  已经花掉的音轨钱认了，但不会继续把最贵的视频那一步跑完。
- **重试语义**：`can_retry_video()` 只看本地音轨在不在，在就复用、只重跑出片。
  注意重试入口**故意不查中止标记** —— 否则「终态任务不能重跑」会把重试静默吞掉，
  这个坑在测试里钉住了（`test_retry_only_reruns_video_and_keeps_audio`）。

## 存储

面试要求 FastAPI + MongoDB。这里做成可插拔：

- 启动时探测 `MONGO_URL`（默认 `mongodb://localhost:27017`），连得上就用 MongoDB；
- 连不上（比如没起 Docker）自动回退到 `backend/data/store.json`，**开箱即跑**；
- 两者对外是同一套异步接口（`app/store.py`），业务代码不感知。
- `/api/health` 会回报当前用的是哪一个。

## 目录

```
backend/
├── app/
│   ├── main.py            FastAPI 应用、CORS、统一错误格式
│   ├── config.py          配置（读 backend/.env 与 voice-to-avater-demo/.env）
│   ├── schemas.py         对外数据契约
│   ├── thankyou.py        ThankYou Open API 客户端（生成/估价/轮询/下载）
│   ├── seeds.py           20 个种子人设 + 真实音色绑定
│   ├── samples.py         试听音源的生成与缓存
│   ├── portraits.py       候选形象与三视图的生成（提示词 / 下载 / 缓存 / 复用）
│   ├── speech.py          台词音轨的合成与缓存（按 voice + 台词 去重）
│   ├── videos.py          说话视频：模型差异表 MODEL_SPECS / payload 拼装 / 出片任务
│   ├── portrait_ref.py    形象图解析（本地路径 / 上游地址 / 过期回退上传换 file_id）
│   ├── media.py           纯 Python 时长探测（读 MP4 moov/mvhd、MP3 帧头；本机无 ffmpeg）
│   ├── library.py         声音库装配（种子 + 导入）
│   ├── jobs.py            任务生命周期 queued→running→succeeded/failed
│   ├── store.py           存储层（MongoDB / JSON 可插拔）
│   └── routers/           system / voices / catalog / portraits / speak / jobs
├── scripts/build_samples.py   批量生成试听音源
├── tests/                 pytest（上游全部替换成假实现，不调用真实 AI）
└── data/                  运行时数据（samples/*.mp3、portraits/*.jpg、speech/*.mp3、
                           videos/{job_id}/final.mp4、store.json）—— 不入库
```

## 还能扩什么

创作模块现在收敛成单一玩法（让角色开口说话），历史上试过的「换角色演爆款视频」
（换脸 + 换声 + 对口型那套编排）已经整个拆掉：它把「动画怎么运镜」这种连模型都执行不了
的自由文本丢给用户填，是把技术难题伪装成用户输入，而且每一步都是独立计费的重活。

后面若要扩，仍然走同一套 `client.run()` + Job 生命周期：

- 1080p（`resolution: "1080p"`，30 点/秒）—— 后端已支持，只差一个开关；
- 换一副更贴角色的音色（`/api/catalog/voices` 已有 1000+ 真实音色）；
- `motion-control` / `lip-sync` 等平台已有模型，接法与说话视频同构。
