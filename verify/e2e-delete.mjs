import { chromium } from "file:///C:/Users/WIN11/.workbuddy/binaries/node/workspace/node_modules/playwright-core/index.mjs";
import { fileURLToPath } from "node:url";
import {
  sweeper,
  hookSweeper,
  delJob,
  delCreatedAvatar,
  delCreation,
  snapshotDeletedSeeds,
  restoreNewDeletedSeeds,
} from "./lib-cleanup.mjs";

// 本脚本专测删除：临时任务 / 临时角色 / 临时创作结束后必须全部消失。
// 用 sweeper 兜底 —— 任一断言失败或崩溃也不能把测试数据留在主项目里。
const sw = sweeper();
hookSweeper(sw);
// UI 删除流程可能把种子角色拉黑，结束时恢复本次新拉黑的
const seedsBefore = await snapshotDeletedSeeds();
sw.add("恢复被 UI 删除的种子角色", () => restoreNewDeletedSeeds(seedsBefore));
for (const j of ["job_e2e_tmp"]) sw.add(`清理 ${j}`, () => delJob(j));
for (const a of ["avatar_e2e_tmp", "avatar_e2e_tmp2"]) sw.add(`清理 ${a}`, () => delCreatedAvatar(a));
for (const c of ["creation_e2e_tmp", "creation_900"]) sw.add(`清理 ${c}`, () => delCreation(c));

/**
 * 删除功能 e2e（会真删后端的一条任务记录 + 临时测试角色及其创作）：
 *   1. 任务中心：终态任务的「删除记录」→ 确认弹窗 → 行消失，再同步也不回来；
 *   2. Avatar 卡片弹窗：点卡片 → 弹窗「删除角色」行 → 确认 → 列表移除且刷新不回来
 *      （用 API 临时造的角色测，种子的 deleted_seed_avatars 是真实用户数据不碰）；
 *   3. 创作详情：删除 → 确认 → 返回，角色详情页创作计数归零。
 *
 * 前置：后端 8000 在跑（有真实任务）、前端 8082 在跑。 Avatar 删除用 mock 模式上下文。
 */

const BASE = "http://localhost:8082";
const API = "http://localhost:8000";
const getLib = () => fetch(`${API}/api/library`).then((r) => r.json()).catch(() => null);
const putDoc = (path, doc) =>
  fetch(`${API}/api/library/${path}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(doc),
  });
const delDoc = (path) => fetch(`${API}/api/library/${path}`, { method: "DELETE" });
/** 终态任务数（succeeded/failed）——页面可能有正在跑的新任务，用 API 计数做断言才稳 */
const terminalCount = async () => {
  const data = await fetch(`${API}/api/jobs?limit=100`).then((r) => r.json()).catch(() => null);
  return data ? data.jobs.filter((j) => j.status === "succeeded" || j.status === "failed").length : null;
};
const waitFor = async (fn, ms, step = 800) => {
  const end = Date.now() + ms;
  let v = await fn();
  while (!v && Date.now() < end) {
    await new Promise((r) => setTimeout(r, step));
    v = await fn();
  }
  return v;
};

let pass = 0;
const fails = [];
function check(name, ok, detail = "") {
  if (ok) {
    pass += 1;
    console.log(`  PASS  ${name}${detail ? `  → ${detail}` : ""}`);
  } else {
    fails.push(name);
    console.log(`  FAIL  ${name}${detail ? `  → ${detail}` : ""}`);
  }
}

const errors = [];
async function watch(page) {
  page.on("pageerror", (e) => errors.push("pageerror " + e.message));
  page.on("console", (m) => m.type() === "error" && errors.push("console " + m.text()));
}

const browser = await chromium.launch({ channel: "msedge", headless: true });

/* ---------- 1. 任务删除（真实后端，删的是临时插入的测试任务） ---------- */
{
  // 用户在真实使用应用，不能拿真实任务开刀。克隆一条现有任务的形状，
  // 以固定 id 插进 Mongo 当测试数据，UI 删掉后现场自然干净。
  const { execSync } = await import("node:child_process");
  const TMP_JOB = "job_e2e_tmp";
  const tplDoc = await fetch(`${API}/api/jobs?limit=100`)
    .then((r) => r.json())
    .then((d) => d.jobs.find((j) => j.type === "portrait") ?? d.jobs[0]);
  if (!tplDoc) {
    check("后端有任务可作模板", false, "任务列表为空，无法构造测试任务");
  } else {
    const now = new Date().toISOString();
    const doc = {
      ...tplDoc,
      id: TMP_JOB,
      status: "succeeded",
      input: { ...tplDoc.input },
      output: tplDoc.output ? { ...tplDoc.output } : undefined,
      error: undefined,
      created_at: now,
      updated_at: now,
    };
    const json = JSON.stringify(doc);
    const docker = "C:/Users/WIN11/AppData/Local/Programs/DockerDesktop/resources/bin/docker.exe";
    // Windows 的 cmd 不认单引号，中文标点会把 mongosh 的解析打炸 —— 走 stdin 传脚本最稳
    execSync(`"${docker}" exec -i voice-avatar-mongo mongosh --quiet voice_avatar`, {
      input: `db.jobs.insertOne(${json})\n`,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const page = await browser.newPage({ viewport: { width: 420, height: 1000 } });
    await watch(page);
    await page.goto(`${BASE}/jobs`, { waitUntil: "networkidle" });
    await page.waitForTimeout(2000);
    const t0 = await terminalCount();
    await page.locator('[data-testid="job-delete"]').first().click();
    await page.waitForTimeout(600);
    check("确认弹窗出现", await page.locator('[data-testid="job-delete-sheet"]').isVisible());
    await page.locator('[data-testid="job-delete-sheet-confirm"]').click();
    // 列表按时间倒序、测试任务最新排最前，first() 点的就是它；
    // 断言用固定 id 查后端，不受同时段新任务干扰
    const gone = await waitFor(async () => {
      const data = await fetch(`${API}/api/jobs?limit=100`).then((r) => r.json()).catch(() => null);
      return data ? !data.jobs.some((j) => j.id === TMP_JOB) : false;
    }, 10000);
    check("后端里测试任务已删除", gone);
    const t1 = await terminalCount();
    check("终态任务数减一", t1 === t0 - 1, `${t0} → ${t1}`);

    // 刷新后页面上的可删行数与后端终态计数一致（删除是持久的）
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(2000);
    const apiCount = await terminalCount();
    const uiCount = await page.locator('[data-testid="job-delete"]').count();
    check("刷新后页面与后端一致", uiCount === apiCount, `UI ${uiCount} / API ${apiCount}`);
    await page.close();
  }
}

/* ---------- 2. Avatar 删除（入口在角色卡操作弹窗，mock 模式） ---------- */
{
  // 种子角色可能已被用户真删过（deleted_seed_avatars 是真实用户数据，不能动）。
  // 用 API 临时造一个测试角色（+一条创作），走 UI 删掉它，测完库里自然干净。
  const now = new Date().toISOString();
  const tmpId = "avatar_e2e_tmp";
  await putDoc(`created-avatars/${tmpId}`, {
    id: tmpId,
    name: "待删除测试角色",
    voice_id: "voice_001",
    views: { front: null, side: null, back: null },
    source: "generated",
    prompt: "",
    profile: { summary: "", ageRange: "", personality: "", style: "" },
    created_at: now,
  });
  await putDoc("creations/creation_e2e_tmp", {
    id: "creation_e2e_tmp",
    avatar_id: tmpId,
    type: "speak",
    title: "测试创作",
    script: "hi",
    video_url: null,
    voice_url: null,
    cover_url: null,
    created_at: now,
    updated_at: now,
  });

  const page = await browser.newPage({ viewport: { width: 420, height: 1000 } });
  await watch(page);
  await page.addInitScript(() => {
    try {
      window.localStorage.setItem("vta.portraitMode", "mock");
    } catch {}
  });
  await page.goto(`${BASE}/avatars`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1800);
  // 点角色卡 → 操作弹窗 → 「删除角色」行 → 确认弹窗
  await page.locator(`[data-testid="avatar-card-${tmpId}"]`).click();
  await page.waitForTimeout(800);
  check("卡片弹窗里有删除角色入口", await page.locator('[data-testid="sheet-delete-avatar"]').isVisible());
  await page.locator('[data-testid="sheet-delete-avatar"]').click();
  await page.waitForTimeout(600);
  const sheetText = (await page.locator('[data-testid="avatar-delete-sheet"]').innerText()).replace(/\s+/g, " ");
  check("确认弹窗标题带角色名", sheetText.includes("待删除测试角色"), sheetText.slice(0, 60));
  check("弹窗提示连带删除创作条数", sheetText.includes("1 条创作记录"), sheetText.slice(0, 60));
  await page.locator('[data-testid="avatar-delete-sheet-confirm"]').click();
  await page.waitForTimeout(1800);
  const listText = await page.evaluate(() => document.body.innerText);
  check("列表里不再有这个角色", !listText.includes("待删除测试角色"));

  // 刷新后也不回来（自建角色直接从后端移除，不是靠标记过滤）
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  const reloaded = await page.evaluate(() => document.body.innerText);
  check("刷新后仍不出现", !reloaded.includes("待删除测试角色"));

  const libAfter = await getLib();
  check(
    "后端已移除该角色且连带删了创作",
    !(libAfter?.created_avatars ?? []).some((a) => a.id === tmpId) &&
      !(libAfter?.creations ?? []).some((c) => c.avatar_id === tmpId),
  );
  await page.close();
}

/* ---------- 3. 创作记录删除（临时角色 + 临时创作，不碰真实数据） ---------- */
{
  const now = new Date().toISOString();
  const tmpId = "avatar_e2e_tmp2";
  await putDoc(`created-avatars/${tmpId}`, {
    id: tmpId,
    name: "创作删除测试角色",
    voice_id: "voice_001",
    views: { front: null, side: null, back: null },
    source: "generated",
    prompt: "",
    profile: { summary: "", ageRange: "", personality: "", style: "" },
    created_at: now,
  });
  await putDoc("creations/creation_900", {
    id: "creation_900",
    avatar_id: tmpId,
    type: "speak",
    title: "待删除的创作",
    script: "测试台词",
    video_url: null,
    voice_url: null,
    cover_url: null,
    created_at: now,
    updated_at: now,
  });

  const page = await browser.newPage({ viewport: { width: 420, height: 1000 } });
  await watch(page);
  await page.addInitScript(() => {
    try {
      window.localStorage.setItem("vta.portraitMode", "mock");
    } catch {}
  });
  await page.goto(`${BASE}/creation/creation_900`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1800);
  check("创作详情页有删除入口", await page.locator('[data-testid="creation-delete"]').isVisible());
  await page.locator('[data-testid="creation-delete"]').click();
  await page.waitForTimeout(600);
  const sheetShown = await page.locator('[data-testid="creation-delete-sheet"]').isVisible();
  check("创作删除弹窗出现", sheetShown);
  await page.locator('[data-testid="creation-delete-sheet-confirm"]').click();
  await page.waitForTimeout(1500);
  check("删除后返回上一页", !page.url().includes("/creation/creation_900"), page.url());

  const libAfter = await getLib();
  check(
    "后端库里 creation_900 已删除",
    !(libAfter?.creations ?? []).some((c) => c.id === "creation_900"),
  );

  // replace 兜底后页面就在角色详情上，内存里的创作数组也已删掉 —— 直接断言当前页
  await page.waitForTimeout(600);
  const detailAfter = await page.evaluate(() => document.body.innerText);
  check("角色详情页创作库归零", /创作库\s*0 条/.test(detailAfter.replace(/\n+/g, "\n")), "当前页断言");

  await page.close();
  // 清掉临时角色（它的创作已删，删角色是纯清理）
  await delDoc(`created-avatars/${tmpId}`);
}

await browser.close();

// 兜底清扫：把所有临时任务 / 角色 / 创作再删一遍（正常路径它们已被 UI 删掉，重复 DELETE 只是 404）
await sw.run();

console.log(`\n=== 汇总：${pass} 通过 / ${fails.length} 失败 ===`);
if (fails.length) console.log("失败项:", fails.join(" | "));
console.log(`页面错误: ${errors.length ? JSON.stringify(errors.slice(0, 5)) : "无"}`);
process.exit(fails.length || errors.length ? 1 : 0);
