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
import { getVoice } from "../../../src/data/voices";
import { AVATAR_VIEWS } from "../../../src/data/types";
import type { AvatarProfile, AvatarView, AvatarViews } from "../../../src/data/types";
import { addAvatar, getJob, subscribeData } from "../../../src/data/mock";
import {
  cancelJob,
  fetchJobById,
  isRemoteJob,
  restartJob,
  resumeJob,
  startPortraitJob,
  startViewsJob,
} from "../../../src/data/portrait";
import { absUrl, userErrorMessage } from "../../../src/lib/api";
import { StepIndicator } from "../../../src/components/StepIndicator";
import { WatercolorPortrait } from "../../../src/components/WatercolorPortrait";
import { Button } from "../../../src/components/Button";
import { Chip } from "../../../src/components/Chip";
import { ErrorState } from "../../../src/components/ErrorState";
import { ProfileEditSheet } from "../../../src/components/ProfileEditSheet";
import type { ProfileDraft } from "../../../src/components/ProfileEditSheet";
import { ScreenHeader } from "../../../src/components/ScreenHeader";
import { Toast, useToast } from "../../../src/components/Toast";
import { ScreenContainer } from "../../../src/components/ScreenContainer";
import { useIsPC } from "../../../src/lib/useIsPC";

type Stage =
  | "prompt"
  | "generating"
  | "candidates"
  | "supplement"
  | "generatingViews"
  | "save"
  | "done"
  | "error";

const STEPS = [
  { label: "描述形象" },
  { label: "选择候选" },
  { label: "补充视图" },
  { label: "保存" },
];

const QUICK_TAGS = ["30 岁左右", "温和亲切", "职业感", "自然光", "微笑", "半身像"];

const PROGRESS_STEPS = ["正在分析声音特征", "正在生成候选形象", "正在生成人物设定"];

const VIEWS_PROGRESS_STEPS = ["正在生成侧面形象", "正在生成背面形象"];/** 声音 tag → 中文描述（seeds.py 里 20 个人设的 tone / 用途 tag） */
const TONE_LABELS: Record<string, string> = {
  warm: "温和亲切",
  deep: "低沉沉稳",
  bright: "明亮开朗",
  energetic: "活力充沛",
  calm: "沉稳平静",
  playful: "俏皮灵动",
  soft: "轻柔亲和",
  steady: "稳重专业",
  cute: "元气可爱",
  raspy: "沙哑有型",
  elegant: "优雅从容",
  smooth: "圆润滑畅",
  clear: "清晰利落",
  friendly: "友善亲和",
  fresh: "清新自然",
  bold: "大气有力",
  lively: "活泼生动",
};
const USE_LABELS: Record<string, string> = {
  narration: "叙事与有声书",
  documentary: "纪录片解说",
  advertising: "广告口播",
  gaming: "游戏解说",
  meditation: "冥想引导",
  character: "角色演绎",
  assistant: "智能助手旁白",
  news: "新闻播报",
  anime: "动漫配音",
  audiobook: "有声书朗读",
  podcast: "播客主持",
  education: "课程讲解",
  vlog: "Vlog 口播",
  trailer: "预告片配音",
  ecommerce: "电商带货",
  storytelling: "故事讲述",
};

/**
 * 按声音人设组装默认形象描述：性别取 tag，气质/用途按 tag 映射，
 * 描述兜底用声音自带的 description。用户在文本框里可以随意改。
 */
function buildDefaultPrompt(voice: ReturnType<typeof getVoice>): string {
  if (!voice) return "一位适合做口播形象的人物";
  const tags = voice.tags || [];
  const gender = tags.includes("male") ? "男" : tags.includes("female") ? "女" : "";
  const tone = tags.map((t) => TONE_LABELS[t]).filter(Boolean).join("");
  const use = tags.map((t) => USE_LABELS[t]).filter(Boolean)[0];
  if (!gender && !tone) return voice.description || "一位适合做口播形象的人物";
  return `一位三十岁左右的${gender ? `${gender}性` : "人物"}${tone ? `，气质${tone}` : ""}${use ? `，适合${use}` : ""}。`;
}

/** 三张候选的初始人物设定（由声音人设推导，用户可以逐个修改） */
function buildDefaultProfiles(voice: ReturnType<typeof getVoice>): AvatarProfile[] {
  if (!voice) return [];
  const tags = voice.tags || [];
  const gender = tags.includes("male") ? "男" : tags.includes("female") ? "女" : "";
  const g = gender ? `${gender}性` : "人物";
  const tone = tags.map((t) => TONE_LABELS[t]).filter(Boolean)[0] ?? "温和";
  const tone2 = tags.map((t) => TONE_LABELS[t]).filter(Boolean)[1] ?? "清晰";
  const use = tags.map((t) => USE_LABELS[t]).filter(Boolean)[0] ?? "口播";
  return [
    {
      summary: `一位三十多岁的${g}，气质${tone}，适合${use}。`,
      ageRange: "30-35 岁",
      personality: tone,
      style: use,
    },
    {
      summary: `一位三十五岁上下的${g}，表达清晰可信，适合讲解与分享类内容。`,
      ageRange: "32-38 岁",
      personality: tone2,
      style: "讲解 / 分享",
    },
    {
      summary: `一位二十多岁的${g}，状态轻松自然，适合短视频与日常口播。`,
      ageRange: "24-28 岁",
      personality: "自然、亲切",
      style: "短视频 / 日常口播",
    },
  ];
}

/**
 * 创建 Avatar 流程（从声音出发）。
 * 需求功能 3：根据声音生成候选图和人物信息。
 * 需求功能 4：保存 Avatar。
 *
 * 生成候选形象是一次「任务」：任务写进任务中心并写进 URL（?job=），
 * 所以生成中可以直接离开页面，之后从任务中心点回来接着看进度。
 */
export default function CreateAvatarScreen() {
  const { voiceId, job: jobParam } = useLocalSearchParams<{ voiceId: string; job?: string }>();
  const router = useRouter();
  const isPC = useIsPC();
  const voice = getVoice(voiceId);

  const [stage, setStage] = useState<Stage>("prompt");
  // 默认描述与人物设定由声音人设推导（性别/气质/用途），用户可改
  const [prompt, setPrompt] = useState(() => buildDefaultPrompt(voice));
  const [profiles, setProfiles] = useState<AvatarProfile[]>(() => buildDefaultProfiles(voice));
  const [selected, setSelected] = useState(0);
  // 当前这次生成对应的任务 id（任务中心里能点回来）
  const [jobId, setJobId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  // 第几批：换一批候选时 +1（后端用它算随机种子，保证真的换一批）
  const [round, setRound] = useState(0);
  // 候选图尺寸随格子宽度自适应（上限 132），避免人像溢出格子互相重叠
  const [portraitSize, setPortraitSize] = useState(132);
  // 三视图：正面在候选阶段选定；侧面/背面可在「补充视图」阶段生成，也可跳过以后再说
  const [supplemented, setSupplemented] = useState(false);
  // 补三视图的真实任务 id（后端可用时才有）
  const [viewsJobId, setViewsJobId] = useState<string | null>(null);
  const [viewsProgress, setViewsProgress] = useState(0);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const restoredJob = useRef<string | null>(null);

  // 任务进度由数据层驱动（后端任务轮询 / 本地演示推进器），这里订阅变更即可
  const [, forceUpdate] = useState(0);
  useEffect(() => subscribeData(() => forceUpdate((x) => x + 1)), []);

  const job = getJob(jobId);
  const viewsJob = getJob(viewsJobId);

  /** 候选图：后端生成的真实图片；本地演示时没有，占位图兜底 */
  const candidateUrls = [0, 1, 2].map((i) => absUrl(job?.output?.image_urls?.[i]));

  /** 三视图：正面=选中的候选图，侧面/背面=补图任务产物 */
  const viewUrl = (key: AvatarView): string | undefined => {
    if (key === "front") return candidateUrls[selected];
    return absUrl(viewsJob?.output?.view_urls?.[key]);
  };

  const generating = isRemoteJob(jobId ?? "");

  // 带 ?job= 进来：按任务状态恢复到对应步骤（等待页 / 候选页 / 失败页 / 保存页）
  useEffect(() => {
    if (!jobParam || restoredJob.current === jobParam) return;
    const apply = (target: ReturnType<typeof getJob>) => {
      if (!target || target.type !== "portrait") return;
      restoredJob.current = jobParam;
      if (target.input.kind === "views") {
        // 补三视图的任务：回到保存页（成功）或在等待页继续看进度。
        // 同时要认回「参考的是哪个候选任务」，否则保存页拿不到正面图。
        setViewsJobId(target.id);
        setSelected(target.input.source_index ?? 0);
        const sourceId = target.input.source_job_id;
        if (sourceId) {
          setJobId(sourceId);
          const src = getJob(sourceId);
          if (src?.input.prompt) setPrompt(src.input.prompt);
          else
            void fetchJobById(sourceId).then((s) => {
              if (s?.input.prompt) setPrompt(s.input.prompt);
            });
        }
        if (target.status === "succeeded") {
          setSupplemented(true);
          setStage("save");
        } else if (target.status === "failed") {
          setStage("error");
        } else {
          resumeJob(target.id);
          setStage("generatingViews");
        }
        return;
      }
      setJobId(target.id);
      if (target.input.prompt) setPrompt(target.input.prompt);
      if (target.input.variant) setRound(target.input.variant);
      if (target.status === "succeeded") {
        setStage("candidates");
      } else if (target.status === "failed") {
        setStage("error");
      } else {
        // 回到等待页：如果任务没在推进（比如种子任务 / 刷新过），让它继续
        resumeJob(target.id);
        setStage("generating");
      }
    };

    const local = getJob(jobParam);
    if (local) {
      apply(local);
      return;
    }
    // 本地列表里没有（刷新过页面）：向后端问一次
    fetchJobById(jobParam).then((remote) => apply(remote));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobParam]);

  // 生成中：任务状态一变就切步骤
  useEffect(() => {
    if (stage !== "generating") return;
    if (job?.status === "succeeded") setStage("candidates");
    else if (job?.status === "failed") setStage("error");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, job?.status]);

  // 补三视图：后端有真实任务就等任务，否则退回本地进度演示
  useEffect(() => {
    if (stage !== "generatingViews") return;
    if (viewsJob) {
      setViewsProgress(viewsJob.progress ?? 0);
      if (viewsJob.status === "succeeded") {
        setSupplemented(true);
        setStage("save");
      } else if (viewsJob.status === "failed") {
        setStage("error");
      }
      return;
    }
    setViewsProgress(0);
    timer.current = setInterval(() => {
      setViewsProgress((p) => {
        if (p >= 100) {
          if (timer.current) clearInterval(timer.current);
          setSupplemented(true);
          setStage("save");
          return 100;
        }
        return p + 5;
      });
    }, 60);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, viewsJob?.status, viewsJob?.progress]);

  // 勾选角标尺寸/内缩量随人像尺寸缩放，确保始终完整落在圆角框内
  const badgeSize = Math.round(Math.min(22, Math.max(14, portraitSize * 0.15)));
  const badgeInset = Math.max(5, Math.round(portraitSize * 0.06));

  /** 同一轮里三张候选 / 三个视图的占位图种子（没有真实图片时才用） */
  const candidateSeed = (i: number) => `${voiceId}-${i}-r${round}`;
  const viewSeed = (key: string) => `${voiceId}-${key}-r${round}`;

  const generatingProgress = job?.progress ?? 0;
  const estimatedPoints = job?.input.estimated_points ?? job?.output?.estimated_points ?? null;

  const startGenerate = async () => {
    if (!voice || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const created = await startPortraitJob({
        voice_id: voice.id,
        prompt: prompt.trim() || `${voice.name} 的形象`,
        count: 3,
        variant: round,
      });
      setJobId(created.id);
      // 写进 URL：刷新 / 从任务中心回来都能恢复到这一步
      restoredJob.current = created.id;
      router.setParams({ job: created.id });
      setStage("generating");
    } catch (err) {
      setNotice(userErrorMessage(err, "生成失败，请稍后再试"));
    } finally {
      setBusy(false);
    }
  };

  /** 重新生成候选：换一批（variant +1），沿用当前设定重出 3 张 */
  const regenerate = async (nextPrompt?: string) => {
    if (!voice || busy) return;
    const next = round + 1;
    setBusy(true);
    setNotice(null);
    try {
      if (jobId && getJob(jobId)) {
        await restartJob(jobId, { prompt: nextPrompt ?? prompt, variant: next });
      } else {
        const created = await startPortraitJob({
          voice_id: voice.id,
          prompt: nextPrompt ?? prompt,
          count: 3,
          variant: next,
        });
        setJobId(created.id);
        restoredJob.current = created.id;
        router.setParams({ job: created.id });
      }
      setRound(next);
      setStage("generating");
    } catch (err) {
      setNotice(userErrorMessage(err, "生成失败，请稍后再试"));
    } finally {
      setBusy(false);
    }
  };

  const { message: toastMsg, show: showToast } = useToast();

  const cancelGenerate = async () => {
    if (jobId) {
      try {
        const job = await cancelJob(jobId);
        showToast(job?.error?.message || "已取消生成");
      } catch {
        showToast("取消失败，任务稍后在任务中心停止");
      }
    }
    setStage("prompt");
  };

  /** 补侧面 / 背面：真 image-to-image（以选中的候选图为参考）。后端出错直接显示。 */
  const startSupplementViews = async () => {
    if (!jobId || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const created = await startViewsJob({
        job_id: jobId,
        index: selected,
        reference_url: undefined,
      });
      if (created) setViewsJobId(created.id);
      setStage("generatingViews");
    } catch (err) {
      setNotice(userErrorMessage(err, "生成失败，请稍后再试"));
    } finally {
      setBusy(false);
    }
  };

  /** 保存：把这次生成的结果落成一条 Avatar，能在「我的 Avatar」里看到 */
  const saveAvatar = async () => {
    if (!voice) return;
    const views: AvatarViews = { front: candidateUrls[selected] ?? null };
    if (supplemented) {
      views.side = viewUrl("side") ?? null;
      views.back = viewUrl("back") ?? null;
    }
    // 记下「这张正面图是哪个任务、第几张生成出来的」：
    // 以后在编辑角色信息页补侧面 / 背面时，靠它回上游取参考图，保证还是同一个人。
    const realSource = jobId && isRemoteJob(jobId);
    await addAvatar({
      id: `avatar_${Date.now()}`,
      name: name.trim() || voice.name,
      voice_id: voice.id,
      views,
      source: "generated",
      prompt,
      profile: profiles[selected],
      created_at: new Date().toISOString(),
      source_job_id: realSource ? (jobId as string) : undefined,
      source_index: realSource ? selected : undefined,
    });
    setStage("done");
  };

  const applyDraft = (draft: ProfileDraft) => {
    setPrompt(draft.prompt);
    setProfiles((prev) => prev.map((p, i) => (i === selected ? draft.profile : p)));
  };

  const currentStep =
    stage === "prompt"
      ? 0
      : stage === "generating" || stage === "candidates" || stage === "error"
        ? 1
        : stage === "supplement" || stage === "generatingViews"
          ? 2
          : 3;

  if (!voice) {
    return (
      <ScreenContainer header={<ScreenHeader title="创建 Avatar" back />}>
        <ErrorState title="声音不存在" message="返回声音列表重新选一个声音" retryLabel="返回" onRetry={() => router.back()} />
      </ScreenContainer>
    );
  }

  return (
    <ScreenContainer header={<ScreenHeader title="创建 Avatar" back />} style={{ paddingHorizontal: 0 }}>
      <ScrollView contentContainerStyle={[styles.scroll, isPC && styles.scrollPC]} showsVerticalScrollIndicator={false}>
        <View style={isPC ? styles.innerPC : undefined}>
        {/* 声音来源 */}
        <View style={styles.sourceCard}>
          <WatercolorPortrait seed={voice.id} size={44} />
          <View style={styles.sourceInfo}>
            <Text style={styles.sourceLabel}>基于声音</Text>
            <Text style={styles.sourceName}>{voice.name}</Text>
          </View>
        </View>

        <StepIndicator steps={STEPS} current={currentStep} style={styles.stepGap} />

        {/* 步骤 1：描述形象 */}
        {stage === "prompt" && (
          <View style={styles.block}>
            <Text style={styles.blockTitle}>想要一个什么样的形象？</Text>
            <Text style={styles.blockDesc}>
              描述一下形象和气质，我们会用真实文生图生成 3 张候选形象供你挑选。
            </Text>
            <View style={styles.textareaWrap}>
              <TextInput
                value={prompt}
                onChangeText={setPrompt}
                multiline
                placeholder={`例如：一位温暖的女性，友善的微笑，柔和的光线（声音：${voice.name}）`}
                placeholderTextColor={colors.textHelper}
                style={styles.textarea}
                textAlignVertical="top"
                testID="portrait-prompt"
              />
              <Text style={styles.counter}>{prompt.length}/300</Text>
            </View>
            <View style={styles.chipRow}>
              {QUICK_TAGS.map((t) => (
                <Chip
                  key={t}
                  label={t}
                  onPress={() => setPrompt((p) => (p ? `${p}，${t}` : t))}
                />
              ))}
            </View>
            {notice ? <Text style={styles.notice}>{notice}</Text> : null}
            <Button
              label={busy ? "正在提交…" : "生成候选图"}
              size="lg"
              fullWidth
              loading={busy}
              testID="generate-portraits"
              onPress={startGenerate}
            />
            <Text style={styles.costHint}>
              每次生成 3 张候选图，走 ThankYou 文生图；生成中可以先离开，进度会记在任务中心。
            </Text>
          </View>
        )}

        {/* 生成中（进度来自任务中心里那条任务，离开后再回来会接着走） */}
        {stage === "generating" && (
          <View style={styles.block}>
            <View style={styles.genCard}>
              <View style={styles.genHead}>
                <Text style={styles.genTitle}>正在生成候选形象</Text>
                <Text style={styles.genPercent}>{generatingProgress}%</Text>
              </View>
              <View style={styles.progressTrack}>
                <View style={[styles.progressFill, { width: `${generatingProgress}%` }]} />
              </View>
              <View style={styles.stepList}>
                {PROGRESS_STEPS.map((s, i) => {
                  const done = generatingProgress > (i + 1) * 33;
                  const active = !done && generatingProgress > i * 33;
                  return (
                    <View key={s} style={styles.stepRow}>
                      <Feather
                        name={done ? "check-circle" : active ? "loader" : "circle"}
                        size={14}
                        color={done ? colors.success : active ? colors.brand : colors.textDisabled}
                      />
                      <Text
                        style={[
                          styles.stepText,
                          (done || active) && { color: colors.textBody },
                        ]}
                      >
                        {s}
                      </Text>
                    </View>
                  );
                })}
              </View>
              <Text style={styles.genHint}>
                {generating
                  ? "正在调 ThankYou 生成，通常需要 20-60 秒；生成时可以先离开，完成后会在任务里通知你。"
                  : "通常需要 30-60 秒，生成时可以先离开，完成后会在任务里通知你。"}
                {generating && estimatedPoints ? ` 本批预计消耗 ${estimatedPoints} 点。` : ""}
              </Text>
            </View>
            <View style={styles.genActions}>
              <Button label="取消生成" variant="ghost" size="sm" onPress={cancelGenerate} />
              <Pressable hitSlop={8} testID="go-jobs" onPress={() => router.push("/jobs")}>
                <Text style={styles.linkText}>去任务中心看进度 ›</Text>
              </Pressable>
            </View>
          </View>
        )}

        {/* 失败 */}
        {stage === "error" && (
          <View style={styles.block}>
            <ErrorState
              title="候选图生成失败"
              message={userErrorMessage(job?.error, "形象生成服务暂时不可用，可以稍后重试")}
              // 用户主动取消的任务不给重试：取消是明确意图，想再生成就重新发起
              retryLabel={job?.error?.code === "CANCELED" ? undefined : "重试生成"}
              onRetry={() => {
                if (jobId && getJob(jobId)) {
                  // 重试沿用同一批：已经生成成功的候选图会复用，只补失败的那几张
                  restartJob(jobId, { prompt })
                    .then(() => setStage("generating"))
                    .catch((err) => setNotice(userErrorMessage(err, "生成失败，请稍后再试")));
                } else {
                  void startGenerate();
                }
              }}
              secondaryLabel="返回修改描述"
              onSecondary={() => setStage("prompt")}
            />
          </View>
        )}

        {/* 步骤 2：选择候选 */}
        {stage === "candidates" && (
          <View style={styles.block}>
            <Text style={styles.blockTitle}>选一张作为形象</Text>
            <Text style={styles.blockDesc}>共 3 张候选图，点选后可以查看人物设定。</Text>
            <View
              style={styles.candidateGrid}
              onLayout={(e) => {
                const gridWidth = e.nativeEvent.layout.width;
                // 3 列 + 2 个 10px 间距，再减去格子自身 padding（6×2）
                const next = Math.min(132, Math.max(72, Math.floor((gridWidth - 20) / 3) - 12));
                setPortraitSize((prev) => (prev === next ? prev : next));
              }}
            >
              {[0, 1, 2].map((i) => (
                <Pressable
                  key={i}
                  onPress={() => setSelected(i)}
                  style={styles.candidate}
                  testID={`candidate-${i}`}
                >
                  <View style={styles.candidateMedia}>
                    <WatercolorPortrait
                      seed={candidateSeed(i)}
                      url={candidateUrls[i]}
                      size={portraitSize}
                      selected={selected === i}
                    />
                    {selected === i && (
                      <View
                        style={[
                          styles.checkBadge,
                          {
                            width: badgeSize,
                            height: badgeSize,
                            borderRadius: badgeSize / 2,
                            top: badgeInset,
                            right: badgeInset,
                          },
                        ]}
                      >
                        <Feather name="check" size={Math.round(badgeSize * 0.6)} color={colors.textInvert} />
                      </View>
                    )}
                  </View>
                  <Text style={styles.candidateLabel}>候选 {i + 1}</Text>
                </Pressable>
              ))}
            </View>

            {/* 人物信息 */}
            <View style={styles.profileCard}>
              <View style={styles.profileHead}>
                <Feather name="user" size={14} color={colors.brand} />
                <Text style={styles.profileTitle}>人物设定</Text>
                <Pressable
                  style={styles.profileEdit}
                  hitSlop={8}
                  testID="open-profile-edit"
                  onPress={() => setEditing(true)}
                >
                  <Feather name="edit-2" size={11} color={colors.brand} />
                  <Text style={styles.profileEditText}>修改</Text>
                </Pressable>
              </View>
              <Text style={styles.profileSummary}>{profiles[selected].summary}</Text>
              <View style={styles.profileMeta}>
                {[
                  ["年龄段", profiles[selected].ageRange],
                  ["性格", profiles[selected].personality],
                  ["风格", profiles[selected].style],
                ].map(([k, v]) => (
                  <View key={k} style={styles.profileItem}>
                    <Text style={styles.profileKey}>{k}</Text>
                    <Text style={styles.profileValue}>{v}</Text>
                  </View>
                ))}
              </View>
            </View>

            <Button
              label="修改人物设定"
              variant="secondary"
              size="md"
              fullWidth
              onPress={() => setEditing(true)}
            />
            <Button
              label="下一步"
              size="lg"
              fullWidth
              testID="to-supplement"
              onPress={() => { setName(voice.name); setStage("supplement"); }}
            />
            <Button
              label="换一批候选图"
              variant="ghost"
              size="sm"
              fullWidth
              loading={busy}
              onPress={() => void regenerate()}
            />
          </View>
        )}

        {/* 步骤 3：补充视图（可选） */}
        {stage === "supplement" && (
          <View style={styles.block}>
            <Text style={styles.blockTitle}>需要补充侧面和背面吗？</Text>
            <Text style={styles.blockDesc}>
              三视图能让形象更完整：正面用于主展示，侧面和背面用于转身、多角度对话等场景。
              补图会以你选中的这张正面图作参考，保持同一人物。
            </Text>
            <View style={styles.viewsPreview}>
              {AVATAR_VIEWS.map((v) => {
                const done = v.key === "front";
                return (
                  <View key={v.key} style={[styles.viewPreviewItem, done && styles.viewPreviewDone]}>
                    <WatercolorPortrait
                      seed={viewSeed(v.key)}
                      url={done ? candidateUrls[selected] : viewUrl(v.key)}
                      size={76}
                    />
                    <View style={styles.viewPreviewLabel}>
                      <Feather
                        name={done ? "check" : "plus"}
                        size={10}
                        color={done ? colors.success : colors.textHelper}
                      />
                      <Text style={[styles.viewPreviewText, done && styles.viewPreviewTextDone]}>
                        {v.label}
                        {done ? "已选" : "待生成"}
                      </Text>
                    </View>
                  </View>
                );
              })}
            </View>
            <Button
              label={busy ? "正在提交…" : "补充侧面和背面"}
              size="lg"
              fullWidth
              loading={busy}
              testID="generate-views"
              onPress={() => void startSupplementViews()}
            />
            <Button
              label="先保存，以后再说"
              variant="ghost"
              size="sm"
              fullWidth
              testID="skip-views"
              onPress={() => setStage("save")}
            />
            <Text style={styles.supplementHint}>之后也可以随时在 Avatar 详情页补充缺失的视图。</Text>
          </View>
        )}

        {/* 补充视图生成中 */}
        {stage === "generatingViews" && (
          <View style={styles.block}>
            <View style={styles.genCard}>
              <View style={styles.genHead}>
                <Text style={styles.genTitle}>正在补充侧面和背面</Text>
                <Text style={styles.genPercent}>{viewsProgress}%</Text>
              </View>
              <View style={styles.progressTrack}>
                <View style={[styles.progressFill, { width: `${viewsProgress}%` }]} />
              </View>
              <View style={styles.stepList}>
                {VIEWS_PROGRESS_STEPS.map((s, i) => {
                  const done = viewsProgress > (i + 1) * 50;
                  const active = !done && viewsProgress > i * 50;
                  return (
                    <View key={s} style={styles.stepRow}>
                      <Feather
                        name={done ? "check-circle" : active ? "loader" : "circle"}
                        size={14}
                        color={done ? colors.success : active ? colors.brand : colors.textDisabled}
                      />
                      <Text
                        style={[
                          styles.stepText,
                          (done || active) && { color: colors.textBody },
                        ]}
                      >
                        {s}
                      </Text>
                    </View>
                  );
                })}
              </View>
              <Text style={styles.genHint}>
                {viewsJob
                  ? "以你选中的正面图为参考生成，保持同一人物；通常需要 20-60 秒。可以离开页面，完成后会在任务里通知你。"
                  : "保持同一人物设定，通常需要 30-60 秒。可以离开页面，完成后会在任务里通知你。"}
              </Text>
            </View>
            <View style={styles.genActions}>
              <Button
                label="取消补充"
                variant="ghost"
                size="sm"
                onPress={() => {
                  if (viewsJobId) {
                    cancelJob(viewsJobId).catch((err) =>
                      showToast(userErrorMessage(err, "取消失败，请稍后再试")),
                    );
                  }
                  setViewsJobId(null);
                  setStage("supplement");
                }}
              />
              <Pressable hitSlop={8} onPress={() => router.push("/jobs")}>
                <Text style={styles.linkText}>去任务中心看进度 ›</Text>
              </Pressable>
            </View>
          </View>
        )}

        {/* 步骤 4：保存 */}
        {stage === "save" && (
          <View style={styles.block}>
            <Text style={styles.blockTitle}>保存这个 Avatar</Text>
            <View style={styles.savePreview}>
              <WatercolorPortrait
                seed={candidateSeed(selected)}
                url={candidateUrls[selected]}
                size={96}
              />
              <View style={styles.saveInfo}>
                <Text style={styles.saveProfile} numberOfLines={3}>
                  {profiles[selected].summary}
                </Text>
                <Text style={styles.saveVoice}>声音 · {voice.name}</Text>
              </View>
            </View>
            {/* 三视图状态 */}
            <View style={styles.viewsStatus}>
              {AVATAR_VIEWS.map((v) => {
                const done = v.key === "front" || supplemented;
                return (
                  <View key={v.key} style={[styles.viewsStatusItem, done && styles.viewsStatusItemDone]}>
                    <Feather
                      name={done ? "check" : "clock"}
                      size={12}
                      color={done ? colors.success : colors.textHelper}
                    />
                    <Text style={[styles.viewsStatusText, done && styles.viewsStatusTextDone]}>
                      {v.label}
                      {done ? "已生成" : "未生成"}
                    </Text>
                  </View>
                );
              })}
            </View>
            <View style={styles.inputWrap}>
              <Text style={styles.inputLabel}>给它起个名字</Text>
              <TextInput
                value={name}
                onChangeText={setName}
                placeholder="Avatar 名称"
                placeholderTextColor={colors.textHelper}
                style={styles.input}
                maxLength={20}
                testID="avatar-name"
              />
              <Text style={styles.counter}>{name.length}/20</Text>
            </View>
            <Button label="保存 Avatar" size="lg" fullWidth testID="save-avatar" onPress={saveAvatar} />
            <Button label="换一张候选图" variant="ghost" size="sm" onPress={() => setStage("candidates")} />
          </View>
        )}

        {/* 完成 */}
        {stage === "done" && (
          <View style={styles.block}>
            <View style={styles.doneCard}>
              <View style={styles.doneIcon}>
                <Feather name="check" size={22} color={colors.textInvert} />
              </View>
              <Text style={styles.doneTitle}>Avatar 已创建</Text>
              <Text style={styles.doneDesc}>
                「{name || voice.name}」已经绑定声音 {voice.name}。
                {supplemented
                  ? "三视图已齐全，正面、侧面、背面都可以在说话时使用。"
                  : "正面图已生成，侧面和背面可以稍后在详情页补充。"}
              </Text>
            </View>
            <Button
              label="去 Avatar 列表"
              size="lg"
              fullWidth
              onPress={() => router.push("/avatars")}
            />
            <Button label="再创建一个" variant="ghost" size="sm" onPress={() => setStage("prompt")} />
          </View>
        )}
        </View>
      </ScrollView>

      {/* 修改人物设定：保存后直接重新生成候选 */}
      <ProfileEditSheet
        visible={editing}
        candidateIndex={selected + 1}
        value={{ prompt, profile: profiles[selected] }}
        onClose={() => setEditing(false)}
        onSaveAndRegenerate={(draft) => {
          applyDraft(draft);
          setEditing(false);
          void regenerate(draft.prompt);
        }}
      />
      <Toast message={toastMsg} />
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  scroll: { paddingHorizontal: 16, paddingBottom: 40, gap: 20 },
  // PC：内容区限宽水平居中；innerPC 是贴内容的细边框面板（不满屏时边框包住实际内容）
  scrollPC: {
    width: 720,
    maxWidth: "100%",
    alignSelf: "center",
    paddingHorizontal: 24,
    // 内容不满一屏时垂直也居中；超一屏照常滚动
    flexGrow: 1,
    justifyContent: "center",
    paddingVertical: 24,
  },
  innerPC: {
    borderWidth: 1.5,
    borderColor: "rgba(0,0,0,0.08)",
    borderRadius: 16,
    backgroundColor: colors.surface,
    padding: 24,
    gap: 20,
  },
  // 步骤指示器与上（声音来源卡）下（当前步骤内容块）的呼吸感
  stepGap: { marginVertical: 8 },
  sourceCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: colors.surface,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.05)",
    padding: 10,
    marginTop: 8,
  },
  sourceInfo: { gap: 1 },
  sourceLabel: { ...typography.small, fontSize: 11, color: colors.textHelper },
  sourceName: { ...typography.title, fontSize: 14, color: colors.textTitle },
  block: { gap: 14 },
  blockTitle: { ...typography.h3, color: colors.textTitle },
  blockDesc: { ...typography.caption, color: colors.textDescription, marginTop: -6 },
  textareaWrap: {
    backgroundColor: colors.surface,
    borderRadius: radius.panel,
    borderWidth: 1,
    borderColor: colors.inputBorderOpaque,
    padding: 12,
  },
  textarea: {
    fontFamily: "Lato_400Regular",
    fontSize: 15,
    lineHeight: 22,
    color: colors.textBody,
    minHeight: 96,
    paddingVertical: 0,
  },
  counter: {
    fontFamily: "GeistMono_400Regular",
    fontSize: 11,
    color: colors.textHelper,
    textAlign: "right",
    marginTop: 6,
  },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  notice: {
    ...typography.small,
    color: colors.danger,
    backgroundColor: colors.dangerBackground,
    borderRadius: radius.panel,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  costHint: { ...typography.small, color: colors.textHelper, textAlign: "center" },
  genCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.panel,
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.05)",
    padding: 16,
    gap: 12,
  },
  genHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  genTitle: { ...typography.title, color: colors.textTitle },
  genPercent: { fontFamily: "GeistMono_500Medium", fontSize: 14, color: colors.brand },
  progressTrack: { height: 6, borderRadius: 3, backgroundColor: colors.fillDefault, overflow: "hidden" },
  progressFill: { height: 6, borderRadius: 3, backgroundColor: colors.brand },
  stepList: { gap: 8 },
  stepRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  stepText: { ...typography.caption, color: colors.textHelper },
  genHint: { ...typography.small, color: colors.textDescription },
  genActions: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  linkText: { ...typography.small, color: colors.brand, fontFamily: "Onest_500Medium" },
  candidateGrid: { flexDirection: "row", gap: 10 },
  candidate: {
    flex: 1,
    alignItems: "center",
    gap: 6,
    padding: 6,
  },
  // 紧包人像，作为勾选角标的定位参考（角标相对人像而非格子，避免错位）
  candidateMedia: { position: "relative" },
  checkBadge: {
    position: "absolute",
    backgroundColor: colors.brand,
    alignItems: "center",
    justifyContent: "center",
  },
  candidateLabel: { ...typography.small, color: colors.textDescription },
  // 补充视图预览（正面已选 + 侧面/背面待生成）
  viewsPreview: { flexDirection: "row", gap: 10 },
  viewPreviewItem: {
    flex: 1,
    alignItems: "center",
    gap: 6,
    padding: 6,
    borderRadius: radius.panel,
    borderWidth: 1,
    borderColor: "transparent",
  },
  viewPreviewDone: { borderColor: "rgba(0,0,0,0.08)" },
  viewPreviewLabel: { flexDirection: "row", alignItems: "center", gap: 3 },
  viewPreviewText: { ...typography.small, color: colors.textHelper },
  viewPreviewTextDone: { color: colors.success },
  supplementHint: { ...typography.small, color: colors.textDescription, textAlign: "center" },
  // 保存页三视图状态
  viewsStatus: { flexDirection: "row", gap: 8 },
  viewsStatusItem: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    height: 32,
    borderRadius: radius.panel,
    borderWidth: 1,
    borderColor: colors.inputBorderOpaque,
    backgroundColor: colors.surface,
  },
  viewsStatusItemDone: {
    borderColor: "rgba(0, 180, 137, 0.35)",
    backgroundColor: colors.successBackground,
  },
  viewsStatusText: { ...typography.small, color: colors.textHelper },
  viewsStatusTextDone: { color: colors.success },
  profileCard: {
    backgroundColor: colors.landingCard,
    borderRadius: radius.panel,
    borderWidth: 1,
    borderColor: colors.landingCardBorder,
    padding: 14,
    gap: 8,
  },
  profileHead: { flexDirection: "row", alignItems: "center", gap: 6 },
  profileTitle: { ...typography.title, fontSize: 14, color: colors.textTitle },
  profileEdit: { flexDirection: "row", alignItems: "center", gap: 3, marginLeft: "auto" },
  profileEditText: { ...typography.small, color: colors.brand, fontFamily: "Onest_500Medium" },
  profileSummary: { ...typography.caption, color: colors.textBody },
  profileMeta: { flexDirection: "row", gap: 16, marginTop: 2 },
  profileItem: { gap: 2 },
  profileKey: { ...typography.small, fontSize: 11, color: colors.textHelper },
  profileValue: { ...typography.caption, fontSize: 13, color: colors.textTitle, fontFamily: "Onest_500Medium" },
  savePreview: {
    flexDirection: "row",
    gap: 12,
    backgroundColor: colors.surface,
    borderRadius: radius.panel,
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.05)",
    padding: 12,
    alignItems: "center",
  },
  saveInfo: { flex: 1, gap: 6 },
  saveProfile: { ...typography.caption, color: colors.textBody },
  saveVoice: { ...typography.small, color: colors.textHelper },
  inputWrap: {
    backgroundColor: colors.surface,
    borderRadius: radius.panel,
    borderWidth: 1,
    borderColor: colors.inputBorderOpaque,
    padding: 12,
  },
  inputLabel: { ...typography.small, color: colors.textHelper, marginBottom: 6 },
  input: {
    fontFamily: "Onest_400Regular",
    fontSize: 16,
    color: colors.textBody,
    paddingVertical: 0,
    height: 26,
  },
  doneCard: {
    alignItems: "center",
    paddingVertical: 28,
    paddingHorizontal: 20,
    backgroundColor: colors.landingCard,
    borderRadius: radius.hero,
    borderWidth: 1,
    borderColor: colors.landingCardBorder,
    gap: 8,
  },
  doneIcon: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: colors.success,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 6,
  },
  doneTitle: { ...typography.h3, color: colors.textTitle },
  doneDesc: { ...typography.caption, color: colors.textDescription, textAlign: "center" },
});
