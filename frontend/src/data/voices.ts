import voicesJson from "./voices.json";
import { fetchVoices } from "../lib/api";
import type { Voice } from "./types";

/** 种子声音（来自项目 seed/voices.json，复制到前端以便自包含）。 */
export const voices: Voice[] = voicesJson as Voice[];

/** 同步查本地种子声音。用于不需要网络的页面（如创建流程读声音名）。 */
export function getVoice(id: string | undefined): Voice | undefined {
  return voices.find((v) => v.id === id);
}

export interface VoiceSource {
  voices: Voice[];
  /** api = 后端声音库（真实音源）；local = 后端不可用时的本地兜底 */
  source: "api" | "local";
  /** 后端不可用时的原因，用于在界面上给出提示 */
  warning?: string;
  samplesReady?: number;
}

/**
 * 读取声音库。优先走后端（拿到带真实试听音源的声音），
 * 后端不可用时回退到本地种子数据，保证 demo 仍可用。
 */
export async function loadVoices(): Promise<VoiceSource> {
  try {
    const { voices: list, samplesReady } = await fetchVoices();
    if (list.length > 0) return { voices: list, source: "api", samplesReady };
    return { voices, source: "local", warning: "后端声音库为空，已显示本地示例数据" };
  } catch (err) {
    return {
      voices,
      source: "local",
      warning: `后端未连接，已回退到本地示例数据（${err instanceof Error ? err.message : "未知错误"}）`,
    };
  }
}
