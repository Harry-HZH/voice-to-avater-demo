import { chromium } from "file:///C:/Users/WIN11/.workbuddy/binaries/node/workspace/node_modules/playwright-core/index.mjs";
import { fileURLToPath } from "node:url";

const BASE = "http://localhost:8082";
const IMG_DIR = fileURLToPath(new URL(".", import.meta.url));
const API = "http://localhost:8000";

/**
 * 种子可能已被用户真删（deleted_seed_avatars 是真实用户数据），不能写死 avatar_001。
 * 用 API 临时造一个带 8x8 假脸的角色供各页面与创作台冒烟，测完删掉，不碰真实数据。
 */
const FACE = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGN4/fgOVsQwtCQAomaqgdBcDRgAAAAASUVORK5CYII=";
const TMP = "avatar_smoke_tmp";
await fetch(`${API}/api/library/created-avatars/${TMP}`, {
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    id: TMP,
    name: "冒烟测试角色",
    voice_id: "voice_001",
    views: { front: FACE, side: null, back: null },
    source: "generated",
    prompt: "",
    profile: { summary: "", ageRange: "", personality: "", style: "" },
    created_at: new Date().toISOString(),
  }),
}).catch(() => {});

const pages = ["/voices", "/avatars", "/jobs", `/avatar/${TMP}`, "/voice/voice_001"];
const routes = [
  `/avatar/${TMP}/create`,
];

const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 420, height: 1000 }, deviceScaleFactor: 2 });
await page.addInitScript(() => {
  try {
    window.localStorage.setItem("vta.portraitMode", "mock");
  } catch {
    /* 忽略 */
  }
});
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror " + e.message));
page.on("console", (m) => m.type() === "error" && errors.push("console " + m.text()));

for (const p of pages) {
  await page.goto(BASE + p, { waitUntil: "networkidle" });
  await page.waitForTimeout(1400);
  const txt = await page.evaluate(() => document.body.innerText.slice(0, 60).replace(/\s+/g, " "));
  console.log(`${p.padEnd(24)} OK  «${txt}»`);
}
for (const p of routes) {
  await page.goto(BASE + p, { waitUntil: "networkidle" });
  await page.waitForTimeout(1600);
  console.log(`${p.padEnd(24)} OK  «${(await page.evaluate(() => document.body.innerText.slice(0, 40))).replace(/\s+/g, " ")}»`);
}

// 创作台：写台词 → 费用实时变化（零成本，不点生成）
await page.locator('[data-testid="speak-script"]').fill("大家好，我是冒烟测试角色，今天想和你聊三件事。");
await page.waitForTimeout(400);
const costText = (await page.locator('[data-testid="cost-estimate"]').innerText()).replace(/\s+/g, " ");
console.log(`\n创作台按字数估的费用: «${costText}»`);
await page.screenshot({ path: `${IMG_DIR}/speak-smoke-write.png`, fullPage: true });

console.log(`页面错误: ${errors.length ? JSON.stringify(errors.slice(0, 5), null, 1) : "无"}`);
await browser.close();

// 清理临时角色
await fetch(`${API}/api/library/created-avatars/${TMP}`, { method: "DELETE" }).catch(() => {});
