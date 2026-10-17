import { useCallback, useEffect, useMemo, useState } from "react";
import { FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import { colors, typography } from "../src/theme/theme";
import { avatars, refreshLibrary, subscribeData } from "../src/data/mock";
import { getVoice } from "../src/data/voices";
import { AvatarCard } from "../src/components/AvatarCard";
import type { Avatar } from "../src/data/types";
import { EmptyState } from "../src/components/EmptyState";
import { SearchBar } from "../src/components/SearchBar";
import { ScreenContainer } from "../src/components/ScreenContainer";
import { ScreenHeader } from "../src/components/ScreenHeader";
import { useWindowDimensions } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { useIsPC } from "../src/lib/useIsPC";

// PC 网格：卡片最大宽度，列数按可用宽度自动算
const CARD_MAX = 280;
const CARD_GAP = 10;

// 「添加形象」占位卡的哨兵项
const ADD_SENTINEL = { id: "__add_avatar__" };

/** Avatar 列表（功能列表入口之一）：已保存的形象，点击进入详情去「开口说话」 */
export default function AvatarsScreen() {
  const router = useRouter();
  const [query, setQuery] = useState("");
  // 创建流程保存后立刻反映到列表
  const [, forceUpdate] = useState(0);
  useEffect(() => subscribeData(() => forceUpdate((x) => x + 1)), []);
  const isPC = useIsPC();
  // PC 列数按屏宽自动算：卡片宽度不超过 CARD_MAX
  const { width: winW } = useWindowDimensions();
  const pcCols = Math.max(2, Math.floor((winW - 48 + CARD_GAP) / (CARD_MAX + CARD_GAP)));
  // 每次聚焦（首次挂载 + 切 tab 回来）都重新拉后端用户产出库：
  // 在别的设备 / 别的页面增删过的角色，回到列表能立刻看到
  useFocusEffect(
    useCallback(() => {
      void refreshLibrary();
    }, []),
  );
  const filtered = useMemo(
    () => {
      const q = query.trim().toLowerCase();
      return avatars.filter((a) => !q || a.name.toLowerCase().includes(q));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [query, avatars.length]
  );

  return (
    <ScreenContainer
      header={isPC ? <ScreenHeader title="我的 Avatar" /> : undefined}
      style={{ paddingHorizontal: 0 }}
      fullWidth
    >
      <View style={styles.introRow}>
        <Text style={[styles.intro, isPC && styles.introPC]}>形象 = 一张脸 + 一个声音。创建后可以随时让它说新的话。</Text>
        <Text style={styles.count}>{avatars.length} 个</Text>
      </View>
      <View style={styles.searchWrap}>
        <SearchBar value={query} onChangeText={setQuery} placeholder="搜索 Avatar" />
      </View>
      <FlatList
        // PC 列数随屏宽变化，用 key 强制重挂
        key={isPC ? `pc-${pcCols}col` : "mobile-2col"}
        // 末尾追加「添加形象」占位卡，随网格正常占一个格子
        data={[...filtered, ADD_SENTINEL]}
        keyExtractor={(a) => a.id}
        numColumns={isPC ? pcCols : 2}
        columnWrapperStyle={isPC ? styles.rowPC : styles.row}
        renderItem={({ item }) => (
          <View style={isPC ? [styles.cellPC, { width: `${100 / pcCols}%` }] : styles.cell}>
            {item.id === ADD_SENTINEL.id ? (
              <Pressable
                testID="avatar-add-placeholder"
                onPress={() => router.push("/voices")}
                style={({ pressed }) => [styles.addCard, pressed && styles.pressed]}
              >
                <View style={styles.addIcon}>
                  <Feather name="plus" size={22} color={colors.textSubtitle} />
                </View>
                <Text style={styles.addText}>添加形象</Text>
                <Text style={styles.addHint}>从声音库选一个声音开始</Text>
              </Pressable>
            ) : (
              <AvatarCard avatar={item as Avatar} voice={getVoice((item as Avatar).voice_id)} />
            )}
          </View>
        )}
        contentContainerStyle={isPC ? [styles.list, styles.listPC] : styles.list}
        showsVerticalScrollIndicator={false}
        ListEmptyComponent={
          <EmptyState
            title={query ? "没有找到匹配的 Avatar" : "还没有 Avatar"}
            description="从一个声音开始，选一张候选图，几分钟内就能得到你的第一个 Avatar"
            actionLabel="去选声音"
            onAction={() => router.push("/voices")}
          />
        }
      />
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
  },
  pageTitle: { ...typography.h2, color: colors.textTitle, paddingTop: 24, paddingHorizontal: 16 },
  intro: { ...typography.caption, color: colors.textDescription, flexShrink: 1 },
  introPC: { fontSize: 15, lineHeight: 22 },
  count: { ...typography.small, color: colors.textHelper },
  searchWrap: { paddingHorizontal: 16, paddingBottom: 12 },
  list: { paddingHorizontal: 16, paddingBottom: 32, gap: 10 },
  // PC：列间缝隙由 cell 内边距提供，容器补回外缘
  listPC: { paddingHorizontal: 16 - CARD_GAP / 2 },
  row: { gap: 10 },
  rowPC: {},
  cell: { flex: 1, maxWidth: "50%" },
  // 「添加形象」占位卡：与 AvatarCard 同比例，虚线框弱化存在感
  addCard: {
    aspectRatio: 0.85,
    borderRadius: 16,
    borderWidth: 1.5,
    borderColor: "rgba(0,0,0,0.10)",
    borderStyle: "dashed",
    backgroundColor: "rgba(0,0,0,0.015)",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
  },
  addIcon: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.fillDefault,
    alignItems: "center",
    justifyContent: "center",
  },
  addText: { ...typography.small, color: colors.textTitle, fontFamily: "Onest_500Medium" },
  addHint: { ...typography.caption, color: colors.textHelper },
  pressed: { opacity: 0.7 },
  // PC：列数按屏宽算，宽度由 renderItem 内联百分比下发，卡片不超过 CARD_MAX
  cellPC: { paddingHorizontal: CARD_GAP / 2 },
});
