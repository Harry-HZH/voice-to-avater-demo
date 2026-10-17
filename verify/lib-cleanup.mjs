/**
 * e2e 共享清理工具：确保测试结束后（无论成功、失败还是 Ctrl-C）
 * 不在主项目（后端 Mongo + 产物文件）里留下任何测试记录。
 *
 * 用法：
 *   const sw = sweeper(); hookSweeper(sw);
 *   sw.add("清理临时角色", () => delCreatedAvatar(tmpId));
 *   ... 测试主体 ...
 *   await sw.run();          // 正常路径收尾
 *   process.exit(fail ? 1 : 0);
 */

export const API = "http://localhost:8000";

const lib = (path, method) => fetch(`${API}/api/library/${path}`, { method }).catch(() => {});
export const delJob = (id) => fetch(`${API}/api/jobs/${id}`, { method: "DELETE" }).catch(() => {});
export const delCreatedAvatar = (id) => lib(`created-avatars/${id}`, "DELETE");
export const delPatch = (id) => lib(`avatar-patches/${id}`, "DELETE");
export const delCreation = (id) => lib(`creations/${id}`, "DELETE");
export const restoreSeed = (id) => lib(`deleted-seeds/${id}`, "DELETE");

/** 清理任务收集器：add() 注册，run() 逐个执行（失败忽略，不互相阻断） */
export function sweeper() {
  const tasks = [];
  return {
    add(label, fn) {
      tasks.push([label, fn]);
    },
    async run() {
      while (tasks.length) {
        const [label, fn] = tasks.shift();
        try {
          await fn();
        } catch {
          /* 清理失败不打断退出流程 */
        }
      }
    },
  };
}

/** 挂上 Ctrl-C / 未捕获异常兜底：异常退出也尽量清干净 */
export function hookSweeper(sw) {
  const bail = async (code, msg) => {
    if (msg) console.error(`\n[bail] ${msg} —— 先执行清理`);
    await sw.run();
    process.exit(code);
  };
  process.on("SIGINT", () => bail(130, "收到 SIGINT"));
  process.on("uncaughtException", (e) => bail(1, `未捕获异常 ${e?.message ?? e}`));
}

/* ---------- 快照 & 差量清扫 ---------- */

export async function snapshotJobIds() {
  try {
    const d = await (await fetch(`${API}/api/jobs?limit=200`)).json();
    return new Set((d.jobs ?? []).map((j) => j.id));
  } catch {
    return new Set();
  }
}

export async function snapshotAvatarIds() {
  try {
    const d = await (await fetch(`${API}/api/library`)).json();
    return new Set((d.created_avatars ?? []).map((a) => a.id));
  } catch {
    return new Set();
  }
}

/** 删除运行期间新出现、且已到终态的任务（连同产物文件） */
export async function purgeNewJobs(beforeIds) {
  try {
    const d = await (await fetch(`${API}/api/jobs?limit=200`)).json();
    const terminal = new Set(["succeeded", "failed", "cancelled"]);
    for (const j of d.jobs ?? []) {
      if (!beforeIds.has(j.id) && terminal.has(j.status)) await delJob(j.id);
    }
  } catch {
    /* 后端不可达就算了 */
  }
}

/** 删除运行期间新建的 Avatar 文档 */
export async function purgeNewAvatars(beforeIds) {
  try {
    const d = await (await fetch(`${API}/api/library`)).json();
    for (const a of d.created_avatars ?? []) {
      if (!beforeIds.has(a.id)) await delCreatedAvatar(a.id);
    }
  } catch {
    /* 同上 */
  }
}

export async function snapshotDeletedSeeds() {
  try {
    const d = await (await fetch(`${API}/api/library`)).json();
    return new Set(d.deleted_seed_avatars ?? []);
  } catch {
    return new Set();
  }
}

/** 恢复运行期间被 UI 删除流程拉黑的种子角色 */
export async function restoreNewDeletedSeeds(beforeIds) {
  try {
    const d = await (await fetch(`${API}/api/library`)).json();
    for (const id of d.deleted_seed_avatars ?? []) {
      if (!beforeIds.has(id)) await restoreSeed(id);
    }
  } catch {
    /* 同上 */
  }
}
