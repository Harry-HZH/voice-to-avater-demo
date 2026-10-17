/**
 * 编辑角色信息页 · 补三视图验证
 *
 * 覆盖两条路径：
 *
 *   A 段（零成本，始终跑）：演示数据（没有真实来源任务）→ 退回占位图演示，不调后端。
 *   B 段（真实，约 6 点）：拿后端已有的真实候选任务造一个 Avatar（候选那一步不重复花钱），
 *                          再在编辑页补侧面 → **真实 image-to-image**，图片真的能显示出来。
 *
 * 因为 B 段会真的消耗点数，默认跳过，需要显式放行：
 *
 *     ALLOW_REAL=1 node .workbuddy/verify/e2e-edit-view-real.mjs
 *
 * 前置：后端已在 8000 跑起来（且里面至少有一条成功的候选形象任务），前端在 8082 跑起来。
 */
import { chromium } from "file:///C:/Users/WIN11/.workbuddy/binaries/node/workspace/node_modules/playwright-core/index.mjs";
import { fileURLToPath } from "node:url";
import {
  sweeper,
  hookSweeper,
  snapshotJobIds,
  snapshotAvatarIds,
  purgeNewJobs,
  purgeNewAvatars,
  snapshotDeletedSeeds,
  restoreNewDeletedSeeds,
} from "./lib-cleanup.mjs";

const BASE = "http://localhost:8082";
const API = "http://localhost:8000";
const IMG = fileURLToPath(new URL(".", import.meta.url));
const ALLOW_REAL = process.env.ALLOW_REAL === "1";

// 测试结束（含失败 / Ctrl-C）要清掉本次新建的任务与 Avatar，不在主项目留记录
const sw = sweeper();
hookSweeper(sw);
// UI 删除流程可能把种子角色拉黑，结束时恢复本次新拉黑的
const seedsBefore = await snapshotDeletedSeeds();
sw.add("恢复被 UI 删除的种子角色", () => restoreNewDeletedSeeds(seedsBefore));
const jobsBefore = await snapshotJobIds();
const avatarsBefore = await snapshotAvatarIds();
sw.add("清扫本次新建的任务", () => purgeNewJobs(jobsBefore));
sw.add("清扫本次新建的 Avatar", () => purgeNewAvatars(avatarsBefore));

let pass = 0;
let fail = 0;
const check = (label, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  → " + extra : ""}`);
  ok ? pass++ : fail++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const health = await (await fetch(`${API}/api/health`)).json();
check("后端在线且已配置 key", health.status === "ok" && health.api_key_configured === true);

const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 420, height: 900 }, deviceScaleFactor: 2 });
await page.addInitScript(() => {
  try {
    window.localStorage.removeItem("vta.portraitMode"); // 不走强制 mock
  } catch {
    /* 忽略 */
  }
});
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror " + e.message));
page.on("console", (m) => {
  if (m.type() === "error") errors.push("console " + m.text());
});

const viewsPosts = [];
page.on("request", (r) => {
  if (r.method() === "POST" && r.url().includes("/api/portraits/views")) {
    try {
      viewsPosts.push(JSON.parse(r.postData() || "{}"));
    } catch {
      viewsPosts.push({ parse_error: r.postData() });
    }
  }
});

const body = () => page.evaluate(() => document.body.innerText.replace(/\u200b/g, ""));
const waitText = async (re, timeout = 200000) => {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (re.test(await body())) return true;
    await sleep(400);
  }
  return false;
};
const probeImages = () =>
  page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('[data-testid="portrait-image"]')) {
      const rect = el.getBoundingClientRect();
      if (rect.width < 8 || rect.height < 8) continue; // 跳过 expo-router 留在 DOM 里的旧页面
      const img = el.querySelector("img");
      if (img) out.push({ src: img.currentSrc || img.src, w: img.naturalWidth, h: img.naturalHeight });
    }
    return out;
  });

/* ================= A. 演示数据：退回占位图，不调后端 ================= */
console.log("\n--- A. 演示数据（无真实来源任务）---");
await page.goto(`${BASE}/avatar/avatar_003/edit`, { waitUntil: "networkidle" });
await page.waitForTimeout(1500);

check("演示角色的侧面还没生成（有「+」入口）", (await page.locator('[data-testid="generate-view-side"]').count()) === 1);
await page.locator('[data-testid="generate-view-side"]').click();
await page.waitForTimeout(400);
check("点击后进入生成中", /侧面生成中/.test(await body()));
check("演示补图走完后侧面视为已生成", await waitText(/2\/3 已生成/, 15000));
check("演示数据不会调用后端补图接口", viewsPosts.length === 0, `calls=${viewsPosts.length}`);
await page.screenshot({ path: `${IMG}/v10-edit-A-demo.png`, fullPage: true });

if (!ALLOW_REAL) {
  console.log("\n跳过 B 段（真实 image-to-image）：设置 ALLOW_REAL=1 才会真的生成一张侧面图。");
  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  console.log(errors.length ? `页面错误: ${JSON.stringify(errors.slice(0, 5), null, 1)}` : "无 console / page 错误");
  await browser.close();
  process.exit(fail ? 1 : 0);
}

/* ================= B. 真实：给真实生成的形象补侧面 ================= */
console.log("\n--- B. 真实补图（image-to-image）---");

// 找一条已有真实产物的候选任务，用它冒充这一次的「生成候选」结果，
// 这样候选那 3 张不会重复花钱，只有补图那 1 张是真的。
const all = await (await fetch(`${API}/api/jobs?type=portrait&limit=50`)).json();
const srcJob = (all.jobs || []).find(
  (j) =>
    j.input?.kind === "candidates" &&
    j.status === "succeeded" &&
    (j.output?.provider_urls || []).length >= 3 &&
    (j.output.provider_urls || []).every(Boolean),
);
if (!srcJob) {
  console.log("  后端没有可复用的真实候选任务，跳过 B 段（先跑一次 e2e-portrait-real.mjs）。");
  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  await browser.close();
  process.exit(fail ? 1 : 0);
}
console.log(`  复用真实候选任务 ${srcJob.id}（参考图 ${srcJob.output.provider_urls.length} 张）`);

const usageBefore = await (await fetch(`${API}/api/usage?period_days=1`)).json();

// 只拦「提交候选生成」，让候选那一步零成本；补图请求照旧打真实后端
await page.route("**/api/portraits", async (route) => {
  if (route.request().method() !== "POST") return route.continue();
  await route.fulfill({
    status: 202,
    contentType: "application/json",
    body: JSON.stringify({
      job: { ...srcJob, status: "queued", progress: 0, output: null, error: null },
      poll_url: `/api/jobs/${srcJob.id}`,
      estimated_points: 18,
    }),
  });
});

const NAME = "补图验证";
await page.goto(`${BASE}/avatar/create/voice_001`, { waitUntil: "networkidle" });
await page.waitForTimeout(1500);
await page.locator('[data-testid="portrait-prompt"]').fill("一位三十岁左右的温柔女性，友善的微笑");
await page.locator('[data-testid="generate-portraits"]').click();
await page.waitForTimeout(800);

check("复用任务后进入候选页", await waitText(/选一张作为形象/, 60000));
await page.waitForTimeout(2500);
const cand = await probeImages();
check("候选页渲染出 3 张真实图片", cand.length === 3 && cand.every((c) => c.w > 100), JSON.stringify(cand.map((c) => c.w)));

// 跳过补图，故意让这个形象只有正面 —— 这正是「后面在编辑页补」的场景
await page.locator('[data-testid="candidate-0"]').click();
await page.waitForTimeout(300);
await page.locator('[data-testid="to-supplement"]').click();
await page.waitForTimeout(500);
await page.locator('[data-testid="skip-views"]').click();
await page.waitForTimeout(600);
check("跳过补图后进入保存页", /保存这个 Avatar/.test(await body()));
await page.locator('[data-testid="avatar-name"]').fill(NAME);
await page.locator('[data-testid="save-avatar"]').click();
await page.waitForTimeout(800);
check("保存完成", /Avatar 已创建/.test(await body()));

// 全程走客户端路由（page.goto 会刷新页面，内存里的新形象就没了）
await page.getByText("去 Avatar 列表", { exact: true }).click();
await page.waitForTimeout(1500);
check("列表里能看到刚创建的形象", new RegExp(NAME).test(await body()));
await page.getByText(NAME, { exact: true }).first().click();
await page.waitForTimeout(600);
await page.locator('[data-testid="sheet-edit-profile"]').click();
await page.waitForTimeout(1500);
check("进入编辑角色信息页", /编辑角色信息/.test(await body()));
check("刚创建的形象只有正面（1/3）", /1\/3 已生成/.test(await body()), (await body()).match(/\d\/3 已生成/)?.[0] ?? "");
check("正面是真实图片", (await probeImages()).some((c) => c.w > 100));

const before = viewsPosts.length;
await page.locator('[data-testid="generate-view-side"]').click();
await page.waitForTimeout(1000);
check("补图进入生成中", /侧面生成中/.test(await body()));
await page.screenshot({ path: `${IMG}/v10-edit-B-01-generating.png`, fullPage: true });

check("补图完成并给出提示", await waitText(/已补充/, 200000));
await page.waitForTimeout(2500);
await page.screenshot({ path: `${IMG}/v10-edit-B-02-done.png`, fullPage: true });

check("确实调用了后端补图接口", viewsPosts.length === before + 1, `calls=${viewsPosts.length - before}`);
const sent = viewsPosts[viewsPosts.length - 1] || {};
check("补图请求带上了来源候选任务 id", sent.job_id === srcJob.id, String(sent.job_id));
check("只申请了 side 这一个视角（不顺手多花钱）", JSON.stringify(sent.views) === '["side"]', JSON.stringify(sent.views));

check("补完之后是 2/3", /2\/3 已生成/.test(await body()));

const after = await probeImages();
const newImg = after.find((c) => c.w > 100 && !cand.some((o) => o.src.split("?")[0] === c.src.split("?")[0]));
check("新补充的侧面渲染出真实图片", !!newImg, JSON.stringify(after.map((c) => c.w)));

const list = await (await fetch(`${API}/api/jobs?type=portrait&limit=5`)).json();
const viewsJob = (list.jobs || []).find((j) => j.input?.kind === "views" && j.input?.source_job_id === srcJob.id);
check("后端落了一条「只补 side」的补图任务且成功", !!viewsJob && viewsJob.status === "succeeded", viewsJob ? viewsJob.id : "未找到");
if (viewsJob) {
  check("任务记录了来源候选任务", viewsJob.input.source_job_id === srcJob.id);
  check("任务产物里只有 side", Object.keys(viewsJob.output?.view_urls || {}).join(",") === "side", JSON.stringify(viewsJob.output?.view_urls));
}

const usageAfter = await (await fetch(`${API}/api/usage?period_days=1`)).json();
const spent = Number((usageAfter.total_cost - usageBefore.total_cost).toFixed(2));
console.log(`  本次真实生成共消耗 ${spent} ${usageAfter.currency}（1 张图）`);
check("消耗落在合理区间（约 6 点）", spent > 0 && spent <= 12, String(spent));

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
console.log(errors.length ? `页面错误: ${JSON.stringify(errors.slice(0, 5), null, 1)}` : "无 console / page 错误");

// 清理本次留下的所有记录（任务 + 保存的 Avatar）
await sw.run();
console.log("已清理本次测试产生的任务与 Avatar 记录");

await browser.close();
process.exit(fail ? 1 : 0);
