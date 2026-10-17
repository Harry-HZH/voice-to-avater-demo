/**
 * 候选形象（创作形象流程）的任务生命周期。
 *
 * 设计：**后端优先，本地兜底**。
 *   - 后端可用时：POST /api/portraits 提交真实文生图任务，之后轮询 /api/jobs/{id}，
 *     把后端返回的任务原样写进本地任务列表（进度是后端真实推进的，不是假动画）；
 *   - 后端不可用（没启动 / 没配 key）时：退回本地 mock 推进器，纯前端 demo 照样能演示完整流程。
 *
 * 页面只读本地列表（`getJob` / `jobs` + `subscribeData`），所以两种模式对页面是透明的。
 */

import {
  ApiError,
  cancelRemoteJob,
  createPortraitJob,
  createSpeakJob,
  createViewsJob,
  deleteRemoteJob,
  fetchJob,
  fetchJobs,
  requestSpeakPreview,
  retryRemoteJob,
} from "../lib/api";
import type { SpeakPreview } from "../lib/api";
import type { Job } from "./types";
import {
  cancelJob as cancelLocalJob,
  failJob,
  getJob,
  removeJob as removeLocalJob,
  resumeJob as resumeLocalJob,
  restartJob as restartLocalJob,
  startPortraitJob as startLocalPortraitJob,
  upsertJob,
} from "./mock";

/** 后端任务 id（这些任务的状态以后端为准，前端只轮询） */
const remoteJobs = new Set<string>();
const timers = new Map<string, ReturnType<typeof setInterval>>();
const inflight = new Set<string>();

const POLL_MS = 1500;
/** 轮询连续失败到这个次数就判定后端挂了，任务直接置失败并停止轮询（4 次 ≈ 6 秒） */
const MAX_CONSECUTIVE_FAILURES = 4;

/**
 * 强制走本地演示（不调真实文生图，不花点数）。
 *
 * 自动化验证脚本要反复跑「生成候选图」，不能每次都真花钱，所以在
 * 浏览器里放一个开关：URL 带 `?portraits=mock`，或 localStorage 的
 * `vta.portraitMode = "mock"`（验证脚本用后者，一次性设置全局生效）。
 */
const MOCK_MODE = "mock";

export function forcedMockMode(): boolean {
  if (typeof window === "undefined") return false;
  try {
    if (window.location?.search?.includes(`portraits=${MOCK_MODE}`)) return true;
    return window.localStorage?.getItem("vta.portraitMode") === MOCK_MODE;
  } catch {
    return false;
  }
}

export function isRemoteJob(id: string): boolean {
  return remoteJobs.has(id);
}

function stopPoll(id: string): void {
  const t = timers.get(id);
  if (t) {
    clearInterval(t);
    timers.delete(id);
  }
}

function startPoll(id: string): void {
  if (timers.has(id)) return;
  let ticks = 0;
  let failures = 0;
  const timer = setInterval(async () => {
    ticks += 1;
    const local = getJob(id);
    // 终态就停；另外兜一个上限，避免后端重启后留下「永远 running」的任务被无限轮询
    if (!local || local.status === "succeeded" || local.status === "failed" || ticks > 400) {
      stopPoll(id);
      return;
    }
    if (inflight.has(id)) return;
    inflight.add(id);
    try {
      const fresh = (await fetchJob(id)) as Job;
      failures = 0;
      // 用户可能在这条请求飞行途中点了取消：晚到的非终态快照不得把终态改回去
      const local = getJob(id);
      if (local && local.status === "failed" && fresh.status !== "failed") {
        return;
      }
      // 飞行途中任务可能被重试过：晚到的旧快照（updated_at 更旧）不得回退新进度
      // —— 否则重试后进度会 67% → 33% → 67% 地跳。时间戳相同视为无新信息。
      if (local && fresh.updated_at && local.updated_at && fresh.updated_at <= local.updated_at) {
        return;
      }
      upsertJob(fresh);
      // 后端已经到了终态就别再排下一轮了（本来下个 tick 也会停，这里提前省一次请求）
      if (fresh.status === "succeeded" || fresh.status === "failed") stopPoll(id);
    } catch (err) {
      // 偶发一次失败（后端重启的空档）等下个 tick 再试；
      // 连续失败说明后端真的挂了 —— 不再傻轮询，任务就地置失败，页面走报错流程
      failures += 1;
      if (failures >= MAX_CONSECUTIVE_FAILURES) {
        console.warn("[portrait] 轮询连续失败，判定后端不可用：", (err as Error)?.message);
        stopPoll(id);
        failJob(id, { code: "SYSTEM_BUSY", message: "系统繁忙，请稍后再试" });
      }
    } finally {
      inflight.delete(id);
    }
  }, POLL_MS);
  timers.set(id, timer);
}

/** 停掉所有轮询（组件卸载 / 测试收尾用） */
export function stopAllPolling(): void {
  for (const id of [...timers.keys()]) stopPoll(id);
}

function isBackendIssue(err: unknown): boolean {
  return err instanceof ApiError;
}

/**
 * 发起「生成候选形象」。
 * 后端不可达 / 出错 → 直接抛错给页面（错了就是错了，不再静默回退本地演示）；
 * 只有显式声明的演示模式（`vta.portraitMode = "mock"`，e2e 脚本用）才走本地推进器。
 */
export async function startPortraitJob(input: {
  voice_id: string;
  prompt: string;
  count?: number;
  variant?: number;
}): Promise<Job> {
  if (forcedMockMode()) return startLocalPortraitJob(input);
  const accepted = await createPortraitJob(input);
  const job = accepted.job as Job;
  if (accepted.estimated_points != null) {
    job.input = { ...job.input, estimated_points: accepted.estimated_points };
  }
  remoteJobs.add(job.id);
  upsertJob(job);
  startPoll(job.id);
  return job;
}

/**
 * 用选定的候选图补侧面 / 背面（真实 image-to-image）。
 *
 * 两种入口：
 *   - `job_id` + `index`：参考图由后端从那条候选任务里取（创建流程）；
 *   - 只给 `reference_url`：保存过的形象后来补视图（编辑角色信息页）。
 *
 * 返回 undefined 表示这次补图走的是显式演示模式（`vta.portraitMode = "mock"`），
 * 调用方自行处理；后端不可达 / 出错直接抛错，不再静默降级。
 */
export async function startViewsJob(input: {
  job_id?: string;
  index?: number;
  views?: string[];
  reference_url?: string;
  voice_id?: string;
  prompt?: string;
}): Promise<Job | undefined> {
  if (forcedMockMode()) return undefined;
  if (!input.job_id && !input.reference_url) return undefined;
  const accepted = await createViewsJob({
    index: input.index ?? 0,
    ...input,
  });
  const job = accepted.job as Job;
  remoteJobs.add(job.id);
  upsertJob(job);
  startPoll(job.id);
  return job;
}

/**
 * 台词试听：合成音轨，拿到真实秒数与精确费用。
 *
 * 这一步真花点数（约 1.5 点），而视频要按秒计费（720p 20 点/秒）——
 * 差两个数量级。所以「先听再出片」不是为了体验，是为了别让用户盲付。
 * 缓存的音轨会被后面的出片直接复用，不会把 TTS 买第二遍。
 */
export async function previewSpeak(input: {
  voice_id: string;
  script: string;
}): Promise<SpeakPreview> {
  if (forcedMockMode()) {
    // 演示模式不花钱：按字数估一个秒数回来，把流程走完
    const seconds = Math.min(30, Math.max(2, Math.round(input.script.length / 4.5)));
    return {
      key: "sp_demo",
      audio_url: "",
      duration: seconds,
      duration_known: true,
      estimated_points: seconds * 20,
      resolution: "720p",
      max_seconds: 30,
      over_limit: seconds > 30,
      cached: false,
    };
  }
  return requestSpeakPreview(input);
}

/**
 * 发起「让角色说这段话」。
 *
 * 和后端不可用时的关系：这个玩法**没有本地兜底**。
 * 候选形象可以退回水彩占位图演示，但视频没有「假装生成」的意义 ——
 * 一条假视频对用户毫无价值，还容易让人以为功能已经能用。
 * 所以后端不可用时直接把错误抛给页面，由页面说清楚原因。
 */
export async function startSpeakJob(input: {
  voice_id: string;
  script: string;
  source_job_id?: string;
  source_index?: number;
  image_url?: string;
  avatar_id?: string;
  avatar_name?: string;
  aspect_ratio?: string;
  duration?: number | null;
}): Promise<Job> {
  if (forcedMockMode()) {
    throw new ApiError("MOCK_MODE", "当前处于演示模式，未提交真实生成", 0);
  }
  const accepted = await createSpeakJob(input);
  const job = accepted.job as Job;
  if (accepted.estimated_points != null) {
    job.input = { ...job.input, estimated_points: accepted.estimated_points };
  }
  remoteJobs.add(job.id);
  upsertJob(job);
  startPoll(job.id);
  return job;
}

/** 从任务中心回到等待页时调用：远程任务补上轮询，本地任务继续推进。 */
export function resumeJob(id: string): Job | undefined {
  if (remoteJobs.has(id)) {
    const job = getJob(id);
    if (job && job.status === "running") startPoll(id);
    return job;
  }
  return resumeLocalJob(id);
}

/**
 * 重试 / 换一批。
 * - 不传 variant：原地重试，已经成功的候选图会复用（后端只补失败的）；
 * - 传新的 variant：换一批，整批重新生成。
 */
export async function restartJob(
  id: string,
  patch: { prompt?: string; count?: number; variant?: number } = {},
): Promise<Job | undefined> {
  if (!remoteJobs.has(id)) return restartLocalJob(id, patch);
  const job = (await retryRemoteJob(id, patch)) as Job;
  upsertJob(job);
  startPoll(id);
  return job;
}

/** 取消。后端不可达 / 出错直接抛错（本地演示任务就地取消）。 */
export async function cancelJob(id: string): Promise<Job | undefined> {
  if (!remoteJobs.has(id)) return cancelLocalJob(id);
  const job = (await cancelRemoteJob(id)) as Job;
  upsertJob(job);
  stopPoll(id);
  return job;
}

/**
 * 删除一条任务记录。后端任务会连产物文件一起清掉（成片、候选图）；
 * 本地演示任务直接移除。调用方负责先让用户确认。
 *
 * 注意：成片被删后，引用它的创作记录会显示「没有成片」—— 这是有意的：
 * 文件都没了，假装还能播才是 bug。
 */
export async function deleteJob(id: string): Promise<boolean> {
  stopPoll(id);
  if (remoteJobs.has(id)) {
    try {
      await deleteRemoteJob(id);
    } catch (err) {
      // 网络不通 / 后端重启丢了这条记录：本地删掉即可，别把用户卡死
      if (!isBackendIssue(err) || ((err as ApiError).status !== 0 && (err as ApiError).status !== 404)) {
        throw err;
      }
    }
    remoteJobs.delete(id);
  }
  return removeLocalJob(id);
}

/**
 * 按 id 取任务；本地没有就向后端要一次（带 ?job= 进来但本地列表已刷新过时用得上）。
 */
export async function fetchJobById(id: string): Promise<Job | undefined> {
  const local = getJob(id);
  if (local) return local;
  try {
    const job = (await fetchJob(id)) as Job;
    remoteJobs.add(job.id);
    upsertJob(job);
    if (job.status === "running" || job.status === "queued") startPoll(job.id);
    return getJob(job.id);
  } catch {
    return undefined;
  }
}

/**
 * 用后端的任务列表刷新本地列表。
 *
 * 本地列表是内存态，刷新页面就没了；后端才是真的落库的那一份，
 * 所以任务中心打开时对齐一次，之前生成过的形象任务还能点回去看候选。
 * 后端不可用就保持本地数据（含演示用的种子任务）。
 */
export async function hydrateJobs(): Promise<number> {
  if (forcedMockMode()) return 0;
  try {
    const data = await fetchJobs({ limit: 50 });
    let added = 0;
    for (const job of data.jobs as Job[]) {
      remoteJobs.add(job.id);
      upsertJob(job);
      // 还在跑的任务继续跟着后端更新
      if (job.status === "running" || job.status === "queued") startPoll(job.id);
      added += 1;
    }
    if (added) console.info(`[portrait] 从后端同步了 ${added} 条任务`);
    return added;
  } catch {
    return 0;
  }
}
