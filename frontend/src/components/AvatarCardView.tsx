import { useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { colors, radius } from "../theme/theme";
import { formatDate } from "../lib/format";
import type { Avatar, Voice } from "../data/types";
import { viewCount } from "../data/mock";
import { WatercolorPortrait } from "./WatercolorPortrait";

interface Props {
  avatar: Avatar;
  voice?: Voice;
}

/**
 * 角色卡片的可视部分（无交互）：完整人像撑满卡片，底部 30% 为加深蒙层，
 * 蒙层上展示名称、日期、声音胶囊与三视图完整度。
 * 列表里的 AvatarCard 包一层 Pressable + 操作弹窗，编辑页的卡片预览直接用它。
 */
export function AvatarCardView({ avatar, voice }: Props) {
  const [portraitSize, setPortraitSize] = useState(0);
  const sizeRef = useRef(0);

  const onLayout = (e: { nativeEvent: { layout: { width: number; height: number } } }) => {
    // 人像为正方形，取卡片高度做封面式裁剪（宽度被完全覆盖，上下溢出被卡片裁掉）
    const next = Math.round(e.nativeEvent.layout.height);
    if (next !== sizeRef.current) {
      sizeRef.current = next;
      setPortraitSize(next);
    }
  };

  const views = viewCount(avatar);
  const complete = views === 3;

  return (
    <View style={styles.card} onLayout={onLayout}>
      {/* 完整人像撑满（cover）；有真实形象图就显示真实图 */}
      <View style={styles.portraitWrap}>
        {portraitSize > 0 && (
          <WatercolorPortrait seed={avatar.id} size={portraitSize} url={avatar.views.front} />
        )}
      </View>

      {/* 底部 30% 加深蒙层 */}
      <LinearGradient
        colors={["rgba(22, 22, 22, 0)", "rgba(22, 22, 22, 0.45)", "rgba(22, 22, 22, 0.78)"]}
        locations={[0, 0.55, 1]}
        style={styles.scrim}
      />

      {/* 蒙层上的卡片信息 */}
      <View style={styles.info}>
        <View style={styles.nameRow}>
          <Text style={styles.name} numberOfLines={1}>
            {avatar.name}
          </Text>
          <Text style={styles.date}>{formatDate(avatar.created_at).slice(0, 10)}</Text>
        </View>
        <View style={styles.metaRow}>
          <View style={styles.voiceChip}>
            <Feather name="mic" size={10} color={colors.textInvert} />
            <Text style={styles.voiceText} numberOfLines={1}>
              {voice ? voice.name : "声音已删除"}
            </Text>
          </View>
          <View style={styles.viewsTag}>
            <Feather
              name={complete ? "check-circle" : "alert-circle"}
              size={11}
              color={complete ? colors.textInvert : colors.warning}
            />
            <Text style={styles.viewsText}>{views}/3 视图</Text>
          </View>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    aspectRatio: 0.85,
    backgroundColor: colors.backgroundMedium,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.06)",
    overflow: "hidden",
  },
  portraitWrap: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
  },
  scrim: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    height: "30%",
  },
  info: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: 10,
    paddingTop: 6,
    paddingBottom: 8,
    gap: 5,
  },
  nameRow: { flexDirection: "row", alignItems: "baseline", gap: 6 },
  name: { fontFamily: "Onest_500Medium", fontSize: 15, color: colors.textInvert, flexShrink: 1 },
  date: { fontFamily: "GeistMono_400Regular", fontSize: 10, color: "rgba(255,255,255,0.6)" },
  metaRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  voiceChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 7,
    height: 19,
    borderRadius: radius.button,
    backgroundColor: "rgba(255,255,255,0.18)",
    flexShrink: 1,
  },
  voiceText: { fontFamily: "Lato_400Regular", fontSize: 11, color: colors.textInvert },
  viewsTag: { flexDirection: "row", alignItems: "center", gap: 3, marginLeft: "auto" },
  viewsText: { fontFamily: "Lato_400Regular", fontSize: 11, color: "rgba(255,255,255,0.75)" },
});
