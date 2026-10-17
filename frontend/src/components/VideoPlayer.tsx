import { Platform, StyleSheet, View } from "react-native";
import { useEffect } from "react";
import { VideoView, useVideoPlayer } from "expo-video";
import { colors, radius } from "../theme/theme";
import { ensureAudibleAudioMode } from "../lib/nativeAudioMode";

/**
 * 视频播放器，按平台分流：
 *
 * - web（RN Web）：DOM `<video>`。浏览器原生控件在桌面端好用得多
 *   （进度条拖拽、全屏、音量都是现成的）。样式用普通 CSS 对象
 *   （objectFit / display 这类 RNW 不认），写在原生 style 属性上。
 * - 原生（Expo Go / dev client）：expo-video 的 VideoView，
 *   自带原生控件；iOS 静音键问题由 ensureAudibleAudioMode 兜住。
 */

function WebVideoPlayer({ url, poster, testID }: { url: string; poster?: string; testID: string }) {
  return (
    <video
      src={url}
      poster={poster}
      controls
      playsInline
      preload="metadata"
      data-testid={testID}
      style={{
        width: "100%",
        height: "100%",
        display: "block",
        objectFit: "contain",
        backgroundColor: "#000",
      }}
    />
  );
}

function NativeVideoPlayer({ url, testID }: { url: string; testID: string }) {
  const player = useVideoPlayer({ uri: url });
  // 静音键会吞音频：挂载时就声明允许出声（幂等，重复调用无害）
  useEffect(() => {
    void ensureAudibleAudioMode();
  }, []);
  return <VideoView style={styles.fill} player={player} nativeControls contentFit="contain" testID={testID} />;
}

export function VideoPlayer({
  url,
  poster,
  height = 360,
  testID = "video-player",
}: {
  url: string;
  poster?: string;
  height?: number;
  testID?: string;
}) {
  const isWeb = Platform.OS === "web";
  return (
    <View style={[styles.frame, { height }]}>
      {isWeb ? (
        <WebVideoPlayer url={url} poster={poster} testID={testID} />
      ) : (
        <NativeVideoPlayer url={url} testID={testID} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    width: "100%",
    borderRadius: radius.panel,
    overflow: "hidden",
    backgroundColor: "#000",
    borderWidth: 1,
    borderColor: colors.landingCardBorder,
  },
  fill: { width: "100%", height: "100%" },
});
