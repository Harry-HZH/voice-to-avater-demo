/**
 * 后端 API 层。
 *
 * 后端提供声音库与真实音源（见 voice-to-avater-demo/backend）：
 *   GET  /api/voices              我的声音库（20 个种子人设 + 导入的音色）
 *   GET  /api/voices/{id}/sample  试听音源（真实人声 mp3，本地缓存）
 *   POST /api/voices/{id}/preview 用该声音合成任意文案
 *   GET  /api/catalog/voices      浏览 ThankYou 音色目录
 *
 * 候选形象也走后端（真实文生图）：
 *   POST /api/portraits           提交生成 N 张候选形象（返回 queued 任务）
 *   POST /api/portraits/views     用选定的候选图生成侧面 / 背面
 *   GET  /api/jobs/{id}           轮询任务状态与产物
 *   GET  /api/jobs/{id}/image/{i} 候选图 / 三视图图片
 *   POST /api/jobs/{id}/cancel    取消
 *   POST /api/jobs/{id}/retry     重试 / 换一批
 *
 * 创作（让角色开口说话）：
 *   POST /api/speak/preview       台词试听（约 1.5 点，拿到真实秒数 + 精确费用）
 *   GET  /api/speak/audio/{key}   台词音轨
 *   POST /api/speak               提交（人物图 + 音轨 → 会说话的视频）
 *   GET  /api/jobs/{id}/video     成片
 *   GET  /api/jobs/{id}/voice     成片的台词音轨
 *
 * 所有请求都带兜底：后端不可用时返回 null/抛错，调用方回退到本地 mock，
 * 保证纯前端 demo 仍然能跑。
 */

import type { Avatar, Creation, Job, Voice } from "../data/types";

const DEFAULT_BASE = "http://localhost:8000";

/** 后端地址。可用 EXPO_PUBLIC_API_BASE_URL 覆盖（frontend/.env）。 */
export const API_BASE = (
  process.env.EXPO_PUBLIC_API_BASE_URL || DEFAULT_BASE
).replace(/\/+$/, "");

/** 把后端返回的相对产物地址补成可播放 / 可显示的绝对地址。 */
export function absUrl(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  // 已经带 scheme 的一律原样返回：http(s) 是上游地址，data:/blob: 是内联 / 本地资源。
  // 少了这一步，data:image/png;base64,... 会被拼成 http://localhost:8000/data:...，
  // 变成一个永远加载不出来的地址。
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
  return `${API_BASE}${url.startsWith("/") ? "" : "/"}${url}`;
}

export class ApiError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/**
 * 面向用户的报错文案。
 *
 * 原则：后端/网络的详细错误（堆栈、上游地址、HTTP 码）一律不给用户看，
 * 统一兜底成「系统繁忙，请稍后再试」；只有两类例外：
 *   - VALIDATION_ERROR：用户输入本身的问题（如提示词不合规），改不了提示词永远会再错；
 *   - CANCELED：取消是用户自己的操作，用既定文案。
 */
export function userErrorMessage(err: unknown, fallback = "系统繁忙，请稍后再试"): string {
  if (err instanceof ApiError) {
    if (err.code === "VALIDATION_ERROR") return err.message || fallback;
    if (err.code === "CANCELED") return err.message || "已取消生成";
    // 演示模式是显式声明的状态说明，不是系统错误
    if (err.code === "MOCK_MODE") return err.message || "当前处于演示模式，未提交真实生成";
  }
  if (err && typeof err === "object" && "code" in err) {
    const code = String((err as { code?: unknown }).code);
    if (code === "VALIDATION_ERROR") {
      const msg = (err as { message?: unknown }).message;
      if (typeof msg === "string" && msg) return msg;
    }
    if (code === "CANCELED") {
      const msg = (err as { message?: unknown }).message;
      if (typeof msg === "string" && msg) return msg;
    }
  }
  return fallback;
}

/** 统一把后端的 { error: { code, message } } 转成 ApiError。 */
async function raiseForStatus(resp: Response): Promise<never> {
  let code = `HTTP_${resp.status}`;
  let message = resp.statusText || "请求失败";
  try {
    const body = await resp.json();
    const detail = body?.detail?.error || body?.error;
    if (detail) {
      code = detail.code || code;
      message = detail.message || message;
    } else if (typeof body?.detail === "string") {
      message = body.detail;
    }
  } catch {
    /* 保留默认信息 */
  }
  throw new ApiError(code, message, resp.status);
}

/** 请求超时（毫秒）。移动端 Wi-Fi 静默断连时 fetch 会挂起等 TCP 超时（可达几十秒），
 *  不设超时的话轮询防重入锁被占住，失败计数不走，错误迟迟报不出来。 */
const REQUEST_TIMEOUT_MS = 8000;

async function request<T>(path: string, init?: RequestInit & { timeoutMs?: number }): Promise<T> {
  let resp: Response;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), init?.timeoutMs ?? REQUEST_TIMEOUT_MS);
  try {
    resp = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
      signal: abort.signal,
    });
  } catch (err) {
    throw new ApiError("NETWORK_ERROR", `无法连接后端（${API_BASE}）`, 0);
  } finally {
    clearTimeout(timer);
  }

  if (!resp.ok) await raiseForStatus(resp);
  if (resp.status === 204) return undefined as T;
  return (await resp.json()) as T;
}

/* ---------- 声音库 ---------- */

export interface VoiceListResult {
  voices: Voice[];
  total: number;
  samplesReady: number;
}

export async function fetchVoices(): Promise<VoiceListResult> {
  const data = await request<{ voices: Voice[]; total: number; samples_ready: number }>("/api/voices");
  return { voices: data.voices, total: data.total, samplesReady: data.samples_ready };
}

export async function fetchVoice(id: string): Promise<Voice> {
  return request<Voice>(`/api/voices/${encodeURIComponent(id)}`);
}

export interface PreviewAccepted {
  job: Job;
  poll_url: string;
}

/** 用指定声音把一段文字念出来（真实 TTS）。返回 queued 的任务。 */
export async function createPreview(voiceId: string, text: string): Promise<PreviewAccepted> {
  return request<PreviewAccepted>(`/api/voices/${encodeURIComponent(voiceId)}/preview`, {
    method: "POST",
    body: JSON.stringify({ text }),
  });
}

export async function fetchJob(jobId: string): Promise<Job> {
  return request<Job>(`/api/jobs/${encodeURIComponent(jobId)}`);
}

/** 后端任务列表（任务中心打开时用它对齐一次本地列表）。 */
export async function fetchJobs(
  { type, status, limit = 50 }: { type?: string; status?: string; limit?: number } = {},
): Promise<{ jobs: Job[] }> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (type) params.set("type", type);
  if (status) params.set("status", status);
  return request<{ jobs: Job[] }>(`/api/jobs?${params.toString()}`);
}

/** 轮询任务直到终态。
 *
 * 网络错误容忍到截止时间：一次 fetch 失败（8s 超时 / Wi-Fi 抖动）不代表任务失败，
 * 后端可能还在跑甚至已完成——否则用户会看到「试听失败」，重试一次又秒出结果
 * （其实第一次的任务早就成功了）。只有拿到明确终态或整体超时才算数。
 */
export async function waitJob(
  jobId: string,
  { intervalMs = 1500, timeoutMs = 60000 } = {},
): Promise<Job> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let job: Job;
    try {
      job = await fetchJob(jobId);
    } catch (err) {
      if (Date.now() > deadline) {
        throw new ApiError("POLL_TIMEOUT", "生成超时，请稍后重试", 0);
      }
      await new Promise((r) => setTimeout(r, intervalMs));
      continue;
    }
    if (job.status === "succeeded" || job.status === "failed") return job;
    if (Date.now() > deadline) {
      throw new ApiError("POLL_TIMEOUT", "生成超时，请稍后重试", 0);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/* ---------- 音色目录 ---------- */

export interface CatalogVoice {
  provider_voice_id: string;
  name: string;
  languages: string[];
  provider: string;
  has_preview: boolean;
}

export interface CatalogResult {
  voices: CatalogVoice[];
  total: number;
  page: number;
  page_size: number;
  languages: Record<string, number>;
}

export async function fetchCatalog(
  { q, language, page = 1, pageSize = 20 }: { q?: string; language?: string; page?: number; pageSize?: number } = {},
): Promise<CatalogResult> {
  const params = new URLSearchParams({ page: String(page), page_size: String(pageSize) });
  if (q) params.set("q", q);
  if (language) params.set("language", language);
  return request<CatalogResult>(`/api/catalog/voices?${params.toString()}`);
}

export async function importVoice(providerVoiceId: string, name: string, language: string): Promise<Voice> {
  return request<Voice>("/api/voices/import", {
    method: "POST",
    body: JSON.stringify({ provider_voice_id: providerVoiceId, name, language }),
  });
}

/* ---------- 音源就绪等待 ---------- */

/**
 * 试听音源可能尚未生成（后端返回 202 + 后台生成中）。
 * 这里探测到就绪（200/206）再交给播放器，避免 <audio> 播到 JSON。
 *
 * 用 `Range: bytes=0-0` 而不是 HEAD：既能只取一个字节，又不受
 * 各服务器对 HEAD 支持不一致的影响（FastAPI 的 GET 路由不一定挂 HEAD）。
 */
export async function waitForSample(
  sampleUrl: string,
  { intervalMs = 2500, timeoutMs = 45000, probeTimeoutMs = 8000 } = {},
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let status = 0;
    // 探测也必须带超时：移动端连接静默挂起时，一次挂死的 fetch 就能
    // 吃光整个 45s 预算直接报超时，而后端其实早已生成完（重试就秒出）。
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), probeTimeoutMs);
    try {
      const resp = await fetch(sampleUrl, { headers: { Range: "bytes=0-0" }, signal: abort.signal });
      status = resp.status;
      // 就绪：200/206 是音频；202 表示后端正在生成
      if (status === 200 || status === 206) {
        try {
          await resp.body?.cancel();
        } catch {
          /* 忽略 */
        }
        return sampleUrl;
      }
    } catch {
      status = 0;
    } finally {
      clearTimeout(timer);
    }
    if (Date.now() > deadline) {
      throw new ApiError("SAMPLE_TIMEOUT", "音源生成超时，请稍后重试", status);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

export async function health(): Promise<{ status: string; samples_ready: number; voices_total: number }> {
  return request("/api/health");
}

/* ---------- 候选形象（真实文生图） ---------- */

export interface PortraitJobAccepted {
  job: Job;
  poll_url: string;
  /** 预计消耗（点数）。后端生成前会先估价，失败时为 null。 */
  estimated_points: number | null;
}

/** 提交一次候选形象生成。立刻返回 queued 任务，之后轮询 fetchJob。 */
export async function createPortraitJob(input: {
  voice_id: string;
  prompt: string;
  count?: number;
  variant?: number;
}): Promise<PortraitJobAccepted> {
  return request<PortraitJobAccepted>("/api/portraits", {
    method: "POST",
    body: JSON.stringify({ variant: 0, ...input }),
  });
}

/** 用选定的候选图作参考，生成侧面 / 背面（保持同一人物）。 */
export async function createViewsJob(input: {
  job_id?: string;
  index?: number;
  views?: string[];
  reference_url?: string;
  voice_id?: string;
  prompt?: string;
}): Promise<PortraitJobAccepted> {
  return request<PortraitJobAccepted>("/api/portraits/views", {
    method: "POST",
    body: JSON.stringify({ views: ["side", "back"], ...input }),
  });
}

export async function cancelRemoteJob(jobId: string): Promise<Job> {
  return request<Job>(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, { method: "POST" });
}

/** 删除一条任务记录（后端会连产物文件一起清掉）。仅终态任务可删，否则 409。 */
export async function deleteRemoteJob(jobId: string): Promise<{ deleted: boolean; id: string }> {
  return request(`/api/jobs/${encodeURIComponent(jobId)}`, { method: "DELETE" });
}

/**
 * 重试 / 换一批。
 * 不传 variant → 复用已成功的候选图，只补失败的；
 * 传新 variant → 换一批，整批重出。
 */
export async function retryRemoteJob(
  jobId: string,
  patch: { prompt?: string; count?: number; variant?: number } = {},
): Promise<Job> {
  return request<Job>(`/api/jobs/${encodeURIComponent(jobId)}/retry`, {
    method: "POST",
    body: JSON.stringify(patch),
  });
}

/* ---------- 用户产出库（角色 / 角色修改 / 删除标记 / 创作记录） ---------- */

export interface LibrarySnapshot {
  created_avatars: Avatar[];
  avatar_patches: Record<string, Partial<Avatar>>;
  deleted_seed_avatars: string[];
  creations: Creation[];
}

export async function fetchLibrary(): Promise<LibrarySnapshot> {
  return request<LibrarySnapshot>("/api/library");
}

/** upsert 一条用户产出（路径形如 `created-avatars/avatar_x`）。 */
/** 保存一条库文档，返回后端落库后的版本（媒体 URL 可能已被重写成快照地址）。 */
export async function putLibraryDoc(
  path: string,
  doc: unknown,
): Promise<Record<string, unknown> | undefined> {
  return await request<Record<string, unknown>>(`/api/library/${path}`, {
    method: "PUT",
    body: JSON.stringify(doc),
  });
}

export async function deleteLibraryDoc(path: string): Promise<void> {
  await request(`/api/library/${path}`, { method: "DELETE" });
}

/* ---------- 创作：让角色开口说话 ---------- */

export interface SpeakPreview {
  /** 音轨的缓存键。出片时后端按同一个键复用这份音轨，不会重复花 TTS 的钱 */
  key: string;
  /** 相对地址，播放时用 absUrl 补全 */
  audio_url: string;
  /** 音轨时长（秒）。读不出来时为 null */
  duration: number | null;
  duration_known: boolean;
  /** 预估消耗点数 = 秒数 × 单秒单价（720p 20 点/秒） */
  estimated_points: number | null;
  resolution: string;
  max_seconds: number;
  /** 超出时长上限：前端应拦下「生成视频」并提示改短台词 */
  over_limit: boolean;
  cached: boolean;
}

/**
 * 台词试听：把台词合成成音轨，返回**真实秒数**与精确费用。
 *
 * 这一步会真花点数（约 1.5 点），但换来的是后面那几百点的确定性 ——
 * 视频按输出秒数计费，先听一遍再决定要不要出片，是这块唯一诚实的做法。
 */
export async function requestSpeakPreview(input: {
  voice_id: string;
  script: string;
}): Promise<SpeakPreview> {
  // 这条接口是同步的：后端会在请求里等上游 TTS 跑完才返回（合成完按
  // 音色+台词缓存）。TTS 正常 5~20 秒，绝不能用 8 秒的全局默认超时——
  // 否则前端准时 abort 报「试听失败」，用户再点一次才命中缓存秒出。
  return request<SpeakPreview>("/api/speak/preview", {
    method: "POST",
    body: JSON.stringify(input),
    timeoutMs: 60000,
  });
}

/**
 * 提交一条「让角色说这段话」的任务。
 *
 * 形象图来源二选一：`source_job_id` + `source_index`（取那条候选任务里选中的那张），
 * 或直接给 `image_url`。后端会优先用任务里记下的上游地址，省一次上传。
 */
export async function createSpeakJob(input: {
  voice_id: string;
  script: string;
  source_job_id?: string;
  source_index?: number;
  image_url?: string;
  avatar_id?: string;
  avatar_name?: string;
  aspect_ratio?: string;
  duration?: number | null;
}): Promise<PortraitJobAccepted> {
  return request<PortraitJobAccepted>("/api/speak", {
    method: "POST",
    body: JSON.stringify(input),
  });
}
