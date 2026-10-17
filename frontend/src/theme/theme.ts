/**
 * fish.audio 设计主题（React Native 版）
 * 来源：design/theme.ts + fish.audio 线上实测补充（2026-10）
 * 颜色里的 8 位十六进制是 #RRGGBBAA（最后两位是透明度）。
 */

export const colors = {
  // 背景和表面
  background: "#fbfaf9", // 页面背景（暖白）
  backgroundMedium: "#f6f0ec", // 次级区域背景
  surface: "#ffffff", // 卡片、弹层
  landingCard: "#f4eeeb", // 落地页/展示卡片底（实测补充）
  landingCardBorder: "rgba(0, 0, 0, 0.05)", // 展示卡片边框

  // 文字
  textTitle: "#161616",
  textBody: "#1d1d1c",
  textSubtitle: "#554e4c",
  textDescription: "#7a6f6b",
  textHelper: "#9f928e",
  textDisabled: "#c4b7b4",
  textInvert: "#ffffff",

  // 边框和填充
  border: "#551a0027",
  borderLight: "#60200010",
  inputBorderOpaque: "#d1cecc",
  fillDefault: "#60200010",
  fillMedium: "#661f0019",

  // 主按钮（黑色胶囊）
  actionPrimaryBg: "#1d1d1c",
  actionPrimaryBgHover: "#333130",
  actionPrimaryBgDisabled: "#dcd2ce",
  actionPrimaryFg: "#ffffff",

  // 次按钮（浅色填充）
  actionSecondaryBg: "#60200010",
  actionSecondaryFg: "#161616",

  // 强调色（品牌）
  brand: "#f56138", // 珊瑚色
  brandHover: "#e0522b",
  brandFaint: "#402220",

  // 状态
  danger: "#f54b45",
  dangerBackground: "#ffefeb",
  success: "#00b489",
  successBackground: "#ebf9f6",
  info: "#027fff",
  warning: "#ff8e1d",

  // 可视化频谱色（波形 / 音频动效专用）
  spectrum: [
    "#9433ff",
    "#3380ff",
    "#00d9ff",
    "#1af2b2",
    "#80ff33",
    "#ffb200",
    "#ff3399",
  ],

  // 水彩 pastel 三原色组（候选图 / 头像占位，模拟 fish.audio 水彩晕染封面）
  watercolor: [
    ["#e9ddf6", "#f6dce9", "#dce7f7"],
    ["#f7e3d9", "#f6dcd9", "#e7f0e3"],
    ["#ddeef6", "#e3f6e9", "#f6f3dc"],
    ["#f6e3ee", "#e3e6f7", "#f6ecdc"],
    ["#e6f0e3", "#f0e6f6", "#e3eef0"],
    ["#f7ecd9", "#f6dce0", "#e0eef7"],
  ],
} as const;

export const fonts = {
  heading: "Onest", // 标题、按钮、标签
  body: "Lato", // 正文
  mono: "Geist Mono", // 代码
} as const;

export const radius = {
  button: 9999, // 按钮是胶囊形
  card: 8, // 设计变量 radius-lg = 0.5rem
  input: 8,
  panel: 16, // 面板（实测补充）
  hero: 24, // 大卡片（实测补充）
} as const;

// 阴影很轻。Web 用 boxShadow，原生用 elevation。
export const shadows = {
  card: {
    boxShadow: "0 2px 8px 0 rgba(0, 0, 0, 0.02)",
    elevation: 1,
  },
  default: {
    boxShadow: "0 1px 3px 0 rgba(0, 0, 0, 0.04)",
    elevation: 1,
  },
  popover: {
    boxShadow: "0 12px 24px -4px rgba(0, 0, 0, 0.06), 0 0 1px 0 rgba(0, 0, 0, 0.1)",
    elevation: 8,
  },
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

/** 排版尺度（实测：H1 = 48px / 52px 行高 / 400 轻字重） */
export const typography = {
  h1: { fontSize: 48, lineHeight: 52, fontWeight: "400" as const },
  h2: { fontSize: 28, lineHeight: 34, fontWeight: "400" as const },
  h3: { fontSize: 20, lineHeight: 26, fontWeight: "500" as const },
  title: { fontSize: 17, lineHeight: 24, fontWeight: "500" as const },
  body: { fontSize: 15, lineHeight: 22, fontWeight: "400" as const },
  caption: { fontSize: 13, lineHeight: 18, fontWeight: "400" as const },
  small: { fontSize: 12, lineHeight: 16, fontWeight: "400" as const },
} as const;
