import { StyleSheet, View } from "react-native";
import { useIsPC } from "../lib/useIsPC";
import { colors } from "../theme/theme";

/**
 * 页面容器：手机优先限宽 640 居中；PC 视口**限宽 1200 且居中**——
 * 铺满超宽屏会把搜索框/筛选条/卡片拉成超长条；桌面端页面本身
 * 用双栏布局（isPC 分支）利用空间，不靠拉宽容器。
 *
 * `header` 插槽：PC 端渲染为**通栏**顶条（白色，与暖灰内容区分色，
 * 对齐 fish.audio），内部再限宽 1200 让标题与内容左缘对齐；
 * 手机端照旧放在限宽容器内部顶部，行为与从前一致。
 */
export function ScreenContainer({
  children,
  style,
  header,
  fullWidth = false,
}: {
  children: React.ReactNode;
  style?: object;
  header?: React.ReactNode;
  /** PC 端不限宽 1200，内容区从侧边栏右缘起铺满（列表网格类页面用） */
  fullWidth?: boolean;
}) {
  const isPC = useIsPC();
  const inner = (
    <View style={[styles.container, isPC && (fullWidth ? styles.pcFull : styles.pc), style]}>
      {!isPC && header}
      {children}
    </View>
  );
  if (!isPC || !header) return inner;
  return (
    <View style={styles.pcPage}>
      {/* 顶栏内容直接从左缘开始（真左对齐，不随内容区限宽居中） */}
      <View style={styles.pcHeaderBar}>{header}</View>
      {inner}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    width: "100%",
    maxWidth: 640,
    alignSelf: "center",
    paddingHorizontal: 16,
  },
  pc: { maxWidth: 1200, alignSelf: "center", paddingHorizontal: 24, paddingTop: 8 },
  pcFull: { width: "100%", maxWidth: "100%", paddingHorizontal: 24, paddingTop: 8 },
  pcPage: { flex: 1 },
  // 通栏白条：底色与侧边栏色差分割，发丝线收边
  pcHeaderBar: {
    width: "100%",
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(0,0,0,0.05)",
  },
});
