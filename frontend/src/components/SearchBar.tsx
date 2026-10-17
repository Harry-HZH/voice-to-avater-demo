import { StyleSheet, TextInput, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import { colors, radius } from "../theme/theme";
import { useIsPC } from "../lib/useIsPC";

interface Props {
  value: string;
  onChangeText?: (t: string) => void;
  placeholder?: string;
}

/** 搜索框（胶囊输入）。UI 框架阶段不接搜索逻辑 */
export function SearchBar({ value, onChangeText, placeholder = "搜索声音" }: Props) {
  const isPC = useIsPC();
  return (
    // PC 上限宽 520：超宽视口里全宽输入框会拉成一条长带，fish.audio 同款短搜索框
    <View style={[styles.wrap, isPC && styles.wrapPC]}>
      <Feather name="search" size={16} color={colors.textHelper} />
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.textHelper}
        style={styles.input}
        returnKeyType="search"
        clearButtonMode="while-editing"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    height: 40,
    paddingHorizontal: 14,
    borderRadius: radius.button,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.inputBorderOpaque,
  },
  wrapPC: { width: 520, maxWidth: "100%" },
  input: {
    flex: 1,
    fontFamily: "Lato_400Regular",
    fontSize: 14,
    color: colors.textBody,
    paddingVertical: 0,
    height: 38,
  },
});
