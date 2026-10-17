/**
 * 原生端音频会话设置。
 *
 * iOS 的静音键默认会把 app 的音频整个吞掉（AVAudioSession 默认走 silent 模式），
 * 「点了播放没声音」十有八九是它。播任何媒体前调一次这个，声明我们要出声。
 * web 端是空操作（浏览器没有这个概念）。
 */

import { Platform } from "react-native";
import * as ExpoAudio from "expo-audio";

let done = false;

export async function ensureAudibleAudioMode(): Promise<void> {
  if (Platform.OS === "web" || done) return;
  done = true;
  try {
    await ExpoAudio.setAudioModeAsync({
      playsInSilentMode: true,
      // 短音频（试听/音轨）压低别家声音比直接打断礼貌
      interruptionMode: "duckOthers",
    });
  } catch {
    /* 设置失败不阻塞播放，只是静音键可能仍然生效 */
  }
}
