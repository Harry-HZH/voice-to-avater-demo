/**
 * 声音库真实音源端到端验证。
 *
 * 关键点：真的验证「有声音在播」——
 * 拦截 window.Audio，记录所有被创建的音频元素，断言 paused=false 且 currentTime 在推进。
 */
import { chromium } from "file:///C:/Users/WIN11/.workbuddy/binaries/node/workspace/node_modules/playwright-core/index.mjs";
import { fileURLToPath } from "node:url";

const BASE = process.env.FE || "http://localhost:8082";
const API = process.env.API || "http://localhost:8000";
const OUT = fileURLToPath(new URL(".", import.meta.url));

let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  → " + extra : ""}`);
  ok ? pass++ : fail++;
};

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--autoplay-policy=no-user-gesture-required"],
});
const page = await browser.newPage({ viewport: { width: 420, height: 1000 }, deviceScaleFactor: 2 });

// 记录所有 Audio 实例，便于断言“真的在播放”
await page.addInitScript(() => {
  const Real = window.Audio;
  window.__audios = [];
  window.Audio = function (...args) {
    const a = new Real(...args);
    window.__audios.push(a);
    return a;
  };
});

const consoleErrors = [];
page.on("pageerror", (e) => consoleErrors.push("pageerror " + e.message));
page.on("console", (m) => m.type() === "error" && consoleErrors.push("console " + m.text()));

const body = () => page.evaluate(() => document.body.innerText);
const audios = () =>
  page.evaluate(() =>
    (window.__audios || []).map((a) => ({
      src: a.src,
      paused: a.paused,
      currentTime: a.currentTime,
      duration: Number.isFinite(a.duration) ? a.duration : null,
      readyState: a.readyState,
    })),
  );

console.log("=".repeat(66));
console.log("1) 声音库列表：数据来自后端");
console.log("=".repeat(66));
await page.goto(`${BASE}/voices`, { waitUntil: "networkidle" });
await page.waitForTimeout(2000);
let t = await body();
check("列表渲染出声音", /Aria/.test(t) && /Mei/.test(t), t.split("\n").find((l) => /个声音/.test(l)) || "");
check("显示真实音源就绪数", /个真实音源已就绪/.test(t));
check("没有回退提示", !/回退到本地|后端未连接/.test(t));
await page.screenshot({ path: `${OUT}/v5-01-voices.png` });

const voiceCount = await page.evaluate(() => document.querySelectorAll('[data-testid^="voice-"]').length);
console.log(`  （页面卡片数：${voiceCount}）`);

console.log("");
console.log("=".repeat(66));
console.log("2) 列表播放：真的在播后端音源");
console.log("=".repeat(66));
const firstPlay = page.locator('[data-testid="play-voice_001"]');
check("播放按钮存在", (await firstPlay.count()) > 0);
await firstPlay.click();
await page.waitForTimeout(2500);
let list = await audios();
check("创建了 Audio 实例", list.length > 0, `${list.length} 个`);
check("音频指向后端 /sample", list.some((a) => /:\d+\/api\/voices\/voice_001\/sample/.test(a.src)), list[0]?.src || "");
check("音频未暂停（正在播放）", list.some((a) => a.paused === false));
const t1 = list[0]?.currentTime ?? 0;
await page.waitForTimeout(1200);
const t2 = (await audios())[0]?.currentTime ?? 0;
check("播放进度在推进", t2 > t1, `${t1.toFixed(2)}s → ${t2.toFixed(2)}s`);
check("时长合理（>1s 且 <60s）", !!list[0]?.duration && list[0].duration > 1 && list[0].duration < 60, `${list[0]?.duration?.toFixed(1)}s`);
await page.screenshot({ path: `${OUT}/v5-02-playing.png` });

console.log("");
console.log("=".repeat(66));
console.log("3) 声音详情：真实音源 + 任意文案合成");
console.log("=".repeat(66));
await page.goto(`${BASE}/voice/voice_001`, { waitUntil: "networkidle" });
await page.waitForTimeout(1800);
t = await body();
check("详情页显示声音信息", /Aria/.test(t) && /storytelling/.test(t));
check("有「用这个声音说一段话」", /用这个声音说一段话/.test(t));

await page.locator('[data-testid="play-sample"]').click();
await page.waitForTimeout(2200);
list = await audios();
check("详情页音源可播放", list.some((a) => a.paused === false && a.src.includes("/api/voices/voice_001/sample")));

// 合成任意文案
const synthText = "Hello, I am Aria. This line was generated just now.";
await page.locator('[data-testid="synth-input"]').fill(synthText);
await page.locator('[data-testid="synth-submit"]').click();
console.log("  （已提交合成，等待真实 TTS 返回…）");
let synthJobAudio = null;
for (let i = 0; i < 40; i++) {
  await page.waitForTimeout(2500);
  const a = await audios();
  synthJobAudio = a.find((x) => x.src.includes("/api/jobs/"));
  if (synthJobAudio) break;
}
check("合成结果音频已生成", !!synthJobAudio, synthJobAudio?.src || "(超时)");
if (synthJobAudio) {
  check("合成音频在播放", synthJobAudio.paused === false);
  check("合成音频时长合理", !!synthJobAudio.duration && synthJobAudio.duration > 1, `${synthJobAudio.duration?.toFixed(1)}s`);
  const st = synthJobAudio.currentTime;
  await page.waitForTimeout(1200);
  const st2 = (await audios()).find((x) => x.src.includes("/api/jobs/"))?.currentTime ?? st;
  check("合成音频进度推进", st2 > st, `${st.toFixed(2)}s → ${st2.toFixed(2)}s`);
}
await page.screenshot({ path: `${OUT}/v5-03-voice-detail.png` });

console.log("");
console.log("=".repeat(66));
console.log("4) 后端接口：音源就绪与失败处理");
console.log("=".repeat(66));
const health = await (await fetch(`${API}/api/health`)).json();
check("后端健康", health.status === "ok", `store=${health.store_backend} samples=${health.samples_ready}/${health.voices_total}`);
check("全部 20 条音源就绪", health.samples_ready === health.voices_total, `${health.samples_ready}/${health.voices_total}`);

const sampleResp = await fetch(`${API}/api/voices/voice_005/sample`);
check("音源返回 200 + audio/mpeg", sampleResp.status === 200 && (sampleResp.headers.get("content-type") || "").includes("audio/mpeg"), `HTTP ${sampleResp.status} ${sampleResp.headers.get("content-type")}`);
const buf = Buffer.from(await sampleResp.arrayBuffer());
check("音源文件非空且有 mp3 头", buf.length > 10000 && buf[0] === 0xff, `${(buf.length / 1024).toFixed(0)} KB, magic=0x${buf[0]?.toString(16)}`);

const missing = await fetch(`${API}/api/voices/not_exist/sample`);
const missingBody = await missing.json().catch(() => ({}));
check("不存在的音源返回 404 + 错误体", missing.status === 404 && missingBody?.detail?.error?.code === "NOT_FOUND", JSON.stringify(missingBody).slice(0, 80));

const badPreview = await fetch(`${API}/api/voices/voice_001/preview`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ text: "" }),
});
const badBody = await badPreview.json().catch(() => ({}));
check("空文案返回 422 校验错误", badPreview.status === 422 && badBody?.error?.code === "VALIDATION_ERROR", JSON.stringify(badBody).slice(0, 90));

console.log("");
console.log("=".repeat(66));
console.log("5) 其他页面冒烟");
console.log("=".repeat(66));
for (const p of ["/voices", "/avatars", "/jobs", "/avatar/avatar_001", "/voice/voice_005"]) {
  await page.goto(BASE + p, { waitUntil: "networkidle" });
  await page.waitForTimeout(1300);
  const txt = await page.evaluate(() => document.body.innerText.slice(0, 40).replace(/\s+/g, " "));
  check(`${p} 正常渲染`, txt.length > 4, `«${txt}»`);
}

const realErrors = consoleErrors.filter((e) => !/favicon|Download the React DevTools/i.test(e));
check("无 console 报错", realErrors.length === 0, realErrors.slice(0, 3).join(" | "));

console.log("");
console.log("=".repeat(66));
console.log(`结果：${pass} 通过 / ${fail} 失败`);
console.log("=".repeat(66));
await browser.close();
process.exit(fail ? 1 : 0);
