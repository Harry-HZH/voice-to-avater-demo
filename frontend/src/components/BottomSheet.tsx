import { useEffect, useRef } from "react";
import {
  Animated,
  Easing,
  Modal,
  Pressable,
  StyleSheet,
  useWindowDimensions,
  View,
} from "react-native";
import { colors, shadows } from "../theme/theme";
import { useIsPC } from "../lib/useIsPC";

interface Props {
  visible: boolean;
  onClose: () => void;
  /** 面板高度占屏幕比例（上限），默认 0.8；PC 上作为弹窗最大高度 */
  heightRatio?: number;
  /** 顶部把手（拖拽指示条），PC 居中弹窗强制不显示 */
  showHandle?: boolean;
  testID?: string;
  children: React.ReactNode;
}

/** PC 居中弹窗的宽度（fish audio 风格的紧凑对话框） */
const DIALOG_WIDTH = 560;

/**
 * 弹窗外壳。
 *
 * - 手机：bottom sheet，面板从底部滑入；灰色蒙层立即铺满（不做动画），
 *   之前用 Modal 的 animationType="slide" 会把蒙层和面板一起推上来，所以自己动面板。
 * - PC（视口 ≥1024）：改为水平垂直居中的对话框——固定宽度、高度随内容
 *   （不超过 heightRatio），淡入 + 轻微放大登场，不带拖拽把手。
 */
export function BottomSheet({
  visible,
  onClose,
  heightRatio = 0.8,
  showHandle = true,
  testID,
  children,
}: Props) {
  const { height: windowHeight } = useWindowDimensions();
  const isPC = useIsPC();
  const sheetHeight = Math.round(windowHeight * heightRatio);
  // 0 = 隐藏，1 = 完全出现
  const progress = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!visible) {
      progress.setValue(0);
      return;
    }
    progress.setValue(0);
    Animated.timing(progress, {
      toValue: 1,
      duration: 220,
      easing: Easing.out(Easing.cubic),
      // web 端没有原生动画模块，用 JS driver（transform/opacity 同样生效）
      useNativeDriver: false,
    }).start();
  }, [visible, progress]);

  // 手机：从屏幕底部滑入
  const translateY = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [sheetHeight, 0],
  });
  // PC：淡入 + 0.96 → 1 轻微放大
  const dialogOpacity = progress;
  const dialogScale = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [0.96, 1],
  });

  const sheetStyle = isPC
    ? [
        styles.dialog,
        { maxWidth: DIALOG_WIDTH, maxHeight: sheetHeight, opacity: dialogOpacity },
        { transform: [{ scale: dialogScale }] },
      ]
    : [styles.sheet, { height: sheetHeight, transform: [{ translateY }] }];

  return (
    <Modal
      visible={visible}
      transparent
      animationType="none"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <View style={[styles.root, isPC && styles.rootPC]} testID={testID}>
        {/* 蒙层：静态的满屏半透明，不参与面板动画 */}
        <Pressable
          style={styles.backdrop}
          onPress={onClose}
          testID={testID ? `${testID}-backdrop` : undefined}
        />

        <Animated.View style={sheetStyle}>
          {!isPC && showHandle ? <View style={styles.handle} /> : null}
          {children}
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: "flex-end" },
  // PC：弹窗水平垂直居中
  rootPC: { justifyContent: "center", alignItems: "center", paddingHorizontal: 24 },
  backdrop: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: "rgba(22, 22, 22, 0.4)",
  },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    ...shadows.popover,
  },
  dialog: {
    width: "100%",
    backgroundColor: colors.surface,
    borderRadius: 20,
    overflow: "hidden",
    ...shadows.popover,
  },
  handle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.inputBorderOpaque,
    alignSelf: "center",
    marginTop: 10,
  },
});
