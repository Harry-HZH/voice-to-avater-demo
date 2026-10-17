/**
 * tab 聚焦刷新 e2e（零成本，mock 模式 + 网络断言）：
 *   1. 声音库：切走再切回来，要再次请求 /api/voices；
 *   2. 任务中心：切走再切回来，要再次请求 /api/jobs；
 *   3. 我的 Avatar：切走再切回来，要再次请求 /api/library，
 *      且期间用 API 新建的角色（不刷新页面）要出现在列表里。
 *
 * 前置：前端 8082 在跑。
 */
import { chromium } from "file:///C:/Users/WIN11/.workbuddy/binaries/node/workspace/node_modules/playwright-core/index.mjs";
import { fileURLToPath } from "node:url";
import {
  sweeper,
  hookSweeper,
  delCreatedAvatar,
  snapshotDeletedSeeds,
  restoreNewDeletedSeeds,
} from "./lib-cleanup.mjs";

const BASE = "http://localhost:8082";
const API = "http://localhost:8000";
// 测试结束（含失败 / Ctrl-C）要清掉新建的临时角色，不在主项目留记录
const sw = sweeper();
hookSweeper(sw);
// UI 删除流程可能把种子角色拉黑，结束时恢复本次新拉黑的
const seedsBefore = await snapshotDeletedSeeds();
sw.add("恢复被 UI 删除的种子角色", () => restoreNewDeletedSeeds(seedsBefore));
const putDoc = (path, doc) =>
  fetch(`${API}/api/library/${path}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(doc),
  });
const delDoc = (path) => fetch(`${API}/api/library/${path}`, { method: "DELETE" });

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

const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 420, height: 1000 } });

const hits = { voices: 0, jobs: 0, library: 0 };
page.on("request", (req) => {
  const u = req.url();
  if (u.includes("/api/voices")) hits.voices += 1;
  else if (u.includes("/api/jobs?")) hits.jobs += 1;
  else if (u.includes("/api/library?") || u.endsWith("/api/library")) hits.library += 1;
});

// 通过顶部菜单切 tab（等价于用户点 tab，不触发页面整刷）
async function goTab(label) {
  await page.getByLabel("打开功能列表").click();
  await page.waitForTimeout(300);
  // 菜单 overlay 在 DOM 里位于页面内容之后，取 .last() 避免命中面包屑/正文里的同名文字
  await page.getByText(label, { exact: true }).last().click();
  await page.waitForTimeout(1200);
}

await page.goto(`${BASE}/voices`, { waitUntil: "networkidle" });
await page.waitForTimeout(1500);

/* 1. 声音库聚焦刷新 */
const voicesBefore = hits.voices;
await goTab("我的 Avatar");
await goTab("声音库");
check("声音库切回后重新请求 /api/voices", hits.voices > voicesBefore, `${voicesBefore} → ${hits.voices}`);

/* 2. 任务中心聚焦刷新 */
const jobsBefore = hits.jobs;
await goTab("声音库");
await goTab("任务中心");
check("任务中心切回后重新请求 /api/jobs", hits.jobs > jobsBefore, `${jobsBefore} → ${hits.jobs}`);

/* 3. 我的 Avatar 聚焦刷新：不刷新页面，API 侧新建角色后切回来要出现 */
const libBefore = hits.library;
const now = new Date().toISOString();
const tmpId = "avatar_focus_tmp";
await putDoc(`created-avatars/${tmpId}`, {
  id: tmpId, name: "聚焦刷新测试角色", voice_id: "voice_001",
  views: { front: null, side: null, back: null },
  source: "generated", prompt: "",
  profile: { summary: "", ageRange: "", personality: "", style: "" },
  created_at: now,
});
sw.add("清理临时角色", () => delCreatedAvatar(tmpId));
await goTab("声音库");
await goTab("我的 Avatar");
check("我的 Avatar 切回后重新请求 /api/library", hits.library > libBefore, `${libBefore} → ${hits.library}`);
const seen = await page.locator(`[data-testid^="avatar-card-"]`).count();
const body = await page.evaluate(() => document.body.innerText);
check("API 新建的角色不刷新页面就出现在列表", body.includes("聚焦刷新测试角色"), `卡片 ${seen} 张`);

// 清掉临时角色（无论前面是否有失败项）
await sw.run();

console.log(`\n=== 汇总：${pass} 通过 / ${fails.length} 失败 ===`);
if (fails.length) console.log("失败项:", fails.join(" | "));
await browser.close();
process.exit(fails.length ? 1 : 0);
