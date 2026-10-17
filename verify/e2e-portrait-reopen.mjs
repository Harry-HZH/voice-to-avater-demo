/**
 * 零成本验证：任务中心能从后端恢复真实任务，并且能点回候选页 / 保存页。
 *
 * 依赖后端已经跑过一次真实生成（backend/data/portraits 里有图）。
 * 不调用任何生成接口，所以不消耗点数 —— 用来补验「刷新之后还能点回去」这件事。
 */
import { chromium } from "file:///C:/Users/WIN11/.workbuddy/binaries/node/workspace/node_modules/playwright-core/index.mjs";
import { fileURLToPath } from "node:url";

const BASE = "http://localhost:8082";
const API = "http://localhost:8000";
const IMG = fileURLToPath(new URL(".", import.meta.url));

let pass = 0;
let fail = 0;
const check = (label, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  → " + extra : ""}`);
  ok ? pass++ : fail++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 后端要有已完成的候选任务与补图任务
const list = await (await fetch(`${API}/api/jobs?type=portrait&limit=50`)).json();
const candidates = (list.jobs || []).filter((j) => (j.input?.kind ?? "candidates") !== "views" && j.status === "succeeded");
const views = (list.jobs || []).filter((j) => j.input?.kind === "views" && j.status === "succeeded");
check("后端有已完成的候选任务", candidates.length > 0, `${candidates.length} 条`);
check("后端有已完成的补图任务", views.length > 0, `${views.length} 条`);
if (!candidates.length) {
  console.log("没有可复用的真实任务，请先跑 ALLOW_REAL=1 e2e-portrait-real.mjs");
  process.exit(1);
}

const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 420, height: 900 }, deviceScaleFactor: 2 });
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
const probeImages = () =>
  page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('[data-testid="portrait-image"]')) {
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) continue;
      const img = el.querySelector("img");
      out.push(img ? { src: img.currentSrc || img.src, w: img.naturalWidth } : { src: "", w: 0 });
    }
    return out;
  });

/* 1. 任务中心：刷新后仍能看到后端任务 */
console.log("\n--- 任务中心：从后端恢复 ---");
await page.goto(BASE + "/jobs", { waitUntil: "networkidle" });
await page.waitForTimeout(3000);
const t = await body();
check("列出后端已完成的候选任务", /已生成 3 张候选图/.test(t));
check("列出后端已完成的补图任务", /已生成 2 张视图/.test(t));
const thumbs = await probeImages();
check("任务卡显示真实产物缩略图", thumbs.some((c) => c.w > 100), JSON.stringify(thumbs.map((c) => c.w)));
await page.screenshot({ path: `${IMG}/v9-reopen-01-jobs.png` });

/* 2. 点回候选页 */
console.log("\n--- 回到候选页 ---");
await page.getByText("已生成 3 张候选图", { exact: true }).first().click();
await page.waitForTimeout(3000);
check("落在候选页", /选一张作为形象/.test(await body()), page.url().replace(BASE, ""));
const cand = await probeImages();
check("3 张候选图都还在", cand.length === 3 && cand.every((c) => c.w > 100), JSON.stringify(cand.map((c) => c.w)));
check("候选图来自本后端", cand.every((c) => /:\d+\/api\/jobs\//.test(c.src)), cand[0]?.src ?? "");
await page.screenshot({ path: `${IMG}/v9-reopen-02-candidates.png` });

/* 3. 点开补图任务：直接落到保存页 */
console.log("\n--- 回到补图结果 ---");
await page.goBack();
await page.waitForTimeout(2500);
await page.getByText("已生成 2 张视图", { exact: true }).first().click();
await page.waitForTimeout(3000);
check("落在保存页", /保存这个 Avatar/.test(await body()), page.url().replace(BASE, ""));
check("三视图都标记为已生成", /正面已生成/.test(await body()) && /侧面已生成/.test(await body()) && /背面已生成/.test(await body()));
const saved = await probeImages();
check("保存页有真实正面图", saved.some((c) => c.w > 100), JSON.stringify(saved.map((c) => c.w)));
await page.screenshot({ path: `${IMG}/v9-reopen-03-save.png` });

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
console.log(errors.length ? `页面错误: ${JSON.stringify(errors.slice(0, 5), null, 1)}` : "无 console / page 错误");
await browser.close();
process.exit(fail ? 1 : 0);
