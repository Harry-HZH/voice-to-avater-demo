/**
 * 费用的客户端口径。
 *
 * 和后端 `settings.speak_points` / `video_points_per_second` 是同一套公式，
 * 存在的理由是**在还没花钱之前就能给出一个数**：
 *
 *   1. 用户敲台词的时候，实时显示「这段大概几秒、要多少点」——
 *      让他边写边感受到字数在花钱，而不是写完了才被吓一跳；
 *   2. 试听之后，用后端返回的真实秒数覆盖掉这个估算值。
 *
 * 视频按输出秒数计费：720p 20 点/秒，1080p 30 点/秒。
 * 一条 15 秒的成片就是 300 点 —— 这是整个功能里最需要被看见的数字。
 */

/** 上游统一计价：720p 20 点/秒。和后端 settings.video_points_720p 一致。 */
export const POINTS_PER_SECOND = 20;

/** 台词音轨时长上限（秒）。和后端 settings.speak_max_seconds 一致。 */
export const MAX_SECONDS = 30;

/**
 * 中文口播的语速约 4.5 字/秒（含标点）。
 * 这个系数只用来在没试听前做个粗估，真实秒数一律以试听结果为准 ——
 * 所以宁可保守，不要给用户一个偏小的数字。
 */
const CHARS_PER_SECOND = 4.5;

/** 只做粗估用：按字数猜一段台词要念几秒。 */
export function estimateSeconds(script: string): number {
  const chars = script.trim().length;
  if (!chars) return 0;
  return Math.max(1, Math.round(chars / CHARS_PER_SECOND));
}

/** 按秒数算钱。seconds 为 null 说明时长未知，返回 null（不要瞎给数字）。 */
export function pointsFor(seconds: number | null | undefined): number | null {
  if (!seconds || seconds <= 0) return null;
  return Math.round(seconds * POINTS_PER_SECOND);
}

export function exceedsLimit(seconds: number | null | undefined): boolean {
  return !!seconds && seconds > MAX_SECONDS;
}

/** 「约 8 秒 · 160 点」。点数为空时只显示秒数。 */
export function describeCost(seconds: number | null | undefined): string {
  const points = pointsFor(seconds);
  if (!seconds) return "时长未知";
  const secs = seconds >= 10 ? Math.round(seconds) : Math.round(seconds * 10) / 10;
  return points == null ? `约 ${secs} 秒` : `约 ${secs} 秒 · ${points} 点`;
}
