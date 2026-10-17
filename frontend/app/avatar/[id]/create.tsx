import { useEffect, useMemo, useState } from "react";
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
import { colors, radius, spacing, typography } from "../../../src/theme/theme";
import { getAvatar, getJob, subscribeData } from "../../../src/data/mock";
import { getVoice } from "../../../src/data/voices";
import { SCRIPT_FIELD, SCRIPT_MAX, getCreation, saveCreation } from "../../../src/data/creations";
import {
  cancelJob,
  fetchJobById,
  previewSpeak,
  resumeJob,
  startSpeakJob,
} from "../../../src/data/portrait";
import { absUrl, userErrorMessage } from "../../../src/lib/api";
import type { SpeakPreview } from "../../../src/lib/api";
import {
  MAX_SECONDS,
  POINTS_PER_SECOND,
  describeCost,
  estimateSeconds,
  exceedsLimit,
  pointsFor,
} from "../../../src/lib/cost";
import { useSamplePlayer } from "../../../src/lib/useSamplePlayer";
import type { Job } from "../../../src/data/types";
import { WatercolorPortrait } from "../../../src/components/WatercolorPortrait";
import { Toast, useToast } from "../../../src/components/Toast";
import { VideoPlayer } from "../../../src/components/VideoPlayer";
import { Button } from "../../../src/components/Button";
import { ErrorState } from "../../../src/components/ErrorState";
import { ScreenHeader } from "../../../src/components/ScreenHeader";
import { ScreenContainer } from "../../../src/components/ScreenContainer";
import { useIsPC } from "../../../src/lib/useIsPC";

type Phase = "write" | "running" | "done";

const ASPECTS: { key: string; label: string }[] = [
  { key: "9:16", label: "竖屏 9:16" },
  { key: "16:9", label: "横屏 16:9" },
];

/**
 * 创作台：让角色开口说话。
 *
 * 就一件事 —— 角色的脸 + 角色的声音 + 你写的一句话 = 一条会说话的视频。
 * 页面按「写 → 出片 → 保存」三态走，中间没有向导、没有类型选择。
 *
 * 费用是这个页面的主角，所以它被设计成**逐步才知道得更准**：
 *   敲字时 → 按字数粗估（实时）；
 *   试听后 → 后端量出的真实秒数（精确）。
 * 试听只要 1.5 点而出片是 20 点/秒，差两个数量级 —— 所以「先听再出片」
 * 是省钱，不是流程冗余。试听过的音轨会被出片直接复用，不重复计费。
 */
export default function SpeakStudioScreen() {
  const { id, edit, job: jobParam } = useLocalSearchParams<{
    id: string;
    edit?: string;
    job?: string;
  }>();
  const router = useRouter();
  const isPC = useIsPC();
  const avatar = getAvatar(id);
  const voice = avatar ? getVoice(avatar.voice_id) : undefined;
  const editing = edit ? getCreation(edit) : undefined;

  const [script, setScript] = useState(editing?.script ?? "");
  const [title, setTitle] = useState(editing?.title ?? "");
  const [aspect, setAspect] = useState(ASPECTS[0].key);
  const [phase, setPhase] = useState<Phase>("write");
  const [jobId, setJobId] = useState<string | undefined>(editing?.job_id);
  const [previewing, setPreviewing] = useState(false);
  /** 试听结果连同「是哪段台词的」一起存 —— 台词一改，结果自动失效 */
  const [preview, setPreview] = useState<(SpeakPreview & { script: string }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 取消这类「已生效」的操作走 toast，不占用表单区的错误位
  const { message: toastMsg, show: showToast } = useToast();

  // 任务进度来自数据层（后端轮询），订阅后重新渲染即可读到最新值
  const [, forceUpdate] = useState(0);
  useEffect(() => subscribeData(() => forceUpdate((x) => x + 1)), []);

  // 从任务中心点回来（?job=）时接上：本地有就续传，本地没有就回后端取一次
  useEffect(() => {
    if (!jobParam) return;
    /**
     * 台词与画面比例只存在于任务的 input 里。不回填的话，从任务中心点回来看到的是
     * 一个空台词框，接着保存就会存下一条空台词的创作 —— 所以这里必须补上。
     * 用 `prev || x` 只做兜底填充，不覆盖用户已经敲进去的内容。
     */
    const wire = (j: Job) => {
      setJobId(jobParam);
      if (!editing) {
        const { script: s, aspect_ratio: a } = j.input;
        if (s) setScript((prev) => prev || s);
        if (a) setAspect((prev) => prev || a);
      }
      if (j.status === "succeeded") setPhase("done");
      else if (j.status === "running" || j.status === "queued") setPhase("running");
    };
    const local = resumeJob(jobParam);
    if (local) {
      wire(local);
      return;
    }
    let alive = true;
    void (async () => {
      const remote = await fetchJobById(jobParam);
      if (!alive || !remote) return;
      wire(remote);
    })();
    return () => {
      alive = false;
    };
  }, [jobParam, editing]);

  /**
   * ?edit= 进来：**不回结果态**，而是停在写台词那一态（按钮就叫「改台词重新生成」，
   * 用户的意图是改台词）。台词/标题已由 useState 初值带进来，这里只挂上 jobId，
   * 让音轨地址、时长这些信息仍然可读。
   */
  useEffect(() => {
    if (editing?.job_id) setJobId(editing.job_id);
  }, [editing?.job_id]);

  const job: Job | undefined = jobId ? getJob(jobId) : undefined;
  const audio = useSamplePlayer();
  const frontUrl = absUrl(avatar?.views.front);

  /** 只有明确失败才回到可编辑态，第一次渲染时 job 可能还没同步过来 */
  useEffect(() => {
    if (phase !== "running" || !jobId) return;
    if (job?.status === "succeeded") setPhase("done");
    else if (job?.status === "failed") {
      setPhase("write");
      setError(userErrorMessage(job.error, "生成失败，请稍后再试"));
    }
  }, [phase, jobId, job?.status, job?.error?.message]);

  const activePreview = preview && preview.script === script ? preview : null;
  /** 试听前只有按字数估的秒数；试听后是后端量出来的真数 */
  const seconds = activePreview?.duration ?? estimateSeconds(script);
  const exact = !!activePreview?.duration;
  const over = exceedsLimit(seconds);
  const points = pointsFor(seconds);

  const videoUrl = useMemo(() => absUrl(job?.output?.video_url), [job?.output?.video_url]);
  // 后端给台词音轨用的字段名是 audio_url（与 tts 任务一致），不是 voice_url
  const voiceUrl = useMemo(() => absUrl(job?.output?.audio_url), [job?.output?.audio_url]);
  const coverUrl = useMemo(
    () => absUrl(job?.output?.image_urls?.[0]) ?? frontUrl,
    [job?.output?.image_urls, frontUrl],
  );

  /** 角色得有一张真实的脸，否则上游没法让它开口 —— 这事要先说清楚，别等烧完 TTS 的钱 */
  const hasFace = !!avatar && (!!avatar.views.front || !!avatar.source_job_id);

  if (!avatar) {
    return (
      <ScreenContainer header={<ScreenHeader title="角色不存在" back />}>
        <ErrorState
          title="没有找到这个角色"
          message="它可能已被删除"
          retryLabel="返回列表"
          onRetry={() => router.push("/avatars")}
        />
      </ScreenContainer>
    );
  }

  if (!hasFace) {
    return (
      <ScreenContainer header={<ScreenHeader title="让 TA 说话" back />}>
        <ErrorState
          title="这个角色还没有真实形象"
          message="让角色开口说话需要一张真实的人像。先为它生成形象，再回来。"
          retryLabel="去生成形象"
          onRetry={() => router.push(`/avatar/create/${avatar.voice_id}`)}
        />
      </ScreenContainer>
    );
  }

  const onPreview = async () => {
    const text = script.trim();
    if (!text || previewing) return;
    setPreviewing(true);
    setError(null);
    try {
      const result = await previewSpeak({ voice_id: avatar.voice_id, script: text });
      setPreview({ ...result, script });
    } catch (err) {
      setError(userErrorMessage(err, "试听失败，请稍后再试"));
    } finally {
      setPreviewing(false);
    }
  };

  const onGenerate = async () => {
    const text = script.trim();
    if (!text || over) return;
    setError(null);
    try {
      const created = await startSpeakJob({
        voice_id: avatar.voice_id,
        script: text,
        source_job_id: avatar.source_job_id,
        source_index: avatar.source_index ?? 0,
        avatar_id: avatar.id,
        avatar_name: avatar.name,
        aspect_ratio: aspect,
        duration: activePreview?.duration ?? null,
      });
      setJobId(created.id);
      setPhase("running");
    } catch (err) {
      setError(userErrorMessage(err, "提交失败，请稍后再试"));
    }
  };

  const onCancel = async () => {
    if (!jobId) return;
    try {
      const job = await cancelJob(jobId);
      showToast(job?.error?.message || "已取消生成");
      setError(null);
    } catch {
      /* 取消失败也让用户回到编辑态，任务会在任务中心继续显示真实状态 */
      showToast("取消失败，任务稍后在任务中心停止");
    }
    setPhase("write");
  };

  const onSave = async () => {
    const saved = await saveCreation({
      id: editing?.id,
      avatar_id: avatar.id,
      title: title.trim() || defaultTitle(avatar.name, script),
      script: script.trim(),
      video_url: job?.output?.video_url ?? null,
      voice_url: job?.output?.audio_url ?? null,
      cover_url: frontUrl ?? null,
      job_id: jobId,
      duration: job?.output?.output_duration ?? job?.output?.duration ?? null,
      points: job?.output?.estimated_points ?? points,
    });
    router.replace(`/creation/${saved.id}`);
  };

  const stageText = job?.stage ?? (job?.status === "queued" ? "排队中" : "准备中");
  const progress = Math.round(job?.progress ?? 0);

  return (
    <ScreenContainer
      header={<ScreenHeader title={editing ? "重新生成" : "让 TA 说话"} back />}
      style={{ paddingHorizontal: 0 }}
    >
      <ScrollView contentContainerStyle={[styles.scroll, isPC && styles.scrollPC]} showsVerticalScrollIndicator={false}>
        <View style={[styles.inner, isPC && styles.innerPC]}>
          {/* 演员：一张脸 + 一副嗓子，就是这次生成的全部素材 */}
          <View style={styles.actorCard}>
            <WatercolorPortrait seed={avatar.id} url={frontUrl} size={56} />
            <View style={styles.actorInfo}>
              <Text style={styles.actorName} numberOfLines={1}>
                {avatar.name}
              </Text>
              <Text style={styles.actorMeta} numberOfLines={1}>
                {/* 成片用的是**提交那一刻**的音色，不是角色现在绑定的音色
                    （用户后来可能改过音色，那时用旧音色做的片子还是旧音色） */}
                {voice ? `音色 · ${job?.input?.voice_name ?? voice.name}` : "音色未知"}
                {job?.output?.resolution ? ` · ${job.output.resolution}` : ""}
              </Text>
            </View>
          </View>

          {/* ---------- 第一阶段：写台词 ---------- */}
          {phase === "write" && (
            <View style={styles.block}>
              <Text style={styles.fieldLabel}>{SCRIPT_FIELD.label}</Text>
              <Text style={styles.fieldHint}>{SCRIPT_FIELD.hint}</Text>
              <TextInput
                value={script}
                onChangeText={(t) => {
                  setScript(t);
                  if (error) setError(null);
                }}
                multiline
                editable={!previewing}
                placeholder={SCRIPT_FIELD.placeholder}
                placeholderTextColor={colors.textHelper}
                testID="speak-script"
                style={[styles.input, styles.textarea]}
                textAlignVertical="top"
                maxLength={SCRIPT_MAX}
              />
              <View style={styles.counterRow}>
                <Text style={styles.counter}>{script.trim().length} 字</Text>
                {script.trim().length > 0 && (
                  <Text
                    style={[styles.counter, over && styles.counterDanger]}
                    testID="cost-estimate"
                  >
                    {/* describeCost 自己就带「约 X 秒 · Y 点」，这里只补一个「（估算）」后缀，
                        否则会出现「约 约 4 秒 · 80 点」 */}
                    {describeCost(seconds)}
                    {exact ? "" : "（估算）"}
                  </Text>
                )}
              </View>

              <View style={styles.aspectRow}>
                {ASPECTS.map((a) => {
                  const active = aspect === a.key;
                  return (
                    <Pressable
                      key={a.key}
                      onPress={() => setAspect(a.key)}
                      testID={`aspect-${a.key}`}
                      style={[styles.aspectChip, active && styles.aspectChipActive]}
                    >
                      <Text style={[styles.aspectText, active && styles.aspectTextActive]}>
                        {a.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>

              {/* 试听结果：这是全页最值钱的一块信息 */}
              {activePreview && (
                <View style={styles.previewCard} testID="preview-result">
                  <Pressable
                    onPress={() =>
                      activePreview.audio_url
                        ? void audio.playUrl(absUrl(activePreview.audio_url)!, activePreview.key)
                        : undefined
                    }
                    disabled={!activePreview.audio_url}
                    testID="play-preview"
                    style={({ pressed }) => [styles.playRow, pressed && styles.pressed]}
                  >
                    <View style={styles.playIcon}>
                      {audio.playingId === activePreview.key ? (
                        <Feather name="pause" size={16} color={colors.textInvert} />
                      ) : (
                        <Feather name="play" size={16} color={colors.textInvert} />
                      )}
                    </View>
                    <Text style={styles.playLabel}>
                      {audio.playingId === activePreview.key ? "播放中…" : "听一听这段台词"}
                    </Text>
                  </Pressable>
                  <Text style={styles.previewCost} testID="preview-cost">
                    {describeCost(activePreview.duration)}
                  </Text>
                  <Text style={styles.previewNote}>
                    音轨已就绪，出片时直接复用，不会重复计费。
                  </Text>
                </View>
              )}

              {over && (
                <Text style={styles.warn} testID="over-limit">
                  念出来约 {Math.round(seconds)} 秒，超过 {MAX_SECONDS} 秒上限。视频按秒计费，
                  请把台词改短一些。
                </Text>
              )}
              {audio.error && <Text style={styles.warn}>{audio.error}</Text>}
              {error && (
                <Text style={styles.error} testID="speak-error">
                  {error}
                </Text>
              )}

              <View style={styles.actions}>
                <Button
                  label={previewing ? "合成中…" : "试听台词"}
                  variant="secondary"
                  size="lg"
                  fullWidth
                  loading={previewing}
                  disabled={!script.trim()}
                  testID="preview-speech"
                  onPress={onPreview}
                />
                <Button
                  label={points ? `生成视频（约 ${points} 点）` : "生成视频"}
                  size="lg"
                  fullWidth
                  disabled={!script.trim() || over}
                  testID="generate-speech"
                  onPress={onGenerate}
                />
              </View>
              <Text style={styles.footNote}>
                试听约 1.5 点，只合成音频；出片按输出秒数计费（{POINTS_PER_SECOND} 点/秒）。
                没试听也可以直接生成。
              </Text>
            </View>
          )}

          {/* ---------- 第二阶段：出片中 ---------- */}
          {phase === "running" && (
            <View style={styles.block}>
              <Text style={styles.blockTitle}>正在让 TA 说话</Text>
              <View style={styles.generatingCard}>
                <WatercolorPortrait seed={avatar.id} url={frontUrl} size={140} />
                <View style={styles.progressTrack}>
                  <View style={[styles.progressFill, { width: `${Math.max(2, progress)}%` }]} />
                </View>
                <Text style={styles.generatingText} testID="speak-progress">
                  {stageText} · {progress}%
                </Text>
                <Text style={styles.generatingNote}>
                  视频要跑几分钟，可以离开这个页面 —— 任务中心会一直显示进度。
                </Text>
                <Pressable hitSlop={8} onPress={onCancel} testID="cancel-speak">
                  <Text style={styles.cancelText}>取消</Text>
                </Pressable>
              </View>
            </View>
          )}

          {/* ---------- 第三阶段：成片 ---------- */}
          {phase === "done" && (
            <View style={styles.block}>
              {videoUrl ? (
                <VideoPlayer url={videoUrl} poster={frontUrl} height={380} testID="speak-video" />
              ) : (
                <View style={styles.missingVideo}>
                  <Text style={styles.missingVideoText}>
                    成片没能缓存到本地。可以点「重新生成」再试一次。
                  </Text>
                </View>
              )}

              {voiceUrl && (
                <Pressable
                  onPress={() => void audio.playUrl(voiceUrl, `${jobId}-voice`)}
                  testID="play-voice-track"
                  style={({ pressed }) => [styles.trackRow, pressed && styles.pressed]}
                >
                  <Feather
                    name={audio.playingId === `${jobId}-voice` ? "pause" : "play"}
                    size={14}
                    color={colors.brand}
                  />
                  <Text style={styles.trackLabel}>台词音轨</Text>
                  <Text style={styles.trackMeta}>
                    {describeCost(job?.output?.duration ?? seconds)}
                  </Text>
                </Pressable>
              )}

              <View style={styles.summaryCard}>
                <Text style={styles.summaryScript} numberOfLines={4}>
                  {script.trim()}
                </Text>
                <View style={styles.summaryMeta}>
                  <Text style={styles.summaryMetaText}>
                    {job?.output?.aspect_ratio ?? aspect}
                  </Text>
                  <Text style={styles.summaryMetaText}>{job?.output?.resolution ?? "720p"}</Text>
                  {job?.output?.estimated_points != null && (
                    <Text style={styles.summaryMetaText}>
                      约 {job.output.estimated_points} 点
                    </Text>
                  )}
                </View>
              </View>

              <Text style={styles.fieldLabel}>标题</Text>
              <TextInput
                value={title}
                onChangeText={setTitle}
                placeholder={defaultTitle(avatar.name, script)}
                placeholderTextColor={colors.textHelper}
                testID="creation-title"
                style={styles.input}
              />

              <Button
                label="保存到创作库"
                size="lg"
                fullWidth
                testID="save-creation"
                onPress={onSave}
              />
              <View style={styles.rowActions}>
                <Button
                  label="重新生成"
                  variant="secondary"
                  size="sm"
                  testID="regenerate-speech"
                  onPress={() => {
                    setPhase("write");
                    setError(null);
                  }}
                />
                <Button
                  label="改台词"
                  variant="ghost"
                  size="sm"
                  onPress={() => setPhase("write")}
                />
              </View>
            </View>
          )}
        </View>
      </ScrollView>
      <Toast message={toastMsg} />
    </ScreenContainer>
  );
}

function defaultTitle(name: string, script: string): string {
  const head = script.trim().replace(/\s+/g, " ").slice(0, 10);
  return head ? `${name} · ${head}` : `${name}的说话视频`;
}

const styles = StyleSheet.create({
  scroll: { paddingHorizontal: spacing.lg, paddingBottom: 40 },
  // PC：内容区限宽水平居中（fish.audio create-voice 式），标题仍固定在顶部左对齐
  scrollPC: {
    paddingHorizontal: 24,
    paddingBottom: 40,
    alignItems: "center",
    // 内容不满一屏时垂直也居中（fish.audio create-voice 式）；超一屏照常滚动
    flexGrow: 1,
    justifyContent: "center",
  },
  inner: { gap: spacing.lg, paddingTop: spacing.sm },
  innerPC: {
    width: 720,
    maxWidth: "100%",
    borderWidth: 1.5,
    borderColor: "rgba(0,0,0,0.08)",
    borderRadius: 16,
    backgroundColor: colors.surface,
    padding: 24,
  },
  block: { gap: spacing.sm },
  pressed: { opacity: 0.85 },

  actorCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: radius.panel,
    borderWidth: 1,
    borderColor: colors.landingCardBorder,
    padding: spacing.md,
  },
  actorInfo: { flex: 1, gap: 2, minWidth: 0 },
  actorName: { ...typography.title, color: colors.textTitle },
  actorMeta: { ...typography.small, color: colors.textDescription },

  fieldLabel: { ...typography.title, fontSize: 14, color: colors.textTitle },
  fieldHint: { ...typography.small, color: colors.textHelper },
  input: {
    fontFamily: "Lato_400Regular",
    fontSize: 15,
    color: colors.textBody,
    backgroundColor: colors.surface,
    borderRadius: radius.input,
    borderWidth: 1,
    borderColor: colors.inputBorderOpaque,
    paddingHorizontal: 12,
    height: 44,
  },
  textarea: { height: 132, paddingTop: 10, lineHeight: 22 },
  counterRow: { flexDirection: "row", justifyContent: "space-between", gap: spacing.sm },
  counter: { ...typography.small, color: colors.textHelper },
  counterDanger: { color: colors.danger },

  aspectRow: { flexDirection: "row", gap: spacing.sm },
  aspectChip: {
    paddingHorizontal: 12,
    height: 30,
    borderRadius: radius.button,
    backgroundColor: colors.fillDefault,
    justifyContent: "center",
  },
  aspectChipActive: { backgroundColor: "rgba(245, 97, 56, 0.12)" },
  aspectText: { ...typography.small, color: colors.textSubtitle },
  aspectTextActive: { color: colors.brand, fontFamily: "Onest_500Medium" },

  previewCard: {
    backgroundColor: colors.successBackground,
    borderRadius: radius.panel,
    padding: spacing.md,
    gap: 6,
  },
  playRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  // flexShrink: 0 —— RN/RNW 默认 flexShrink: 1，圆形图标会被文字挤扁
  playIcon: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: colors.brand,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  playLabel: { ...typography.title, fontSize: 14, color: colors.textTitle, flexShrink: 1 },
  previewCost: { ...typography.body, color: colors.textTitle, fontFamily: "Onest_500Medium" },
  previewNote: { ...typography.small, color: colors.textDescription },

  warn: { ...typography.caption, color: colors.warning },
  error: { ...typography.caption, color: colors.danger },
  footNote: { ...typography.small, color: colors.textHelper },

  actions: { gap: spacing.sm, marginTop: spacing.xs },
  rowActions: { flexDirection: "row", gap: spacing.sm },

  blockTitle: { ...typography.h3, color: colors.textTitle },
  generatingCard: {
    alignItems: "center",
    gap: spacing.md,
    backgroundColor: colors.landingCard,
    borderRadius: radius.hero,
    borderWidth: 1,
    borderColor: colors.landingCardBorder,
    padding: spacing.xl,
  },
  progressTrack: {
    alignSelf: "stretch",
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.fillDefault,
    overflow: "hidden",
  },
  progressFill: { height: 6, borderRadius: 3, backgroundColor: colors.brand },
  generatingText: { ...typography.body, color: colors.textTitle, fontFamily: "Onest_500Medium" },
  generatingNote: { ...typography.small, color: colors.textDescription, textAlign: "center" },
  cancelText: { ...typography.small, color: colors.textSubtitle, textDecorationLine: "underline" },

  missingVideo: {
    padding: spacing.lg,
    borderRadius: radius.panel,
    backgroundColor: colors.dangerBackground,
  },
  missingVideoText: { ...typography.caption, color: colors.textBody },

  trackRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    backgroundColor: colors.surface,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: colors.landingCardBorder,
    paddingHorizontal: spacing.md,
    height: 44,
  },
  trackLabel: { ...typography.caption, color: colors.textTitle, fontFamily: "Onest_500Medium" },
  trackMeta: { ...typography.small, color: colors.textDescription, flex: 1, textAlign: "right" },

  summaryCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.panel,
    borderWidth: 1,
    borderColor: colors.landingCardBorder,
    padding: spacing.md,
    gap: spacing.sm,
  },
  summaryScript: { ...typography.caption, color: colors.textBody },
  summaryMeta: { flexDirection: "row", gap: spacing.sm, flexWrap: "wrap" },
  summaryMetaText: {
    ...typography.small,
    color: colors.textSubtitle,
    backgroundColor: colors.fillDefault,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: radius.button,
  },
});
