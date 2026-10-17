import { Image, StyleSheet, View } from "react-native";
import Svg, { Circle, Ellipse, Path } from "react-native-svg";
import { colors } from "../theme/theme";
import { hashIndex } from "../lib/format";
import { absUrl } from "../lib/api";

interface Props {
  /** 用于稳定选取配色的种子（如 avatar id）；没有真实图片时用它画占位图 */
  seed: string;
  size?: number;
  selected?: boolean;
  /**
   * 真实图片地址（后端生成的候选图 / 三视图 / Avatar 形象）。
   * 传了就渲染真实图片；没传（本地 mock 数据）就继续用下面的水彩占位图。
   */
  url?: string | null;
}

/**
 * 形象图：有真实图片就显示图片，否则用水彩人像占位。
 *
 * 占位图是「多层半透明 pastel 椭圆叠出晕染感 + 人形剪影」，模拟 fish.audio 的水彩渐变封面；
 * 真实图片统一按 cover 裁成方形，保证不同尺寸的格子布局一致。
 */
export function WatercolorPortrait({ seed, size = 120, selected = false, url }: Props) {
  // 相对地址（/api/creation-media/... 等）在这里统一补全成绝对地址：
  // 各调用方有的传相对、有的传绝对，漏补域名会去请求前端 dev server → 404 → 只剩底色
  const src = absUrl(url);

  if (src) {
    return (
      <View style={[styles.wrap, { width: size, height: size }]} testID="portrait-image">
        <Image
          source={{ uri: src }}
          style={{ width: size, height: size }}
          resizeMode="cover"
          accessibilityLabel="形象图"
        />
        {selected && <View style={[styles.frame]} pointerEvents="none" />}
      </View>
    );
  }

  const palette = colors.watercolor[hashIndex(seed, colors.watercolor.length)];
  const [c1, c2, c3] = palette;

  return (
    <View style={[styles.wrap, { width: size, height: size }]}>
      <Svg width={size} height={size} viewBox="0 0 100 100">
        <Ellipse cx="34" cy="30" rx="34" ry="26" fill={c1} opacity={0.85} />
        <Ellipse cx="72" cy="40" rx="30" ry="28" fill={c2} opacity={0.8} />
        <Ellipse cx="46" cy="76" rx="38" ry="26" fill={c3} opacity={0.85} />
        <Circle cx="30" cy="24" r="7" fill="#ffffff" opacity={0.35} />
        <Circle cx="76" cy="66" r="5" fill="#ffffff" opacity={0.3} />
        {/* 人形剪影 */}
        <Circle cx="50" cy="40" r="13" fill="#554e4c" opacity={0.28} />
        <Path
          d="M 26 84 C 26 64 74 64 74 84 L 74 100 L 26 100 Z"
          fill="#554e4c"
          opacity={0.28}
        />
      </Svg>
      {/* 选中内框：叠加层绘制，避免 border 挤压内容导致选中态图形变形 */}
      {selected && <View style={[styles.frame]} pointerEvents="none" />}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { overflow: "hidden", backgroundColor: colors.backgroundMedium },
  frame: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    borderWidth: 2,
    borderColor: colors.brand,
  },
});
