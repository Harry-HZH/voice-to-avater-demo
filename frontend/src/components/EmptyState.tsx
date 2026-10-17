import { StyleSheet, Text, View } from "react-native";
import { colors, typography } from "../theme/theme";
import { Button } from "./Button";

interface Props {
  title: string;
  description?: string;
  actionLabel?: string;
  onAction?: () => void;
}

/** 空状态：说明 + 主行动点 */
export function EmptyState({ title, description, actionLabel, onAction }: Props) {
  return (
    <View style={styles.wrap}>
      <View style={styles.iconRing}>
        <View style={styles.iconDot} />
      </View>
      <Text style={styles.title}>{title}</Text>
      {description ? <Text style={styles.desc}>{description}</Text> : null}
      {actionLabel ? (
        <View style={styles.action}>
          <Button label={actionLabel} onPress={onAction} variant="primary" size="md" />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: "center", paddingVertical: 48, paddingHorizontal: 24 },
  iconRing: {
    width: 56,
    height: 56,
    borderRadius: 28,
    borderWidth: 1,
    borderColor: colors.inputBorderOpaque,
    borderStyle: "dashed",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 16,
  },
  iconDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.textDisabled },
  title: { ...typography.title, color: colors.textTitle, textAlign: "center" },
  desc: {
    ...typography.caption,
    color: colors.textDescription,
    textAlign: "center",
    marginTop: 6,
    maxWidth: 260,
  },
  action: { marginTop: 20 },
});
