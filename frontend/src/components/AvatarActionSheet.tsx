import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { colors, radius, typography } from "../theme/theme";
import { formatDate } from "../lib/format";
import type { Avatar, Voice } from "../data/types";
import { hasView, removeAvatar, viewCount } from "../data/mock";
import { creationsOfAvatar } from "../data/creations";
import { AVATAR_VIEWS } from "../data/types";
import { WatercolorPortrait } from "./WatercolorPortrait";
import { BottomSheet } from "./BottomSheet";
import { ConfirmSheetBody } from "./ConfirmSheet";

interface Props {
  avatar: Avatar;
  voice?: Voice;
  visible: boolean;
  onClose: () => void;
}

/** 弹窗内容宽度上限，与页面内容区对齐 */
const CONTENT_MAX_WIDTH = 640;

/**
 * 角色卡片操作弹窗：占屏幕 80% 高度的 bottom sheet。
 * 入口：查看生成内容 / 创作 / 编辑角色信息（独立页面）/ 删除角色（红色，二次确认）。
 */
export function AvatarActionSheet({ avatar, voice, visible, onClose }: Props) {
  const router = useRouter();
  const [deleteVisible, setDeleteVisible] = useState(false);
  const creationCount = creationsOfAvatar(avatar.id).length;

  const views = viewCount(avatar);
  const viewsComplete = views === 3;
  const missing = AVATAR_VIEWS.filter((v) => !hasView(avatar, v.key));

  const go = (href: string) => {
    onClose();
    router.push(href);
  };

  return (
    // iOS 上 Modal 不能嵌套（内层 Modal 不显示却拦截触摸 → 全屏点不动），
    // 所以删除确认不另开一层，而是在同一个 BottomSheet 里切换「操作列表 ↔ 确认弹窗」两态。
    <BottomSheet
      visible={visible}
      onClose={deleteVisible ? () => setDeleteVisible(false) : onClose}
      heightRatio={0.8}
      testID="avatar-sheet"
    >
      {deleteVisible ? (
        /* 删除二次确认态：复用外层 Modal */
        <ConfirmSheetBody
          title={`删除「${avatar.name}」？`}
          message={
            creationCount > 0
              ? `这个角色的 ${creationCount} 条创作记录会一并删除，操作无法撤销。`
              : "删除后无法撤销。"
          }
          confirmLabel="删除角色"
          onCancel={() => setDeleteVisible(false)}
          onConfirm={async () => {
            setDeleteVisible(false);
            onClose();
            await removeAvatar(avatar.id);
            // 卡片宿主都是列表页（/avatars、/voice/[id]），数据订阅会自动把卡片移除
          }}
          testID="avatar-delete-sheet"
        />
      ) : (
        <>
      {/* 操作面板内容：蒙层立即铺满，只有这块面板从底部滑入 */}
      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        <View style={styles.inner}>
          {/* 角色摘要 */}
          <View style={styles.profileCard}>
            <WatercolorPortrait seed={avatar.id} size={56} url={avatar.views.front} />
            <View style={styles.profileInfo}>
              <Text style={styles.profileName} numberOfLines={1}>
                {avatar.name}
              </Text>
              <View style={styles.profileMetaRow}>
                <Feather name="mic" size={11} color={colors.textHelper} />
                <Text style={styles.profileMetaText} numberOfLines={1}>
                  {voice ? voice.name : "声音已删除"}
                </Text>
                <Text style={styles.profileMetaDot}>·</Text>
                <Text style={styles.profileMetaText}>
                  {formatDate(avatar.created_at).slice(0, 10)} 创建
                </Text>
              </View>
              <View style={styles.viewsRow}>
                <Feather
                  name={viewsComplete ? "check-circle" : "alert-circle"}
                  size={11}
                  color={viewsComplete ? colors.success : colors.warning}
                />
                <Text style={styles.viewsText}>
                  三视图 {views}/3
                  {missing.length > 0
                    ? ` · 缺 ${missing.map((v) => v.label).join("、")}`
                    : " · 已齐备"}
                </Text>
              </View>
            </View>
          </View>

          {/* 操作入口 */}
          <Pressable
            style={({ pressed }) => [styles.action, pressed && styles.actionPressed]}
            testID="sheet-view-content"
            onPress={() => go(`/avatar/${avatar.id}`)}
          >
            <View style={[styles.actionIcon, { backgroundColor: "rgba(2, 127, 255, 0.08)" }]}>
              <Feather name="play-circle" size={17} color={colors.info} />
            </View>
            <View style={styles.actionText}>
              <Text style={styles.actionLabel}>查看生成内容</Text>
              <Text style={styles.actionDesc}>已保存的创作与最近任务</Text>
            </View>
            <Feather name="chevron-right" size={16} color={colors.textDisabled} />
          </Pressable>

          <Pressable
            style={({ pressed }) => [styles.action, styles.actionHighlight, pressed && styles.actionPressed]}
            testID="sheet-create"
            onPress={() => go(`/avatar/${avatar.id}/create`)}
          >
            <View style={[styles.actionIcon, { backgroundColor: "rgba(245, 97, 56, 0.1)" }]}>
              <Feather name="mic" size={17} color={colors.brand} />
            </View>
            <View style={styles.actionText}>
              <Text style={styles.actionLabel}>让 TA 说话</Text>
              <Text style={styles.actionDesc}>写一段台词，用 TA 的形象和音色说成视频</Text>
            </View>
            <Feather name="chevron-right" size={16} color={colors.brand} />
          </Pressable>

          <Pressable
            style={({ pressed }) => [styles.action, pressed && styles.actionPressed]}
            testID="sheet-edit-profile"
            onPress={() => go(`/avatar/${avatar.id}/edit`)}
          >
            <View style={styles.actionIcon}>
              <Feather name="edit-2" size={17} color={colors.textSubtitle} />
            </View>
            <View style={styles.actionText}>
              <Text style={styles.actionLabel}>编辑角色信息</Text>
              <Text style={styles.actionDesc}>修改名称、简介、人物设定与三视图</Text>
            </View>
            <Feather name="chevron-right" size={16} color={colors.textDisabled} />
          </Pressable>

          {/* 删除角色：最后一位，红色弱化但不藏起来 */}
          <Pressable
            style={({ pressed }) => [styles.action, pressed && styles.actionPressed]}
            testID="sheet-delete-avatar"
            onPress={() => setDeleteVisible(true)}
          >
            <View style={[styles.actionIcon, { backgroundColor: colors.dangerBackground }]}>
              <Feather name="trash-2" size={17} color={colors.danger} />
            </View>
            <View style={styles.actionText}>
              <Text style={[styles.actionLabel, { color: colors.danger }]}>删除角色</Text>
              <Text style={styles.actionDesc}>删除后无法撤销，创作记录会一并清除</Text>
            </View>
          </Pressable>
        </View>
      </ScrollView>

      {/* 底部取消 */}
      <View style={styles.footer}>
        <Pressable
          style={({ pressed }) => [styles.cancelBtn, pressed && { opacity: 0.7 }]}
          onPress={onClose}
        >
          <Text style={styles.cancelText}>取消</Text>
        </Pressable>
      </View>
        </>
      )}
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  scroll: { paddingBottom: 8 },
  inner: {
    width: "100%",
    maxWidth: CONTENT_MAX_WIDTH,
    alignSelf: "center",
    paddingHorizontal: 16,
    paddingTop: 14,
    gap: 10,
  },
  profileCard: {
    flexDirection: "row",
    gap: 12,
    alignItems: "center",
    backgroundColor: colors.landingCard,
    borderRadius: radius.panel,
    borderWidth: 1,
    borderColor: colors.landingCardBorder,
    padding: 12,
  },
  profileInfo: { flex: 1, gap: 4, minWidth: 0 },
  profileName: { ...typography.h3, color: colors.textTitle },
  profileMetaRow: { flexDirection: "row", alignItems: "center", gap: 5 },
  profileMetaText: { ...typography.small, color: colors.textDescription, flexShrink: 1 },
  profileMetaDot: { ...typography.small, color: colors.textDisabled },
  viewsRow: { flexDirection: "row", alignItems: "center", gap: 5 },
  viewsText: { ...typography.small, color: colors.textDescription, flexShrink: 1 },
  action: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: colors.surface,
    borderRadius: radius.panel,
    borderWidth: 1,
    borderColor: colors.landingCardBorder,
    padding: 14,
  },
  actionHighlight: { borderColor: "rgba(245, 97, 56, 0.35)", backgroundColor: "rgba(245, 97, 56, 0.04)" },
  actionPressed: { opacity: 0.85 },
  actionIcon: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: colors.fillDefault,
    alignItems: "center",
    justifyContent: "center",
  },
  actionText: { flex: 1, gap: 2, minWidth: 0 },
  actionLabel: { ...typography.title, fontSize: 15, color: colors.textTitle },
  actionDesc: { ...typography.small, color: colors.textHelper },
  footer: {
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 16,
    borderTopWidth: 1,
    borderTopColor: colors.landingCardBorder,
  },
  cancelBtn: {
    height: 44,
    borderRadius: radius.button,
    backgroundColor: colors.actionSecondaryBg,
    alignItems: "center",
    justifyContent: "center",
    alignSelf: "center",
    width: "100%",
    maxWidth: CONTENT_MAX_WIDTH - 32,
  },
  cancelText: { fontFamily: "Onest_500Medium", fontSize: 14, color: colors.textSubtitle },
});
