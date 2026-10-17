import { useEffect, useRef, useState } from "react";
import { ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { colors, radius, typography } from "../theme/theme";
import type { AvatarProfile } from "../data/types";
import { BottomSheet } from "./BottomSheet";
import { Button } from "./Button";

export interface ProfileDraft {
  /** 形象描述：重新生成候选图时的提示词 */
  prompt: string;
  profile: AvatarProfile;
}

interface Props {
  visible: boolean;
  /** 正在修改哪一张候选（1 起，用于文案） */
  candidateIndex: number;
  /** 当前的形象描述与人物设定，打开时回填 */
  value: ProfileDraft;
  onClose: () => void;
  /** 保存设定并重新生成候选图 */
  onSaveAndRegenerate: (next: ProfileDraft) => void;
}

const MAX_PROMPT = 300;
const MAX_SUMMARY = 80;

/**
 * 修改人物设定弹窗：改完直接保存并重新生成候选图。
 * 生成结果不满意时不用退回第一步，改几个字段就能再来一批。
 */
export function ProfileEditSheet({
  visible,
  candidateIndex,
  value,
  onClose,
  onSaveAndRegenerate,
}: Props) {
  const [prompt, setPrompt] = useState(value.prompt);
  const [summary, setSummary] = useState(value.profile.summary);
  const [ageRange, setAgeRange] = useState(value.profile.ageRange);
  const [personality, setPersonality] = useState(value.profile.personality);
  const [style, setStyle] = useState(value.profile.style);

  // 每次「打开」都按当前设定回填；只在 visible 由 false 变 true 时执行一次，
  // 不能依赖 value（它是每次渲染新建的对象），否则输入一个字就会被重置。
  const latest = useRef(value);
  latest.current = value;
  useEffect(() => {
    if (!visible) return;
    const v = latest.current;
    setPrompt(v.prompt);
    setSummary(v.profile.summary);
    setAgeRange(v.profile.ageRange);
    setPersonality(v.profile.personality);
    setStyle(v.profile.style);
  }, [visible]);

  const draft = (): ProfileDraft => ({
    prompt: prompt.trim(),
    profile: {
      summary: summary.trim(),
      ageRange: ageRange.trim(),
      personality: personality.trim(),
      style: style.trim(),
    },
  });

  return (
    <BottomSheet visible={visible} onClose={onClose} heightRatio={0.86} testID="profile-sheet">
      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        <View style={styles.inner}>
          <View style={styles.head}>
            <Text style={styles.title}>修改人物设定</Text>
            <Text style={styles.subtitle}>
              正在修改「候选 {candidateIndex}」。保存后会沿用新设定重出 3 张候选图。
            </Text>
          </View>

          <View style={styles.field}>
            <Text style={styles.label}>形象描述</Text>
            <View style={styles.textareaWrap}>
              <TextInput
                value={prompt}
                onChangeText={setPrompt}
                multiline
                placeholder="描述想要的形象与气质，重新生成候选图时会用到"
                placeholderTextColor={colors.textHelper}
                style={styles.textarea}
                textAlignVertical="top"
                maxLength={MAX_PROMPT}
                testID="profile-prompt"
              />
              <Text style={styles.counter}>
                {prompt.length}/{MAX_PROMPT}
              </Text>
            </View>
          </View>

          <View style={styles.field}>
            <Text style={styles.label}>年龄段</Text>
            <TextInput
              value={ageRange}
              onChangeText={setAgeRange}
              placeholder="例如：28-34 岁"
              placeholderTextColor={colors.textHelper}
              style={styles.input}
              maxLength={16}
              testID="profile-age"
            />
          </View>

          <View style={styles.field}>
            <Text style={styles.label}>性格</Text>
            <TextInput
              value={personality}
              onChangeText={setPersonality}
              placeholder="例如：沉稳、亲切"
              placeholderTextColor={colors.textHelper}
              style={styles.input}
              maxLength={24}
              testID="profile-personality"
            />
          </View>

          <View style={styles.field}>
            <Text style={styles.label}>风格</Text>
            <TextInput
              value={style}
              onChangeText={setStyle}
              placeholder="例如：知识分享 / 课程"
              placeholderTextColor={colors.textHelper}
              style={styles.input}
              maxLength={24}
              testID="profile-style"
            />
          </View>

          <View style={styles.field}>
            <Text style={styles.label}>人物简介</Text>
            <View style={styles.textareaWrap}>
              <TextInput
                value={summary}
                onChangeText={setSummary}
                multiline
                placeholder="一句话描述这个人物的定位"
                placeholderTextColor={colors.textHelper}
                style={[styles.textarea, styles.textareaShort]}
                textAlignVertical="top"
                maxLength={MAX_SUMMARY}
                testID="profile-summary"
              />
              <Text style={styles.counter}>
                {summary.length}/{MAX_SUMMARY}
              </Text>
            </View>
          </View>

          <Text style={styles.hint}>当前选中的候选图会被替换，另外两张也会一起换新。</Text>
        </View>
      </ScrollView>

      <View style={styles.footer} testID="profile-sheet-footer">
        <View style={styles.footerInner}>
          <Button label="取消" variant="ghost" size="md" testID="profile-cancel" onPress={onClose} />
          <Button
            label="保存并重新生成"
            size="md"
            testID="profile-save-regenerate"
            onPress={() => onSaveAndRegenerate(draft())}
          />
        </View>
      </View>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  scroll: { paddingBottom: 8 },
  inner: {
    width: "100%",
    maxWidth: 640,
    alignSelf: "center",
    paddingHorizontal: 16,
    paddingTop: 14,
    gap: 12,
  },
  head: { gap: 4 },
  title: { ...typography.h3, color: colors.textTitle },
  subtitle: { ...typography.small, color: colors.textDescription },
  field: { gap: 6 },
  label: { ...typography.small, color: colors.textHelper },
  input: {
    height: 42,
    borderRadius: radius.panel,
    borderWidth: 1,
    borderColor: colors.inputBorderOpaque,
    backgroundColor: colors.surface,
    paddingHorizontal: 12,
    fontFamily: "Onest_400Regular",
    fontSize: 15,
    color: colors.textBody,
  },
  textareaWrap: {
    backgroundColor: colors.surface,
    borderRadius: radius.panel,
    borderWidth: 1,
    borderColor: colors.inputBorderOpaque,
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 8,
  },
  textarea: {
    fontFamily: "Lato_400Regular",
    fontSize: 15,
    lineHeight: 22,
    color: colors.textBody,
    minHeight: 72,
    paddingVertical: 0,
  },
  textareaShort: { minHeight: 46 },
  counter: {
    fontFamily: "GeistMono_400Regular",
    fontSize: 11,
    color: colors.textHelper,
    textAlign: "right",
    marginTop: 4,
  },
  hint: { ...typography.small, color: colors.textDescription },
  footer: {
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 16,
    borderTopWidth: 1,
    borderTopColor: colors.landingCardBorder,
  },
  footerInner: {
    width: "100%",
    maxWidth: 640,
    alignSelf: "center",
    flexDirection: "row",
    justifyContent: "flex-end",
    alignItems: "center",
    gap: 10,
  },
});
