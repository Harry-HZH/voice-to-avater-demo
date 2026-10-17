import { Pressable, StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { colors, typography } from "../theme/theme";
import { useIsPC } from "../lib/useIsPC";

interface Props {
  title: string;
  /** 右侧操作区 */
  right?: React.ReactNode;
  /** 是否显示返回按钮 */
  back?: boolean;
}

/**
 * 页面头部：返回按钮 + 标题。
 * PC 端是固定顶栏（对齐 fish.audio）：标题始终左对齐、底部细分隔线；
 * 内容区（ScrollView）在它下面滚动，标题不跟着走。
 */
export function ScreenHeader({ title, right, back = false }: Props) {
  const router = useRouter();
  const isPC = useIsPC();
  return (
    <View style={[styles.header, isPC && styles.headerPC]}>
      <View style={styles.left}>
        {back && (
          <Pressable
            onPress={() => router.back()}
            hitSlop={8}
            style={({ pressed }) => [styles.backBtn, pressed && styles.pressed]}
          >
            <Feather name="arrow-left" size={20} color={colors.textTitle} />
          </Pressable>
        )}
        <Text style={[styles.title, isPC && styles.titlePC]} numberOfLines={1}>
          {title}
        </Text>
      </View>
      {right}
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 12,
    minHeight: 52,
  },
  // PC：固定顶栏（放 ScreenContainer 的 header 插槽里，白底与发丝线由通栏容器负责）
  headerPC: {
    minHeight: 56,
    paddingHorizontal: 24,
    paddingVertical: 10,
  },
  left: { flexDirection: "row", alignItems: "center", gap: 8, flex: 1 },
  backBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.fillDefault,
  },
  pressed: { opacity: 0.7 },
  title: { ...typography.title, color: colors.textTitle, flexShrink: 1 },
  titlePC: { fontSize: 16 },
});
