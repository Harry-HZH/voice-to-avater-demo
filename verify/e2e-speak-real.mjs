/**
 * 「让角色开口说话」真实链路端到端验证。
 *
 * 与 e2e-speak-studio.mjs 的分工：
 *   - e2e-speak-studio.mjs  零成本，走 mock，验界面与交互闭环；
 *   - 本脚本                验**真东西**：真后端 + 真成片 mp4 + 真的能播。
 *
 * 前提（脚本会自己检查）：
 *   1. 后端在 http://127.0.0.1:8000 跑着；
 *   2. 已经存在一条**成功的 speak 任务**（用它当样本，不重新花钱生成）。
 *      默认用 job_bff8639e1f8d，可用 SPEAK_JOB=<id> 覆盖。
 *
 * 为什么不需要花点数：种子角色没有真实形象图，创作台会拦住它。这里用 localStorage
 * 给种子角色补一张**真实的本地产物图**（`/api/jobs/<portrait_job>/image/<i>`，
 * 就是上游文生图的产物），让「有形象」这一前置条件成立 —— 走的是真实图片、真实后端，
 * 只有「生成」那一步被跳过（改成读一条已经生成好的任务）。
 */

import { chromium } from "file:///C:/Users/WIN11/.workbuddy/binaries/node/workspace/node_modules/playwright-core/index.mjs";
import { fileURLToPath } from "node:url";

const BASE = process.env.BASE ?? "http://localhost:8082";
const OUT = fileURLToPath(new URL(".", import.meta.url));
const JOB = process.env.SPEAK_JOB ?? "job_bff8639e1f8d";
const AVATAR = process.env.SPEAK_AVATAR ?? "avatar_001";
// 一张真实存在、由上游生成并缓存到本后端的形象图（0 成本复用）
const FACE = process.env.SPEAK_FACE ?? "/api/jobs/job_4c9c33d542c6/image/0";
const API = "http://127.0.0.1:8000";

const results = [];
function check(label, ok, detail = "") {
  results.push({ label, ok: !!ok });
  console.log(`${ok ? "  ✓" : "  ✗"} ${label}${ok || !detail ? "" : `  ← ${detail}`}`);
}

const exists = (page, sel) => page.locator(sel).count().then((n) => n > 0);

// 快照角色补丁：本脚本经 localStorage 迁移给角色种真实脸，测完还原，不留进真实库
let savedPatch; // undefined = 后端连不上（不用还原）；null = 原本没有补丁
try {
  const lib0 = await (await fetch(`${API}/api/library`)).json();
  savedPatch = lib0?.avatar_patches?.[AVATAR] ?? null;
} catch {
  /* 后端不可达，后面自然失败 */
}

const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 420, height: 1200 }, deviceScaleFactor: 2 });

const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(String(e)));

// 记录所有请求，用来断言「播放」是否真的发生了
const net = [];
page.on("response", (r) => net.push({ url: r.url(), status: r.status() }));

await page.addInitScript(
  ({ face, avatar }) => {
    try {
      window.localStorage.setItem("vta.portraitMode", "real");
      window.localStorage.setItem("vta.avatarPatches", JSON.stringify({ [avatar]: { views: { front: face, side: null, back: null } } }));
    } catch {
      /* 忽略 */
    }
  },
  { face: FACE, avatar: AVATAR },
);

/* ---------- 0. 后端与任务前置条件 ---------- */
console.log("— 0. 前置条件");
{
  const health = await fetch(`${API}/api/health`).then((r) => r.json()).catch(() => null);
  check("后端在跑", !!health && health.status === "ok", JSON.stringify(health));

  const job = await fetch(`${API}/api/jobs/${JOB}`).then((r) => r.json()).catch(() => null);
  check(`样本任务 ${JOB} 已成功`, job?.status === "succeeded", JSON.stringify(job?.status));
  check("样本任务有成片地址", !!job?.output?.video_url, JSON.stringify(job?.output ?? null));
  if (job?.status !== "succeeded") {
    console.log("\n没有可用的成功样本任务，先跑一条再验。中止。");
    await browser.close();
    process.exit(1);
  }
}

/* ---------- 1. 成片态能渲染 ---------- */
console.log("\n— 1. 从任务接回创作台");
{
  await page.goto(`${BASE}/avatar/${AVATAR}/create?job=${JOB}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(3000);

  check("没有停在「缺形象」引导上", !(await exists(page, '[data-testid="speak-script"]')) || (await exists(page, '[data-testid="creation-title"]')));
  check("渲染出成片态", await exists(page, '[data-testid="creation-title"]'));
  check("台词被回填（不是空的）", (await page.locator('[data-testid="speak-script"]').count()) === 0 || (await page.locator('[data-testid="speak-script"]').inputValue()).length > 0);
}

/* ---------- 2. 视频元素指向本后端、且真的能播 ---------- */
console.log("\n— 2. 成片真的能播");
{
  check("播放器已渲染", await exists(page, '[data-testid="speak-video"]'));

  const info = await page.evaluate(async () => {
    const v = document.querySelector('[data-testid="speak-video"]');
    if (!v) return { ok: false, reason: "no <video>" };
    v.muted = true; // 无头环境不静音可能被策略挡住
    try {
      await v.play();
    } catch (e) {
      return { ok: false, reason: `play() 失败: ${e}` };
    }
    const t0 = v.currentTime;
    await new Promise((r) => setTimeout(r, 1600));
    return {
      ok: true,
      src: v.getAttribute("src"),
      t0,
      t1: v.currentTime,
      duration: v.duration,
      videoWidth: v.videoWidth,
      videoHeight: v.videoHeight,
    };
  });

  check("拿到 <video> 元素", info.ok, info.reason);
  check(
    "src 指向本后端的成片地址",
    typeof info.src === "string" && info.src.includes(`/api/jobs/${JOB}/video`),
    String(info.src),
  );
  check("元数据可读（时长 > 0）", Number.isFinite(info.duration) && info.duration > 0, `duration=${info.duration}`);
  check("画面尺寸可读（说明真的解码了）", info.videoWidth > 0 && info.videoHeight > 0, `${info.videoWidth}x${info.videoHeight}`);
  check("播放推进（currentTime 在涨）", info.t1 > info.t0, `${info.t0} → ${info.t1}`);

  const fetched = net.filter((n) => n.url.includes(`/api/jobs/${JOB}/video`) && n.status < 400);
  check("确实向后端请求了成片", fetched.length > 0, JSON.stringify(fetched.slice(0, 2)));
}

/* ---------- 3. 台词音轨也能放 ---------- */
console.log("\n— 3. 台词音轨");
{
  const before = net.length;
  if (await exists(page, '[data-testid="play-voice-track"]')) {
    await page.locator('[data-testid="play-voice-track"]').first().click();
    await page.waitForTimeout(2500);
    const got = net.slice(before).filter((n) => n.url.includes(`/api/jobs/${JOB}/voice`));
    check("点了播放后真的去取了音轨", got.length > 0, JSON.stringify(net.slice(before).map((n) => n.url).slice(0, 3)));
  } else {
    check("音轨入口存在", false, "没找到 play-voice-track");
  }
}

/* ---------- 4. 任务中心能看到它 ---------- */
console.log("\n— 4. 任务中心");
{
  await page.goto(`${BASE}/jobs`, { waitUntil: "networkidle" });
  await page.waitForTimeout(2500);
  const body = await page.locator("body").innerText();
  check("任务中心列出了这条说话任务", body.includes("开口说话") || body.includes("说话"));
  await page.screenshot({ path: `${OUT}/v13-speak-real-jobs.png`, fullPage: true });
}

await page.goto(`${BASE}/avatar/${AVATAR}/create?job=${JOB}`, { waitUntil: "networkidle" });
await page.waitForTimeout(2500);
await page.screenshot({ path: `${OUT}/v13-speak-real-done.png`, fullPage: true });

/* ---------- 汇总 ---------- */
console.log(`\n控制台错误：${errors.length}`);
errors.slice(0, 5).forEach((e) => console.log(`  ! ${e.slice(0, 160)}`));

const passed = results.filter((r) => r.ok).length;
console.log(`\n===== ${passed}/${results.length} 通过 =====`);
results.filter((r) => !r.ok).forEach((r) => console.log(`  ✗ ${r.label}`));

/* ---------- 还原角色补丁 ---------- */
if (savedPatch !== undefined) {
  try {
    if (savedPatch) {
      await fetch(`${API}/api/library/avatar-patches/${encodeURIComponent(AVATAR)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ patch: savedPatch }),
      });
    } else {
      await fetch(`${API}/api/library/avatar-patches/${encodeURIComponent(AVATAR)}`, { method: "DELETE" });
    }
  } catch {
    /* 还原失败就留着，下次运行会覆盖 */
  }
}

await browser.close();
process.exitCode = passed === results.length && errors.length === 0 ? 0 : 1;
