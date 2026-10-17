import { useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import { usePathname, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { colors, radius, shadows, typography } from "../theme/theme";
import { WaveBars } from "./WaveBars";
import { getAvatar } from "../data/mock";
import { getCreation } from "../data/creations";
import { getVoice } from "../data/voices";

/** 顶部栏高度（不含安全区） */
const BAR_HEIGHT = 52;
/** 内容区最大宽度，与 ScreenContainer 保持一致，菜单左边界据此对齐 */
const CONTENT_MAX_WIDTH = 640;
interface Crumb {
  label: string;
  href?: string;
}

/** 功能列表：三大入口 */
const FUNCTIONS: {
  href: string;
  label: string;
  desc: string;
  icon: keyof typeof Feather.glyphMap;
}[] = [
  { href: "/voices", label: "声音库", desc: "浏览我的声音，创建 Avatar", icon: "mic" },
  { href: "/avatars", label: "我的 Avatar", desc: "管理形象，让 TA 开口说话", icon: "user" },
  { href: "/jobs", label: "任务中心", desc: "查看生成进度与结果", icon: "clock" },
];

/** 根据当前路由生成面包屑（品牌之后的部分） */
function buildCrumbs(segments: string[]): Crumb[] {
  const [first, second, third] = segments;
  if (first === "voices") {
    return [{ label: "声音库", href: "/voices" }];
  }
  if (first === "voice" && second) {
    const voice = getVoice(second);
    return [
      { label: "声音库", href: "/voices" },
      { label: voice ? voice.name : "声音详情" },
    ];
  }
  if (first === "avatars") {
    return [{ label: "我的 Avatar", href: "/avatars" }];
  }
  if (first === "avatar" && second === "create") {
    const voice = getVoice(third);
    return [
      { label: "声音库", href: "/voices" },
      ...(voice ? [{ label: voice.name, href: `/voice/${voice.id}` }] : []),
      { label: "新建 Avatar" },
    ];
  }
  if (first === "avatar" && second && third === "create") {
    const avatar = getAvatar(second);
    return [
      { label: "我的 Avatar", href: "/avatars" },
      { label: avatar ? avatar.name : "Avatar", href: `/avatar/${second}` },
      { label: "创作" },
    ];
  }
  if (first === "avatar" && second && third === "edit") {
    const avatar = getAvatar(second);
    return [
      { label: "我的 Avatar", href: "/avatars" },
      { label: avatar ? avatar.name : "Avatar", href: `/avatar/${second}` },
      { label: "编辑角色信息" },
    ];
  }
  if (first === "avatar" && second) {
    const avatar = getAvatar(second);
    return [
      { label: "我的 Avatar", href: "/avatars" },
      { label: avatar ? avatar.name : "Avatar 详情" },
    ];
  }
  if (first === "creation" && second) {
    const creation = getCreation(second);
    return [
      { label: "任务中心", href: "/jobs" },
      { label: creation ? creation.title : "创作详情" },
    ];
  }
  if (first === "jobs") {
    return [{ label: "任务中心", href: "/jobs" }];
  }
  return [];
}

/** 当前所在功能（用于菜单高亮） */
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
 * 手机端全局顶部栏：品牌（点开功能列表）+ 面包屑。
 * PC 端不渲染本组件，导航由 SideNav（左侧常显竖向菜单）承担。
 */
export function AppHeader() {
  const router = useRouter();
  const pathname = usePathname();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const [open, setOpen] = useState(false);

  // 路由变化时自动收起菜单
  const segments = useMemo(() => pathname.split("/").filter(Boolean), [pathname]);
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  const crumbs = useMemo(() => buildCrumbs(segments), [segments]);
  const active = activeFunction(segments);
  const menuLeft = Math.max(16, (width - CONTENT_MAX_WIDTH) / 2 + 16);
  const menuTop = insets.top + BAR_HEIGHT + 6;

  return (
    <>
      <View style={[styles.bar, { paddingTop: insets.top }]}>
        <View style={styles.barInner}>
          <Pressable
            onPress={() => setOpen((o) => !o)}
            style={({ pressed }) => [
              styles.brand,
              open && styles.brandOpen,
              pressed && styles.pressed,
            ]}
            accessibilityLabel="打开功能列表"
          >
            <WaveBars height={16} barCount={5} color={colors.textTitle} />
            <Text style={styles.brandText}>Voice to Avatar</Text>
            <Feather
              name={open ? "chevron-up" : "chevron-down"}
              size={14}
              color={colors.textHelper}
            />
          </Pressable>

          <View style={styles.crumbs}>
              {crumbs.map((c, i) => {
                const isLast = i === crumbs.length - 1;
                return (
                  <View key={`${c.label}-${i}`} style={styles.crumb}>
                    <Text style={styles.sep}>/</Text>
                    {isLast || !c.href ? (
                      <Text style={styles.crumbCurrent} numberOfLines={1}>
                        {c.label}
                      </Text>
                    ) : (
                      <Pressable
                        onPress={() => router.push(c.href!)}
                        hitSlop={4}
                        style={styles.crumbItem}
                      >
                        <Text style={styles.crumbLink} numberOfLines={1}>
                          {c.label}
                        </Text>
                      </Pressable>
                    )}
                  </View>
                );
              })}
          </View>
        </View>
      </View>

      {open && (
        <View style={styles.overlay}>
          <Pressable style={styles.backdrop} onPress={() => setOpen(false)} />
          <View style={[styles.menu, { top: menuTop, left: menuLeft }]}>
            <Text style={styles.menuTitle}>功能</Text>
            {FUNCTIONS.map((f) => {
              const isActive = f.href === active;
              return (
                <Pressable
                  key={f.href}
                  onPress={() => {
                    setOpen(false);
                    router.push(f.href);
                  }}
                  style={({ pressed }) => [
                    styles.menuItem,
                    isActive && styles.menuItemActive,
                    pressed && styles.pressed,
                  ]}
                >
                  <View style={[styles.menuIcon, isActive && styles.menuIconActive]}>
                    <Feather
                      name={f.icon}
                      size={15}
                      color={isActive ? colors.textTitle : colors.textDescription}
                    />
                  </View>
                  <View style={styles.menuText}>
                    <Text style={[styles.menuLabel, isActive && styles.menuLabelActive]}>
                      {f.label}
                    </Text>
                    <Text style={styles.menuDesc}>{f.desc}</Text>
                  </View>
                  {isActive && <Feather name="check" size={15} color={colors.textTitle} />}
                </Pressable>
              );
            })}
          </View>
        </View>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  bar: {
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(0, 0, 0, 0.05)",
    zIndex: 10,
  },
  barInner: {
    flexDirection: "row",
    alignItems: "center",
    height: BAR_HEIGHT,
    paddingHorizontal: 12,
    gap: 4,
    width: "100%",
    maxWidth: CONTENT_MAX_WIDTH,
    alignSelf: "center",
  },
  brand: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    paddingVertical: 6,
    paddingHorizontal: 8,
    borderRadius: radius.button,
  },
  brandOpen: { backgroundColor: colors.fillDefault },
  brandText: {
    ...typography.title,
    fontSize: 15,
    fontFamily: "Onest_500Medium",
    color: colors.textTitle,
  },
  pressed: { opacity: 0.7 },
  // 面包屑整条：窄屏 + 长名字时要能收缩，并把溢出裁掉（否则文字会互相压叠）
  crumbs: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    flexShrink: 1,
    minWidth: 0,
    overflow: "hidden",
  },
  crumb: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    flexShrink: 1,
    minWidth: 0,
  },
  // RN 的 flex item 默认 min-width: auto，不加这个里面的文字不肯收缩、会压到隔壁
  crumbItem: { flexShrink: 1, minWidth: 0 },
  // flexShrink: 0 —— RN/RNW 默认 flexShrink: 1，面包屑一长「/」会被压成 0 宽而消失
  // （同上一个坑：语言筛选条被压扁）
  sep: { ...typography.small, color: colors.textDisabled, flexShrink: 0 },
  crumbLink: {
    ...typography.title,
    fontSize: 14,
    fontFamily: "Onest_400Regular",
    color: colors.textDescription,
    flexShrink: 1,
    minWidth: 0,
  },
  crumbCurrent: {
    ...typography.title,
    fontSize: 14,
    fontFamily: "Onest_500Medium",
    color: colors.textTitle,
    flexShrink: 1,
    minWidth: 0,
  },
  overlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 100,
  },
  backdrop: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  menu: {
    position: "absolute",
    width: 272,
    backgroundColor: colors.surface,
    borderRadius: radius.panel,
    borderWidth: 1,
    borderColor: "rgba(0, 0, 0, 0.05)",
    padding: 8,
    gap: 2,
    ...shadows.popover,
  },
  menuTitle: {
    ...typography.small,
    color: colors.textHelper,
    paddingHorizontal: 8,
    paddingTop: 4,
    paddingBottom: 2,
  },
  menuItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    padding: 8,
    // 与 SideNav 一致的全圆角药丸项
    borderRadius: 9999,
  },
  // active 高亮对齐 fish.audio：极淡暖底 + 近黑文字/图标（品牌橙不用在导航高亮上）
  menuItemActive: { backgroundColor: "rgba(96, 0, 0, 0.04)" },
  menuIcon: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: colors.fillDefault,
    alignItems: "center",
    justifyContent: "center",
  },
  menuIconActive: { backgroundColor: "rgba(96, 0, 0, 0.07)" },
  menuText: { flex: 1, gap: 1 },
  menuLabel: {
    ...typography.title,
    fontSize: 14,
    fontFamily: "Onest_400Regular",
    color: colors.textDescription,
  },
  menuLabelActive: { fontFamily: "Onest_500Medium", color: colors.textTitle },
  menuDesc: { ...typography.small, fontFamily: "Lato_400Regular", color: colors.textHelper },
});
