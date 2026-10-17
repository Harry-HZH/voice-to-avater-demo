import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useState } from "react";
import { colors, radius, shadows, typography } from "../theme/theme";
import { languageLabel } from "../lib/format";
import { absUrl } from "../lib/api";
import { useIsPC } from "../lib/useIsPC";
import type { Voice } from "../data/types";
import { WatercolorPortrait } from "./WatercolorPortrait";
import { WaveBars } from "./WaveBars";

/** 头像边长：播放按钮要相对头像绝对定位，外层容器必须和头像等大，不能被 flex 拉伸 */
const AVATAR_SIZE = 64;

interface Props {
  voice: Voice;
  playing?: boolean;
  /** 音源还在后端生成中 */
  preparing?: boolean;
  onPlay?: () => void;
}

/** 声音列表卡片：水彩封面 + 播放真实试听音源 + 标签 + 创建入口 */
export function VoiceCard({ voice, playing = false, preparing = false, onPlay }: Props) {
  const router = useRouter();
  const isPC = useIsPC();
  const [hover, setHover] = useState(false);
  const avatarSize = isPC ? 72 : AVATAR_SIZE;
  return (
    <Pressable
      onPress={() => router.push(`/voice/${voice.id}`)}
      testID={`voice-${voice.id}`}
      onHoverIn={() => setHover(true)}
      onHoverOut={() => setHover(false)}
      style={({ pressed }) => [
        styles.card,
        isPC && styles.cardPC,
        hover && styles.cardHover,
        pressed && styles.pressed,
      ]}
    >
      <View style={styles.thumbWrap}>
        <View style={[styles.avatarBox, { width: avatarSize, height: avatarSize }]}>
          {/* 有按人设生成的真实头像就显示，否则回退水彩占位 */}
          <WatercolorPortrait seed={voice.id} size={avatarSize} url={absUrl(voice.avatar_url)} />
          <Pressable
            onPress={(e) => {
              e.stopPropagation();
              onPlay?.();
            }}
            hitSlop={8}
            testID={`play-${voice.id}`}
            style={({ pressed }) => [styles.playBtn, pressed && styles.pressed]}
          >
            {preparing ? (
              <ActivityIndicator size="small" color={colors.textInvert} />
            ) : (
              <Feather name={playing ? "pause" : "play"} size={14} color={colors.textInvert} />
            )}
          </Pressable>
        </View>
      </View>

      <View style={styles.info}>
        <View style={styles.titleRow}>
          <Text style={styles.name} numberOfLines={1}>
            {voice.name}
          </Text>
          <View style={styles.langBadge}>
            <Text style={styles.langText}>{languageLabel(voice.language)}</Text>
          </View>
        </View>
        <Text style={[styles.desc, isPC && styles.descPC]} numberOfLines={2}>
          {voice.description}
        </Text>
        <View style={styles.tagRow}>
          {voice.tags.slice(0, 3).map((t) => (
            <View key={t} style={styles.tag}>
              <Text style={styles.tagText}>{t}</Text>
            </View>
          ))}
          <View style={styles.waveWrap}>
            <WaveBars playing={playing} height={18} barCount={8} />
          </View>
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: "row",
    gap: 12,
    padding: 12,
    backgroundColor: colors.surface,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.05)",
    ...shadows.card,
  },
  // PC：更舒展的留白与圆角
  cardPC: { padding: 16, gap: 14, borderRadius: 14 },
  // web 悬停：边框加深 + 轻微抬升
  cardHover: {
    borderColor: "rgba(0,0,0,0.12)",
    boxShadow: "0 6px 16px 0 rgba(0, 0, 0, 0.06)",
  },
  pressed: { opacity: 0.92 },
  // row 容器默认 alignItems:stretch 会把这层拉成整张卡片高，
  // 必须显式钉住头像尺寸，播放按钮才不至于漂到卡片底部
  thumbWrap: { alignSelf: "flex-start" },
  avatarBox: {
    position: "relative",
    // 尺寸由内联样式按 isPC 下发（PC 72 / 手机 64）
  },
  playBtn: {
    position: "absolute",
    right: -4,
    bottom: -4,
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: colors.actionPrimaryBg,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderColor: colors.surface,
  },
  info: { flex: 1, gap: 6 },
  titleRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  name: { ...typography.title, color: colors.textTitle, flexShrink: 1 },
  langBadge: {
    paddingHorizontal: 8,
    height: 20,
    borderRadius: radius.button,
    backgroundColor: colors.fillDefault,
    justifyContent: "center",
  },
  langText: { fontFamily: "Lato_700Bold", fontSize: 11, color: colors.textSubtitle },
  desc: { ...typography.caption, color: colors.textDescription },
  descPC: { fontSize: 14, lineHeight: 20 },
  tagRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 2 },
  tag: {
    paddingHorizontal: 8,
    height: 22,
    borderRadius: radius.button,
    borderWidth: 1,
    borderColor: colors.inputBorderOpaque,
    justifyContent: "center",
  },
  tagText: { fontFamily: "Lato_400Regular", fontSize: 11, color: colors.textHelper },
  waveWrap: { marginLeft: "auto" },
});
