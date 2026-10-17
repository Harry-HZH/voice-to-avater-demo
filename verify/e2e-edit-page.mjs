import { chromium } from "file:///C:/Users/WIN11/.workbuddy/binaries/node/workspace/node_modules/playwright-core/index.mjs";
import { fileURLToPath } from "node:url";
import {
  sweeper,
  hookSweeper,
  snapshotDeletedSeeds,
  restoreNewDeletedSeeds,
} from "./lib-cleanup.mjs";

const BASE = "http://localhost:8082";
const API = "http://localhost:8000";
const OUT = fileURLToPath(new URL(".", import.meta.url));

// 中途崩溃也要还原补丁现场（脚本种的 8x8 假脸不留进真实库）
const sw = sweeper();
hookSweeper(sw);
// UI 删除流程可能把种子角色拉黑，结束时恢复本次新拉黑的
const seedsBefore = await snapshotDeletedSeeds();
sw.add("恢复被 UI 删除的种子角色", () => restoreNewDeletedSeeds(seedsBefore));

// 快照脚本会碰到的两个种子角色的补丁，测完还原（脚本种的 8x8 假脸不留进真实库）
let savedPatches; // undefined = 后端连不上（不用还原）
try {
  const lib0 = await (await fetch(`${API}/api/library`)).json();
  savedPatches = {
    avatar_001: lib0?.avatar_patches?.avatar_001 ?? null,
    avatar_003: lib0?.avatar_patches?.avatar_003 ?? null,
  };
} catch {
  /* 后端不可达 */
}
const restorePatch = async (id) => {
  if (!savedPatches) return;
  const p = savedPatches[id];
  try {
    if (p) {
      await fetch(`${API}/api/library/avatar-patches/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ patch: p }),
      });
    } else {
      await fetch(`${API}/api/library/avatar-patches/${id}`, { method: "DELETE" });
    }
  } catch {
    /* 下次运行会覆盖 */
  }
};
sw.add("还原 avatar_001 补丁", () => restorePatch("avatar_001"));
sw.add("还原 avatar_003 补丁", () => restorePatch("avatar_003"));

const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 420, height: 1100 }, deviceScaleFactor: 2 });
/**
 * 走到创作台（第 8 段）要求角色有一张真实形象图，种子角色的 front 是 null 占位。
 * 这里补一张 8x8 的假图 + 打开 mock 开关：
 *   - 补图：让创作台能进入「写台词」态；
 *   - mock：第 7 段补三视图不再依赖后端在不在，走本地演示，结果稳定。
 * viewCount 看的是 key 是否存在，所以补图不会把「三视图 3/3」改成别的。
 */
const FACE = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGN4/fgOVsQwtCQAomaqgdBcDRgAAAAASUVORK5CYII=";
await page.addInitScript((face) => {
  try {
    window.localStorage.setItem("vta.portraitMode", "mock");
    window.localStorage.setItem(
      "vta.avatarPatches",
      JSON.stringify({ avatar_001: { views: { front: face, side: null, back: null } } }),
    );
  } catch {
    /* 忽略 */
  }
}, FACE);
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
page.on("console", (m) => m.type() === "error" && errors.push("console: " + m.text()));

const body = () => page.evaluate(() => document.body.innerText);
/** Expo 开发服的 #error-toast 空浮层会挡住滚动后的点击（生产构建无此节点），测试里关掉它的 pointer-events */
const neutralizeDevOverlays = () =>
  page.evaluate(() => {
    document.querySelectorAll("#error-toast").forEach((el) => {
      el.style.pointerEvents = "none";
    });
  });
let pass = 0;
let fail = 0;
const check = (name, okResult) => {
  okResult ? pass++ : fail++;
  console.log(`  ${okResult ? "PASS" : "FAIL"}  ${name}`);
};
/** 按钮是否处于不可用态。RNW 的 Pressable 会把 disabled 映射到 aria-disabled */
const isDisabled = async (sel) => {
  const el = page.locator(sel).first();
  const aria = await el.getAttribute("aria-disabled");
  if (aria !== null) return aria === "true";
  return el.isDisabled();
};

/* ---------- 1. 详情页：创作相关内容已移除，创作库/最近任务保留 ---------- */
console.log("— 1. AVATAR 详情页（查看生成内容）");
await page.goto(`${BASE}/avatar/avatar_001`, { waitUntil: "networkidle" });
await page.waitForTimeout(2200);
let t = await body();
check("有「创作库」", /创作库/.test(t));
// 演示种子任务已随任务中心流程化重构清理：这个角色没有任务时，
// 「最近任务」区块按设计不出现（有 speak 任务时才显示）
check("没有任务时不显示「最近任务」区块", !/最近任务/.test(t));
check("保留形象信息（人物设定）", /年龄段/.test(t) && /性格/.test(t) && /风格/.test(t));
check("已移除「让它说一段话」", !/让它说一段话/.test(t));
check("已移除说话输入框", (await page.locator('textarea[placeholder*="输入台词"]').count()) === 0);
check(
  "已移除说话提交按钮（无同名的可点击元素）",
  (await page.locator('[tabindex="0"]').filter({ hasText: /^开口说话$/ }).count()) === 0,
);
check("已移除开口说话状态卡（排队/生成中视频/失败卡）", !/正在生成视频/.test(t) && !/视频生成失败/.test(t));
check("已移除「开口结果」", !/开口结果/.test(t));
check("已移除演示失败状态入口", !/演示失败状态/.test(t));
check("三视图管理已搬走（无生成入口）", (await page.locator('[data-testid^="generate-view-"]').count()) === 0);
check("三视图状态 chip 仍在", /三视图 \d\/3/.test(t));
console.log("     （注：角色有 speak 任务时，详情页「最近任务」里会出现对应的 JobCard）");
await page.screenshot({ path: `${OUT}/v4-01-detail.png`, fullPage: true });

/* ---------- 2. 详情页「编辑」→ 编辑页 ---------- */
console.log("\n— 2. 详情页「编辑」进入独立编辑页");
await page.locator('[data-testid="avatar-edit"]').click();
await page.waitForTimeout(1600);
check("URL 为 /avatar/avatar_001/edit", page.url().endsWith("/avatar/avatar_001/edit"));
t = (await body()).replace(/\s+/g, " ");
check("标题「编辑角色信息」", /编辑角色信息/.test(t));
check("有卡片预览", /卡片在「我的 Avatar」里的样子/.test(t));
check("有基本信息表单", /基本信息/.test(t) && /年龄段/.test(t));
check("声音为只读行", /暂不可更换/.test(t));
check("有三视图管理", /三视图/.test(t) && /3\/3 已生成/.test(t));
check("面包屑「我的 Avatar / 小鹿 / 编辑角色信息」", /我的 Avatar \/ 小鹿 \/ 编辑角色信息/.test(t));

/* ---------- 3. 表单读回当前值 ---------- */
console.log("\n— 3. 表单读回当前角色信息");
const vals = {};
for (const k of ["name", "summary", "age", "personality", "style"]) {
  vals[k] = await page.locator(`[data-testid="edit-${k}"]`).inputValue();
}
console.log("     " + JSON.stringify(vals, null, 0));
check("名称 = 小鹿", vals.name === "小鹿");
check("简介含「三十多岁」", vals.summary.includes("三十多岁"));
check("年龄段 = 30-35 岁", vals.age === "30-35 岁");
check("性格 = 温和、耐心", vals.personality === "温和、耐心");
check("风格 = 叙事 / 有声书", vals.style === "叙事 / 有声书");

/* ---------- 4. 改名 → 卡片预览实时更新 ---------- */
console.log("\n— 4. 改名后卡片预览实时更新");
await page.locator('[data-testid="edit-name"]').fill("小鹿改名");
await page.locator('[data-testid="edit-age"]').fill("31-36 岁");
await page.waitForTimeout(700);
const previewUpdated = await page.evaluate(() =>
  Array.from(document.querySelectorAll("div")).some(
    (e) => e.children.length === 0 && e.textContent.trim() === "小鹿改名",
  ),
);
check("卡片预览出现新名称", previewUpdated);
await page.screenshot({ path: `${OUT}/v4-02-edit.png`, fullPage: true });

/* ---------- 5. 保存 → 返回详情页并生效 ---------- */
console.log("\n— 5. 保存修改后返回详情页且已生效");
await page.locator('[data-testid="save-avatar-profile"]').click();
await page.waitForTimeout(1800);
check("返回详情页", page.url().endsWith("/avatar/avatar_001"));
t = await body();
check("详情页显示新名称「小鹿改名」", /小鹿改名/.test(t));
check("详情页显示新年龄段「31-36 岁」", /31-36 岁/.test(t));
await page.screenshot({ path: `${OUT}/v4-03-detail-saved.png`, fullPage: true });

/* ---------- 6. 操作弹窗入口改造 ---------- */
console.log("\n— 6. 操作弹窗：编辑角色信息改为跳转独立页");
await page.goto(`${BASE}/avatars`, { waitUntil: "networkidle" });
await page.waitForTimeout(2000);
await page.getByText("阿澈", { exact: true }).first().click();
await page.waitForTimeout(1200);
t = (await body()).replace(/\s+/g, " ");
check("弹窗打开（有查看生成内容）", /查看生成内容/.test(t));
check("弹窗内已无内联编辑表单", (await page.locator('[data-testid="save-profile"]').count()) === 0);
check("查看生成内容描述已更新为「创作库与最近任务」", /已保存的创作与最近任务/.test(t));
await page.screenshot({ path: `${OUT}/v4-05-sheet.png`, fullPage: true });
await page.locator('[data-testid="sheet-edit-profile"]').click();
await page.waitForTimeout(1600);
check("跳转到 /avatar/avatar_002/edit", page.url().endsWith("/avatar/avatar_002/edit"));
const a2 = {
  name: await page.locator('[data-testid="edit-name"]').inputValue(),
  age: await page.locator('[data-testid="edit-age"]').inputValue(),
};
check(`编辑页读回阿澈的信息（${a2.name} / ${a2.age}）`, a2.name === "阿澈" && a2.age === "22-28 岁");
check("编辑页卡片预览显示阿澈", /阿澈/.test(await body()));

/* ---------- 7. 三视图补图（无来源任务 → 明确报错，不再有占位演示） ---------- */
console.log("\n— 7. 三视图补图：avatar_003 只有正面且无来源任务，补图必须报错");
await page.goto(`${BASE}/avatar/avatar_003`, { waitUntil: "networkidle" });
await page.waitForTimeout(1800);
t = await body();
check("详情页 chip 显示 1/3", /三视图 1\/3/.test(t));
await page.locator('[data-testid="avatar-edit"]').click();
await page.waitForTimeout(1500);
check("编辑页 1/3 已生成", /1\/3 已生成/.test(await body()));
check("侧面有「点击生成」入口", (await page.locator('[data-testid="generate-view-side"]').count()) === 1);
await page.locator('[data-testid="generate-view-side"]').click();
await page.waitForTimeout(1200);
check("补图给出明确报错（不搞占位演示）", /无法补图|缺参考图/.test(await body()));
await page.locator('[data-testid="generate-view-back"]').click();
await page.waitForTimeout(1200);
check("背面同样报错", /无法补图|缺参考图/.test(await body()));
check("视图数没有偷偷变成 2/3", /1\/3 已生成/.test(await body()));
await page.screenshot({ path: `${OUT}/v4-04-views.png`, fullPage: true });
await neutralizeDevOverlays();
await page.locator('[data-testid="cancel-edit"]').click();
await page.waitForTimeout(1600);
check("回到详情页", page.url().endsWith("/avatar/avatar_003"));
t = await body();
check("详情页 chip 仍是 1/3（没有假数据）", /三视图 1\/3/.test(t));

/* ---------- 8. 创作台：让角色开口说话 ---------- */
console.log("\n— 8. 创作台的台词输入与费用提示");
await page.goto(`${BASE}/avatar/avatar_001/create`, { waitUntil: "networkidle" });
await page.waitForTimeout(2000);
{
  const ct = (await body()).replace(/\s+/g, " ");
  check("有台词字段", /台词/.test(ct));
  check("未填台词时提示的生成按钮不可用", await isDisabled('[data-testid="generate-speech"]'));
  check("未填台词时试听按钮不可用", await isDisabled('[data-testid="preview-speech"]'));

  await page.locator('[data-testid="speak-script"]').fill("大家好，我是小鹿，今天想和你聊三件事。");
  await page.waitForTimeout(300);
  const cost = (await page.locator('[data-testid="cost-estimate"]').innerText()).replace(/\s+/g, " ");
  // 试听前只能按字数粗估，所以要明确标出「估算」——不能让用户把一个估数当成准数
  check(`费用随字数实时显示（${cost}）`, /估算/.test(cost) && /点/.test(cost));
  check("填了台词后生成按钮可用", !(await isDisabled('[data-testid="generate-speech"]')));
  check("没试听过也能直接生成", /没试听也可以直接生成/.test((await body()).replace(/\s+/g, " ")));
}
await page.screenshot({ path: `${OUT}/v11-speak-write.png`, fullPage: true });

/* ---------- 还原补丁现场 ---------- */
await sw.run();

console.log(`\n=== 汇总：${pass} 通过 / ${fail} 失败 ===`);
console.log(`页面错误: ${errors.length ? JSON.stringify(errors.slice(0, 5), null, 1) : "无"}`);
await browser.close();
process.exit(fail === 0 ? 0 : 1);
