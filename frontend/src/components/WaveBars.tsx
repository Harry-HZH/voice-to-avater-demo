import { useEffect, useRef } from "react";
import { Animated, Easing, StyleSheet, View } from "react-native";
import Svg, { Rect } from "react-native-svg";
import { colors } from "../theme/theme";

interface Props {
  playing?: boolean;
  height?: number;
  barCount?: number;
  color?: string;
  activeColor?: string;
}

const BAR_WIDTH = 4;
const GAP = 3;
/** 各波形条的基础高度（模拟 fish.audio 品牌标识的音频波形） */
const BAR_HEIGHTS = [10, 18, 26, 14, 30, 22, 12, 24, 16, 28, 20, 10];

/** 品牌母题：圆角音频波形条。播放时尾部高亮 + 整体呼吸动画 */
export function WaveBars({
  playing = false,
  height = 32,
  barCount = 12,
  color = colors.textHelper,
  activeColor = colors.brand,
}: Props) {
  const anim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!playing) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(anim, { toValue: 1, duration: 550, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(anim, { toValue: 0, duration: 550, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [playing, anim]);

  const bars = BAR_HEIGHTS.slice(0, barCount);
  const width = bars.length * (BAR_WIDTH + GAP) - GAP;
  const activeCount = playing ? 4 : 0;

  return (
    <Animated.View
      style={[
        styles.wrap,
        {
          height,
          transform: [
            { scaleY: playing ? anim.interpolate({ inputRange: [0, 1], outputRange: [1, 0.78] }) : 1 },
          ],
        },
      ]}
    >
      <Svg width={width} height={height}>
        {bars.map((h, i) => {
          const isActive = i >= bars.length - activeCount;
          const barHeight = Math.min(h, height);
          return (
            <Rect
              key={i}
              x={i * (BAR_WIDTH + GAP)}
              y={(height - barHeight) / 2}
              width={BAR_WIDTH}
              height={barHeight}
              rx={BAR_WIDTH / 2}
              fill={isActive ? activeColor : color}
              opacity={isActive ? 0.95 : 0.55 + (i % 3) * 0.15}
            />
          );
        })}
      </Svg>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: { justifyContent: "center" },
});
