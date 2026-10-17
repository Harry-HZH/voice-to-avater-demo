import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { colors, radius, typography } from "../../src/theme/theme";
import { getVoice } from "../../src/data/voices";
import { API_BASE, absUrl, createPreview, fetchVoice, userErrorMessage, waitJob } from "../../src/lib/api";
import { useSamplePlayer } from "../../src/lib/useSamplePlayer";
import { avatarsOfVoice } from "../../src/data/mock";
import { languageLabel } from "../../src/lib/format";
import { WatercolorPortrait } from "../../src/components/WatercolorPortrait";
import { WaveBars } from "../../src/components/WaveBars";
import { Button } from "../../src/components/Button";
import { AvatarCard } from "../../src/components/AvatarCard";
import { EmptyState } from "../../src/components/EmptyState";
import { ScreenHeader } from "../../src/components/ScreenHeader";
import { ScreenContainer } from "../../src/components/ScreenContainer";
import { useIsPC } from "../../src/lib/useIsPC";
import type { Voice } from "../../src/data/types";

type SynthState = "idle" | "queued" | "running" | "failed";

/**
 * 声音详情。
 * 需求功能 2：从一个声音开始创建 Avatar —— 主行动点。
 * 同时可以播放该声音的**真实试听音源**，并用它合成任意文案试听。
 */
export default function VoiceDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const isPC = useIsPC();
  const [voice, setVoice] = useState<Voice | null>(() => getVoice(id) ?? null);
  const [loading, setLoading] = useState(true);
  const [warning, setWarning] = useState<string | null>(null);
  const player = useSamplePlayer();

  // 自定义文案合成
  const [text, setText] = useState("");
  const [synth, setSynth] = useState<SynthState>("idle");
  const [synthError, setSynthError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    fetchVoice(id)
      .then((v) => {
        if (!alive) return;
        setVoice(v);
        setWarning(null);
        setLoading(false);
      })
      .catch((err) => {
        if (!alive) return;
        setVoice(getVoice(id) ?? null);
        setWarning(userErrorMessage(err, "服务暂不可用，请稍后再试"));
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [id]);

  if (loading && !voice) {
    return (
      <ScreenContainer header={<ScreenHeader title="声音" back />}>
        <View style={styles.loadingBox}>
          <ActivityIndicator color={colors.actionPrimaryBg} />
          <Text style={styles.heroHint}>正在读取声音…</Text>
        </View>
      </ScreenContainer>
    );
  }

  if (!voice) {
    return (
      <ScreenContainer header={<ScreenHeader title="声音不存在" back />}>
        <EmptyState title="没有找到这个声音" description="它可能已被删除" />
      </ScreenContainer>
    );
  }

  const related = avatarsOfVoice(voice.id);
  const isPlaying = player.playingId === voice.id;
  const isPreparing = player.preparingId === voice.id;

  const runSynth = async () => {
    const content = text.trim();
    if (!content || synth === "queued" || synth === "running") return;
    setSynthError(null);
    setSynth("queued");
    try {
      const { job } = await createPreview(voice.id, content);
      setSynth("running");
      const done = await waitJob(job.id);
      if (done.status === "succeeded" && done.output?.audio_url) {
        setSynth("idle");
        const url = done.output.audio_url.startsWith("http")
          ? done.output.audio_url
          : `${API_BASE}${done.output.audio_url}`;
        await player.playUrl(url, `synth:${job.id}`);
      } else {
        setSynth("failed");
        setSynthError(userErrorMessage(done.error, "合成失败，请稍后再试"));
      }
    } catch (err) {
      setSynth("failed");
      setSynthError(userErrorMessage(err, "合成失败，请稍后再试"));
    }
  };

  const synthBusy = synth === "queued" || synth === "running";

  return (
    <ScreenContainer header={<ScreenHeader title={voice.name} back />} style={{ paddingHorizontal: 0 }}>
      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        {warning ? (
          <View style={styles.banner}>
            <Text style={styles.bannerText}>后端未连接，已显示本地示例数据</Text>
          </View>
        ) : null}

        {/* PC 双栏：左 = 试听 + 声音信息，右 = 合成 + 创建 CTA；手机保持单列 */}
        <View style={isPC ? styles.pcRow : styles.stack}>
          <View style={isPC ? styles.pcCol : styles.stack}>
            {/* 播放区：真实试听音源。PC 横排：头像在左，播放/波形在右 */}
            <View style={[styles.heroCard, isPC && styles.heroCardPC]}>
              <WatercolorPortrait seed={voice.id} size={isPC ? 168 : 140} url={absUrl(voice.avatar_url)} />
              <View style={styles.heroPlayCol}>
                <Pressable
                  onPress={() => player.toggle(voice)}
                  testID="play-sample"
                  style={({ pressed }) => [styles.playBtn, pressed && styles.pressed]}
                  hitSlop={8}
                >
                  {isPreparing ? (
                    <ActivityIndicator size="small" color={colors.textInvert} />
                  ) : (
                    <Feather name={isPlaying ? "pause" : "play"} size={20} color={colors.textInvert} />
                  )}
                </Pressable>
                <View style={styles.heroWave}>
                  <WaveBars playing={isPlaying} height={40} barCount={14} />
                </View>
                <Text style={styles.heroHint}>
                  {isPreparing
                    ? "音源生成中，请稍候…"
                    : isPlaying
                      ? "正在播放真实音源…"
                      : "点击播放该声音的真实音源"}
                </Text>
                {player.error ? <Text style={styles.errorText}>{player.error}</Text> : null}
              </View>
            </View>

            {/* 声音信息 */}
            <View style={styles.section}>
              <View style={styles.metaRow}>
                <Text style={styles.name}>{voice.name}</Text>
                <View style={styles.langBadge}>
                  <Text style={styles.langText}>{languageLabel(voice.language)}</Text>
                </View>
              </View>
              <Text style={styles.desc}>{voice.description}</Text>
              <View style={styles.tagRow}>
                {voice.tags.map((t) => (
                  <View key={t} style={styles.tag}>
                    <Text style={styles.tagText}>{t}</Text>
                  </View>
                ))}
              </View>
            </View>
          </View>

          <View style={isPC ? styles.pcCol : styles.stack}>
            {/* 用这个声音说一段话：真实语音合成 */}
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>用这个声音说一段话</Text>
              <TextInput
                value={text}
                onChangeText={setText}
                multiline
                testID="synth-input"
                placeholder={`输入要说的内容，例如：${voice.language === "zh" ? "大家好，我是" + voice.name + "。" : `Hi, I'm ${voice.name}.`}`}
                placeholderTextColor={colors.textHelper}
                style={[styles.input, isPC && styles.inputPC]}
                textAlignVertical="top"
              />
              <Button
                label={synthBusy ? "合成中…" : "合成试听"}
                size="md"
                fullWidth
                testID="synth-submit"
                disabled={!text.trim() || synthBusy}
                onPress={runSynth}
              />
              {synthBusy ? (
                <View style={styles.synthRow}>
                  <ActivityIndicator size="small" color={colors.actionPrimaryBg} />
                  <Text style={styles.synthText}>
                    {synth === "queued" ? "排队中…" : "正在合成语音…"}
                  </Text>
                </View>
              ) : null}
              {synthError ? <Text style={styles.errorText}>{synthError}</Text> : null}
            </View>

            {/* 主行动点：创建 Avatar */}
            <View style={styles.section}>
              <Button
                label="用这个声音创建 Avatar"
                size="lg"
                fullWidth
                onPress={() => router.push(`/avatar/create/${voice.id}`)}
              />
              <Text style={styles.ctaHint}>
                我们会根据这个声音生成候选形象和人物设定，你选一张喜欢的保存。
              </Text>
            </View>
          </View>
        </View>

        {/* 关联 Avatar */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>用这个声音创建的 Avatar</Text>
          {related.length > 0 ? (
            <View style={styles.relatedGrid}>
              {related.map((a) => (
                <View key={a.id} style={styles.relatedCell}>
                  <AvatarCard avatar={a} voice={voice} />
                </View>
              ))}
            </View>
          ) : (
            <EmptyState
              title="还没有用这个声音创建形象"
              description="点击上方按钮，生成第一张候选图"
            />
          )}
        </View>
      </ScrollView>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  scroll: { paddingHorizontal: 16, paddingBottom: 32, gap: 16 },
  // 手机：单列堆叠（gap 语义与 scroll 一致）；PC：双栏
  stack: { gap: 16 },
  pcRow: { flexDirection: "row", gap: 20, alignItems: "flex-start" },
  pcCol: { flex: 1, gap: 16, minWidth: 0 },
  loadingBox: { alignItems: "center", paddingVertical: 60, gap: 10 },
  banner: {
    backgroundColor: colors.fillDefault,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  bannerText: { ...typography.small, color: colors.textSubtitle },
  heroCard: {
    backgroundColor: colors.landingCard,
    borderRadius: radius.hero,
    borderWidth: 1,
    borderColor: colors.landingCardBorder,
    alignItems: "center",
    paddingVertical: 28,
    gap: 12,
    marginTop: 4,
  },
  // PC：横排，头像在左、播放区在右，卡片不用竖着堆很高
  heroCardPC: {
    flexDirection: "row",
    alignItems: "center",
    gap: 24,
    paddingVertical: 24,
    paddingHorizontal: 24,
  },
  heroPlayCol: { alignItems: "center", gap: 12 },
  playBtn: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: colors.actionPrimaryBg,
    alignItems: "center",
    justifyContent: "center",
  },
  pressed: { opacity: 0.85 },
  heroWave: { paddingHorizontal: 24 },
  heroHint: { ...typography.small, color: colors.textDescription },
  errorText: { ...typography.small, color: colors.actionPrimaryBg },
  section: { gap: 10 },
  metaRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  name: { ...typography.h2, color: colors.textTitle },
  langBadge: {
    paddingHorizontal: 10,
    height: 22,
    borderRadius: radius.button,
    backgroundColor: colors.fillDefault,
    justifyContent: "center",
  },
  langText: { fontFamily: "Lato_700Bold", fontSize: 11, color: colors.textSubtitle },
  desc: { ...typography.body, color: colors.textSubtitle },
  tagRow: { flexDirection: "row", gap: 6, flexWrap: "wrap" },
  tag: {
    paddingHorizontal: 10,
    height: 24,
    borderRadius: radius.button,
    borderWidth: 1,
    borderColor: colors.inputBorderOpaque,
    justifyContent: "center",
  },
  tagText: { fontFamily: "Lato_400Regular", fontSize: 12, color: colors.textHelper },
  input: {
    minHeight: 88,
    borderWidth: 1,
    borderColor: colors.inputBorderOpaque,
    borderRadius: radius.card,
    backgroundColor: colors.surface,
    paddingHorizontal: 12,
    paddingVertical: 10,
    ...typography.body,
    color: colors.textTitle,
  },
  synthRow: { flexDirection: "row", alignItems: "center", gap: 8, justifyContent: "center" },
  synthText: { ...typography.small, color: colors.textDescription },
  ctaHint: { ...typography.small, color: colors.textDescription, textAlign: "center" },
  sectionTitle: { ...typography.title, color: colors.textTitle, marginBottom: 2 },
  // PC 上合成输入框更高：右栏空间大，多行文案一次看得全
  inputPC: { minHeight: 150 },
  relatedGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  relatedCell: { flexGrow: 1, flexBasis: "46%", maxWidth: 300 },
});
