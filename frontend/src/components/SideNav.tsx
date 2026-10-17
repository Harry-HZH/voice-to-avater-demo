import { Pressable, StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import { useRouter, usePathname } from "expo-router";
import { colors, typography } from "../theme/theme";
import { WaveBars } from "./WaveBars";

/** PC 侧边栏宽度 */
export const SIDENAV_WIDTH = 232;

const FUNCTIONS: {
  href: string;
  label: string;
  icon: keyof typeof Feather.glyphMap;
}[] = [
  { href: "/voices", label: "声音库", icon: "mic" },
  { href: "/avatars", label: "我的 Avatar", icon: "user" },
  { href: "/jobs", label: "任务中心", icon: "clock" },
];

/** 当前所在功能（与 AppHeader 的判定保持一致） */
function activeFunction(segments: string[]): string | null {
  switch (segments[0]) {
    case "voices":
    case "voice":
      return "/voices";
    case "avatars":
    case "avatar":
      return "/avatars";
    case "creation":
    case "jobs":
      return "/jobs";
    default:
      return null;
  }
}

/**
 * PC 专属左侧导航：品牌在顶，三大入口从上到下排列。
 * 样式对齐 fish.audio 桌面端侧边栏：全圆角药丸项、active 用极淡暖底 +
 * 近黑文字（品牌橙只留给强调处，不用在导航高亮上）。
 * 只在视口 ≥1024 时由根布局渲染；手机端走 AppHeader。
 */
export function SideNav() {
  const router = useRouter();
  const pathname = usePathname();
  const segments = pathname.split("/").filter(Boolean);
  const active = activeFunction(segments);

  return (
    <View style={styles.aside} testID="sidenav">
      <View style={styles.brand}>
        <WaveBars height={18} barCount={5} color={colors.textTitle} />
        <Text style={styles.brandText}>Voice to Avatar</Text>
      </View>

      <Text style={styles.sectionTitle}>功能</Text>
      <View style={styles.navList}>
        {FUNCTIONS.map((f) => {
          const isActive = f.href === active;
          return (
            <Pressable
              key={f.href}
              onPress={() => router.push(f.href)}
              style={({ pressed }) => [
                styles.item,
                isActive && styles.itemActive,
                pressed && styles.pressed,
              ]}
              testID={`nav-${f.href.replace("/", "")}`}
            >
              <Feather
                name={f.icon}
                size={15}
                color={isActive ? colors.textTitle : colors.textDescription}
              />
              <Text style={[styles.itemLabel, isActive && styles.itemLabelActive]}>
                {f.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  aside: {
    width: SIDENAV_WIDTH,
    flexShrink: 0,
    backgroundColor: colors.surface,
    borderRightWidth: 1,
    borderRightColor: "rgba(0, 0, 0, 0.05)",
    paddingTop: 16,
    paddingHorizontal: 8,
    gap: 6,
  },
  brand: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 8,
    height: 44,
  },
  brandText: {
    ...typography.title,
    fontSize: 15,
    fontFamily: "Onest_500Medium",
    color: colors.textTitle,
  },
  sectionTitle: {
    ...typography.small,
    color: colors.textHelper,
    paddingHorizontal: 12,
    paddingTop: 8,
  },
  navList: { gap: 2 },
  // fish.audio：36 高的全圆角药丸项，紧凑排布
  item: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    height: 36,
    paddingHorizontal: 12,
    borderRadius: 9999,
  },
  // active：极淡暖色底 + 近黑文字（对齐 fish.audio 的 rgba(96,0,0,0.03) + #161616）
  itemActive: { backgroundColor: "rgba(96, 0, 0, 0.04)" },
  itemLabel: {
    ...typography.title,
    fontSize: 14,
    fontFamily: "Onest_400Regular",
    color: colors.textDescription,
  },
  itemLabelActive: {
    fontFamily: "Onest_500Medium",
    color: colors.textTitle,
  },
  pressed: { opacity: 0.7 },
});
