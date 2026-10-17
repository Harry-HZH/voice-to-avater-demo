import { Pressable, StyleSheet, Text } from "react-native";
import { colors, radius } from "../theme/theme";

interface Props {
  label: string;
  selected?: boolean;
  onPress?: () => void;
}

/** 胶囊标签 / 筛选 chip（选中 = 深色填充） */
export function Chip({ label, selected = false, onPress }: Props) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.chip,
        selected && styles.chipSelected,
        pressed && styles.pressed,
      ]}
    >
      <Text style={[styles.label, selected && styles.labelSelected]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chip: {
    height: 30,
    paddingHorizontal: 14,
    borderRadius: radius.button,
    backgroundColor: colors.fillDefault,
    alignItems: "center",
    justifyContent: "center",
  },
  chipSelected: { backgroundColor: colors.actionPrimaryBg },
  pressed: { opacity: 0.85 },
  label: {
    fontFamily: "Lato_400Regular",
    fontSize: 13,
    color: colors.textSubtitle,
  },
  labelSelected: { color: colors.textInvert, fontFamily: "Lato_700Bold" },
});
