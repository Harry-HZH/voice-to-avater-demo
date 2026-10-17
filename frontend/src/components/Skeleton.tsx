import { useEffect, useRef } from "react";
import { Animated, Easing, StyleSheet, View } from "react-native";
import { colors, radius } from "../theme/theme";

/** 骨架屏：加载中的卡片占位（呼吸动画） */
export function Skeleton({ height = 16, width = "100%", style }: { height?: number; width?: number | string; style?: object }) {
  const anim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(anim, { toValue: 1, duration: 800, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(anim, { toValue: 0, duration: 800, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [anim]);

  return (
    <Animated.View
      style={[
        styles.bone,
        {
          height,
          width,
          opacity: anim.interpolate({ inputRange: [0, 1], outputRange: [0.45, 0.9] }),
        },
        style,
      ]}
    />
  );
}

/** 声音卡片骨架 */
export function VoiceCardSkeleton() {
  return (
    <View style={styles.card}>
      <Skeleton height={64} width={64} style={{ borderRadius: radius.card }} />
      <View style={{ flex: 1, gap: 8 }}>
        <Skeleton height={16} width="45%" />
        <Skeleton height={12} width="80%" />
        <Skeleton height={12} width="60%" />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bone: { backgroundColor: colors.textDisabled, borderRadius: 6, opacity: 0.5 },
  card: {
    flexDirection: "row",
    gap: 12,
    padding: 12,
    backgroundColor: colors.surface,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.05)",
  },
});
