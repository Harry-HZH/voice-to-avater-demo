import { useCallback, useMemo, useState } from "react";
import { FlatList, ScrollView, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { useFocusEffect } from "expo-router";
import { useIsPC } from "../src/lib/useIsPC";

// PC 网格：卡片最大宽度，列数按可用宽度自动算（与我的 Avatar 页同一套）
const CARD_MAX = 460;
const CARD_GAP = 14;
import { colors, typography } from "../src/theme/theme";
import { loadVoices } from "../src/data/voices";
import { languageLabel } from "../src/lib/format";
import { useSamplePlayer } from "../src/lib/useSamplePlayer";
import { VoiceCard } from "../src/components/VoiceCard";
import { VoiceCardSkeleton } from "../src/components/Skeleton";
import { EmptyState } from "../src/components/EmptyState";
import { SearchBar } from "../src/components/SearchBar";
import { Chip } from "../src/components/Chip";
import { ScreenContainer } from "../src/components/ScreenContainer";
import { ScreenHeader } from "../src/components/ScreenHeader";
import type { Voice } from "../src/data/types";

/**
 * 声音库（功能列表入口之一）。
 * 需求功能 1：浏览自己的声音。数据来自后端，每个声音都能播放**真实试听音源**。
 */
export default function VoicesScreen() {
  const [query, setQuery] = useState("");
  const [lang, setLang] = useState("all");
  const [list, setList] = useState<Voice[]>([]);
  const [loading, setLoading] = useState(true);
  const [warning, setWarning] = useState<string | null>(null);
  const [samplesReady, setSamplesReady] = useState<number | undefined>(undefined);
  const player = useSamplePlayer();
  const isPC = useIsPC();
  // PC 列数按屏宽自动算：卡片宽度不超过 CARD_MAX（减去侧边栏 232 + 页面左右边距）
  const { width: winW } = useWindowDimensions();
  const pcCols = Math.max(1, Math.floor((winW - 232 - 48 + CARD_GAP) / (CARD_MAX + CARD_GAP)));

  // 每次聚焦（首次挂载 + 切 tab 回来）都重新拉声音库：头像/试听状态可能已经变了。
  // 只有首次挂载才显示骨架屏，之后的刷新静默覆盖，不闪屏。
  useFocusEffect(
    useCallback(() => {
      let alive = true;
      loadVoices().then((res) => {
        if (!alive) return;
        setList(res.voices);
        setWarning(res.warning ?? null);
        setSamplesReady(res.samplesReady);
        setLoading(false);
      });
      return () => {
        alive = false;
      };
    }, []),
  );

  const langFilters = useMemo(() => {
    const present = Array.from(new Set(list.map((v) => v.language))).sort();
    return [{ key: "all", label: "全部" }, ...present.map((l) => ({ key: l, label: languageLabel(l) }))];
  }, [list]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return list.filter((v) => {
      const matchLang = lang === "all" || v.language === lang;
      const matchQuery =
        !q ||
        v.name.toLowerCase().includes(q) ||
        v.description.toLowerCase().includes(q) ||
        (v.tags || []).some((t) => t.toLowerCase().includes(q));
      return matchLang && matchQuery;
    });
  }, [list, query, lang]);

  return (
    <ScreenContainer
      header={isPC ? <ScreenHeader title="声音库" /> : undefined}
      fullWidth
    >
      <Text style={[styles.intro, isPC && styles.introPC]}>
        选一个声音，得到会说话的形象。点播放可以先听听真实音色。
      </Text>

      {warning ? (
        <View style={styles.banner}>
          <Text style={styles.bannerText}>{warning}</Text>
        </View>
      ) : null}

      {player.error ? (
        <View style={[styles.banner, styles.bannerError]}>
          <Text style={styles.bannerText}>{player.error}</Text>
        </View>
      ) : null}

      <SearchBar value={query} onChangeText={setQuery} />

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.chipScroll}
        contentContainerStyle={styles.chipRow}
      >
        {langFilters.map((f) => (
          <Chip key={f.key} label={f.label} selected={lang === f.key} onPress={() => setLang(f.key)} />
        ))}
      </ScrollView>

      <View style={styles.metaRow}>
        <Text style={styles.countText}>{filtered.length} 个声音</Text>
        {samplesReady !== undefined && list.length > 0 ? (
          <Text style={styles.readyText}>· {samplesReady} 个真实音源已就绪</Text>
        ) : null}
      </View>

      {loading ? (
        <View style={styles.list}>
          {[0, 1, 2, 3].map((i) => (
            <VoiceCardSkeleton key={i} />
          ))}
        </View>
      ) : (
        <FlatList
          // PC 列数随屏宽变化，用 key 强制重挂
          key={isPC ? `pc-${pcCols}col` : "mobile-1col"}
          data={filtered}
          keyExtractor={(v) => v.id}
          numColumns={isPC ? pcCols : 1}
          columnWrapperStyle={isPC ? styles.rowPC : undefined}
          renderItem={({ item }) => (
            <View style={isPC ? [styles.pcCell, { width: `${100 / pcCols}%` }] : undefined}>
              <VoiceCard
                voice={item}
                playing={player.playingId === item.id}
                preparing={player.preparingId === item.id}
                onPlay={() => player.toggle(item)}
              />
            </View>
          )}
          style={styles.listWrap}
          contentContainerStyle={isPC ? [styles.list, styles.listPC] : styles.list}
          showsVerticalScrollIndicator={false}
          ListEmptyComponent={
            <EmptyState
              title="没有找到匹配的声音"
              description="换个关键词，或清除筛选条件看看全部声音"
              actionLabel="清除筛选"
              onAction={() => {
                setQuery("");
                setLang("all");
              }}
            />
          }
        />
      )}
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  pageTitle: {
    ...typography.h2,
    color: colors.textTitle,
    paddingTop: 24,
  },
  intro: {
    ...typography.caption,
    color: colors.textDescription,
    paddingTop: 14,
    paddingBottom: 10,
  },
  introPC: { fontSize: 15, lineHeight: 22, paddingTop: 6, paddingBottom: 14 },
  banner: {
    backgroundColor: colors.fillDefault,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    marginBottom: 10,
  },
  bannerError: { backgroundColor: "rgba(245,97,56,0.10)" },
  bannerText: { ...typography.small, color: colors.textSubtitle },
  // 横向筛选条：必须 flexShrink: 0，否则列表一长就会被 flex 挤扁（chip 被裁切）
  chipScroll: { flexGrow: 0, flexShrink: 0, marginVertical: 10 },
  chipRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingRight: 8 },
  metaRow: { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 10 },
  countText: { ...typography.small, color: colors.textHelper },
  readyText: { ...typography.small, color: colors.textHelper },
  // 列表自己占满剩余高度并内部滚动，页头（筛选条）就不会被压缩
  listWrap: { flex: 1 },
  list: { gap: 10, paddingBottom: 32 },
  // PC：列数按屏宽算，宽度由 renderItem 内联百分比下发；缝隙用 cell 内边距实现
  rowPC: {},
  pcCell: { paddingHorizontal: CARD_GAP / 2, paddingBottom: 4 },
  listPC: { paddingHorizontal: 16 - CARD_GAP / 2, gap: 0, rowGap: 10 },
});
