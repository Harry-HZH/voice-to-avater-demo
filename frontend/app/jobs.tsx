import { useCallback, useEffect, useState } from "react";
import { FlatList, StyleSheet, Text, View } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { useIsPC } from "../src/lib/useIsPC";
import { colors, typography } from "../src/theme/theme";
import { jobs, subscribeData } from "../src/data/mock";
import { cancelJob, deleteJob, hydrateJobs, restartJob } from "../src/data/portrait";
import { JobCard } from "../src/components/JobCard";
import { Chip } from "../src/components/Chip";
import { EmptyState } from "../src/components/EmptyState";
import { ScreenContainer } from "../src/components/ScreenContainer";
import { ScreenHeader } from "../src/components/ScreenHeader";
import { ConfirmSheet } from "../src/components/ConfirmSheet";
import { userErrorMessage } from "../src/lib/api";
import { Toast, useToast } from "../src/components/Toast";
import type { JobStatus } from "../src/data/types";

type Filter = "all" | "active" | "done" | "failed";

const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "active", label: "进行中" },
  { key: "done", label: "已完成" },
  { key: "failed", label: "失败" },
];

function matchFilter(status: JobStatus, f: Filter): boolean {
  if (f === "all") return true;
  if (f === "active") return status === "queued" || status === "running";
  if (f === "done") return status === "succeeded";
  return status === "failed";
}

/**
 * 任务中心（功能列表入口之一）：生成形象 / 开口说话的任务状态。
 * queued → running → succeeded / failed 全状态可见，失败可重试。
 */
export default function JobsScreen() {
  const router = useRouter();
  const [filter, setFilter] = useState<Filter>("all");
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  // 轻反馈统一走 toast（取消成功 / 删除失败）；需要决策的仍是确认弹窗
  const { message: toastMsg, show } = useToast();
  // 新任务（如保存创作）产生后刷新列表
  const [, forceUpdate] = useState(0);
  useEffect(() => subscribeData(() => forceUpdate((x) => x + 1)), []);
  const isPC = useIsPC();
  // 后端才是真正落库的那一份：每次聚焦（首次挂载 + 切 tab 回来）都同步一次，
  // 任务状态 / 新产物在别处产生后回到任务中心能立刻看到
  useFocusEffect(
    useCallback(() => {
      void hydrateJobs();
    }, []),
  );
  // 注意：不做 useMemo——jobs 是模块级可变数组，任务状态原地更新时条数不变，
  // 以条数为依赖的缓存会返回旧列表（取消后卡片不刷新就是这个坑）。全量过滤开销可忽略。
  const filtered = jobs.filter((j) => matchFilter(j.status, filter));

  return (
    <ScreenContainer
      header={isPC ? <ScreenHeader title="任务中心" /> : undefined}
      style={{ paddingHorizontal: 0 }}
    >
      <View style={styles.introRow}>
        <Text style={[styles.intro, isPC && styles.introPC]}>生成候选形象、让角色开口说话的任务都在这里。</Text>
        <Text style={styles.count}>{jobs.length} 条</Text>
      </View>
      <View style={styles.chipRow}>
        {FILTERS.map((f) => (
          <Chip
            key={f.key}
            label={f.label}
            selected={filter === f.key}
            onPress={() => setFilter(f.key)}
          />
        ))}
      </View>
      <FlatList
        // 单列（PC/手机一致，用户指定）
        data={filtered}
        keyExtractor={(j) => j.id}
        renderItem={({ item, index }) => {
          // 候选形象任务：整卡点回生成页，按任务状态落到等待页 / 候选页 / 失败页
          const openCreate =
            item.type === "portrait" && item.input.voice_id
              ? () =>
                  router.push({
                    pathname: "/avatar/create/[voiceId]",
                    params: { voiceId: item.input.voice_id as string, job: item.id },
                  })
              : undefined;
          // 说话任务：点回创作台（成片就在那儿看，也能改台词重来）
          const openSpeak =
            item.type === "speak" && item.input.avatar_id
              ? () => router.push(`/avatar/${item.input.avatar_id}/create?job=${item.id}`)
              : undefined;
          // 已取消的任务就是已取消：整卡不可点、没有「去处理」，想再生成就重新发起
          const canceled = item.status === "failed" && item.error?.code === "CANCELED";
          const open = canceled ? undefined : openCreate ?? openSpeak;
          return (
            <JobCard
              job={item}
              pressHint={
                canceled
                  ? undefined
                  : openCreate
                  ? item.status === "succeeded"
                    ? item.input.kind === "views"
                      ? "查看结果"
                      : "查看候选"
                    : item.status === "failed"
                      ? "去处理"
                      : "回到等待页"
                  : openSpeak
                    ? item.status === "succeeded"
                      ? "查看成片"
                      : item.status === "failed"
                        ? "去处理"
                        : "查看进度"
                    : undefined
              }
              onRetry={async () => {
                // 先把任务重新跑起来，再跳回生成页，否则会先落到失败页
                try {
                  await restartJob(item.id);
                  open?.();
                } catch (err) {
                  show(userErrorMessage(err, "重试失败，请稍后再试"));
                }
              }}
              onCancel={async () => {
                try {
                  const job = await cancelJob(item.id);
                  show(job?.error?.message || "已取消生成");
                  // 后端才是任务状态的真源：取消后立刻对齐一次，
                  // 避免卡片还停留在「排队中 / 生成中」等下一次轮询
                  void hydrateJobs();
                } catch (err) {
                  show(userErrorMessage(err, "取消失败，请稍后再试"));
                }
              }}
              onDelete={() => {
                setPendingDeleteId(item.id);
              }}
              onPress={open}
            />
          );
        }}
        contentContainerStyle={styles.list}
        showsVerticalScrollIndicator={false}
        ListEmptyComponent={
          <EmptyState
            title="暂无任务"
            description="生成候选形象、或让角色开口说话时，任务会显示在这里"
          />
        }
      />

      <ConfirmSheet
        visible={pendingDeleteId !== null}
        onClose={() => setPendingDeleteId(null)}
        title="删除这条任务记录？"
        message="本地的产物文件（候选图 / 成片 / 音轨）会一并删除，无法恢复；引用它的创作将无法继续播放。"
        confirmLabel="删除记录"
        onConfirm={async () => {
          if (!pendingDeleteId) return;
          try {
            await deleteJob(pendingDeleteId);
            setPendingDeleteId(null);
            show("已删除任务记录");
          } catch (err) {
            setPendingDeleteId(null);
            show(userErrorMessage(err, "删除失败，请稍后再试"));
          }
        }}
        testID="job-delete-sheet"
      />

      <Toast message={toastMsg} />
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  introRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 10,
    flexWrap: "wrap",
  },
  // PC 页面大标题：单独占一行（introRow 换行包裹）
  pageTitle: { ...typography.h2, color: colors.textTitle, paddingTop: 24, width: "100%" },
  intro: { ...typography.caption, color: colors.textDescription, flexShrink: 1 },
  introPC: { fontSize: 15, lineHeight: 22 },
  count: { ...typography.small, color: colors.textHelper },
  chipRow: {
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: 16,
    paddingTop: 6,
    paddingBottom: 16,
  },
  list: { paddingHorizontal: 16, paddingBottom: 32, gap: 10 },
  // PC 两列：行内两格等宽，缝隙放宽
  pcRow: { gap: 14 },
  pcCell: { flex: 1 },
});
