/**
 * 用户产出库的远端同步层。
 *
 * 角色 / 角色修改 / 删除的种子 / 创作记录**存在后端**（MongoDB / JSON 回退），
 * 浏览器端只是内存缓存（见 mock.ts / creations.ts 的模块级数组）。
 * 之前这些东西写 localStorage，按 origin 隔离 —— 换个地址（localhost vs
 * 局域网 IP）或换台设备就"丢"了，现在统一入库。
 *
 * 唯一还留在 localStorage 的是 `vta.portraitMode` 这种演示开关（不是数据）。
 */

import { deleteLibraryDoc, fetchLibrary, putLibraryDoc } from "../lib/api";
import type { Avatar, Creation } from "./types";

export type { LibrarySnapshot } from "../lib/api";

/** 旧版 localStorage 的 key（v1 只存浏览器的时代）；迁移用，搬完即删 */
const LEGACY_KEYS = {
  createdAvatars: "vta.avatars",
  avatarPatches: "vta.avatarPatches",
  creations: "vta.creations",
  deletedSeedAvatars: "vta.deletedSeeds",
} as const;

export interface LegacyData {
  created: Avatar[];
  patches: Record<string, Partial<Avatar>>;
  deletedSeeds: string[];
  creations: Creation[];
  keys: string[];
}

/** 读出旧版 localStorage 增量；没有或读不动就返回 null（绝不让坏 JSON 打挂页面） */
export function readLegacyStorage(): LegacyData | null {
  const ls = (globalThis as { localStorage?: Storage }).localStorage;
  if (!ls) return null;
  const read = <T,>(key: string): T | undefined => {
    try {
      const raw = ls.getItem(key);
      return raw ? (JSON.parse(raw) as T) : undefined;
    } catch {
      return undefined;
    }
  };
  const created = read<Avatar[]>(LEGACY_KEYS.createdAvatars);
  const patches = read<Record<string, Partial<Avatar>>>(LEGACY_KEYS.avatarPatches);
  const deletedSeeds = read<string[]>(LEGACY_KEYS.deletedSeedAvatars);
  const creations = read<Creation[]>(LEGACY_KEYS.creations);
  if (!created && !patches && !deletedSeeds && !creations) return null;
  const keys = Object.values(LEGACY_KEYS).filter((k) => {
    try {
      return ls.getItem(k) !== null;
    } catch {
      return false;
    }
  });
  return {
    created: created ?? [],
    patches: patches ?? {},
    deletedSeeds: deletedSeeds ?? [],
    creations: creations ?? [],
    keys,
  };
}

/** 迁移完成后清掉旧 key（按 origin 一次性）。失败不重试也不阻塞主流程。 */
export function clearLegacyStorage(keys: string[]): void {
  const ls = (globalThis as { localStorage?: Storage }).localStorage;
  if (!ls) return;
  for (const k of keys) {
    try {
      ls.removeItem(k);
    } catch {
      /* 忽略 */
    }
  }
}

export { fetchLibrary, putLibraryDoc, deleteLibraryDoc };

export const libraryApi = {
  putCreatedAvatar: (a: Avatar) => putLibraryDoc(`created-avatars/${encodeURIComponent(a.id)}`, a),
  deleteCreatedAvatar: (id: string) =>
    deleteLibraryDoc(`created-avatars/${encodeURIComponent(id)}`),
  putAvatarPatch: (id: string, patch: Partial<Avatar>) =>
    putLibraryDoc(`avatar-patches/${encodeURIComponent(id)}`, { patch }),
  deleteAvatarPatch: (id: string) => deleteLibraryDoc(`avatar-patches/${encodeURIComponent(id)}`),
  putDeletedSeed: (id: string) => putLibraryDoc(`deleted-seeds/${encodeURIComponent(id)}`, { id }),
  deleteDeletedSeed: (id: string) =>
    deleteLibraryDoc(`deleted-seeds/${encodeURIComponent(id)}`),
  putCreation: (c: Creation) => putLibraryDoc(`creations/${encodeURIComponent(c.id)}`, c),
  deleteCreation: (id: string) => deleteLibraryDoc(`creations/${encodeURIComponent(id)}`),
};
