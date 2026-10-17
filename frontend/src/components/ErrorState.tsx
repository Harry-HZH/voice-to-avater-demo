import { StyleSheet, Text, View } from "react-native";
import { colors, typography } from "../theme/theme";
import { Button } from "./Button";

interface Props {
  title?: string;
  /** 失败原因，直接展示给用户 */
  message: string;
  retryLabel?: string;
  onRetry?: () => void;
  secondaryLabel?: string;
  onSecondary?: () => void;
}

/** 失败状态：说明原因 + 给出下一步 */
export function ErrorState({
  title = "出了点问题",
  message,
  retryLabel = "重试",
  onRetry,
  secondaryLabel,
  onSecondary,
}: Props) {
  return (
    <View style={styles.wrap}>
      <View style={styles.badge}>
        <Text style={styles.badgeText}>!</Text>
      </View>
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.message}>{message}</Text>
      <View style={styles.actions}>
        {onRetry && retryLabel ? <Button label={retryLabel} onPress={onRetry} size="sm" /> : null}
        {secondaryLabel && onSecondary ? (
          <Button label={secondaryLabel} onPress={onSecondary} variant="ghost" size="sm" />
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: "center",
    paddingVertical: 32,
    paddingHorizontal: 24,
    backgroundColor: colors.dangerBackground,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "rgba(245, 75, 69, 0.25)",
  },
  badge: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.danger,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 12,
  },
  badgeText: { fontFamily: "Onest_600SemiBold", fontSize: 20, color: "#ffffff" },
  title: { ...typography.title, color: colors.textTitle },
  message: {
    ...typography.caption,
    color: colors.textSubtitle,
    textAlign: "center",
    marginTop: 6,
    marginBottom: 16,
    maxWidth: 300,
  },
  actions: { flexDirection: "row", gap: 10 },
});
