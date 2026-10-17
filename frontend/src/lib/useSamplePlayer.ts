/**
 * 试听播放器。
 *
 * 两条播放路径，行为对齐（同一时刻只播一个、播完自动复位、失败有提示）：
 * - web（RN Web）：HTMLAudioElement，浏览器原生能力；
 * - 原生（Expo Go / dev client）：expo-audio 的 createAudioPlayer。
 *
 * 音源未就绪时先等后端生成（waitForSample），两种平台都适用。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Platform } from "react-native";
import * as ExpoAudio from "expo-audio";

import { waitForSample } from "./api";
import { ensureAudibleAudioMode } from "./nativeAudioMode";
import type { Voice } from "../data/types";

const IS_WEB = Platform.OS === "web";

/** 统一的播放句柄：stop 负责停播、摘监听、释放资源。 */
interface PlaybackHandle {
  stop(): void;
}

/**
 * web：直接用 HTMLAudioElement。play() 的 promise 拒绝 = 被浏览器自动播放
 * 策略拦截（没先点一下页面），要和「加载失败」区分开提示。
 */
function startWebAudio(
  url: string,
  onDone: () => void,
  onFail: () => void,
  onBlocked: () => void,
): PlaybackHandle | null {
  const Ctor = (globalThis as unknown as { Audio?: new () => HTMLAudioElement }).Audio;
  if (!Ctor) return null;
  const audio = new Ctor();
  audio.src = url;
  audio.onended = onDone;
  audio.onerror = onFail;
  audio.play().catch(onBlocked);
  return {
    stop: () => {
      audio.onended = null;
      audio.onerror = null;
      try {
        audio.pause();
      } catch {
        /* 忽略 */
      }
    },
  };
}

/** 原生：expo-audio。每次播放建一个 player，stop 时释放。 */
function startNativeAudio(url: string, onDone: () => void, onFail: () => void): PlaybackHandle {
  const player = ExpoAudio.createAudioPlayer({ uri: url });
  let settled = false;
  const sub = player.addListener("playbackStatusUpdate", (status) => {
    if (settled) return;
    if (status.error) {
      settled = true;
      onFail();
    } else if (status.didJustFinish) {
      settled = true;
      onDone();
    }
  });
  player.play();
  return {
    stop: () => {
      settled = true;
      sub.remove();
      try {
        player.pause();
      } catch {
        /* 忽略 */
      }
      try {
        player.remove();
      } catch {
        /* 忽略 */
      }
    },
  };
}

export function useSamplePlayer() {
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [preparingId, setPreparingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const handleRef = useRef<PlaybackHandle | null>(null);
  const tokenRef = useRef(0);

  const stop = useCallback(() => {
    tokenRef.current += 1;
    handleRef.current?.stop();
    handleRef.current = null;
    setPlayingId(null);
    setPreparingId(null);
  }, []);

  useEffect(() => () => stop(), [stop]);

  /** 播放一个已知可用的音频地址。 */
  const playUrl = useCallback(
    async (url: string, id: string) => {
      if (playingId === id) {
        stop();
        return;
      }
      stop();
      setError(null);
      const token = ++tokenRef.current;

      const onDone = () => setPlayingId(null);
      const onFail = () => {
        setPlayingId(null);
        setError("音频加载失败，请重试");
      };

      let handle: PlaybackHandle | null = null;
      if (IS_WEB) {
        handle = startWebAudio(url, onDone, onFail, () => {
          setPlayingId(null);
          setError("播放被浏览器拦截，请再点一次");
        });
        if (!handle) {
          setError("当前环境不支持音频播放");
          return;
        }
      } else {
        // iOS 静音键会吞音频，播放前确保音频会话允许出声
        await ensureAudibleAudioMode();
        handle = startNativeAudio(url, onDone, onFail);
      }

      handleRef.current = handle;
      if (token !== tokenRef.current) {
        handle.stop();
        return;
      }
      setPlayingId(id);
    },
    [playingId, stop],
  );

  /** 播放某个声音的试听音源；音源未就绪时先等后端生成。 */
  const toggle = useCallback(
    async (voice: Voice) => {
      if (playingId === voice.id) {
        stop();
        return;
      }
      const url = voice.sample_url;
      if (!url) {
        setError("这个声音还没有音源");
        return;
      }
      setError(null);

      if (voice.sample_ready === false) {
        const token = ++tokenRef.current;
        setPreparingId(voice.id);
        try {
          const ready = await waitForSample(url);
          if (token !== tokenRef.current) return;
          setPreparingId(null);
          await playUrl(ready, voice.id);
        } catch (err) {
          if (token !== tokenRef.current) return;
          setPreparingId(null);
          setError(err instanceof Error ? err.message : "音源生成失败");
        }
        return;
      }

      await playUrl(url, voice.id);
    },
    [playingId, playUrl, stop],
  );

  return {
    playingId,
    preparingId,
    error,
    toggle,
    playUrl,
    stop,
    clearError: () => setError(null),
  };
}
