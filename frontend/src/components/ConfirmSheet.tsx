import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import { colors, radius, typography } from "../theme/theme";
import { BottomSheet } from "./BottomSheet";

interface BodyProps {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** 确认动作要 async 时给 busy 态：转圈 + 防重复点击 */
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
  /** 内容体根节点的 testID；按钮 id 由它派生（`${testID}-confirm/-cancel`） */
  testID?: string;
  /** 显式指定按钮 id（外壳场景用：root 的 testID 已被 BottomSheet 占用） */
  confirmTestID?: string;
  cancelTestID?: string;
}

interface SheetProps extends Omit<BodyProps, "onCancel"> {
  visible: boolean;
  onClose: () => void;
}

/**
 * 确认弹窗的**内容体**（不含 Modal）。
 * iOS 原生上 Modal 不允许嵌套：内层 Modal 的原生窗口不显示、却照样拦截全部触摸，
 * 表现为「屏幕点哪都没反应」。所以凡是已经处在某个 BottomSheet 里的场景，
 * 必须用这个 Body 复用外层 Modal，绝不能再开一层 ConfirmSheet。
 */
export function ConfirmSheetBody({
  title,
  message,
  confirmLabel = "删除",
  cancelLabel = "取消",
  onConfirm,
  onCancel,
  testID,
  confirmTestID,
  cancelTestID,
}: BodyProps) {
  const [busy, setBusy] = useState(false);

  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.inner} testID={testID}>
      <View style={styles.iconWrap}>
        <Feather name="alert-triangle" size={20} color={colors.danger} />
      </View>
      <Text style={styles.title}>{title}</Text>
      {message ? <Text style={styles.message}>{message}</Text> : null}

      <View style={styles.actions}>
        <Pressable
          testID={confirmTestID ?? (testID ? `${testID}-confirm` : undefined)}
          disabled={busy}
          onPress={() => void confirm()}
          style={({ pressed }) => [styles.confirmBtn, busy && styles.disabled, pressed && styles.pressed]}
        >
          {busy ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <Text style={styles.confirmText}>{confirmLabel}</Text>
          )}
        </Pressable>
        <Pressable
          testID={cancelTestID ?? (testID ? `${testID}-cancel` : undefined)}
          disabled={busy}
          onPress={busy ? () => {} : onCancel}
          style={({ pressed }) => [styles.cancelBtn, busy && styles.disabled, pressed && styles.pressed]}
        >
          <Text style={styles.cancelText}>{cancelLabel}</Text>
        </Pressable>
      </View>
    </View>
  );
}

/**
 * 危险操作确认弹窗（删除等）的独立外壳。
 * ⚠️ 只能用在**没有**处于其它 Modal 内的场景；嵌套场景用 ConfirmSheetBody。
 */
export function ConfirmSheet({
  visible,
  onClose,
  title,
  message,
  confirmLabel = "删除",
  cancelLabel = "取消",
  onConfirm,
  testID,
}: SheetProps) {
  return (
    <BottomSheet visible={visible} onClose={onClose} heightRatio={0.8} testID={testID}>
      {/* key 让每次打开都重挂载，重置上一次残留的 busy 态；
          body 不传 testID（root 的 testID 已在 BottomSheet 上，避免重复），
          按钮 id 显式下发 */}
      <ConfirmSheetBody
        key={String(visible)}
        confirmTestID={testID ? `${testID}-confirm` : undefined}
        cancelTestID={testID ? `${testID}-cancel` : undefined}
        title={title}
        message={message}
        confirmLabel={confirmLabel}
        cancelLabel={cancelLabel}
        onConfirm={onConfirm}
        onCancel={onClose}
      />
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  inner: { paddingHorizontal: 24, paddingTop: 8, paddingBottom: 32, gap: 10 },
  iconWrap: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.dangerBackground,
    alignItems: "center",
    justifyContent: "center",
    alignSelf: "center",
  },
  title: { ...typography.h3, color: colors.textTitle, textAlign: "center" },
  message: { ...typography.caption, color: colors.textDescription, textAlign: "center", lineHeight: 21 },
  actions: { flexDirection: "row", gap: 10, marginTop: 12 },
  confirmBtn: {
    flex: 1,
    height: 46,
    borderRadius: radius.button,
    backgroundColor: colors.danger,
    alignItems: "center",
    justifyContent: "center",
  },
  confirmText: { ...typography.caption, color: "#fff", fontFamily: "Onest_500Medium" },
  cancelBtn: {
    flex: 1,
    height: 46,
    borderRadius: radius.button,
    backgroundColor: colors.fillDefault,
    alignItems: "center",
    justifyContent: "center",
  },
  cancelText: { ...typography.caption, color: colors.textTitle, fontFamily: "Onest_500Medium" },
  disabled: { opacity: 0.6 },
  pressed: { opacity: 0.85 },
});
