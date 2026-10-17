/**
 * 验证三件事：
 *  A. 生成候选形象可以离开，之后从任务中心回到等待页（并接着走）
 *  B. 弹窗：点击瞬间灰色蒙层就铺满全屏，只有面板从底部滑入
 *  C. 生成完成后可改人物设定（底部仅取消 / 保存并重新生成，都靠右下角）
 *
 * 注意：page.goto 会整页刷新并重置内存 mock 数据，因此流程内一律用点击做客户端跳转。
 * 演示种子任务已清理，A2/C 段全部自己造任务，不依赖写死数据。
 */
import { chromium } from "file:///C:/Users/WIN11/.workbuddy/binaries/node/workspace/node_modules/playwright-core/index.mjs";
import { fileURLToPath } from "node:url";
import { sweeper, hookSweeper, snapshotDeletedSeeds, restoreNewDeletedSeeds } from "./lib-cleanup.mjs";

// UI 流程可能把种子角色拉黑，结束时（含失败 / Ctrl-C）恢复本次新拉黑的
const sw = sweeper();
hookSweeper(sw);
const seedsBefore = await snapshotDeletedSeeds();
sw.add("恢复被 UI 删除的种子角色", () => restoreNewDeletedSeeds(seedsBefore));

const BASE = "http://localhost:8082";
const IMG = fileURLToPath(new URL(".", import.meta.url));

let pass = 0;
let fail = 0;
const check = (label, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  → " + extra : ""}`);
  ok ? pass++ : fail++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 420, height: 900 }, deviceScaleFactor: 2 });
// 本脚本会反复点「生成候选图」，必须走本地演示，不能每次真调文生图（要花钱）。
// 真后端联调用 e2e-portrait-real.mjs。
await page.addInitScript(() => {
  try {
    window.localStorage.setItem("vta.portraitMode", "mock");
  } catch {
    /* 忽略 */
  }
});
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror " + e.message));
page.on("console", (m) => {
  if (m.type() !== "error") return;
  const t = m.text();
  if (t.includes("ERR_CONNECTION_REFUSED")) return; // 后端未启动，前端已回退本地数据
  errors.push("console " + t);
});

// innerText 会排除 display:none 的旧页面（stack 会保留历史页面 DOM）
const body = () => page.evaluate(() => document.body.innerText.replace(/\u200b/g, ""));
const waitText = async (re, timeout = 9000) => {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (re.test(await body())) return true;
    await sleep(100);
  }
  return false;
};
/** 标题和百分比是两个文本节点，innerText 里中间是换行，所以不要写死空格 */
const PROG = /正在生成候选形象[^\d]{0,6}(\d+)%/;
const pct = (t) => {
  const m = PROG.exec(t);
  return m ? Number(m[1]) : -1;
};

/* ============ A1. 生成中离开 → 任务中心 → 回到等待页 ============ */
console.log("\n--- A1. 生成中离开，从任务中心回到等待页 ---");

await page.goto(BASE + "/avatar/create/voice_001", { waitUntil: "networkidle" });
await page.waitForTimeout(1500);
await page.locator("textarea").first().fill("一位温暖的女性，友善的微笑，柔和光线");
await page.getByText("生成候选图", { exact: true }).click();
await page.waitForTimeout(150);
check("点生成后进入等待页", await waitText(/正在生成候选形象/, 3000), `进度 ${pct(await body())}%`);
check("任务 id 已写进 URL（可刷新恢复）", /[?&]job=job_/.test(page.url()), page.url().replace(BASE, ""));
await page.screenshot({ path: `${IMG}/v8-01-waiting.png` });

// 生成中直接离开去任务中心
await page.locator('[data-testid="go-jobs"]').click();
await page.waitForTimeout(700);
check("离开后到了任务中心", page.url().endsWith("/jobs"), page.url().replace(BASE, ""));
let t = await body();
check("任务中心能看到这条进行中的任务", /生成候选形象/.test(t) && /正在生成/.test(t) && /已完成 \d+%/.test(t));
const mine = /已完成 (\d+)%/.exec(t);
check("任务里带着真实进度", !!mine, mine?.[0]);
check("任务卡给出「回到等待页」入口", /回到等待页 ›/.test(t));
await page.screenshot({ path: `${IMG}/v8-02-jobs-running.png` });
const pctAtJobs = mine ? Number(mine[1]) : -1;

// 点回等待页：快速采样，抓「回到生成页后看到的第一帧状态」
const clickBack = page.getByText("回到等待页 ›").last().click();
let firstSeen = null;
for (let i = 0; i < 40 && !firstSeen; i++) {
  await sleep(50);
  const b = await body();
  if (PROG.test(b)) firstSeen = { kind: "waiting", p: pct(b) };
  else if (/选一张作为形象/.test(b)) firstSeen = { kind: "candidates", p: 100 };
}
await clickBack.catch(() => {});
check("回到了生成页", page.url().includes("/avatar/create/voice_001"), page.url().replace(BASE, ""));
check(
  "回到的是等待页（继续看进度）",
  firstSeen?.kind === "waiting",
  firstSeen ? `${firstSeen.kind} ${firstSeen.p}%` : "未捕获",
);
check(
  "进度接着走，不是从 0 重新开始",
  firstSeen?.kind === "waiting" && firstSeen.p >= pctAtJobs,
  `任务中心 ${pctAtJobs}% → 回到页面 ${firstSeen?.p}%`,
);
await page.screenshot({ path: `${IMG}/v8-03-waiting-resumed.png` });
const p1 = pct(await body());
await sleep(700);
const p2 = pct(await body());
if (p1 >= 0 && p2 >= 0) check("进度在继续推进", p2 > p1, `${p1}% → ${p2}%`);
check("生成完成自动进入候选页", await waitText(/选一张作为形象/, 9000));

/* ============ A2. 任务卡：running → 候选页；failed → 失败页 ============ */
console.log("\n--- A2. 任务中心里任务的落点 ---");

// 演示种子任务已清理，这里自己造：
// 换一批 → 同一条流程重新跑起来 → 去任务中心 → 点回等待页
// （stack 里会留下隐藏的旧页面实例，按钮取 .last() 才是当前可见页）
await page.getByText("换一批候选图", { exact: true }).last().click();
await page.waitForTimeout(600);
check("换一批后回到等待页", await waitText(/正在生成候选形象/, 3000));
await page.locator('[data-testid="go-jobs"]').click();
await page.waitForTimeout(700);
check("离开后到了任务中心", page.url().endsWith("/jobs"), page.url().replace(BASE, ""));
t = await body();
check("任务显示为生成中", /生成中/.test(t));
check("任务里带着真实进度", /已完成 \d+%/.test(t));
check("任务卡给出「回到等待页」入口", /回到等待页 ›/.test(t));
await page.screenshot({ path: `${IMG}/v8-02b-jobs-running.png` });

await page.getByText("回到等待页 ›").last().click();
await page.waitForTimeout(120);
check(
  "running 任务点进来是等待页/候选页",
  /正在生成候选形象|选一张作为形象/.test(await body()),
  page.url().replace(BASE, ""),
);
check("该任务完成后进入候选页", await waitText(/选一张作为形象/, 9000));

// 失败：再换一批 → 等待页点「取消生成」（旧「演示失败状态」按钮已移除）
// → 任务中心 → 去处理 → 失败页 → 重试
await page.getByText("换一批候选图", { exact: true }).last().click();
await page.waitForTimeout(600);
check("再次回到等待页", await waitText(/正在生成候选形象/, 3000));
await page.getByText("取消生成", { exact: true }).last().click();
await page.waitForTimeout(400);
check("取消后回到写提示词那一步", await waitText(/生成候选图/, 3000));
// 经顶部功能菜单去任务中心（客户端跳转，不重置内存里的任务）
await page.getByText("Voice to Avatar").click();
await page.waitForTimeout(300);
await page.getByText("任务中心", { exact: true }).click();
await page.waitForTimeout(900);
// 已取消的任务就是已取消：没有「去处理」、没有「重试」，整卡不可点
t = await body();
check("已取消的任务没有「去处理」入口", !/去处理 ›/.test(t));
check("已取消的任务没有「重试」按钮", !/重试/.test(t));
await page.screenshot({ path: `${IMG}/v8-04-failed.png` });

/* ============ B. 弹窗：蒙层立即铺满，面板滑入 ============ */
console.log("\n--- B. 弹窗蒙层与面板动画 ---");

await page.goto(BASE + "/avatars", { waitUntil: "networkidle" });
await page.waitForTimeout(1600);

await page.evaluate(() => {
  window.__samples = [];
  const t0 = performance.now();
  const tick = () => {
    const root = document.querySelector('[data-testid="avatar-sheet"]');
    if (root) {
      const bd = document.querySelector('[data-testid="avatar-sheet-backdrop"]');
      const sheet = root.children[1];
      const r = bd ? bd.getBoundingClientRect() : null;
      const sr = sheet ? sheet.getBoundingClientRect() : null;
      window.__samples.push({
        t: Math.round(performance.now() - t0),
        vw: window.innerWidth,
        vh: window.innerHeight,
        bdTop: r ? Math.round(r.top) : null,
        bdH: r ? Math.round(r.height) : null,
        bdW: r ? Math.round(r.width) : null,
        sheetTop: sr ? Math.round(sr.top) : null,
        sheetH: sr ? Math.round(sr.height) : null,
      });
    }
    if (performance.now() - t0 < 700) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});

await page.locator('[data-testid="avatar-card-avatar_001"]').first().click();
await page.waitForTimeout(900);

const samples = (await page.evaluate(() => window.__samples)).filter(
  (s) => s.bdTop !== null && s.sheetTop !== null,
);
console.log(
  "  采样(前5帧):",
  samples.slice(0, 5).map((s) => `t=${s.t} bd[top=${s.bdTop},h=${s.bdH}] sheetTop=${s.sheetTop}`),
);
console.log(
  "  采样(后3帧):",
  samples.slice(-3).map((s) => `t=${s.t} bd[top=${s.bdTop},h=${s.bdH}] sheetTop=${s.sheetTop}`),
);

check("弹窗打开了", samples.length > 3, `${samples.length} 帧`);
if (samples.length > 3) {
  const vh = samples[0].vh;
  check(
    "蒙层从第一帧起就是满屏（不跟着面板滑）",
    samples.every((s) => s.bdTop === 0 && Math.abs(s.bdH - vh) <= 1 && s.bdW === s.vw),
    `bdTop=${[...new Set(samples.map((s) => s.bdTop))]} bdH=${[...new Set(samples.map((s) => s.bdH))]} vh=${vh}`,
  );
  const first = samples[0].sheetTop;
  const last = samples[samples.length - 1].sheetTop;
  check("面板是滑入的（起始在屏幕下方）", first > last + 40, `首帧 sheetTop=${first} → 末帧 ${last}`);
  check("面板最终停在底部", Math.abs(last - (vh - samples[samples.length - 1].sheetH)) <= 2);
}
await page.screenshot({ path: `${IMG}/v8-05-sheet.png` });

/* ============ C. 修改人物设定 + 重新生成 ============ */
console.log("\n--- C. 修改人物设定 ---");

// 自己造一条已完成的任务（种子演示任务已清理）：voice_005 出候选 → 候选页
await page.goto(BASE + "/avatar/create/voice_005", { waitUntil: "networkidle" });
await page.waitForTimeout(1600);
await page.locator("textarea").first().fill("A calm young man in his twenties, clean shirt, studio background");
await page.getByText("生成候选图", { exact: true }).click();
check("生成完成后进入候选页", await waitText(/选一张作为形象/, 9000));
check("任务 id 已写进 URL（可刷新恢复）", /[?&]job=job_/.test(page.url()), page.url().replace(BASE, ""));

const beforeShot = await page.locator('[data-testid="candidate-0"]').first().screenshot();

await page.locator('[data-testid="open-profile-edit"]').first().click();
await page.waitForTimeout(700);
check("人物设定弹窗打开", (await page.locator('[data-testid="profile-sheet"]').count()) > 0);
check(
  "弹窗回填了当前候选的设定",
  (await page.locator('[data-testid="profile-age"]').inputValue()) === "30-35 岁",
  await page.locator('[data-testid="profile-age"]').inputValue(),
);
check(
  "弹窗回填了形象描述",
  (await page.locator('[data-testid="profile-prompt"]').inputValue()).includes("calm young man"),
  await page.locator('[data-testid="profile-prompt"]').inputValue(),
);
await page.screenshot({ path: `${IMG}/v8-06-profile-sheet.png` });

// 底部只有「取消 / 保存并重新生成」两个按钮，且都靠右下角
const footerBtns = page.locator('[data-testid="profile-sheet-footer"] [data-testid]');
check("底部只有两个按钮", (await footerBtns.count()) === 2, String(await footerBtns.count()));
check("底部没有「只保存设定」",
  (await page.getByText("只保存设定", { exact: true }).count()) === 0 &&
  (await page.getByText("保存设定", { exact: true }).count()) === 0);
const btnCancel = await page.locator('[data-testid="profile-cancel"]').boundingBox();
const btnSave = await page.locator('[data-testid="profile-save-regenerate"]').boundingBox();
const ageBox = await page.locator('[data-testid="profile-age"]').boundingBox();
check("两个按钮在同一行", Math.abs(btnCancel.y - btnSave.y) < 2, `y=${btnCancel.y}/${btnSave.y}`);
check("取消在保存左侧", btnCancel.x + btnCancel.width <= btnSave.x + 1);
check("按钮靠右下角（右边与表单列对齐）",
  Math.abs((btnSave.x + btnSave.width) - (ageBox.x + ageBox.width)) <= 2,
  `btn右=${btnSave.x + btnSave.width} 表单右=${ageBox.x + ageBox.width}`);
check("按钮在弹窗下半部", btnSave.y > 900 * 0.5, `y=${btnSave.y}`);

// 改设定 → 保存并重新生成
await page.locator('[data-testid="profile-age"]').fill("26-30 岁");
await page.locator('[data-testid="profile-summary"]').fill("一位二十五六岁的年轻女性，适合美妆短视频口播。");
await page.locator('[data-testid="profile-personality"]').fill("自信、有亲和力");
await page.locator('[data-testid="profile-save-regenerate"]').click();
check("保存并重新生成：进入生成中", await waitText(/正在生成候选形象/, 3000));
await page.screenshot({ path: `${IMG}/v8-07-regenerating.png` });
check("重新生成完成回到候选页", await waitText(/选一张作为形象/, 9000));
t = await body();
check("重新生成后保留修改的设定", /自信、有亲和力/.test(t) && /26-30 岁/.test(t));
const afterRegenShot = await page.locator('[data-testid="candidate-0"]').first().screenshot();
check("重新生成后候选图变了（换了一批）", Buffer.compare(beforeShot, afterRegenShot) !== 0);

// 取消：改了但不保存，设定不变
await page.locator('[data-testid="open-profile-edit"]').first().click();
await page.waitForTimeout(700);
check("再次打开弹窗回填当前值", (await page.locator('[data-testid="profile-age"]').inputValue()) === "26-30 岁");
await page.locator('[data-testid="profile-age"]').fill("50-60 岁");
await page.locator('[data-testid="profile-cancel"]').click();
await page.waitForTimeout(600);
check("取消：弹窗关闭", (await page.locator('[data-testid="profile-sheet"]').count()) === 0);
t = await body();
check("取消：设定没有被改", !/50-60 岁/.test(t) && /26-30 岁/.test(t));

// 换一批候选图（不改设定）
await page.getByText("换一批候选图", { exact: true }).click();
check("换一批：进入生成中", await waitText(/正在生成候选形象/, 3000));
check("换一批：完成回到候选页", await waitText(/选一张作为形象/, 9000));

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
if (errors.length) {
  console.log("页面错误:");
  for (const e of errors.slice(0, 8)) console.log("  " + e);
} else {
  console.log("无 console / page 错误");
}
await sw.run();
await browser.close();
process.exit(fail === 0 && errors.length === 0 ? 0 : 1);
