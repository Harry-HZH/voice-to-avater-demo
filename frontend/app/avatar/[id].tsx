import { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { colors, radius, typography } from "../../src/theme/theme";
import { getAvatar, jobsOfAvatar, subscribeData, viewCount } from "../../src/data/mock";
import { getVoice } from "../../src/data/voices";
import { creationsOfAvatar, creationTypeOf } from "../../src/data/creations";
import { formatDate } from "../../src/lib/format";
import { WatercolorPortrait } from "../../src/components/WatercolorPortrait";
import { ErrorState } from "../../src/components/ErrorState";
import { JobCard } from "../../src/components/JobCard";
import { ScreenHeader } from "../../src/components/ScreenHeader";
import { ScreenContainer } from "../../src/components/ScreenContainer";
import { useIsPC } from "../../src/lib/useIsPC";

/**
 * Avatar 详情：查看这个角色已生成的内容。
 * 形象信息（只读）+ 创作库 + 最近任务。
 * 角色信息的编辑与三视图管理在独立的编辑页（/avatar/[id]/edit）；
 * 删除角色入口在角色卡操作弹窗（AvatarActionSheet），不在这里。
 */
export default function AvatarDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const isPC = useIsPC();
  const avatar = getAvatar(id);
  const voice = avatar ? getVoice(avatar.voice_id) : undefined;

  // 数据变更（如保存了新创作、补充了三视图）后刷新页面
  const [, forceUpdate] = useState(0);
  useEffect(() => subscribeData(() => forceUpdate((x) => x + 1)), []);

  if (!avatar) {
    return (
      <ScreenContainer>
        <ScreenHeader title="Avatar 不存在" back />
        <ErrorState title="没有找到这个 Avatar" message="它可能已被删除" retryLabel="返回列表" onRetry={() => router.push("/avatars")} />
      </ScreenContainer>
    );
  }

  const views = viewCount(avatar);
  const viewsComplete = views === 3;
  const recentJobs = jobsOfAvatar(avatar.id);
  const avatarCreations = creationsOfAvatar(avatar.id);
  const goEdit = () => router.push(`/avatar/${avatar.id}/edit`);

  return (
    <ScreenContainer
      header={
        <ScreenHeader
          title={avatar.name}
          back
          right={
            <Pressable
              hitSlop={8}
              testID="avatar-edit"
              onPress={goEdit}
              style={({ pressed }) => [styles.editBtn, pressed && styles.pressed]}
            >
              <Feather name="edit-2" size={14} color={colors.textTitle} />
              <Text style={styles.editBtnText}>编辑</Text>
            </Pressable>
          }
        />
      }
      style={{ paddingHorizontal: 0 }}
    >
      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        {/* 单列（PC/手机一致，用户指定）：信息卡 → 创作库 → 最近任务 */}
        <View style={styles.stack}>
          {/* 形象信息（只读） */}
          <View style={styles.stack}>
            <View style={[styles.heroCard, isPC && styles.heroCardPC]}>
              <WatercolorPortrait seed={avatar.id} size={isPC ? 160 : 120} url={avatar.views.front} />
              {/* 头像右侧的全部信息（PC 横排 / 手机头像下方竖排） */}
              <View style={[styles.heroBody, isPC && styles.heroBodyPC]}>
                <View style={[styles.heroInfo, isPC && styles.heroInfoPC]}>
                  <Text style={styles.heroName}>{avatar.name}</Text>
                  <View style={styles.voiceChip}>
                    <Feather name="mic" size={11} color={colors.textSubtitle} />
                    <Text style={styles.voiceChipText}>{voice?.name ?? "声音已删除"}</Text>
                  </View>
                  {/* 三视图状态：去编辑页管理 */}
                  <Pressable
                    onPress={goEdit}
                    testID="detail-views-chip"
                    style={({ pressed }) => [styles.viewsChip, pressed && styles.pressed]}
                  >
                    <Feather
                      name={viewsComplete ? "check-circle" : "alert-circle"}
                      size={11}
                      color={viewsComplete ? colors.success : colors.warning}
                    />
                    <Text style={styles.viewsChipText}>三视图 {views}/3</Text>
                    <Feather name="chevron-right" size={11} color={colors.textHelper} />
                  </Pressable>
                </View>
                <Text style={[styles.profileSummary, isPC && styles.profileSummaryPC]}>{avatar.profile.summary}</Text>
                <View style={[styles.profileMeta, isPC && styles.profileMetaPC]}>
                  {[
                    ["年龄段", avatar.profile.ageRange],
                    ["性格", avatar.profile.personality],
                    ["风格", avatar.profile.style],
                  ].map(([k, v]) => (
                    <View key={k} style={[styles.profileItem, isPC && styles.profileItemPC]}>
                      <Text style={styles.profileKey}>{k}</Text>
                      <Text style={styles.profileValue}>{v}</Text>
                    </View>
                  ))}
                </View>
              </View>
            </View>
          </View>

          <View style={styles.stack}>
            {/* 创作库：这个角色已生成的视频创作 */}
            <View style={styles.section}>
              <View style={styles.sectionHead}>
                <Text style={styles.sectionTitle}>创作库</Text>
                <View style={styles.headRight}>
                  <Text style={styles.sectionCount}>{avatarCreations.length} 条</Text>
                  <Pressable
                    onPress={() => router.push(`/avatar/${avatar.id}/create`)}
                    testID="new-creation"
                    style={({ pressed }) => [styles.newBtn, pressed && styles.pressed]}
                  >
                    <Feather name="plus" size={12} color={colors.brand} />
                    <Text style={styles.newBtnText}>新建</Text>
                  </Pressable>
                </View>
              </View>
              {avatarCreations.length > 0 ? (
                <View style={styles.creationList}>
                  {avatarCreations.map((c) => {
                    const t = creationTypeOf(c.type);
                    return (
                      <Pressable
                        key={c.id}
                        onPress={() => router.push(`/creation/${c.id}`)}
                        style={({ pressed }) => [styles.creationRow, pressed && styles.pressed]}
                      >
                        <View style={styles.creationIcon}>
                          <Feather name={t.icon} size={15} color={colors.brand} />
                        </View>
                        <View style={styles.creationInfo}>
                          <Text style={styles.creationTitle} numberOfLines={1}>
                            {c.title}
                          </Text>
                          <Text style={styles.creationMeta}>
                            {t.label} · {formatDate(c.updated_at).slice(0, 10)} 更新
                          </Text>
                        </View>
                        <Feather name="chevron-right" size={16} color={colors.textDisabled} />
                      </Pressable>
                    );
                  })}
                </View>
              ) : (
                <Pressable
                  onPress={() => router.push(`/avatar/${avatar.id}/create`)}
                  style={({ pressed }) => [styles.creationEmpty, pressed && styles.pressed]}
                >
                  <Feather name="mic" size={18} color={colors.textHelper} />
                  <Text style={styles.creationEmptyText}>还没有创作，去让 TA 说第一句话</Text>
                </Pressable>
              )}
            </View>

            {/* 最近任务 */}
            {recentJobs.length > 0 && (
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>最近任务</Text>
                <View style={styles.jobList}>
                  {recentJobs.map((j) => (
                    <JobCard key={j.id} job={j} />
                  ))}
                </View>
              </View>
            )}
          </View>
        </View>
      </ScrollView>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  scroll: { paddingHorizontal: 16, paddingBottom: 40, gap: 16 },
  // 单列堆叠（PC 与手机一致）
  stack: { gap: 16 },
  pressed: { opacity: 0.85 },
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
  heroCard: {
    backgroundColor: colors.landingCard,
    borderRadius: radius.hero,
    borderWidth: 1,
    borderColor: colors.landingCardBorder,
    alignItems: "center",
    padding: 20,
    gap: 10,
    marginTop: 4,
  },
  // PC：头像在左，右侧信息栏占满剩余宽度
  heroCardPC: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 20,
    padding: 24,
  },
  // 手机：头像下方竖排居中（保持原视觉）；PC：左对齐占满
  heroBody: { alignItems: "center", gap: 10 },
  heroBodyPC: { flex: 1, alignItems: "flex-start", gap: 12, minWidth: 0 },
  heroInfoPC: { alignItems: "flex-start", flexDirection: "row", flexWrap: "wrap", gap: 8 },
  profileSummaryPC: { textAlign: "left" },
  profileMetaPC: { flexDirection: "row", flexWrap: "wrap", gap: 12, width: "100%", marginTop: 2 },
  profileItemPC: { alignItems: "flex-start", flexGrow: 1, flexBasis: "30%" },
  heroInfo: { alignItems: "center", gap: 6 },
  heroName: { ...typography.h2, color: colors.textTitle },
  voiceChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 10,
    height: 24,
    borderRadius: radius.button,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.landingCardBorder,
  },
  voiceChipText: { fontFamily: "Lato_700Bold", fontSize: 11, color: colors.textSubtitle },
  viewsChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 10,
    height: 24,
    borderRadius: radius.button,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.landingCardBorder,
  },
  viewsChipText: { fontFamily: "Lato_700Bold", fontSize: 11, color: colors.textSubtitle },
  profileSummary: { ...typography.caption, color: colors.textBody, textAlign: "center" },
  profileMeta: { flexDirection: "row", gap: 20, marginTop: 4 },
  profileItem: { alignItems: "center", gap: 2 },
  profileKey: { ...typography.small, fontSize: 11, color: colors.textHelper },
  profileValue: { ...typography.caption, fontSize: 13, color: colors.textTitle, fontFamily: "Onest_500Medium" },
  section: { gap: 10 },
  sectionHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  sectionTitle: { ...typography.title, color: colors.textTitle },
  sectionCount: { fontFamily: "GeistMono_400Regular", fontSize: 11, color: colors.textHelper },
  headRight: { flexDirection: "row", alignItems: "center", gap: 8 },
  newBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    paddingHorizontal: 10,
    height: 26,
    borderRadius: radius.button,
    backgroundColor: "rgba(245, 97, 56, 0.1)",
  },
  newBtnText: { ...typography.small, fontSize: 12, color: colors.brand, fontFamily: "Onest_500Medium" },
  creationList: { gap: 8 },
  creationRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: colors.surface,
    borderRadius: radius.panel,
    borderWidth: 1,
    borderColor: colors.landingCardBorder,
    padding: 10,
  },
  creationIcon: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: "rgba(245, 97, 56, 0.1)",
    alignItems: "center",
    justifyContent: "center",
  },
  creationInfo: { flex: 1, gap: 1, minWidth: 0 },
  creationTitle: { ...typography.title, fontSize: 14, color: colors.textTitle },
  creationMeta: { ...typography.small, color: colors.textHelper },
  creationEmpty: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: colors.surface,
    borderRadius: radius.panel,
    borderWidth: 1,
    borderColor: colors.landingCardBorder,
    borderStyle: "dashed",
    paddingVertical: 18,
  },
  creationEmptyText: { ...typography.caption, color: colors.textDescription },
  jobList: { gap: 10 },
});
