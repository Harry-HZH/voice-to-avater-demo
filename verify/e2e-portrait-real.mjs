/**
 * 创作形象流程 · 真实联调验证（会真的调用 ThankYou 文生图，消耗点数）
 *
 * 这个脚本**故意不做本地 mock**，用来证明「描述形象 → 生成候选 → 选一张 →
 * 补三视图 → 保存 Avatar」这条链路是真的接通了 AI，而不是占位图。
 *
 * 成本：3 张候选 + 2 张补图 = 5 张图（当前模型 6 点/张，约 30 点）。
 * 所以默认不跑，必须显式放行：
 *
 *     ALLOW_REAL=1 node .workbuddy/verify/e2e-portrait-real.mjs
 *
 * 前置：后端已在 8000 跑起来，前端在 8082 跑起来。
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

if (process.env.ALLOW_REAL !== "1") {
  console.log("跳过真实生成：设置 ALLOW_REAL=1 才会真的调用文生图（会消耗点数）。");
  process.exit(0);
}

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

/* ---------- 0. 后端就绪 & 记录消耗前的用量 ---------- */
const health = await (await fetch(`${API}/api/health`)).json();
check("后端在线且已配置 key", health.status === "ok" && health.api_key_configured === true, JSON.stringify(health));
const usageBefore = await (await fetch(`${API}/api/usage?period_days=1`)).json();
console.log(`  生成前累计消耗：${usageBefore.total_cost} ${usageBefore.currency}`);

const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 420, height: 900 }, deviceScaleFactor: 2 });
// 明确清掉 mock 开关，确保走真实后端
await page.addInitScript(() => {
  try {
    window.localStorage.removeItem("vta.portraitMode");
  } catch {
    /* 忽略 */
  }
});
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror " + e.message));
page.on("console", (m) => {
  if (m.type() === "error") errors.push("console " + m.text());
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

/** 取页面上所有「可见的真实形象图」的加载结果（RNW 可能渲染成 img 或 background-image） */
const probeImages = () =>
  page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('[data-testid="portrait-image"]')) {
      // 跳过隐藏元素：expo-router 的 stack 会把上一个页面留在 DOM 里（display:none）
      const rect = el.getBoundingClientRect();
      if (rect.width < 8 || rect.height < 8) continue;
      const img = el.querySelector("img");
      if (img) {
        out.push({ src: img.currentSrc || img.src, w: img.naturalWidth, h: img.naturalHeight });
        continue;
      }
      const bg = getComputedStyle(el).backgroundImage;
      const m = /url\(["']?(.*?)["']?\)/.exec(bg || "");
      out.push({ src: m ? m[1] : "", w: 0, h: 0 });
    }
    return out;
  });

/* ---------- 1. 描述形象 → 生成候选 ---------- */
console.log("\n--- 1. 生成候选形象（真实文生图） ---");
await page.goto(BASE + "/avatar/create/voice_001", { waitUntil: "networkidle" });
await page.waitForTimeout(2000);

await page.locator('[data-testid="portrait-prompt"]').fill("一位三十岁左右的温柔女性，友善的微笑，穿浅蓝色衬衫");
await page.locator('[data-testid="generate-portraits"]').click();
await page.waitForTimeout(800);

check("提交后进入等待页", await waitText(/正在生成候选形象/, 15000));
const jobUrl = page.url();
check("任务 id 写进了 URL", /[?&]job=job_/.test(jobUrl), jobUrl.replace(BASE, ""));
const jobId = /[?&]job=([^&]+)/.exec(jobUrl)?.[1];
await page.screenshot({ path: `${IMG}/v9-real-01-waiting.png` });

const t0 = Date.now();
check("生成完成，进入候选页", await waitText(/选一张作为形象/, 200000), `${Math.round((Date.now() - t0) / 1000)}s`);
await page.waitForTimeout(2500);

const job = await (await fetch(`${API}/api/jobs/${jobId}`)).json();
check("后端任务 succeeded", job.status === "succeeded", job.status);
check("后端返回 3 张候选图地址", (job.output?.image_urls || []).length === 3, JSON.stringify(job.output?.image_urls));
check("产物落在本后端（不是第三方 CDN）", (job.output?.image_urls || []).every((u) => u.startsWith("/api/jobs/")));
check("记录了本批预计消耗", typeof job.output?.estimated_points === "number", String(job.output?.estimated_points));

// 后端图片本身可取回，且是真实 jpeg
const imgResp = await fetch(`${API}${job.output.image_urls[0]}`);
check(
  "图片接口回真实 jpeg",
  imgResp.ok && imgResp.headers.get("content-type") === "image/jpeg",
  `${imgResp.status} ${imgResp.headers.get("content-type")}`,
);

const cand = await probeImages();
check("页面上渲染出 3 张真实图片", cand.length === 3, JSON.stringify(cand.map((c) => c.w)));
check("3 张图片都真的加载出来了（naturalWidth>0）", cand.length === 3 && cand.every((c) => c.w > 100), JSON.stringify(cand.map((c) => c.w)));
check("3 张候选不是同一张图", new Set(cand.map((c) => c.src)).size === 3);
await page.screenshot({ path: `${IMG}/v9-real-02-candidates.png` });

/* ---------- 2. 选一张 → 补三视图（真实 image-to-image） ---------- */
console.log("\n--- 2. 补侧面 / 背面（以选中候选图作参考） ---");
await page.locator('[data-testid="candidate-1"]').click();
await page.waitForTimeout(300);
await page.locator('[data-testid="to-supplement"]').click();
await page.waitForTimeout(600);
check("进入「补充视图」步骤", /需要补充侧面和背面吗/.test(await body()));

await page.locator('[data-testid="generate-views"]').click();
await page.waitForTimeout(1200);
check("补图进入生成中", await waitText(/正在补充侧面和背面/, 15000));
check("补图完成，进入保存页", await waitText(/保存这个 Avatar/, 200000));
await page.waitForTimeout(2500);
await page.screenshot({ path: `${IMG}/v9-real-03-save.png` });

// 找到这次补图的任务，确认参考图用的是选中的候选
const jobList = await (await fetch(`${API}/api/jobs?type=portrait&limit=10`)).json();
const viewsJob = (jobList.jobs || []).find((j) => j.input?.kind === "views" && j.status === "succeeded");
check("后端有独立的补图任务且成功", !!viewsJob, viewsJob ? viewsJob.id : "未找到");
if (viewsJob) {
  check("补图任务的参考图来自选中的候选（第 2 张）", viewsJob.input.source_index === 1, String(viewsJob.input.source_index));
  check(
    "补图任务产出了侧面和背面",
    Object.keys(viewsJob.output?.view_urls || {}).sort().join(",") === "back,side",
    JSON.stringify(viewsJob.output?.view_urls),
  );
}

const saveImgs = await probeImages();
check("保存页有真实正面图", saveImgs.some((c) => c.w > 100), JSON.stringify(saveImgs.map((c) => c.w)));
check("保存页三视图状态都是已生成", /侧面已生成/.test(await body()) && /背面已生成/.test(await body()));

/* ---------- 3. 保存 → 我的 Avatar 里能看到真实形象 ---------- */
console.log("\n--- 3. 保存 Avatar ---");
await page.locator('[data-testid="avatar-name"]').fill("真实验形");
await page.locator('[data-testid="save-avatar"]').click();
await page.waitForTimeout(800);
check("保存完成", /Avatar 已创建/.test(await body()));
await page.screenshot({ path: `${IMG}/v9-real-04-done.png` });

await page.getByText("去 Avatar 列表", { exact: true }).click();
await page.waitForTimeout(2000);
check("Avatar 列表里能看到刚创建的", /真实验形/.test(await body()));
const listImgs = await probeImages();
check("列表卡片显示真实形象图", listImgs.some((c) => c.w > 100), JSON.stringify(listImgs.map((c) => c.w)));
await page.screenshot({ path: `${IMG}/v9-real-05-avatars.png` });

/* ---------- 4. 任务中心（刷新后仍能点回真实任务） ---------- */
console.log("\n--- 4. 任务中心 ---");
await page.goto(BASE + "/jobs", { waitUntil: "networkidle" });
await page.waitForTimeout(2500);
const jobsText = await body();
check("刷新后仍能列出后端的两条真实任务", /已生成 3 张候选图/.test(jobsText) && /已生成 2 张视图/.test(jobsText));
check("真实任务带真实产物缩略图", (await probeImages()).some((c) => c.w > 100));
await page.screenshot({ path: `${IMG}/v9-real-06-jobs.png` });

// 点回候选任务：应该直接落在候选页并且图片还在
await page.getByText("查看候选", { exact: true }).first().click();
await page.waitForTimeout(2500);
check("从任务中心点回候选页", /选一张作为形象/.test(await body()), page.url().replace(BASE, ""));
check("点回来的候选页仍有真实图片", (await probeImages()).filter((c) => c.w > 100).length === 3);
await page.screenshot({ path: `${IMG}/v9-real-07-back.png` });

/* ---------- 5. 消耗核算 ---------- */
const usageAfter = await (await fetch(`${API}/api/usage?period_days=1`)).json();
const spent = Number((usageAfter.total_cost - usageBefore.total_cost).toFixed(2));
console.log(`  本次真实生成共消耗 ${spent} ${usageAfter.currency}（5 张图）`);
check("消耗落在合理区间（每张 6 点附近）", spent > 0 && spent <= 40, String(spent));

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
console.log(errors.length ? `页面错误: ${JSON.stringify(errors.slice(0, 5), null, 1)}` : "无 console / page 错误");

// 清理本次留下的所有记录（任务 + 保存的 Avatar）
await sw.run();
console.log("已清理本次测试产生的任务与 Avatar 记录");

await browser.close();
process.exit(fail ? 1 : 0);
