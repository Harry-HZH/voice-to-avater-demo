# Watercolor Voice — 让声音变成会说话的角色

声音库 → 生成候选形象 → 补三视图 → 台词试听 → 出会说话的视频。  
前端 Expo (React Native Web)，后端 FastAPI + Mongo，AI 能力接 [ThankYou](https://thankyou.com)（文生图 / image-to-image / TTS / 说话视频）。

## 快速开始

### 前置依赖

| 依赖       | 版本要求                  | 说明                                                            |
| ---------- | ------------------------- | --------------------------------------------------------------- |
| Python     | 3.11+（3.13 验证）        | 后端 FastAPI                                                     |
| Node.js    | 18+（22 验证）            | 前端 Expo SDK 57 / React Native 0.86                             |
| MongoDB    | 可选（4.x+，本地 27017）  | 启动时探测，连不上自动降级为 JSON 文件存储（`backend/data/`），功能不受影响，但降级存储之间数据不互通 |
| API Key    | ThankYou（`tk_` 开头）    | 文生图 / TTS / 说话视频都走它；没有 Key 时接口返回 503 并明说，不假装成功 |

不需要 ffmpeg：音频/视频时长是纯 Python 读容器头算的（`backend/app/media.py`），部署零外部二进制。

### 后端

```bash
cd backend
python -m venv .venv
# Windows: .venv\Scripts\pip install -r requirements.txt
./.venv/bin/pip install -r requirements.txt   # macOS/Linux

# 配置 Key：复制 backend/.env.example 为 backend/.env 填入；
# 或直接在项目根目录放 .env（THANK_YOU_AI_KEY=tk_xxx），两处都会被读到
./.venv/Scripts/python.exe -m uvicorn app.main:app --host 0.0.0.0 --port 8000
```

- `--host 0.0.0.0` 是给真机预览用的（手机要走局域网 IP 访问）；纯本机浏览器调试可以不带
- Swagger：`http://localhost:8000/docs`

### 前端

```bash
cd frontend
npm install
npx expo start --web --port 8082    # 浏览器打开 http://localhost:8082
```

**手机真机预览**：改 `frontend/.env` 的 `EXPO_PUBLIC_API_BASE_URL` 为电脑的局域网 IP（如 `http://192.168.x.x:8000`）后重启——手机上的 localhost 是手机自己。iOS 静音键会吞 expo-audio 的音频，已做音频会话处理；锁屏/切后台暂停轮询是浏览器限制，回前台自动恢复。

### 测试

```bash
# 后端：103 项，假上游零成本零网络
cd backend && ./.venv/Scripts/python.exe -m pytest tests/

# 前端 e2e：需先起前后端（8082/8000）；Playwright 驱动见 verify/ 脚本头部注释
cd verify && node e2e-create-job-flow.mjs
```

覆盖范围与测试报告见 `docs/test-report.html`。

## 几个关键取舍

**1. 状态只有一份真源：后端任务库。**  
前端本地任务列表是内存态缓存（刷新即丢），打开任务中心就对齐一次后端，轮询只更新不落库。不做前端持久化——两份状态迟早打架。

**2. 先试听再出片，是为了别让人盲付。**  
TTS 约 1.5 点，说话视频按秒计费（720p 20 点/秒），差两个数量级。试听拿到**真实秒数**后报价，确认了才提交视频。试听的音轨会被出片直接复用，不买第二遍。

**3. 取消是"真取消"，但有物理上限。**  
取消后：状态立刻置终态、后台晚到写入被丢弃（终态保护）、轮询协程检测到取消立刻中止、不再下载产物。**但已提交给上游的生成请求停不下来**（ThankYou 没有取消接口），上游扣不扣点我们控制不了。测试通过假上游验证了"取消后零新增调用"。

**4. 错误文案对用户只有兜底。**  
后端/网络的详细信息（上游地址、HTTP 码、堆栈）一律不透出，统一「系统繁忙」；只保留 `VALIDATION_ERROR`（用户能改的输入问题）和 `CANCELED` 原文。轮询连续失败 4 次（约 6 秒）判定后端不可用，任务就地置失败，不再无限转圈。

**5. 产物落地本地缓存，费用按真实用量。**  
上游图片/视频/音频下载到本地再交付（`backend/data/media/`），重试只重跑失败的部分：换一批清缓存整批重出，原地重试复用已成功的候选图；视频重试复用已有音轨只重跑出片。

## 没做的部分（和为什么）

| 没做          | 原因                                                                 |
| ----------- | ------------------------------------------------------------------ |
| 上游任务取消接口    | ThankYou 不提供；已在应用层做到"取消后零新增等待与下载"                                  |
| 启动时孤儿任务恢复   | 后端重启后 running 任务无人接管。演示范围内先靠用户重试；要做得可靠需要任务队列（Celery/Arq），当前体量不值得引入 |
| 用户账号体系      | 面试 demo，无多用户隔离需求；用户产出走 `/api/library` 单空间落库                        |
| 移动端真机expo测试 | React Native 写法保留了跨端能力，但只对 Web 做了完整验证（PC 双栏 + 手机单栏）                |
| 任务队列与并发控制   | 单 worker asyncio 协程，够用；并发上限靠上游限流兜底                                 |

## 测试

- 后端 pytest **103 项**（`backend/tests/`）：任务状态机、终态保护、取消语义、计费与缓存、输入验证、上游容错，全部走假上游零成本。
- 前端 Playwright e2e **10 个脚本**（`verify/`）：主流程 48 断言 + 编辑页 47 断言，另有真实联调脚本（会花钱，标注在脚本头部）。
- 详见 `docs/test-report.html`。
