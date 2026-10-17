/**
 * 轻量 toast：屏幕正中央浮层，出现后自动消失。
 *
 * - `useToast()` 持有消息状态，`show(msg)` 弹出（重复调用会重置计时）；
 * - `<Toast message={...} />` 负责渲染，`pointerEvents="none"` 不挡操作。
 *
 * 定位：浮层挂在页面容器里，而容器顶上可能压着 PC 通栏顶栏 / 侧边栏，
 * 直接 justifyContent:center 会偏。挂载后用 `measureInWindow` 实测容器
 * 在窗口中的位置，把消息胶囊平移到**整个视口**的正中央（窗口缩放时重算）。
 * 只承担「操作已生效」这类轻反馈；需要用户决策的仍走弹窗 / 内联错误。
 */

import { useEffect, useRef, useState } from "react";
import { StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { colors, typography } from "../theme/theme";

export function useToast(duration = 2400) {
  const [message, setMessage] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = (msg: string) => {
    setMessage(msg);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setMessage(null), duration);
  };

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  return { message, show };
}

export function Toast({ message }: { message: string | null }) {
  const win = useWindowDimensions();
  const [dy, setDy] = useState(0);
  const wrapRef = useRef<View>(null);

  // 容器在窗口里的垂直中点 = y + h/2；把浮层往上/下平移两者之差，
  // 消息就落在整个视口的正中央（顶栏、侧边栏造成的偏移都被抵消）。
  // 注意：浮层必须**常驻挂载**，否则量不到自己 —— 之前「测不到就不渲染」
  // 是个死锁，Toast 永远出不来。
  useEffect(() => {
    const v = wrapRef.current;
    if (!v) return;
    v.measureInWindow((_x, y, _w, h) => {
      if (h > 0) setDy(win.height / 2 - (y + h / 2));
    });
  }, [message, win.height, win.width]);

  return (
    <View ref={wrapRef} style={styles.wrap} pointerEvents="none" testID="toast">
      {message !== null && (
        <View style={[styles.pill, dy !== 0 && { transform: [{ translateY: dy }] }]}>
          <Text style={styles.text}>{message}</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  // 平移加在胶囊上而不是浮层上：浮层要一直在原地被测量
  pill: {
    backgroundColor: "rgba(0,0,0,0.78)",
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 10,
    overflow: "hidden",
  },
  text: {
    ...typography.small,
    color: colors.textInvert,
  },
});
