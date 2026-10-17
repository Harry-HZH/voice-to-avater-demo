import { useState } from "react";
import { StyleSheet, Pressable, ScrollView, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { colors, radius, spacing, typography } from "../../src/theme/theme";
import { getAvatar } from "../../src/data/mock";
import { creationTypeOf, getCreation, removeCreation } from "../../src/data/creations";
import { absUrl } from "../../src/lib/api";
import { describeCost } from "../../src/lib/cost";
import { formatDate } from "../../src/lib/format";
import { useSamplePlayer } from "../../src/lib/useSamplePlayer";
import { WatercolorPortrait } from "../../src/components/WatercolorPortrait";
import { VideoPlayer } from "../../src/components/VideoPlayer";
import { Button } from "../../src/components/Button";
import { ErrorState } from "../../src/components/ErrorState";
import { ScreenHeader } from "../../src/components/ScreenHeader";
import { ScreenContainer } from "../../src/components/ScreenContainer";
import { ConfirmSheet } from "../../src/components/ConfirmSheet";

/**
 * 创作详情：看成片。
 * 入口：任务中心的说话任务、角色详情页创作库。
 *
 * 这一页只呈现真实产物 —— 视频来自本后端的 /api/jobs/{id}/video，
 * 音轨来自 /api/jobs/{id}/voice。没有成片就说明没生成成功，
 * 不拿占位图糊过去（假装有视频比没有视频更糟）。
 */
export default function CreationDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const creation = getCreation(id);
  const audio = useSamplePlayer();
  const [deleteVisible, setDeleteVisible] = useState(false);

  if (!creation) {
    return (
      <ScreenContainer header={<ScreenHeader title="创作不存在" back />}>
        <ErrorState
          title="没有找到这条创作"
          message="它可能已被删除"
          retryLabel="返回任务中心"
          onRetry={() => router.push("/jobs")}
        />
      </ScreenContainer>
    );
  }

  const avatar = getAvatar(creation.avatar_id);
  const typeInfo = creationTypeOf(creation.type);
  const videoUrl = absUrl(creation.video_url);
  const voiceUrl = absUrl(creation.voice_url);
  const coverUrl = absUrl(creation.cover_url) ?? absUrl(avatar?.views.front);
  const studioUrl = `/avatar/${creation.avatar_id}/create?edit=${creation.id}`;

  return (
    <ScreenContainer
      header={
        <ScreenHeader
          title={creation.title}
          back
          right={
            <View style={styles.headerActions}>
              <Pressable
                hitSlop={8}
                testID="creation-delete"
                onPress={() => setDeleteVisible(true)}
                style={({ pressed }) => [styles.deleteBtn, pressed && styles.pressed]}
              >
                <Feather name="trash-2" size={14} color={colors.danger} />
                <Text style={styles.deleteBtnText}>删除</Text>
              </Pressable>
              <Pressable
                hitSlop={8}
                testID="creation-edit"
                onPress={() => router.push(studioUrl)}
                style={({ pressed }) => [styles.editBtn, pressed && styles.pressed]}
              >
                <Feather name="edit-2" size={14} color={colors.textTitle} />
                <Text style={styles.editBtnText}>重新生成</Text>
              </Pressable>
            </View>
          }
        />
      }
      style={{ paddingHorizontal: 0 }}
    >
      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        {/* 成片 */}
        {videoUrl ? (
          <VideoPlayer url={videoUrl} poster={coverUrl} height={420} testID="creation-video" />
        ) : (
          <View style={styles.missing}>
            <Feather name="film" size={20} color={colors.textHelper} />
            <Text style={styles.missingText}>
              这条创作没有成片。可能是生成失败，或者成片没能缓存到本地。
            </Text>
          </View>
        )}

        {/* 台词音轨：成片是在念什么，可以单独听 */}
        {voiceUrl && (
          <Pressable
            onPress={() => void audio.playUrl(voiceUrl, creation.id)}
            testID="creation-voice"
            style={({ pressed }) => [styles.trackRow, pressed && styles.pressed]}
          >
            <Feather
              name={audio.playingId === creation.id ? "pause" : "play"}
              size={14}
              color={colors.brand}
            />
            <Text style={styles.trackLabel}>台词音轨</Text>
            <Text style={styles.trackMeta}>{describeCost(creation.duration)}</Text>
          </Pressable>
        )}
        {audio.error && <Text style={styles.error}>{audio.error}</Text>}

        {/* 类型与标题 */}
        <View style={styles.headRow}>
          <View style={styles.typeBadge}>
            <Feather name={typeInfo.icon} size={13} color={colors.brand} />
            <Text style={styles.typeBadgeText}>{typeInfo.label}</Text>
          </View>
          <Text style={styles.title}>{creation.title}</Text>
        </View>

        {/* 台词 */}
        <View style={styles.card}>
          <Text style={styles.cardLabel}>台词</Text>
          <Text style={styles.cardBody}>{creation.script}</Text>
        </View>

        {/* 关联角色 */}
        <Pressable
          onPress={() => router.push(`/avatar/${creation.avatar_id}`)}
          style={({ pressed }) => [styles.avatarRow, pressed && styles.pressed]}
        >
          <WatercolorPortrait seed={creation.avatar_id} url={coverUrl} size={44} />
          <View style={styles.avatarInfo}>
            <Text style={styles.avatarName}>{avatar ? avatar.name : "角色已删除"}</Text>
            <Text style={styles.avatarMeta}>查看角色详情</Text>
          </View>
          <Feather name="chevron-right" size={16} color={colors.textDisabled} />
        </Pressable>

        {/* 元信息 */}
        <View style={styles.metaRow}>
          {creation.points != null && (
            <Text style={styles.metaTag}>约 {creation.points} 点</Text>
          )}
          {creation.duration != null && (
            <Text style={styles.metaTag}>{Math.round(creation.duration)} 秒</Text>
          )}
          <Text style={styles.metaText}>
            创建于 {formatDate(creation.created_at)}
          </Text>
        </View>

        <View style={styles.actions}>
          <Button
            label="改台词重新生成"
            size="lg"
            fullWidth
            testID="creation-regenerate"
            onPress={() => router.push(studioUrl)}
          />
        </View>
      </ScrollView>

      <ConfirmSheet
        visible={deleteVisible}
        onClose={() => setDeleteVisible(false)}
        title="删除这条创作？"
        message="只删创作记录，不删后端任务；生成花掉的积分不会退。"
        confirmLabel="删除创作"
        onConfirm={async () => {
          setDeleteVisible(false);
          await removeCreation(creation.id);
          // 直接打开本页时没有历史栈可退（GO_BACK 无人处理），兜底回角色详情
          if (router.canGoBack()) router.back();
          else router.replace(`/avatar/${creation.avatar_id}`);
        }}
        testID="creation-delete-sheet"
      />
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  scroll: { paddingHorizontal: spacing.lg, paddingBottom: 40, gap: spacing.md },
  pressed: { opacity: 0.85 },
  headerActions: { flexDirection: "row", alignItems: "center", gap: 8 },
  deleteBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    height: 32,
    paddingHorizontal: 12,
    borderRadius: radius.button,
    backgroundColor: colors.dangerBackground,
  },
  deleteBtnText: { ...typography.small, color: colors.danger, fontFamily: "Onest_500Medium" },
  editBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    height: 32,
    paddingHorizontal: 12,
    borderRadius: radius.button,
    backgroundColor: colors.fillDefault,
  },
  editBtnText: { ...typography.small, color: colors.textTitle, fontFamily: "Onest_500Medium" },

  missing: {
    alignItems: "center",
    gap: spacing.sm,
    padding: spacing.xl,
    borderRadius: radius.panel,
    backgroundColor: colors.backgroundMedium,
  },
  missingText: {
    ...typography.caption,
    color: colors.textDescription,
    textAlign: "center",
    maxWidth: 320,
  },

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
  error: { ...typography.small, color: colors.danger },

  headRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm, flexWrap: "wrap" },
  typeBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 9,
    height: 24,
    borderRadius: radius.button,
    backgroundColor: "rgba(245, 97, 56, 0.1)",
  },
  typeBadgeText: { ...typography.small, color: colors.brand, fontFamily: "Onest_500Medium" },
  title: { ...typography.h3, color: colors.textTitle, flexShrink: 1 },

  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.panel,
    borderWidth: 1,
    borderColor: colors.landingCardBorder,
    padding: spacing.md,
    gap: 6,
  },
  cardLabel: { ...typography.small, color: colors.textHelper },
  cardBody: { ...typography.caption, fontSize: 14, color: colors.textBody, lineHeight: 22 },

  avatarRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    backgroundColor: colors.landingCard,
    borderRadius: radius.panel,
    borderWidth: 1,
    borderColor: colors.landingCardBorder,
    padding: spacing.sm,
  },
  avatarInfo: { flex: 1, gap: 1, minWidth: 0 },
  avatarName: { ...typography.title, fontSize: 14, color: colors.textTitle },
  avatarMeta: { ...typography.small, color: colors.textHelper },

  metaRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm, flexWrap: "wrap" },
  metaTag: {
    ...typography.small,
    color: colors.textSubtitle,
    backgroundColor: colors.fillDefault,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: radius.button,
  },
  metaText: { ...typography.small, color: colors.textHelper },

  actions: { gap: spacing.sm, marginTop: spacing.xs },
});
