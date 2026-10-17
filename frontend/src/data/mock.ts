import type { Avatar, AvatarView, Job, JobError, JobStatus } from "./types";
import { removeCreationsOfAvatar, setCreations } from "./creations";
import { clearLegacyStorage, libraryApi, readLegacyStorage } from "./library";
import { fetchLibrary, type LibrarySnapshot } from "../lib/api";

/**
 * 模拟数据。仅用于 UI 框架演示，不连接后端。
 * Avatar 的 views 覆盖三种完整度：三视图齐全 / 缺背面 / 仅正面。
 *
 * **用户自己产出的角色存在后端**（/api/library，见 library.ts），启动时由
 * ensureLibraryLoaded() 灌入。否则刷新一次就没了 —— 而角色必须留下来，
 * 因为「让 TA 开口说话」要拿它的形象图发给上游；没有真实形象图的种子角色
 * 根本发不出去。
 */

const SEED_AVATARS: Avatar[] = [
  {
    id: "avatar_001",
    name: "小鹿",
    voice_id: "voice_001",
    views: { front: null, side: null, back: null },
    source: "generated",
    prompt: "A warm woman in her thirties, friendly smile, soft light",
    profile: {
      summary: "一位三十多岁的温和女性，擅长讲故事，语气让人放松。",
      ageRange: "30-35 岁",
      personality: "温和、耐心",
      style: "叙事 / 有声书",
    },
    created_at: "2026-10-09T10:00:00Z",
  },
  {
    id: "avatar_002",
    name: "阿澈",
    voice_id: "voice_005",
    views: { front: null, side: null },
    source: "generated",
    prompt: "A calm young man in his twenties, clean shirt, studio background",
    profile: {
      summary: "二十多岁的干净男生，语速平稳，适合知识类内容。",
      ageRange: "22-28 岁",
      personality: "沉稳、清晰",
      style: "知识分享 / 课程",
    },
    created_at: "2026-10-10T14:30:00Z",
  },
  {
    id: "avatar_003",
    name: "Momo",
    voice_id: "voice_003",
    views: { front: null },
    source: "generated",
    prompt: "A bright young woman, energetic smile, colorful background",
    profile: {
      summary: "明亮的年轻女生，语气有活力，适合带货口播。",
      ageRange: "20-26 岁",
      personality: "活泼、热情",
      style: "带货 / 广告",
    },
    created_at: "2026-10-12T09:15:00Z",
  },
];

const SEED_AVATAR_IDS = new Set(SEED_AVATARS.map((a) => a.id));

/**
 * 角色 = 后端用户产出库 + 种子合成，启动时异步灌入（根布局会等它完成再渲染）。
 *
 * 顺序：新建的在前（最近做的排最前），种子按原顺序跟在后面。
 * 种子上被改过的地方（avatar_patches）在合成时覆盖回来。
 */
export const avatars: Avatar[] = [];

let libReady: Promise<void> | null = null;

/**
 * 从后端拉用户产出并灌入内存（幂等，只跑一次）。
 * 后端不可用时降级为纯种子数据：页面照常跑，改动只活在本会话。
 */
export function ensureLibraryLoaded(): Promise<void> {
  if (!libReady) {
    libReady = hydrateLibrary().catch((err) => {
      console.warn("[library] 后端不可用，使用种子数据（改动不会跨会话保留）", err);
    });
  }
  return libReady;
}

async function hydrateLibrary(): Promise<void> {
  const lib = await fetchLibrary();
  await migrateLegacy(lib);
  applyLibrary(lib);
  notifyDataChange();
}

/**
 * 聚焦刷新：切回 tab / 从其它页面返回时重新拉后端用户产出库并覆盖内存。
 * 用户增量（新建/删除/补丁）每次操作都即时同步到后端，所以整份覆盖是安全的；
 * 后端不可用时保留现有内存数据，不打断页面。
 */
export async function refreshLibrary(): Promise<void> {
  try {
    const lib = await fetchLibrary();
    applyLibrary(lib);
    notifyDataChange();
  } catch (err) {
    console.warn("[library] 聚焦刷新失败，保留当前数据", err);
  }
}

/**
 * 一次性迁移：老版本存在浏览器 localStorage 里的用户增量搬进后端，搬完清 key。
 * 以本地为准覆盖远端（远端此时要么为空要么是上次迁移的同一份数据）。
 */
async function migrateLegacy(lib: LibrarySnapshot): Promise<void> {
  const legacy = readLegacyStorage();
  if (!legacy) return;
  const syncs: Promise<unknown>[] = [];

  for (const a of legacy.created) {
    const i = lib.created_avatars.findIndex((x) => x.id === a.id);
    if (i >= 0) lib.created_avatars[i] = a;
    else lib.created_avatars.push(a);
    syncs.push(
      libraryApi.putCreatedAvatar(a).catch((err) => console.warn("[library] 迁移角色失败", a.id, err)),
    );
  }
  for (const [id, patch] of Object.entries(legacy.patches)) {
    lib.avatar_patches[id] = patch;
    syncs.push(
      libraryApi.putAvatarPatch(id, patch).catch((err) => console.warn("[library] 迁移修改失败", id, err)),
    );
  }
  for (const id of legacy.deletedSeeds) {
    if (!lib.deleted_seed_avatars.includes(id)) lib.deleted_seed_avatars.push(id);
    syncs.push(
      libraryApi.putDeletedSeed(id).catch((err) => console.warn("[library] 迁移删除标记失败", id, err)),
    );
  }
  for (const c of legacy.creations) {
    const i = lib.creations.findIndex((x) => x.id === c.id);
    if (i >= 0) lib.creations[i] = c;
    else lib.creations.push(c);
    syncs.push(
      libraryApi.putCreation(c).catch((err) => console.warn("[library] 迁移创作失败", c.id, err)),
    );
  }

  await Promise.all(syncs);
  clearLegacyStorage(legacy.keys);
}

function applyLibrary(lib: LibrarySnapshot): void {
  const patches = lib.avatar_patches ?? {};
  const deleted = new Set(lib.deleted_seed_avatars ?? []);
  const created = [...(lib.created_avatars ?? [])]
    .filter((a) => !deleted.has(a.id))
    .sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
  const seeds = SEED_AVATARS.filter((a) => !deleted.has(a.id)).map((a) =>
    patches[a.id] ? { ...a, ...patches[a.id] } : a,
  );
  const createdIds = new Set(created.map((a) => a.id));
  avatars.length = 0;
  avatars.push(...created, ...seeds.filter((a) => !createdIds.has(a.id)));
  setCreations(lib.creations ?? []);
}

/**
 * 角色改动落库。后端保存时会把 views 里引用的任务产物地址重写成
 * 创作媒体快照地址（删任务也不失效），这里用返回值回写内存对象，
 * 保证本会话内的卡面一直用稳定地址显示，而不是等着下次聚焦刷新。
 */
async function syncAvatar(a: Avatar): Promise<void> {
  try {
    if (SEED_AVATAR_IDS.has(a.id)) {
      const res = await libraryApi.putAvatarPatch(a.id, a);
      const views = (res?.patch as Avatar["views"] | undefined) ?? null;
      if (views) Object.assign(a.views, views);
    } else {
      const res = await libraryApi.putCreatedAvatar(a);
      if (res?.views) a.views = { ...a.views, ...(res.views as Avatar["views"]) };
    }
    notifyDataChange();
  } catch (err) {
    console.warn("[library] 角色未同步到后端（本会话内仍可用）", err);
  }
}

export function getAvatar(id: string | undefined): Avatar | undefined {
  return avatars.find((a) => a.id === id);
}

/** 更新角色信息（编辑角色信息弹窗保存用），改动同步到后端 */
export async function updateAvatar(id: string, patch: Partial<Avatar>): Promise<Avatar | undefined> {
  const target = avatars.find((a) => a.id === id);
  if (target) {
    Object.assign(target, patch);
    notifyDataChange();
    await syncAvatar(target);
  }
  return target;
}

/* ---------- 数据变更订阅（UI 阶段替代后端推送） ---------- */

const dataListeners = new Set<() => void>();

/** 订阅 mock 数据变更；返回取消订阅函数 */
export function subscribeData(listener: () => void): () => void {
  dataListeners.add(listener);
  return () => {
    dataListeners.delete(listener);
  };
}

export function notifyDataChange(): void {
  dataListeners.forEach((l) => l());
}

/** 追加一条任务（保存创作后在任务中心可见） */
export function addJob(job: Job): Job {
  jobs.unshift(job);
  notifyDataChange();
  return job;
}

/** 写入 / 更新一条任务（后端返回的任务走这里进本地列表，页面才能照常读） */
export function upsertJob(job: Job): Job {
  const i = jobs.findIndex((j) => j.id === job.id);
  if (i >= 0) jobs[i] = { ...jobs[i], ...job };
  else jobs.unshift({ ...job });
  notifyDataChange();
  return jobs.find((j) => j.id === job.id) as Job;
}

/** 追加一个 Avatar（创建流程保存后，能在「我的 Avatar」里看到，并入库） */
export async function addAvatar(avatar: Avatar): Promise<Avatar> {
  avatars.unshift(avatar);
  notifyDataChange();
  await syncAvatar(avatar);
  return avatar;
}

/**
 * 删除一个 Avatar（列表 / 详情页的删除入口），删除标记入库。
 *
 * - 自建角色：从库里删除整条文档；
 * - 种子角色：代码里删不掉，记一条删除标记（刷新不复活）；
 * - 该角色的创作记录一并清掉（脸都没了，成片留着只会变成死链）。
 * 后端任务记录不动 —— 那是历史账本，任务中心里自己删。
 */
export async function removeAvatar(id: string): Promise<boolean> {
  const i = avatars.findIndex((a) => a.id === id);
  if (i < 0) return false;
  // 先删创作再删角色：creations 模块不依赖 mock，无循环引用
  await removeCreationsOfAvatar(id);
  const wasSeed = SEED_AVATAR_IDS.has(id);
  avatars.splice(i, 1);
  notifyDataChange();
  try {
    if (wasSeed) {
      await libraryApi.putDeletedSeed(id);
      // 种子的修改补丁一并清掉：恢复种子时应该回到默认样子
      await libraryApi.deleteAvatarPatch(id).catch(() => undefined);
    } else {
      await libraryApi.deleteCreatedAvatar(id);
    }
  } catch (err) {
    console.warn("[library] 删除标记未同步到后端（本会话内已生效）", err);
  }
  return true;
}

/** 从本地任务列表移除一条任务（后端任务的真删除走 portrait.ts 的 deleteJob）。 */
export function removeJob(id: string): boolean {
  const i = jobs.findIndex((j) => j.id === id);
  if (i < 0) return false;
  jobs.splice(i, 1);
  notifyDataChange();
  return true;
}

/** 按 id 取任务 */
export function getJob(id: string | undefined | null): Job | undefined {
  if (!id) return undefined;
  return jobs.find((j) => j.id === id);
}

/** 更新任务字段（演示用；真实环境由后端推送任务状态） */
export function updateJob(id: string, patch: Partial<Job>): Job | undefined {
  const job = getJob(id);
  if (!job) return undefined;
  Object.assign(job, patch, { updated_at: new Date().toISOString() });
  notifyDataChange();
  return job;
}

/* ---------- 演示用「后台任务推进器」 ----------
 * 真实环境里任务由后端执行、前端轮询；这里用一个模块级定时器模拟，
 * 于是「生成时可以离开页面，回来后任务还在推进 / 已经完成」这件事是真的。
 *
 * 只推进「创建流程创建的任务」和「被显式 resume 的任务」：
 * 种子任务（job_001 等）保持固定状态，保证任务中心四种状态随时都能演示。
 */
const DRIVE_TICK_MS = 200;
const DRIVE_STEP = 8; // 每 tick +8% → 约 2.5 秒完成
const drivenJobs = new Set<string>();
let driver: ReturnType<typeof setInterval> | null = null;

function stopDriverIfIdle() {
  if (drivenJobs.size === 0 && driver) {
    clearInterval(driver);
    driver = null;
  }
}

/** 任务完成时的产物（UI 阶段没有真实文件，按类型给出占位结构） */
function completedOutput(job: Job): Job["output"] {
  if (job.output) return job.output;
  if (job.type === "portrait") {
    return { image_urls: Array.from({ length: job.input.count ?? 3 }, () => null) };
  }
  if (job.type === "speak") {
    // mock 不会真的出片，只把时长带上：任务卡要显示「X 秒 · Y 点」得靠它
    return { video_url: null, duration: job.input.duration ?? null };
  }
  // tts：试听音轨地址由调用方自己拿，任务卡只作记录
  return {};
}

function ensureDriver() {
  if (driver) return;
  driver = setInterval(() => {
    let changed = false;
    for (const id of [...drivenJobs]) {
      const job = getJob(id);
      if (!job || job.status !== "running") {
        drivenJobs.delete(id);
        continue;
      }
      const next = Math.min(100, (job.progress ?? 0) + DRIVE_STEP);
      Object.assign(job, { progress: next, updated_at: new Date().toISOString() });
      if (next >= 100) {
        drivenJobs.delete(id);
        Object.assign(job, {
          status: "succeeded" as JobStatus,
          output: completedOutput(job),
        });
      }
      changed = true;
    }
    stopDriverIfIdle();
    if (changed) notifyDataChange();
  }, DRIVE_TICK_MS);
}

/** 发起一条「生成候选形象」任务：写入任务中心并开始后台推进 */
export function startPortraitJob(input: { voice_id: string; prompt: string; count?: number }): Job {
  const now = new Date().toISOString();
  const job: Job = {
    id: `job_${Date.now()}`,
    type: "portrait",
    status: "running",
    progress: 0,
    input: { voice_id: input.voice_id, prompt: input.prompt, count: input.count ?? 3 },
    output: null,
    error: null,
    created_at: now,
    updated_at: now,
  };
  jobs.unshift(job);
  drivenJobs.add(job.id);
  ensureDriver();
  notifyDataChange();
  return job;
}

/** 继续推进一条已存在但没在推进的任务（从任务中心回到等待页时用） */
export function resumeJob(id: string): Job | undefined {
  const job = getJob(id);
  if (!job || job.status !== "running") return job;
  drivenJobs.add(id);
  ensureDriver();
  return job;
}

/** 重新开始一条任务（失败重试 / 改完设定重新生成候选） */
export function restartJob(
  id: string,
  patch?: { prompt?: string; count?: number },
): Job | undefined {
  const job = getJob(id);
  if (!job) return undefined;
  Object.assign(job, {
    status: "running" as JobStatus,
    progress: 0,
    output: null,
    error: null,
    input: { ...job.input, ...patch },
    updated_at: new Date().toISOString(),
  });
  drivenJobs.add(id);
  ensureDriver();
  notifyDataChange();
  return job;
}

/** 停止推进并把任务标记为失败（用户取消 / 模拟上游失败） */
export function failJob(id: string, error: JobError): Job | undefined {
  const job = getJob(id);
  if (!job) return undefined;
  drivenJobs.delete(id);
  stopDriverIfIdle();
  Object.assign(job, {
    status: "failed" as JobStatus,
    error,
    updated_at: new Date().toISOString(),
  });
  notifyDataChange();
  return job;
}

/** 用户主动取消生成 */
export function cancelJob(id: string): Job | undefined {
  return failJob(id, { code: "CANCELED", message: "已取消生成，积分未扣除" });
}

export function avatarsOfVoice(voiceId: string): Avatar[] {
  return avatars.filter((a) => a.voice_id === voiceId);
}

/** 该视图是否已生成 */
export function hasView(avatar: Avatar, view: AvatarView): boolean {
  return view in avatar.views;
}

/** 已生成视图数量（0-3） */
export function viewCount(avatar: Avatar): number {
  return (["front", "side", "back"] as AvatarView[]).filter((v) => hasView(avatar, v)).length;
}

/** 三视图占位图的种子：同一形象的不同视图用不同配色区分 */
export function viewSeed(avatarId: string, view: AvatarView): string {
  return view === "front" ? avatarId : `${avatarId}-${view}`;
}

/** 生成中的候选图占位 URL（UI 阶段无真实图片） */
export const candidatePlaceholders = [null, null, null];

/**
 * 任务列表（内存态；刷新后由 hydrateJobs 从后端对齐）。
 *
 * **不再放演示种子任务**：几条写死的假任务点进去什么都没有，还会和用户真做的
 * 任务混在一起。四种状态（queued / running / succeeded / failed）在真实使用中
 * 都会出现，本地演示推进器负责把任务从 running 带到 succeeded。
 */
export const jobs: Job[] = [];

export function jobsOfAvatar(avatarId: string): Job[] {
  return jobs.filter((j) => j.input.avatar_id === avatarId);
}
