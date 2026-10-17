import { Pressable, StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import { useState } from "react";
import { colors, radius, typography } from "../theme/theme";
import { formatDate } from "../lib/format";
import { absUrl } from "../lib/api";
import type { Job } from "../data/types";
import { StatusPill } from "./StatusPill";
import { WatercolorPortrait } from "./WatercolorPortrait";

interface Props {
  job: Job;
  onRetry?: () => void;
  onCancel?: () => void;
  onDelete?: () => void;
  /** 整卡点击（候选形象任务回到生成页 / 创作任务进入创作详情） */
  onPress?: () => void;
  /** 可点击时的引导文案，如「回到等待页」 */
  pressHint?: string;
}

const TYPE_META: Record<Job["type"], { icon: keyof typeof Feather.glyphMap; label: string }> = {
  portrait: { icon: "image", label: "生成候选形象" },
  speak: { icon: "video", label: "开口说话" },
  tts: { icon: "mic", label: "语音合成" },
};

/** 说话任务的成片摘要：把真正花掉的钱写出来（时长就是计费时长）。 */
function speakResultText(job: Job): string {
  const seconds = job.output?.output_duration ?? job.output?.duration;
  const points = job.output?.estimated_points;
  const parts: string[] = ["已生成说话视频"];
  if (seconds) parts.push(`${Math.round(seconds)} 秒`);
  if (points != null) parts.push(`${points} 点`);
  return parts.join(" · ");
}

/** 任务卡片：覆盖 queued / running / succeeded / failed 四种状态 */
export function JobCard({ job, onRetry, onCancel, onDelete, onPress, pressHint }: Props) {
  const meta = TYPE_META[job.type] ?? { icon: "activity" as const, label: job.type };
  const [hover, setHover] = useState(false);
  const isPortrait = job.type === "portrait";
  const isViews = job.input.kind === "views";
  const seed = job.input.avatar_id ?? job.input.voice_id ?? job.id;
  const progress = job.progress ?? 62;
  // 有真实产物就显示真实图片（候选图取第一张，三视图取侧面）
  const resultThumb = absUrl(job.output?.image_urls?.[0] ?? job.output?.view_urls?.side);
  // 只有终态任务能删（进行中的先取消），删除入口由父级弹确认
  const deletable = Boolean(onDelete) && (job.status === "succeeded" || job.status === "failed");

  const card = (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.card, hover && styles.cardHover, pressed && styles.pressed]}
      onHoverIn={() => setHover(true)}
      onHoverOut={() => setHover(false)}
    >
      <View style={styles.header}>
        <View style={styles.typeRow}>
          <View style={styles.typeIcon}>
            <Feather name={meta.icon} size={14} color={colors.textSubtitle} />
          </View>
          <View>
            <Text style={styles.type}>{meta.label}</Text>
            <Text style={styles.time}>
              {formatDate(job.created_at)} 创建 · {formatDate(job.updated_at).slice(11)} 更新
            </Text>
          </View>
        </View>
        <StatusPill status={job.status} />
      </View>

      {/* 输入摘要 */}
      <Text style={styles.summary} numberOfLines={2}>
        {job.input.prompt ?? job.input.script ?? job.input.text ?? "—"}
      </Text>

      {/* 进行中：进度条 + 查看进度 / 取消 */}
      {job.status === "running" && (
        <View style={styles.progressBlock}>
          <View style={styles.progressTrack}>
            <View style={[styles.progressFill, { width: `${progress}%` }]} />
          </View>
          <View style={styles.progressMeta}>
            <Text style={styles.progressText}>
              {typeof job.progress === "number"
                ? `正在生成 · ${job.stage ? `${job.stage} ` : ""}已完成 ${progress}%…`
                : `正在生成 · ${job.stage ?? "处理中"}…`}
            </Text>
            <View style={styles.metaActions}>
              {onPress && pressHint ? (
                <Pressable onPress={onPress} hitSlop={8}>
                  <Text style={styles.hintText}>{pressHint} ›</Text>
                </Pressable>
              ) : null}
              {onCancel ? (
                <Pressable onPress={onCancel} hitSlop={8}>
                  <Text style={styles.cancelText}>取消</Text>
                </Pressable>
              ) : null}
            </View>
          </View>
        </View>
      )}

      {/* 排队中 */}
      {job.status === "queued" && (
        <View style={styles.progressBlock}>
          <View style={styles.progressTrack}>
            <View style={[styles.progressFill, { width: "8%", backgroundColor: colors.textHelper }]} />
          </View>
          <View style={styles.progressMeta}>
            <Text style={styles.progressText}>排队中，前面还有 1 个任务…</Text>
            {onPress && pressHint ? (
              <Pressable onPress={onPress} hitSlop={8}>
                <Text style={styles.hintText}>{pressHint} ›</Text>
              </Pressable>
            ) : null}
          </View>
        </View>
      )}

      {/* 成功：结果缩略 */}
      {job.status === "succeeded" && (
        <View style={styles.resultRow}>
          <WatercolorPortrait seed={seed} size={56} url={resultThumb} />
          <View style={styles.resultInfo}>
            <Feather name="check-circle" size={14} color={colors.success} />
            <Text style={styles.resultText}>
              {isPortrait
                ? isViews
                  ? `已生成 ${job.input.count ?? 2} 张视图`
                  : `已生成 ${job.input.count ?? 3} 张候选图`
                : job.type === "tts"
                  ? "语音已生成"
                  : speakResultText(job)}
            </Text>
          </View>
          {onPress && <Feather name="chevron-right" size={16} color={colors.textDisabled} />}
        </View>
      )}

      {/* 失败：原因 + 重试（用户主动取消的不给重试——取消是明确意图，想再生成应重新发起） */}
      {job.status === "failed" && job.error && (
        <View style={styles.errorBlock}>
          <View style={styles.errorHead}>
            <Feather name="alert-circle" size={14} color={colors.danger} />
            <Text style={styles.errorCode}>{job.error.code}</Text>
          </View>
          <Text style={styles.errorMsg}>{job.error.message}</Text>
          <View style={styles.errorActions}>
            {job.error.code !== "CANCELED" && (
              <Pressable onPress={onRetry} hitSlop={8} style={styles.retryBtn}>
                <Feather name="refresh-cw" size={12} color={colors.brand} />
                <Text style={styles.retryText}>重试</Text>
              </Pressable>
            )}
            {onPress && pressHint ? (
              <Pressable onPress={onPress} hitSlop={8} style={styles.retryBtn}>
                <Text style={styles.hintText}>{pressHint} ›</Text>
              </Pressable>
            ) : null}
          </View>
        </View>
      )}

      {/* 删除入口：只对终态任务出现 */}
      {deletable && (
        <Pressable onPress={onDelete} hitSlop={8} testID="job-delete" style={styles.deleteRow}>
          <Feather name="trash-2" size={12} color={colors.textHelper} />
          <Text style={styles.deleteText}>删除记录</Text>
        </Pressable>
      )}
    </Pressable>
  );

  // onPress 已直接挂在卡片根节点上——不要再包一层 Pressable：
  // RN Web 的 press 只派发给最内层 Pressable，嵌套会让外层 onPress 永远收不到点击
  return card;
}

const styles = StyleSheet.create({
  pressed: { opacity: 0.85 },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.05)",
    padding: 14,
    gap: 10,
  },
  // web 悬停：边框加深 + 轻微抬升
  cardHover: {
    borderColor: "rgba(0,0,0,0.12)",
    boxShadow: "0 6px 16px 0 rgba(0, 0, 0, 0.06)",
  },
  header: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: 8 },
  typeRow: { flexDirection: "row", gap: 10, alignItems: "center", flex: 1 },
  typeIcon: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: colors.fillDefault,
    alignItems: "center",
    justifyContent: "center",
  },
  type: { ...typography.title, fontSize: 14, color: colors.textTitle },
  time: { ...typography.small, fontSize: 11, color: colors.textHelper, marginTop: 2 },
  summary: { ...typography.caption, color: colors.textDescription },
  progressBlock: { gap: 6 },
  progressTrack: {
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.fillDefault,
    overflow: "hidden",
  },
  progressFill: { height: 6, borderRadius: 3, backgroundColor: colors.brand },
  progressMeta: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 8,
  },
  progressText: { ...typography.small, color: colors.textSubtitle, flexShrink: 1 },
  metaActions: { flexDirection: "row", alignItems: "center", gap: 12 },
  cancelText: { ...typography.small, color: colors.textSubtitle, textDecorationLine: "underline" },
  hintText: { ...typography.small, color: colors.brand, fontFamily: "Onest_500Medium" },
  resultRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  resultInfo: { flexDirection: "row", alignItems: "center", gap: 6 },
  resultText: { ...typography.caption, color: colors.textBody },
  errorBlock: {
    backgroundColor: colors.dangerBackground,
    borderRadius: radius.card,
    padding: 10,
    gap: 4,
  },
  errorHead: { flexDirection: "row", alignItems: "center", gap: 6 },
  errorCode: { fontFamily: "GeistMono_400Regular", fontSize: 11, color: colors.danger },
  errorMsg: { ...typography.caption, fontSize: 12, color: colors.textSubtitle },
  errorActions: { flexDirection: "row", alignItems: "center", gap: 16, marginTop: 4 },
  retryBtn: { flexDirection: "row", alignItems: "center", gap: 4, alignSelf: "flex-start" },
  retryText: { ...typography.small, color: colors.brand, fontFamily: "Onest_500Medium" },
  deleteRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    alignSelf: "flex-end",
    marginTop: -2,
  },
  deleteText: { ...typography.small, fontSize: 11, color: colors.textHelper },
});
