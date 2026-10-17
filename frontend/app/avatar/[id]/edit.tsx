import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { colors, radius, typography } from "../../../src/theme/theme";
import {
  getAvatar,
  getJob,
  hasView,
  subscribeData,
  updateAvatar,
  viewSeed,
} from "../../../src/data/mock";
import { fetchJobById, startViewsJob } from "../../../src/data/portrait";
import { absUrl, userErrorMessage } from "../../../src/lib/api";
import { getVoice } from "../../../src/data/voices";
import { AVATAR_VIEWS } from "../../../src/data/types";
import type { AvatarView, AvatarViews } from "../../../src/data/types";
import { AvatarCardView } from "../../../src/components/AvatarCardView";
import { WatercolorPortrait } from "../../../src/components/WatercolorPortrait";
import { Button } from "../../../src/components/Button";
import { ErrorState } from "../../../src/components/ErrorState";
import { ScreenHeader } from "../../../src/components/ScreenHeader";
import { ScreenContainer } from "../../../src/components/ScreenContainer";

/**
 * 编辑角色信息（独立页面）：卡片预览 + 基本信息表单 + 三视图管理。
 *
 * 三视图补图走后端真实 image-to-image（以这个形象的正面图作参考，保证还是同一个人）：
 * 创建时如果跳过了侧面 / 背面，这里可以随时补，结果直接写回本地形象数据。
 * 演示数据（没有真实来源任务）或后端不可用时，退回本地占位图演示。
 */
export default function EditAvatarScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const avatar = getAvatar(id);
  const voice = avatar ? getVoice(avatar.voice_id) : undefined;

  // 表单草稿（进入页面时以当前角色信息初始化）
  const [name, setName] = useState(avatar?.name ?? "");
  const [summary, setSummary] = useState(avatar?.profile.summary ?? "");
  const [ageRange, setAgeRange] = useState(avatar?.profile.ageRange ?? "");
  const [personality, setPersonality] = useState(avatar?.profile.personality ?? "");
  const [style, setStyle] = useState(avatar?.profile.style ?? "");
  const [saved, setSaved] = useState(false);

  // 三视图生成进度：远程任务读后端进度，本地演示用定时器
  const [generatingView, setGeneratingView] = useState<AvatarView | null>(null);
  const [viewProgress, setViewProgress] = useState(0);
  const [viewsNotice, setViewsNotice] = useState<string | null>(null);
  // 正在跑的真实补图任务（没有就是本地演示）
  const [remoteViewsJob, setRemoteViewsJob] = useState<{ jobId: string; view: AvatarView } | null>(
    null,
  );
  const viewTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const backTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 已经写回过的补图任务，避免同一个任务被处理两次
  const handledJobs = useRef<Set<string>>(new Set());

  // 数据变更（如三视图生成完成）后刷新页面
  const [dataTick, forceUpdate] = useState(0);
  useEffect(() => subscribeData(() => forceUpdate((x) => x + 1)), []);

  // 真实补图任务的进度与完成：轮询把任务写进本地列表，这里只负责读
  useEffect(() => {
    if (!remoteViewsJob || !avatar) return;
    const job = getJob(remoteViewsJob.jobId);
    if (!job) return;

    if (job.status === "queued" || job.status === "running") {
      setViewProgress(Math.round(job.progress ?? 0));
      return;
    }
    if (handledJobs.current.has(job.id)) return;
    handledJobs.current.add(job.id);

    if (job.status === "succeeded") {
      const urls = (job.output as { view_urls?: Record<string, string> } | null)?.view_urls ?? {};
      const patch: AvatarViews = {};
      for (const [key, url] of Object.entries(urls)) {
        // 后端给的是本后端的相对地址（/api/jobs/...），存进形象前先补成绝对地址
        if (url) patch[key as AvatarView] = absUrl(url) ?? null;
      }
      if (Object.keys(patch).length > 0) {
        void updateAvatar(avatar.id, { views: { ...avatar.views, ...patch } });
      }
      setViewProgress(100);
      setViewsNotice(`已补充：${Object.keys(patch).length} 张视图`);
    } else {
      setViewsNotice(job.error?.message ?? "生成失败，稍后可以再点一次");
    }
    setGeneratingView(null);
    setRemoteViewsJob(null);
  }, [avatar, remoteViewsJob, dataTick]);

  useEffect(() => {
    return () => {
      if (viewTimer.current) clearInterval(viewTimer.current);
      if (backTimer.current) clearTimeout(backTimer.current);
    };
  }, []);

  if (!avatar) {
    return (
      <ScreenContainer header={<ScreenHeader title="Avatar 不存在" back />}>
        <ErrorState
          title="没有找到这个 Avatar"
          message="它可能已被删除"
          retryLabel="返回列表"
          onRetry={() => router.push("/avatars")}
        />
      </ScreenContainer>
    );
  }

  const generatedCount = AVATAR_VIEWS.filter((v) => hasView(avatar, v.key)).length;
  const viewsComplete = generatedCount === 3;

  // 注意：副作用（updateAvatar 会通知其他组件刷新）必须放在 state updater 之外，
  // 否则会在渲染期间触发别的组件 setState，React 会报警告。

  /**
   * 补充缺失视图。必须是真实生成出来的形象（记得住来源任务）才有参考图，
   * 后端 image-to-image；来源任务不在 / 后端出错 → 明确报错，不搞占位图演示。
   */
  const generateView = async (view: AvatarView) => {
    if (generatingView) return;
    setGeneratingView(view);
    setViewProgress(0);
    setViewsNotice(null);

    const sourceJobId = avatar.source_job_id;
    if (!sourceJobId) {
      setGeneratingView(null);
      setViewsNotice("这个形象没有生成来源任务（缺参考图），无法补图");
      return;
    }
    try {
      // 先确认这条候选任务还在后端（它记着上游那张参考图），再提交补图
      const source = await fetchJobById(sourceJobId);
      if (!source) {
        setGeneratingView(null);
        setViewsNotice("来源候选任务已不存在，无法取参考图补图");
        return;
      }
      const created = await startViewsJob({
        job_id: sourceJobId,
        index: avatar.source_index ?? 0,
        views: [view],
      });
      if (!created) {
        setGeneratingView(null);
        setViewsNotice("补图未提交（演示模式不支持补图）");
        return;
      }
      setRemoteViewsJob({ jobId: created.id, view });
    } catch (err) {
      setGeneratingView(null);
      setViewsNotice(userErrorMessage(err, "补图提交失败，请稍后再试"));
    }
  };

  const save = async () => {
    await updateAvatar(avatar.id, {
      name: name.trim() || avatar.name,
      profile: { summary, ageRange, personality, style },
    });
    setSaved(true);
    // 短暂反馈后返回上一页（列表 / 详情页会通过数据订阅自动刷新）
    backTimer.current = setTimeout(() => router.back(), 700);
  };

  return (
    <ScreenContainer header={<ScreenHeader title="编辑角色信息" back />} style={{ paddingHorizontal: 0 }}>
      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        {/* 卡片预览：随输入实时更新 */}
        <View style={styles.previewBlock}>
          <View style={styles.previewCard}>
            <AvatarCardView
              avatar={{
                ...avatar,
                name: name.trim() || avatar.name,
                profile: { summary, ageRange, personality, style },
              }}
              voice={voice}
            />
          </View>
          <Text style={styles.previewHint}>卡片在「我的 Avatar」里的样子</Text>
        </View>

        {/* 基本信息 */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>基本信息</Text>
          <View style={styles.formCard}>
            <Text style={styles.fieldLabel}>名称</Text>
            <TextInput
              value={name}
              onChangeText={setName}
              placeholder="角色名称"
              placeholderTextColor={colors.textHelper}
              testID="edit-name"
              style={styles.input}
            />

            <Text style={styles.fieldLabel}>简介</Text>
            <TextInput
              value={summary}
              onChangeText={setSummary}
              multiline
              placeholder="用一段话介绍这个角色"
              placeholderTextColor={colors.textHelper}
              testID="edit-summary"
              style={[styles.input, styles.textarea]}
              textAlignVertical="top"
            />

            <View style={styles.formRow}>
              <View style={styles.formCol}>
                <Text style={styles.fieldLabel}>年龄段</Text>
                <TextInput
                  value={ageRange}
                  onChangeText={setAgeRange}
                  placeholder="如 30-35 岁"
                  placeholderTextColor={colors.textHelper}
                  testID="edit-age"
                  style={styles.input}
                />
              </View>
              <View style={styles.formCol}>
                <Text style={styles.fieldLabel}>性格</Text>
                <TextInput
                  value={personality}
                  onChangeText={setPersonality}
                  placeholder="如 温和、耐心"
                  placeholderTextColor={colors.textHelper}
                  testID="edit-personality"
                  style={styles.input}
                />
              </View>
            </View>

            <Text style={styles.fieldLabel}>风格</Text>
            <TextInput
              value={style}
              onChangeText={setStyle}
              placeholder="如 叙事 / 有声书"
              placeholderTextColor={colors.textHelper}
              testID="edit-style"
              style={styles.input}
            />

            {/* 声音来自创建时选择的音色，这里只读展示 */}
            <Text style={styles.fieldLabel}>声音</Text>
            <View style={styles.readonlyRow}>
              <Feather name="mic" size={13} color={colors.textHelper} />
              <Text style={styles.readonlyValue}>{voice ? voice.name : "声音已删除"}</Text>
              <Text style={styles.readonlyHint}>创建时确定，暂不可更换</Text>
            </View>
          </View>
        </View>

        {/* 三视图 */}
        <View style={styles.section}>
          <View style={styles.sectionHead}>
            <Text style={styles.sectionTitle}>三视图</Text>
            <Text style={styles.sectionCount}>{generatedCount}/3 已生成</Text>
          </View>
          <View style={styles.viewsRow}>
            {AVATAR_VIEWS.map((v) => {
              const generated = hasView(avatar, v.key);
              const busy = generatingView === v.key;
              return (
                <View key={v.key} style={[styles.viewCard, generated && styles.viewCardDone]}>
                  {generated ? (
                    <>
                      <WatercolorPortrait
                        seed={viewSeed(avatar.id, v.key)}
                        size={80}
                        url={avatar.views[v.key]}
                      />
                      <View style={styles.viewCardLabel}>
                        <Feather name="check" size={10} color={colors.success} />
                        <Text style={styles.viewCardText}>{v.label}</Text>
                      </View>
                    </>
                  ) : busy ? (
                    <View style={styles.viewGenerating}>
                      <ActivityIndicator color={colors.brand} />
                      <Text style={styles.viewGeneratingText}>{v.label}生成中</Text>
                      <View style={styles.viewProgressTrack}>
                        <View style={[styles.viewProgressFill, { width: `${viewProgress}%` }]} />
                      </View>
                    </View>
                  ) : (
                    <Pressable
                      style={({ pressed }) => [styles.viewEmpty, pressed && styles.pressed]}
                      testID={`generate-view-${v.key}`}
                      onPress={() => void generateView(v.key)}
                    >
                      <Feather name="plus" size={18} color={colors.textHelper} />
                      <Text style={styles.viewEmptyText}>{v.label}</Text>
                      <Text style={styles.viewEmptyHint}>点击生成</Text>
                    </Pressable>
                  )}
                </View>
              );
            })}
          </View>
          {!viewsComplete && (
            <Text style={styles.viewsHint}>
              缺失的视图可以随时补充，会保持同一人物设定；生成结果会立即保存。
            </Text>
          )}
          {viewsNotice && (
            <Text style={styles.viewsNotice} testID="views-notice">
              {viewsNotice}
            </Text>
          )}
        </View>

        {/* 保存 */}
        <Button
          label={saved ? "已保存" : "保存修改"}
          size="lg"
          fullWidth
          testID="save-avatar-profile"
          onPress={save}
        />
        <Button label="取消" variant="ghost" size="sm" fullWidth testID="cancel-edit" onPress={() => router.back()} />
      </ScrollView>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  scroll: { paddingHorizontal: 16, paddingBottom: 40, gap: 18 },
  pressed: { opacity: 0.85 },
  previewBlock: { alignItems: "center", gap: 8, paddingTop: 8 },
  previewCard: { width: 180 },
  previewHint: { ...typography.small, color: colors.textHelper },
  section: { gap: 10 },
  sectionHead: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between" },
  sectionTitle: { ...typography.title, color: colors.textTitle },
  sectionCount: { fontFamily: "GeistMono_400Regular", fontSize: 11, color: colors.textHelper },
  formCard: {
    backgroundColor: colors.landingCard,
    borderRadius: radius.panel,
    borderWidth: 1,
    borderColor: colors.landingCardBorder,
    padding: 14,
    gap: 4,
  },
  fieldLabel: { ...typography.small, color: colors.textHelper, marginTop: 8 },
  input: {
    fontFamily: "Lato_400Regular",
    fontSize: 15,
    color: colors.textBody,
    backgroundColor: colors.surface,
    borderRadius: radius.input,
    borderWidth: 1,
    borderColor: colors.inputBorderOpaque,
    paddingHorizontal: 12,
    height: 42,
    marginTop: 6,
  },
  textarea: { height: 84, paddingTop: 10, lineHeight: 22 },
  formRow: { flexDirection: "row", gap: 10 },
  formCol: { flex: 1, minWidth: 0 },
  readonlyRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: colors.surface,
    borderRadius: radius.input,
    borderWidth: 1,
    borderColor: colors.landingCardBorder,
    paddingHorizontal: 12,
    height: 42,
    marginTop: 6,
  },
  readonlyValue: { ...typography.caption, color: colors.textSubtitle },
  readonlyHint: { ...typography.small, fontSize: 11, color: colors.textHelper, marginLeft: "auto" },
  viewsRow: { flexDirection: "row", gap: 10 },
  viewCard: {
    flex: 1,
    minHeight: 122,
    borderRadius: radius.panel,
    borderWidth: 1,
    borderColor: colors.inputBorderOpaque,
    backgroundColor: colors.surface,
    padding: 8,
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  viewCardDone: { borderColor: "rgba(0, 180, 137, 0.35)" },
  viewCardLabel: { flexDirection: "row", alignItems: "center", gap: 3 },
  viewCardText: { fontFamily: "Lato_700Bold", fontSize: 11, color: colors.textSubtitle },
  viewGenerating: { alignItems: "center", gap: 6, alignSelf: "stretch" },
  viewGeneratingText: { ...typography.small, color: colors.textDescription },
  viewProgressTrack: {
    alignSelf: "stretch",
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.fillDefault,
    overflow: "hidden",
  },
  viewProgressFill: { height: 4, borderRadius: 2, backgroundColor: colors.brand },
  viewEmpty: { alignItems: "center", gap: 4, alignSelf: "stretch" },
  viewEmptyText: { fontFamily: "Onest_500Medium", fontSize: 13, color: colors.textSubtitle },
  viewEmptyHint: { ...typography.small, fontSize: 11, color: colors.textHelper },
  viewsHint: { ...typography.small, color: colors.textDescription },
  viewsNotice: { ...typography.small, color: colors.brand },
});
