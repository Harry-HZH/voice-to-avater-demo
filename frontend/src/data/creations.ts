import type { Creation, CreationType } from "./types";
import type { Feather } from "@expo/vector-icons";
import { libraryApi } from "./library";

/**
 * 创作库。现在只有一种玩法：**让角色开口说话**。
 *
 * 之前那套「选类型 → 配参数 → 自由输入动画编排」的向导已经拆掉了。原因很直接：
 * 它把「动画怎么运镜」这种连模型都执行不了的自由文本丢给用户填，是把技术难题
 * 伪装成用户输入；而用户真正要的东西只有两样 —— 一张脸（已经做好了）和一句话。
 */

export const CREATION_META: {
  key: CreationType;
  label: string;
  icon: keyof typeof Feather.glyphMap;
  desc: string;
} = {
  key: "speak",
  label: "开口说话",
  icon: "mic",
  desc: "用角色的形象和音色，把一段台词说成视频",
};

export function creationTypeOf(_key: CreationType) {
  return CREATION_META;
}

/** 台词输入框的引导文案 */
export const SCRIPT_FIELD = {
  label: "台词",
  hint: "用角色的音色念出来。视频按秒计费，写短一点更省钱 —— 30 秒以内最稳。",
  placeholder: "输入角色要说的内容，例如：大家好，我是小鹿，今天想和你聊三件事…",
};

/** 台词字数上限（后端 SpeakRequest.script 也是 1000） */
export const SCRIPT_MAX = 1000;

/* ---------- 创作库 ---------- */

/**
 * 创作库。**初始为空，启动时由 mock.ts 的 ensureLibraryLoaded() 从后端灌入**
 * （成片记录现在存在后端 MongoDB，浏览器只是内存缓存）。
 *
 * 用户保存的成片会 PUT 到后端：成片是花了几百点做出来的，
 * 刷新一次就消失是不可接受的。
 */
export const creations: Creation[] = [];

/** 启动时用后端返回的创作库整体替换内存数组（按更新时间倒序）。 */
export function setCreations(list: Creation[]): void {
  const sorted = [...(list ?? [])].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  creations.length = 0;
  creations.push(...sorted);
}

/** 后端写失败的降级：数据仍在内存里，本会话可读，刷新后丢（控制台有记录） */
function warnSync(what: string, err: unknown): void {
  console.warn(`[creations] ${what}未同步到后端（本会话内仍可用）`, err);
}

export function getCreation(id: string | undefined): Creation | undefined {
  return creations.find((c) => c.id === id);
}

export function creationsOfAvatar(avatarId: string): Creation[] {
  return creations
    .filter((c) => c.avatar_id === avatarId)
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

/** 删除一条创作记录（后端同步删除）。返回是否真的删了（id 不存在时为 false）。 */
export async function removeCreation(id: string): Promise<boolean> {
  const i = creations.findIndex((c) => c.id === id);
  if (i < 0) return false;
  creations.splice(i, 1);
  try {
    await libraryApi.deleteCreation(id);
  } catch (err) {
    warnSync("删除", err);
  }
  return true;
}

/** 删除某个角色的全部创作记录（删除 Avatar 时连带清理）。返回删除条数。 */
export async function removeCreationsOfAvatar(avatarId: string): Promise<number> {
  const doomed = creations.filter((c) => c.avatar_id === avatarId);
  if (doomed.length === 0) return 0;
  const kept = creations.filter((c) => c.avatar_id !== avatarId);
  creations.length = 0;
  creations.push(...kept);
  await Promise.all(
    doomed.map(async (c) => {
      try {
        await libraryApi.deleteCreation(c.id);
      } catch (err) {
        warnSync(`删除 ${c.id}`, err);
      }
    }),
  );
  return doomed.length;
}

/**
 * id 序号。**必须在保存时从当前数组推导**，不能写死 100，也不能在模块加载时
 * 算一次就定死：创作库现在是异步从后端灌入的，模块加载那一刻还是空数组。
 */
function nextSeq(): number {
  return creations.reduce((max, c) => {
    const m = /^creation_(\d+)$/.exec(c.id);
    return m ? Math.max(max, Number(m[1])) : max;
  }, 100) + 1;
}

/**
 * 保存到创作库：带 id 且已存在 → 更新（重新生成后覆盖）；否则新建。
 * 后端同步失败不阻塞保存（内存里仍可用），只打警告。
 *
 * 不再往任务中心补一条 `creation` 记录：成片本身就是一条后端任务，
 * 再写一条只会在任务列表里出现两个说的是同一件事的条目。
 */
export async function saveCreation(input: {
  id?: string;
  avatar_id: string;
  title: string;
  script: string;
  video_url?: string | null;
  voice_url?: string | null;
  cover_url?: string | null;
  job_id?: string;
  duration?: number | null;
  points?: number | null;
}): Promise<Creation> {
  const now = new Date().toISOString();
  const existing = input.id ? creations.find((c) => c.id === input.id) : undefined;
  const patch: Partial<Creation> = {
    title: input.title,
    script: input.script,
    video_url: input.video_url,
    voice_url: input.voice_url,
    cover_url: input.cover_url,
    job_id: input.job_id,
    duration: input.duration,
    points: input.points,
  };

  if (existing) {
    Object.assign(existing, patch, { updated_at: now });
    try {
      await libraryApi.putCreation(existing);
    } catch (err) {
      warnSync("更新", err);
    }
    return existing;
  }

  const created: Creation = {
    id: `creation_${nextSeq()}`,
    avatar_id: input.avatar_id,
    type: "speak",
    created_at: now,
    updated_at: now,
    ...patch,
  } as Creation;
  creations.unshift(created);
  try {
    await libraryApi.putCreation(created);
  } catch (err) {
    warnSync("保存", err);
  }
  return created;
}
