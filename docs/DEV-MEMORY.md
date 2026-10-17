# 项目长期记忆（voice-to-avatar-interview）

## 项目结构（用户指定，勿改）

- **主前端**：`voice-to-avater-demo/frontend/`（Expo SDK 57 + react-native-web）。
  旧的 `frontend/` 是历史副本，已停止维护。
- **后端**：`voice-to-avater-demo/backend/`（**Python + FastAPI**，用户明确要求）。
  存储 MongoDB 优先，连不上自动回退 `backend/data/store.json`。
- 端口：前端 8082，后端 8000。环境：Python 3.13.12，Node 22。**勘误（2026-10-17）：本机现在有 Docker + MongoDB**
  （容器 `voice-avatar-mongo`，后端真实走 Mongo；旧记录说"无 Docker/MongoDB"已过时，e2e-delete 第 1 段的
  mongosh 插桩是能跑的）。后端 venv 在 `C:/Users/WIN11/.workbuddy/binaries/python/envs/default`。

## 凭据

- `THANK_YOU_AI_KEY` 在 `voice-to-avater-demo/.env`（后端也读 `backend/.env`）。
  **不要提交到公开仓库**。

## AI 能力（ThankYou Open API）

- `POST https://api.thankyouai.com/open/v1/generate`；`Prefer: wait=N` **不会**阻塞到完成，
  返回 202 queued，必须轮询 `/generations/{id}`。
- 模型：TTS `fish-audio/text-to-speech`（**约 1.5 点/条**）；候选图/三视图
  `google/nano-banana/text-to-image`（6 点/张，竖构图 `aspect_ratio: "3:4"`；**不要**用
  Seedream v4.5，`image_size` 一大就 `image_too_large` 且贵）；说话视频
  `heygen/avatar4/avatar`（**默认**）或 `infinitalk/avatar`。
- **文生图提示词严禁否定式元指令**（如「不要文字与水印」）：nano-banana 回 `no_output`
  且**照样扣点**。只描述「要什么」。
- 音色目录预览音频在 `platform.r2.fish.audio`，**本机不可达**；TTS 与图片产物在
  `static.thankyouai.com`，**可达**。要音源/参考图必须自己生成 + 本地缓存。
- **`/generate/quote` 对视频只返回固定 100 点预估价，不按时长精算** —— 费用自己按秒算。
- **失败的生成不扣钱**（`generations[].usage.credits_consumed = 0.0`）。所以「调不通就逐个变量
  真跑二分」是免费且可行的排查手段 —— 下面 `source_audio` 那个坑就是这么定位的。

### 说话视频两个模型的入参差异（写错只报糊脸错误）

| | `heygen/avatar4/avatar`（默认） | `infinitalk/avatar` |
|---|---|---|
| 音轨 role | **必须 `source_audio`** | **必须 `source_audio`** |
| `prompt` | 可选 | **必填**（空串也报错） |
| 时长 | 无参数，跟音轨走 | `num_frames`（默认 145，范围 41..721）→ **会截断台词** |
| `aspect_ratio` | 支持 | 不支持 |

- **音轨 role 只能是 `source_audio`，写 `audio` 会被拒**，但报的是
  `The parameter combination is not supported.`（不说哪个字段错），**而且 `/generate/quote`
  对 `audio` 照样放行** —— 估价通过、真跑才炸。靠真跑逐变量二分才定位到。
  这条由 `test_no_spec_uses_the_rejected_audio_role` 守住，别改回 `audio`。
- 收敛在 `backend/app/videos.py: MODEL_SPECS` 一张表。选 heygen 因为不截断台词。
- **`videos._patch` 带终态保护（2026-10-17 修）**：终态任务的写入一律丢弃 —— 否则用户在
  上游轮询期间取消，协程跑完 `_patch(status="succeeded")` 会把 CANCELED 悄悄覆盖回去
  （「取消了还挂在排队中」就是它）。重试不受影响：retry 接口先经 `patch_job` 置回 running。
  守住它的测试：`test_cancelled_job_is_not_revived_by_late_writes`。
- **取消会立刻中止上游轮询（2026-10-17）**：`videos._run(job_id=...)` 轮询中检测到取消
  直接 raise `CANCELED`，不傻等上游、不下载产物。守住测试：
  `test_cancel_during_upstream_poll_stops_waiting`。上游请求本身停不了（API 限制）。

### 素材上传：两段式（每条都与上游文档不符）

1. `POST /files` 只是**预留**，表单除 `file` 还必须带 `content_type` + `size_bytes`（否则 422），
   响应多给一个 `upload_url`（文档里没这个字段）。
2. **字节要自己 `PUT` 到 `upload_url`**，必须带与签名一致的 `Content-Type`
   （不发 403 `SignatureDoesNotMatch`），且**不能带我们的 `Authorization`**
   （会被当 SigV4 解析，回 `Missing x-amz-content-sha256`）→ 用 `thankyou._raw_http()` 裸客户端。
3. 传完 `HEAD` 确认真的能抓到（只 POST 不 PUT 也会返回成功 + 一个永远 404 的 url）。
4. 引用用返回的 **`url`**，不是 `file_id`（喂 file_id 判 `invalid_param`）。
5. **图片类型按魔数判断**（`media.image_content_type`）：上游文生图返回的是 PNG，
   我们按 `.jpg` 存、按 `image/jpeg` 声明，这个谎被 CDN 原样带到响应头。

## 费用口径（说话视频是全场最贵的一步）

- 视频 **20 点/秒**（720p）/ 30 点/秒（1080p）：15 秒 = 300 点 = 50 张候选图。
  所以「**先试听（1.5 点）拿真实秒数，再决定出不出片**」；音轨按 `sha1(voice_id + 台词)`
  缓存在 `backend/data/speech/`，出片复用不重复买 TTS；重试只重跑出片（`can_retry_video`
  只看音轨在不在）；台词 >30 秒直接 422 `SCRIPT_TOO_LONG`，前后端各拦一次。
- 前端口径在 `src/lib/cost.ts`（`estimateSeconds` 按 4.5 字/秒粗估），与后端同一套公式。
  试听前必须标「（估算）」；时长未知时不许编数字。

## 环境坑（会反复踩）

0. **iOS 原生禁止 Modal 嵌套**：内层 Modal 的原生窗口不显示、却拦截全部触摸 → 「屏幕点哪都没反应」
   （web 端 Modal 只是 div，嵌套没事，所以只有真机/模拟器炸）。删除确认弹窗因此拆成
   `ConfirmSheetBody`（纯内容体，复用外层 Modal）+ `ConfirmSheet`（独立外壳）。
   凡是已在某个 BottomSheet 里的确认弹窗必须用 Body 两态切换（见 AvatarActionSheet），别再嵌套。
   注意 Body 的 testID 别和外壳 BottomSheet 的重复（外壳场景按钮 id 用 confirmTestID/cancelTestID 显式下发）。
1. pip 装依赖必须加 `--no-cache-dir`，否则被 SAFE_DELETE_BULK_GUARD 拦截。
2. pypi 官方源极慢，用 `-i https://mirrors.aliyun.com/pypi/simple/`。
3. Python 是 Windows 原生解释器，脚本里 `/tmp/x` 会变成 `E:\tmp\x`，临时文件放项目内。
4. Bash 工具里禁止调用 powershell（安全策略），要用 PowerShell 工具。
5. FastAPI 的 GET 路由不自动挂 HEAD，要支持得显式写 `methods=["GET","HEAD"]`。
6. 本机**没有 ffmpeg**：`backend/app/media.py` 纯 Python 读 MP4 `moov/mvhd` box、
   MP3 首帧头（128kbps=16000 字节/秒）+ 跳 ID3v2。读不出返回 `None`，不瞎猜。

## 声音库数据（20 个人设，改动要四处同步）

`backend/app/seeds.py`、`voice-to-avater-demo/frontend/src/data/voices.json`、
`frontend/src/data/voices.json`（旧副本）、`seed/voices.json`。

- 人设 → 真实音色（`provider_voice_id`）是**按名字线索人工挑的，没有试听**，存在性别/风格
  错配风险（已发现：Min-jun 原绑女声播报音，已改标记 female）；目录里韩语音色只有 3 条、
  没有可换的男声，遇问题只能改标记或换语言。

## 前端约定

- 数据源：后端优先、失败回退本地 mock（`src/data/voices.ts: loadVoices()`）。
- 音频播放统一走 `src/lib/useSamplePlayer.ts`（HTMLAudioElement，web-only）。
- **创作模块只有一个功能：让角色开口说话**（`/avatar/[id]/create`，三态
  写台词 → 出片中 → 成片）。历史上那套「选创作类型 → 编排动画 → 上传参考图」的向导，
  以及后来试过的「换角色演爆款视频」（换脸/换声/对口型）都已**整个拆掉**，别再往回加。
  `JobType` 只剩 `portrait | speak | tts`。
- **本地持久化**（`src/lib/storage.ts`，只存用户增量）：`vta.avatars`（新建角色）、
  `vta.avatarPatches`（对种子角色的修改）、`vta.creations`（创作库）。种子数据不入缓存。
  新条目 id 的序号**必须从已载入数据推导**，写死初始值会在刷新后撞 id 覆盖用户数据。
- **`absUrl()` 对任何自带 scheme 的地址原样返回**（`http(s):`/`data:`/`blob:`），只给后端相对
  路径补域名。曾经只认 `http(s)`，把内联图拼成了 `http://localhost:8000/data:image/png;base64,...`。
- **布局坑**：RN/RNW 默认 `flexShrink: 1`。「页头固定行 + FlatList」的页面，FlatList 必须
  `flex: 1`，页头里横向 ScrollView 要 `flexShrink: 0`，否则列表一长页头被压扁（声音库语言条踩过）。
  排查用 `verify/diag-clipped.mjs` 扫 scrollHeight > clientHeight 的元素。
- **弹窗统一走 `src/components/BottomSheet.tsx`**：不要用 `Modal animationType="slide"`
  （会把蒙层和面板一起推上来），要 `animationType="none"` + 蒙层静态铺满 + 只给面板做
  translateY。表单弹窗的回填 effect 别依赖对象型 props，用 ref 存最新值 + 只依赖 `visible`。
- **生成类交互任务化（已接后端）**：声音库、候选形象、三视图、说话视频都走「提交任务 →
  轮询 `GET /api/jobs/{id}` → 取产物」，入口 `src/data/portrait.ts`（`startPortraitJob /
  startViewsJob / previewSpeak / startSpeakJob / resumeJob / restartJob / cancelJob /
  fetchJobById / hydrateJobs`）。后端连不上自动回退 `mock.ts` 本地推进器，页面只读本地任务
  列表，对两种模式透明；任务 id 写进 URL（`?job=`）。新功能照这个模式接。
  **例外**：说话视频**没有本地兜底** —— 假视频对用户毫无价值，还会让人以为功能已能用，
  所以后端不可用时如实报错。
- **从任务态回到页面必须回填任务输入**：`?job=` 只看状态不够，台词/比例只存在 `job.input`
  里；不回填的话结果态是个空台词框，保存下来就是一条空创作。
- **后端产物地址是相对的**，存进业务数据或给 `<Image>` 用之前必须过 `absUrl()`。
- **补图/参考图要上游能抓到的公网地址**：前端不传 `reference_url`，传 `job_id`（+`index`），
  让后端从任务的 `output.provider_urls` 里取。
- **种子角色 `views.front` 是 `null` 占位图**（不是真实人像），创作台会拦住并引导去生成形象。
  `viewCount` 看的是**键是否存在**，所以种子照样显示「三视图 3/3」—— 刻意如此：占位 ≠ 有真实图。
- **后端产物字段名只有一套**：音频一律 `output.audio_url`（tts 与 speak 都是），
  没有 `voice_url`。前端曾经把 speak 读成 `voice_url` → 台词音轨永远不渲染、
  存进创作库也是 null。`Job.output` 里已删掉 `voice_url`，类型系统会拦。
- **成片用的音色在 `job.input.voice_name`**，不是角色「现在」绑定的音色（用户可能改过）。
- **验证脚本分层，别乱花钱**：随时可跑（零成本）—— `e2e-speak-studio.mjs`（55 项，mock，
  覆盖说话整条闭环）、`e2e-edit-page.mjs`（47 项）、`e2e-create-job-flow.mjs`（40 项）、
  `e2e-portrait-reopen.mjs`、`smoke-all-pages.mjs`；真实生成的要 `ALLOW_REAL=1`
  （`e2e-portrait-real.mjs` 30 点、`e2e-edit-view-real.mjs` 6 点）。
  **`e2e-speak-real.mjs`** 专门验真链路：真后端 + 已有成片任务（`SPEAK_JOB=<id>`），
  不给角色补假图而是补**真实产物图**（`/api/jobs/<portrait_job>/image/0`），
  并断言 `<video>` 真的解码、`currentTime` 在涨 —— 零成本、不用重新生成。
  省钱又验真实链路：用 `page.route` 拦 `POST /api/portraits` 复用已有真实任务。
- **要走创作台布局的验证脚本必须给角色补一张假形象图**：`addInitScript` 写
  `vta.avatarPatches`（8x8 data URI 即可），否则页面停在「还没有真实形象」那一态。

## 媒体快照解耦（任务产物 vs 持久数据）
- 任务记录删除会连带删除产物文件，所以所有「持久数据引用任务产物 URL」的地方都必须快照解耦（`app/creation_media.py`）：
  - 创作条目 → `data/creations/{id}/`，URL `/api/creation-media/{id}/{file}`
  - 声音头像（voice_avatars 集合）→ `data/voice-media/{voice_id}/`，URL `/api/creation-media/voice/{voice_id}/{file}`
  - 角色三视图（created_avatars.views / avatar_patches.views）→ `data/avatar-media/{avatar_id}/`，URL `/api/creation-media/avatar/{avatar_id}/{file}`
- 挂点：library PUT/DELETE 钩子 + 启动迁移 `migrate_media()`（幂等）+ `scripts/gen_voice_avatars.py` bind 时快照。
- 坑：声音头像曾直接引用 `/api/jobs/{id}/image/0`，任务删除后 404；PC 浏览器有缓存掩盖问题，手机无缓存才暴露。gen_voice_avatars.py 幂等跳过已有 avatar_url 的声音，重生成前要先删 voice_avatars 里的失效绑定。
