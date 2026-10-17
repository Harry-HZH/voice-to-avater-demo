import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { colors, radius, typography } from "../theme/theme";

type Variant = "primary" | "secondary" | "ghost";
type Size = "sm" | "md" | "lg";

interface Props {
  label: string;
  onPress?: () => void;
  variant?: Variant;
  size?: Size;
  disabled?: boolean;
  loading?: boolean;
  fullWidth?: boolean;
  icon?: React.ReactNode;
  testID?: string;
}

const HEIGHT: Record<Size, number> = { sm: 32, md: 40, lg: 48 };
const FONT: Record<Size, number> = { sm: 13, md: 14, lg: 15 };

export function Button({
  label,
  onPress,
  variant = "primary",
  size = "md",
  disabled = false,
  loading = false,
  fullWidth = false,
  icon,
  testID,
}: Props) {
  const isDisabled = disabled || loading;
  return (
    <Pressable
      onPress={onPress}
      disabled={isDisabled}
      testID={testID}
      style={({ pressed }) => [
        styles.base,
        { height: HEIGHT[size], paddingHorizontal: size === "sm" ? 14 : 20 },
        variant === "primary" && styles.primary,
        variant === "secondary" && styles.secondary,
        variant === "ghost" && styles.ghost,
        isDisabled && styles.disabled,
        fullWidth && styles.fullWidth,
        pressed && !isDisabled && styles.pressed,
      ]}
    >
      {loading ? (
        <ActivityIndicator size="small" color={variant === "primary" ? colors.actionPrimaryFg : colors.textTitle} />
      ) : (
        <View style={styles.content}>
          {icon}
          <Text
            style={[
              styles.label,
              { fontSize: FONT[size] },
              variant === "primary" && !isDisabled && { color: colors.actionPrimaryFg },
              variant === "secondary" && { color: colors.actionSecondaryFg },
              variant === "ghost" && { color: colors.textSubtitle },
              isDisabled && { color: "rgba(255,255,255,0.7)" },
            ]}
            numberOfLines={1}
          >
            {label}
          </Text>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    borderRadius: radius.button,
    alignItems: "center",
    justifyContent: "center",
    alignSelf: "flex-start",
  },
  content: { flexDirection: "row", alignItems: "center", gap: 6 },
  fullWidth: { alignSelf: "stretch" },
  primary: { backgroundColor: colors.actionPrimaryBg },
  secondary: { backgroundColor: colors.actionSecondaryBg },
  ghost: { backgroundColor: "transparent", borderWidth: 1, borderColor: colors.inputBorderOpaque },
  disabled: { backgroundColor: colors.actionPrimaryBgDisabled },
  pressed: { opacity: 0.85 },
  label: {
    fontFamily: "Onest_500Medium",
    letterSpacing: 0.2,
  },
});
