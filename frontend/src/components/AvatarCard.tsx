import { useEffect, useState } from "react";
import { Pressable, StyleSheet } from "react-native";
import type { Avatar, Voice } from "../data/types";
import { subscribeData } from "../data/mock";
import { AvatarCardView } from "./AvatarCardView";
import { AvatarActionSheet } from "./AvatarActionSheet";

interface Props {
  avatar: Avatar;
  voice?: Voice;
}

/**
 * Avatar 角色卡片：可视部分见 AvatarCardView（人像撑满 + 底部蒙层 + 名称/声音/三视图）。
 * 点击卡片弹出操作面板（查看生成内容 / 创作 / 编辑角色信息）。
 */
export function AvatarCard({ avatar, voice }: Props) {
  const [sheetOpen, setSheetOpen] = useState(false);
  const [hover, setHover] = useState(false);

  // 数据变更（如编辑角色信息）后刷新卡片展示
  const [, forceUpdate] = useState(0);
  useEffect(() => subscribeData(() => forceUpdate((x) => x + 1)), []);

  return (
    <>
      <Pressable
        onPress={() => setSheetOpen(true)}
        testID={`avatar-card-${avatar.id}`}
        onHoverIn={() => setHover(true)}
        onHoverOut={() => setHover(false)}
        style={({ pressed }) => [hover && styles.hover, pressed && styles.pressed]}
      >
        <AvatarCardView avatar={avatar} voice={voice} />
      </Pressable>

      <AvatarActionSheet
        avatar={avatar}
        voice={voice}
        visible={sheetOpen}
        onClose={() => setSheetOpen(false)}
      />
    </>
  );
}

const styles = StyleSheet.create({
  pressed: { opacity: 0.92 },
  // web 悬停：轻微抬升
  hover: { boxShadow: "0 8px 20px 0 rgba(0, 0, 0, 0.10)" },
});
