import { useWindowDimensions } from "react-native";

/** 视口宽度达到该值视为 PC（与常见桌面 / 平板横屏分界一致） */
export const PC_MIN_WIDTH = 1024;

/**
 * 用视口宽度判断当前是不是 PC 布局。
 * 手机竖屏 / 平板竖屏返回 false（沿用手机版单列布局），
 * 桌面宽屏返回 true（限宽放宽到 1200 + 多列网格 + 头部内联导航）。
 * 窗口拉伸 / 旋转时实时跟随。
 */
export function useIsPC(): boolean {
  const { width } = useWindowDimensions();
  return width >= PC_MIN_WIDTH;
}
