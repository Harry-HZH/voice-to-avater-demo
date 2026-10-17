import { StyleSheet, Text, View } from "react-native";
import { colors, radius } from "../theme/theme";
import type { JobStatus } from "../data/types";

const STATUS_MAP: Record<JobStatus, { label: string; bg: string; fg: string }> = {
  queued: { label: "排队中", bg: colors.fillDefault, fg: colors.textSubtitle },
  running: { label: "生成中", bg: "rgba(245, 97, 56, 0.12)", fg: colors.brand },
  succeeded: { label: "已完成", bg: colors.successBackground, fg: colors.success },
  failed: { label: "失败", bg: colors.dangerBackground, fg: colors.danger },
};

/** 任务状态胶囊。queued→running→succeeded/failed 四种状态各有配色 */
export function StatusPill({ status }: { status: JobStatus }) {
  const s = STATUS_MAP[status];
  return (
    <View style={[styles.pill, { backgroundColor: s.bg }]}>
      <View style={[styles.dot, { backgroundColor: s.fg }]} />
      <Text style={[styles.label, { color: s.fg }]}>{s.label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    height: 24,
    paddingHorizontal: 10,
    borderRadius: radius.button,
    alignSelf: "flex-start",
  },
  dot: { width: 6, height: 6, borderRadius: 3 },
  label: { fontFamily: "Onest_500Medium", fontSize: 12 },
});
