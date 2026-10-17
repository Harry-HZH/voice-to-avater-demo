import { View, StyleSheet, type ViewStyle, type StyleProp } from "react-native";
import { colors, radius, shadows } from "../theme/theme";

interface Props {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  padded?: boolean;
  tone?: "surface" | "landing";
}

/** 基础卡片：白底 / 暖灰底两种色调 */
export function Card({ children, style, padded = true, tone = "surface" }: Props) {
  return (
    <View
      style={[
        styles.card,
        tone === "landing" && styles.landing,
        padded && styles.padded,
        tone === "surface" ? shadows.card : null,
        style,
      ]}
    >
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.05)",
  },
  landing: {
    backgroundColor: colors.landingCard,
    borderColor: colors.landingCardBorder,
    borderRadius: radius.hero,
  },
  padded: { padding: 16 },
});
