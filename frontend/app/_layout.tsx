import { useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { Stack } from "expo-router";
import { useFonts } from "expo-font";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import {
  Onest_400Regular,
  Onest_500Medium,
  Onest_600SemiBold,
} from "@expo-google-fonts/onest";
import { Lato_400Regular, Lato_700Bold } from "@expo-google-fonts/lato";
import { GeistMono_400Regular, GeistMono_500Medium } from "@expo-google-fonts/geist-mono";
import { colors } from "../src/theme/theme";
import { AppHeader } from "../src/components/AppHeader";
import { SideNav } from "../src/components/SideNav";
import { useIsPC } from "../src/lib/useIsPC";
import { ensureLibraryLoaded } from "../src/data/mock";

const screenOptions = {
  headerShown: false,
  contentStyle: { backgroundColor: colors.background },
} as const;

// PC：顶栏白条 + 内容区纯白，靠发丝线与侧边栏色差分割（对齐 fish.audio）
const pcScreenOptions = {
  ...screenOptions,
  contentStyle: { backgroundColor: colors.surface },
} as const;

export default function RootLayout() {
  const [loaded, error] = useFonts({
    Onest_400Regular,
    Onest_500Medium,
    Onest_600SemiBold,
    Lato_400Regular,
    Lato_700Bold,
    GeistMono_400Regular,
    GeistMono_500Medium,
  });
  // 用户产出（角色/创作记录）存在后端，首屏渲染前先灌进内存，避免闪一下空列表
  const [libReady, setLibReady] = useState(false);
  useEffect(() => {
    if (!loaded && !error) return;
    let alive = true;
    void ensureLibraryLoaded().finally(() => {
      if (alive) setLibReady(true);
    });
    return () => {
      alive = false;
    };
  }, [loaded, error]);

  const isPC = useIsPC();

  if (!loaded && !error) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator color={colors.textDescription} />
      </View>
    );
  }
  if (!libReady) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator color={colors.textDescription} />
      </View>
    );
  }

  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      <View style={styles.app}>
        {isPC ? (
          /* PC：左侧常显竖向导航 + 右侧内容区（无横向 header） */
          <View style={styles.pcShell}>
            <SideNav />
            <View style={styles.pcContent}>
              <Stack screenOptions={pcScreenOptions} />
            </View>
          </View>
        ) : (
          <>
            {/* 手机：全局顶部栏（面包屑 + 下拉功能菜单） */}
            <AppHeader />
            <Stack screenOptions={screenOptions} />
          </>
        )}
      </View>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  app: { flex: 1, backgroundColor: colors.background },
  pcShell: { flex: 1, flexDirection: "row" },
  pcContent: { flex: 1, minWidth: 0 },
  loading: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.background },
});
