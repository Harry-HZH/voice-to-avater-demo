/**
 * 「让角色开口说话」专项验证 · 零成本（全部走本地 mock，不花钱、不需要后端）
 *
 * 覆盖的是一条完整闭环，而不只是页面能不能打开：
 *
 *   没有真实形象的角色 → 拦住并引导去生成形象（别等烧完 TTS 的钱才说不行）
 *   写台词           → 字数 / 费用估算随字数实时变化，空台词按钮禁用
 *   超限             → 超过 30 秒给出提示并禁用生成
 *   试听             → 拿到真实秒数后不再显示「估算」；改一个字立刻失效
 *   直接生成         → mock 模式下如实报错，不制造假成功
 *   保存到创作库     → 写进后端用户产出库，刷新后仍在（成片花了几百点，丢了不可接受）
 *   改台词重新生成   → 回到创作台并带着原来的台词
 *
 * 前置：前端 dev server 在 8082 跑着（不需要后端）。
 *
 *     node .workbuddy/verify/e2e-speak-studio.mjs
 */
import { chromium } from "file:///C:/Users/WIN11/.workbuddy/binaries/node/workspace/node_modules/playwright-core/index.mjs";
import { fileURLToPath } from "node:url";
import {
  sweeper,
  hookSweeper,
  delCreatedAvatar,
  delCreation,
  snapshotDeletedSeeds,
  restoreNewDeletedSeeds,
} from "./lib-cleanup.mjs";

const BASE = "http://localhost:8082";
const API = "http://localhost:8000";
const OUT = fileURLToPath(new URL(".", import.meta.url));

// 兜底清理：中途崩溃 / Ctrl-C 也不把测试数据留在真实库里
const sw = sweeper();
hookSweeper(sw);
// UI 删除流程可能把种子角色拉黑，结束时恢复本次新拉黑的
const seedsBefore = await snapshotDeletedSeeds();
sw.add("恢复被 UI 删除的种子角色", () => restoreNewDeletedSeeds(seedsBefore));
sw.add("清理临时角色与创作", async () => {
  await delCreatedAvatar("avatar_e2e_face");
  await delCreatedAvatar("avatar_e2e_plain");
  await delCreation(savedCreationId ?? "__none__");
  if (cleanupCreated && jobAvatar) await delCreatedAvatar(jobAvatar);
});

/**
 * 种子的 front 是 null 占位图（不是真实人像），创作台会正确地拦住它。
 * 种子可能已被用户真删（deleted_seed_avatars 是真实用户数据），所以改用
 * API 临时造两个角色：「有真实形象」（8x8 假脸）和「只有占位图」各一个，
 * 测完在脚本结尾删掉，不碰真实数据。
 * 顺便打开 mock 开关：试听与生成都走本地演示，零成本。
 */
const FACE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGN4/fgOVsQwtCQAomaqgdBcDRgAAAAASUVORK5CYII=";

const TMP_FACE = "avatar_e2e_face"; // 有真实形象（假脸）
const TMP_PLAIN = "avatar_e2e_plain"; // 只有占位图，创作台要拦
const putAvatar = async (id, name, front) => {
  await fetch(`${API}/api/library/created-avatars/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id,
      name,
      voice_id: "voice_001",
      views: { front, side: null, back: null },
      source: "generated",
      prompt: "",
      profile: { summary: "", ageRange: "", personality: "", style: "" },
      created_at: new Date().toISOString(),
    }),
  });
};
try {
  await putAvatar(TMP_FACE, "测试角色·有脸", FACE);
  await putAvatar(TMP_PLAIN, "测试角色·无脸", null);
} catch {
  /* 后端不可达时相关段落会自然失败 */
}

const SCRIPT = "欢迎回来，这一期我们讲解 three.js 的基础用法。";
const SAVED_SCRIPT = "大家好，我是小鹿，今天想和你聊三件事。";

let pass = 0;
let fail = 0;
const check = (label, ok, extra = "") => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${extra ? `  → ${extra}` : ""}`);
};

const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 420, height: 1100 }, deviceScaleFactor: 2 });
await page.addInitScript(() => {
  try {
    window.localStorage.setItem("vta.portraitMode", "mock");
  } catch {
    /* 忽略 */
  }
});

const pageErrors = [];
const consoleErrors = [];
page.on("pageerror", (e) => pageErrors.push("pageerror: " + e.message));
page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));

const body = () => page.evaluate(() => document.body.innerText.replace(/\u200b/g, ""));
const text = async () => (await body()).replace(/\s+/g, " ");
const exists = (sel) => page.locator(sel).count().then((n) => n > 0);
const seen = async (re, timeout = 8000) => {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (re.test(await text())) return true;
    await page.waitForTimeout(250);
  }
  return false;
};
/** 按钮是否不可用。RNW 的 Pressable 可能落在 aria-disabled / disabled / pointer-events 上 */
const isDisabled = async (sel) => {
  const el = page.locator(sel).first();
  const aria = await el.getAttribute("aria-disabled");
  if (aria !== null) return aria === "true";
  if (await el.isDisabled().catch(() => false)) return true;
  return page.evaluate(
    (s) => getComputedStyle(document.querySelector(s)).pointerEvents === "none",
    sel,
  );
};
const readCreations = async () => {
  try {
    const lib = await (await fetch(`${API}/api/library`)).json();
    return lib.creations ?? null;
  } catch {
    return null;
  }
};

/* ---------- 1. 没有真实形象的角色：先拦住，而不是等花了钱才报错 ---------- */
console.log("— 1. 没有真实形象的角色（临时角色只有占位图）");
await page.goto(`${BASE}/avatar/${TMP_PLAIN}/create`, { waitUntil: "networkidle" });
await page.waitForTimeout(1800);
{
  const t = await text();
  check("提示「这个角色还没有真实形象」", /还没有真实形象/.test(t));
  check("给出「去生成形象」的下一步", /去生成形象/.test(t));
  check("不出现台词输入框（不会让人白写一段）", !(await exists('[data-testid="speak-script"]')));
  check("不出现生成按钮", !(await exists('[data-testid="generate-speech"]')));
}
await page.screenshot({ path: `${OUT}/v12-speak-01-no-face.png`, fullPage: true });

/* ---------- 2. 有形象：写台词 + 费用随字数实时变化 ---------- */
console.log("\n— 2. 创作台：写台词与费用估算");
await page.goto(`${BASE}/avatar/${TMP_FACE}/create`, { waitUntil: "networkidle" });
await page.waitForTimeout(1800);
{
  const t = await text();
  check("有台词字段", /台词/.test(t));
  check("说明了按秒计费", /按秒计费/.test(t));
  check("空台词时生成按钮不可用", await isDisabled('[data-testid="generate-speech"]'));
  check("空台词时试听按钮不可用", await isDisabled('[data-testid="preview-speech"]'));
  check("没有台词时不给费用数字", !(await exists('[data-testid="cost-estimate"]')));
  check("默认竖屏 9:16 存在", await exists('[data-testid="aspect-9:16"]'));
  check("可切横屏 16:9", await exists('[data-testid="aspect-16:9"]'));

  await page.locator('[data-testid="speak-script"]').fill("大家好。");
  await page.waitForTimeout(350);
  const short = (await page.locator('[data-testid="cost-estimate"]').innerText()).replace(/\s+/g, " ");
  check(`短台词的费用（${short}）`, /\d+ 秒/.test(short) && /点/.test(short));
  check("试听前标的是「估算」", /估算/.test(short));
  check("填了台词后生成按钮可用", !(await isDisabled('[data-testid="generate-speech"]')));
  check("说明了没试听也能直接生成", /没试听也可以直接生成/.test(await text()));

  await page.locator('[data-testid="speak-script"]').fill(SCRIPT);
  await page.waitForTimeout(350);
  const long = (await page.locator('[data-testid="cost-estimate"]').innerText()).replace(/\s+/g, " ");
  const num = (s) => Number((s.match(/约?\s*([\d.]+)\s*秒/) || [])[1] || 0);
  check(`长台词费用更高（${short} → ${long}）`, num(long) > num(short));
  check("切横屏可点", await exists('[data-testid="aspect-16:9"]'));
  await page.locator('[data-testid="aspect-16:9"]').click();
  await page.waitForTimeout(250);
}
await page.screenshot({ path: `${OUT}/v12-speak-02-write.png`, fullPage: true });

/* ---------- 3. 超限：超过 30 秒要拦住 ---------- */
console.log("\n— 3. 台词超限");
{
  await page.locator('[data-testid="speak-script"]').fill("这是一段很长的台词。".repeat(25));
  await page.waitForTimeout(400);
  const t = await text();
  check("给出超限提示", /超过 30 秒上限/.test(t));
  check("超限时生成按钮不可用", await isDisabled('[data-testid="generate-speech"]'));
  check("超限时试听仍然可用（改短之前可以先量出真实秒数）", !(await isDisabled('[data-testid="preview-speech"]')));
  await page.locator('[data-testid="speak-script"]').fill(SCRIPT);
  await page.waitForTimeout(300);
  check("改回合理长度后恢复可用", !(await isDisabled('[data-testid="generate-speech"]')));
}

/* ---------- 4. 试听：拿到真实秒数；改一个字就失效 ---------- */
console.log("\n— 4. 试听台词（mock，零成本）");
{
  await page.locator('[data-testid="preview-speech"]').click();
  const ok = await seen(/音轨已就绪/);
  check("试听结果出现", ok);
  const cost = (await page.locator('[data-testid="preview-cost"]').innerText()).replace(/\s+/g, " ");
  check(`显示真实时长与费用（${cost}）`, /约 \d/.test(cost) && /点/.test(cost));
  const est = (await page.locator('[data-testid="cost-estimate"]').innerText()).replace(/\s+/g, " ");
  check(`试听后的费用不再标「估算」（${est}）`, !/估算/.test(est));
  check("说明音轨会被复用、不会重复计费", /不会重复计费/.test(await text()));
  // mock 模式没有真实音频文件，所以播放入口在但不可点（真实模式下 audio_url 一定有值）
  check("有播放入口", await exists('[data-testid="play-preview"]'));
  check("mock 下无音频文件，播放不可点（如实反映）", await isDisabled('[data-testid="play-preview"]'));

  // 改台词 → 试听结果必须失效，否则就是拿着 A 的秒数给 B 报账
  await page.locator('[data-testid="speak-script"]').fill(SCRIPT + "好。");
  await page.waitForTimeout(400);
  check("改台词后试听结果自动失效", !(await exists('[data-testid="preview-result"]')));
  const est2 = (await page.locator('[data-testid="cost-estimate"]').innerText()).replace(/\s+/g, " ");
  check("失效后回到「估算」口径", /估算/.test(est2));
  await page.locator('[data-testid="speak-script"]').fill(SCRIPT);
  await page.waitForTimeout(250);
}
await page.screenshot({ path: `${OUT}/v12-speak-03-preview.png`, fullPage: true });

/* ---------- 5. 没试听直接生成：mock 下要如实报错 ---------- */
console.log("\n— 5. 直接生成（后端不可用时不假装成功）");
{
  await page.locator('[data-testid="generate-speech"]').click();
  const ok = await seen(/演示模式/);
  check("给出「演示模式，未提交真实生成」的说明", ok);
  check("仍然停在写台词态（没有跳进假的生成中）", await exists('[data-testid="speak-script"]'));
}
await page.screenshot({ path: `${OUT}/v12-speak-04-error.png`, fullPage: true });

/* ---------- 6. 点回一条已成功的说话任务 → 成片态 ---------- */
console.log("\n— 6. 点回已成功的说话任务 → 成片态，并保存到创作库");
// 说话视频没有本地兜底（不造假视频）：「已成片」态只能拿一条真实任务来验。
// 后端不在跑 / 没有成功任务就跳过 6/7/8 段（真链路由 e2e-speak-real.mjs 覆盖），
// 其余段不受影响。
let speakJob = null;
let jobAvatar = null;
let cleanupCreated = false; // 我们为测试新建的角色文档，结束时删掉
let savedCreationId = null; // 第 6 段保存的创作，结束时删掉
let creationsBefore = 0; // 第 6 段保存前 jobAvatar 已有的创作数（第 7 段计数断言用）
// 真实说话任务可能已被用户删掉：往 Mongo 插一条临时任务（无成片）保证 6/7/8 段可跑，
// 结尾删掉。video_url 为 null 会走「成片没能缓存到本地」的如实降级分支。
try {
  const list0 = await (await fetch(`${API}/api/jobs?type=speak&status=succeeded&limit=10`)).json();
  if (!(list0.jobs || []).length) {
    const { execSync } = await import("node:child_process");
    const doc = {
      id: "job_e2e_speak_tmp",
      type: "speak",
      status: "succeeded",
      input: { kind: "speak", avatar_id: TMP_FACE, voice_id: "voice_001", script: SCRIPT, aspect_ratio: "9:16" },
      output: { audio_url: null, video_url: null, resolution: "720p", estimated_points: 30, output_duration: 8 },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    execSync(
      '"C:/Users/WIN11/AppData/Local/Programs/DockerDesktop/resources/bin/docker.exe" exec -i voice-avatar-mongo mongosh --quiet voice_avatar',
      { input: `db.jobs.insertOne(${JSON.stringify(doc)})\n`, stdio: ["pipe", "pipe", "pipe"] },
    );
  }
} catch {
  /* 后端/Docker 不可达时 6/7/8 段自然跳过 */
}
try {
  const list = await (await fetch("http://localhost:8000/api/jobs?type=speak&status=succeeded&limit=10")).json();
  speakJob = (list.jobs || []).find((j) => j.input?.avatar_id) ?? null;
} catch {
  /* 后端不可达 */
}

if (!speakJob) {
  console.log("  跳过：后端没有可用的成功说话任务（6/7/8 段需要一条真实成片）");
} else {
  const jobScript = speakJob.input.script;
  jobAvatar = speakJob.input.avatar_id;
  const jobTitle = "试映角色的开场白";
  // 角色可能不在数据里 / 没有真实形象：补一份带测试脸的角色文档让创作台放行。
  // 已是用户自建角色则不动它（结束时也不删）；否则建测试文档（结束时删）。
  try {
    const lib = await (await fetch(`${API}/api/library`)).json();
    if (!(lib.created_avatars ?? []).some((a) => a.id === jobAvatar)) {
      await putAvatar(jobAvatar, "试映角色", FACE);
      cleanupCreated = true;
    }
  } catch {
    /* 后端不可用时 6/7/8 段会自然跳过 */
  }

  await page.goto(`${BASE}/avatar/${jobAvatar}/create?job=${speakJob.id}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(2000);
  {
    const t = await text();
    check("进入结果态（有标题输入框）", await exists('[data-testid="creation-title"]'));
    check("回填了任务里的台词（不是空框）", t.includes(jobScript));
    const aspect = speakJob.input.aspect_ratio ?? "9:16";
    const resolution = speakJob.output?.resolution ?? "720p";
    check(`显示比例与清晰度（${aspect} / ${resolution}）`, t.includes(aspect) && t.includes(resolution));
    const points = speakJob.output?.estimated_points;
    if (points != null) check(`显示这次花了多少点（约 ${points} 点）`, t.includes(`约 ${points} 点`));
    if (speakJob.output?.video_url) {
      check("真实成片渲染出播放器", await exists('[data-testid="speak-video"]'));
    } else {
      check("没有成片时如实说明", /成片没能缓存到本地/.test(t));
    }
    check("有「保存到创作库」按钮", await exists('[data-testid="save-creation"]'));

    creationsBefore = ((await readCreations()) ?? []).filter((c) => c.avatar_id === jobAvatar).length;

    await page.locator('[data-testid="creation-title"]').fill(jobTitle);
    await page.waitForTimeout(300);
    await page.locator('[data-testid="save-creation"]').click();
    await page.waitForTimeout(1600);
    check("保存后跳到创作详情页", /\/creation\/creation_\d+$/.test(page.url()), page.url());
    savedCreationId = (page.url().match(/creation_\d+/) || [])[0] ?? null;

    const saved = savedCreationId
      ? ((await readCreations()) ?? []).find((c) => c.id === savedCreationId) ?? null
      : null;
    check("已写进后端用户产出库（/api/library）", !!saved, savedCreationId ?? "没找到");
    const duration = speakJob.output?.output_duration ?? speakJob.output?.duration ?? null;
    check(
      "落盘内容完整（台词/角色/时长/点数）",
      !!saved &&
        saved.script === jobScript &&
        saved.avatar_id === jobAvatar &&
        saved.type === "speak" &&
        saved.duration === duration &&
        (points == null || saved.points === points),
      JSON.stringify({ ...saved, cover_url: saved?.cover_url?.slice(0, 40) } ?? null),
    );
    // 回归：absUrl 曾经把 data: 地址也当前端相对路径，拼成 http://localhost:8000/data:...
    check(
      "封面地址没被拼坏（带 scheme 的地址原样保留）",
      !/^https?:\/\/[^/]+\/data:/.test(saved?.cover_url ?? ""),
      saved?.cover_url?.slice(0, 40),
    );

    const t2 = await text();
    check("详情页显示标题", t2.includes(jobTitle));
    check("详情页显示台词", t2.includes(jobScript));
    if (points != null) check("详情页显示消耗", t2.includes(`约 ${points} 点`));
    if (duration != null) check("详情页显示时长", t2.includes(`${Math.round(duration)} 秒`));
    if (!speakJob.output?.video_url) {
      check("没有成片时明确说明", /没有成片/.test(t2) && !(await exists('[data-testid="creation-video"]')));
    }
  }
  await page.screenshot({ path: `${OUT}/v12-speak-05-creation.png`, fullPage: true });

  /* ---------- 7. 刷新后仍在（持久化的意义就在这儿） ---------- */
  console.log("\n— 7. 刷新后创作仍在");
  {
    const url = page.url();
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(1800);
    const t = await text();
    check("刷新后详情页仍能打开", t.includes(jobTitle), url);
    check("刷新后台词仍在", t.includes(jobScript));

    await page.goto(`${BASE}/avatar/${jobAvatar}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1800);
    const t2 = await text();
    check(`角色详情页创作库显示 ${creationsBefore + 1} 条`, new RegExp(`${creationsBefore + 1} 条`).test(t2));
    check("创作库里能看到这条创作", t2.includes(jobTitle));
    check("不再是空态文案", !/还没有创作/.test(t2));
  }
  await page.screenshot({ path: `${OUT}/v12-speak-06-persisted.png`, fullPage: true });

  /* ---------- 8. 改台词重新生成：回到创作台并带着原来的台词 ---------- */
  console.log("\n— 8. 从创作库点进条目 → 改台词重新生成");
  {
    await page.getByText(jobTitle, { exact: true }).first().click();
    await page.waitForTimeout(1700);
    check("创作库的条目可以点开", /\/creation\/creation_\d+$/.test(page.url()), page.url());

    await page.locator('[data-testid="creation-regenerate"]').first().click();
    await page.waitForTimeout(1800);
    check(
      "回到创作台",
      new RegExp(`/avatar/${jobAvatar}/create\\?edit=creation_\\d+`).test(page.url()),
      page.url(),
    );
    const value = await page.locator('[data-testid="speak-script"]').inputValue();
    check("台词已带回来", value === jobScript, value);
    check("停在写台词态（方便改）", await exists('[data-testid="generate-speech"]'));
    check("不进结果态", !(await exists('[data-testid="creation-title"]')));
  }
}
await page.screenshot({ path: `${OUT}/v12-speak-07-edit.png`, fullPage: true });

/* ---------- 清理：不把测试数据留在真实用户产出库里 ---------- */
try {
  if (savedCreationId) {
    await fetch(`${API}/api/library/creations/${savedCreationId}`, { method: "DELETE" });
  }
  if (cleanupCreated && jobAvatar) {
    await fetch(`${API}/api/library/created-avatars/${encodeURIComponent(jobAvatar)}`, { method: "DELETE" });
  }
  // 开头造的两个临时角色
  await fetch(`${API}/api/library/created-avatars/${TMP_FACE}`, { method: "DELETE" });
  await fetch(`${API}/api/library/created-avatars/${TMP_PLAIN}`, { method: "DELETE" });
  // 插入的临时说话任务
  try {
    const { execSync } = await import("node:child_process");
    execSync(
      '"C:/Users/WIN11/AppData/Local/Programs/DockerDesktop/resources/bin/docker.exe" exec -i voice-avatar-mongo mongosh --quiet voice_avatar',
      { input: 'db.jobs.deleteOne({ id: "job_e2e_speak_tmp" })\n', stdio: ["pipe", "pipe", "pipe"] },
    );
  } catch {
    /* 同上 */
  }
} catch {
  /* 后端不在跑时无需清理 */
}

// 兜底再跑一遍 sweeper（正常路径上面已清过，重复 DELETE 只是 404）
await sw.run();

console.log(`\n=== 汇总：${pass} 通过 / ${fail} 失败 ===`);
console.log(`页面错误: ${pageErrors.length ? JSON.stringify(pageErrors.slice(0, 3), null, 1) : "无"}`);
console.log(`控制台错误: ${consoleErrors.length ? JSON.stringify(consoleErrors.slice(0, 3), null, 1) : "无"}`);
await browser.close();
process.exit(fail === 0 ? 0 : 1);
