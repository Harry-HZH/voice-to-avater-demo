import { StyleSheet, Text, View } from "react-native";
import { colors, radius, typography } from "../theme/theme";

export interface Step {
  label: string;
}

/** 创建流程步骤指示器：1 描述 → 2 选择 → 3 保存 */
export function StepIndicator({
  steps,
  current,
  style,
}: {
  steps: Step[];
  current: number;
  style?: object;
}) {
  return (
    <View style={[styles.wrap, style]}>
      {steps.map((s, i) => {
        const state = i < current ? "done" : i === current ? "active" : "todo";
        return (
          <View key={s.label} style={styles.step}>
            <View style={styles.dotRow}>
              <View
                style={[
                  styles.dot,
                  state === "done" && styles.dotDone,
                  state === "active" && styles.dotActive,
                ]}
              >
                <Text
                  style={[
                    styles.dotText,
                    state === "done" && styles.dotTextDone,
                    state === "active" && styles.dotTextActive,
                  ]}
                >
                  {i + 1}
                </Text>
              </View>
              {i < steps.length - 1 && (
                <View style={[styles.line, state === "done" && styles.lineDone]} />
              )}
            </View>
            <Text style={[styles.label, state === "active" && styles.labelActive]}>{s.label}</Text>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: "row", alignItems: "flex-start", justifyContent: "center" },
  step: { alignItems: "center", width: 84 },
  dotRow: { flexDirection: "row", alignItems: "center" },
  dot: {
    width: 26,
    height: 26,
    borderRadius: 13,
    borderWidth: 1,
    borderColor: colors.inputBorderOpaque,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surface,
  },
  dotDone: { backgroundColor: colors.actionPrimaryBg, borderColor: colors.actionPrimaryBg },
  dotActive: { borderColor: colors.brand, borderWidth: 2 },
  dotText: { fontFamily: "Onest_500Medium", fontSize: 12, color: colors.textHelper },
  // done：深色填充圆底，配白字
  dotTextDone: { color: colors.textInvert },
  // active：白底 + 品牌色描边，数字必须用深色（显式 #161616，避免任何覆盖顺序导致白字不可见）
  dotTextActive: { color: "#161616", fontFamily: "Onest_600SemiBold" },
  line: { width: 28, height: 1, backgroundColor: colors.inputBorderOpaque, marginHorizontal: 4 },
  lineDone: { backgroundColor: colors.actionPrimaryBg },
  label: { ...typography.small, color: colors.textHelper, marginTop: 6 },
  labelActive: { color: colors.textTitle, fontFamily: "Onest_500Medium" },
});
