/** 与 INTERVIEW.md 第 4 节建议的数据格式保持一致（Avatar 增加三视图字段，见 README 说明） */

export interface Voice {
  id: string;
  name: string;
  language: string;
  tags: string[];
  description: string;
  /** 试听音源地址。来自后端时是真实人声 mp3（/api/voices/{id}/sample） */
  sample_url: string;
  owner: string;

  /* ---------- 后端扩展字段（本地 mock 数据没有这些字段） ---------- */
  /** 声音来源：seed=内置人设，catalog=从 ThankYou 音色目录导入 */
  source?: "seed" | "catalog";
  /** 底层真实音色 id（Fish Audio），生成语音时使用 */
  provider_voice_id?: string | null;
  provider?: string | null;
  /** 试听音源是否已就绪；false 时后端会在后台生成，前端需等待 */
  sample_ready?: boolean;
  /** 声音头像（按人设定制的生成图，后端相对地址，展示前过 absUrl()）；没有就用水彩占位 */
  avatar_url?: string | null;
}

export interface AvatarProfile {
  summary: string;
  ageRange: string;
  personality: string;
  style: string;
}

/** 形象的三视图：正面（主图）/ 侧面 / 背面 */
export type AvatarView = "front" | "side" | "back";

export const AVATAR_VIEWS: { key: AvatarView; label: string }[] = [
  { key: "front", label: "正面" },
  { key: "side", label: "侧面" },
  { key: "back", label: "背面" },
];

/**
 * 三视图地址表：键的存在即表示该视图已生成；值为图片地址，UI 阶段为 null（水彩占位图）。
 * 侧面/背面可以在创建时补充，也可以后续在 Avatar 详情页随时生成。
 */
export type AvatarViews = Partial<Record<AvatarView, string | null>>;

export interface Avatar {
  id: string;
  name: string;
  voice_id: string;
  views: AvatarViews;
  source: "generated" | "uploaded";
  prompt: string;
  profile: AvatarProfile;
  created_at: string;
  /**
   * 生成这个形象时用的候选任务与选中的那张（仅 source = "generated" 且有真实生成时有值）。
   * 后面想补侧面 / 背面、或者让这个角色开口说话，靠它能回到上游那张图作参考，
   * 保证还是同一个人。
   */
  source_job_id?: string;
  source_index?: number;
}

export type JobStatus = "queued" | "running" | "succeeded" | "failed";
/**
 * portrait：候选形象 / 三视图；tts：合成试听音频；
 * speak：让角色开口说话（人物图 + 台词音轨 → 会说话的视频）—— 创作主线。
 *
 * 早期的 `creation`（口播编排）类型已整个删除：它对应的那套玩法不存在了，
 * 留着只会在任务中心里出现点不开的死条目。
 */
export type JobType = "portrait" | "speak" | "tts";

export interface JobError {
  code: string;
  message: string;
}

export interface Job {
  id: string;
  type: JobType;
  status: JobStatus;
  /** 生成进度 0-100，仅 queued / running 阶段有意义（真实环境由后端返回） */
  progress?: number;
  /**
   * 当前阶段名（如「合成台词」「让角色开口」）。
   * 视频要跑好几分钟，光有百分比用户不知道卡在哪一步。
   */
  stage?: string | null;
  input: {
    voice_id?: string;
    /** 后端补充：声音名字，用于任务卡展示 */
    voice_name?: string;
    avatar_id?: string;
    /** 角色名字，用于任务卡展示（后端不认识 avatar，所以由前端传过来） */
    avatar_name?: string;
    prompt?: string;
    text?: string;
    /** 角色要说的话（speak 任务） */
    script?: string;
    count?: number;
    /** 候选形象任务的细分类型：candidates=出候选图，views=补三视图 */
    kind?: "candidates" | "views";
    /** 第几批（「换一批候选图」时 +1，决定随机种子） */
    variant?: number;
    /** speak / 补三视图：形象图是这条任务里的第几张 */
    source_index?: number;
    /** speak / 补三视图：形象图来自哪条任务 */
    source_job_id?: string;
    views?: string[];
    /** 本次生成预计消耗的点数（后端估价） */
    estimated_points?: number | null;
    /** speak：台词音轨时长（秒）。视频按秒计费，这个数直接决定花多少 */
    duration?: number | null;
    /** speak：画面比例（9:16 竖屏 / 16:9 横屏） */
    aspect_ratio?: string;
    /** 输出清晰度（720p / 1080p） */
    resolution?: string;
    /** speak：实际调用的上游模型 */
    model?: string;
  };
  output: {
    image_urls?: (string | null)[];
    /** 三视图：view key → 图片地址 */
    view_urls?: Record<string, string>;
    /** speak：成片地址（本后端 /api/jobs/{id}/video） */
    video_url?: string | null;
    /**
     * 后端产出的音频地址，可直接播放。
     *   - type=tts：合成出来的语音；
     *   - type=speak：成片的台词音轨（可单独听）。
     * 只有这一个名字 —— 后端不会给 `voice_url`，别照着直觉再写一个（踩过）。
     */
    audio_url?: string | null;
    /** 上游原始产物地址（调试用） */
    provider_url?: string;
    provider_urls?: (string | null)[];
    /** speak：上游成片地址（我们本地缓存失败时的兜底） */
    provider_video_url?: string | null;
    /** speak：成片是否已落到本后端（false 说明只能走上游地址） */
    local_cached?: boolean;
    count?: number;
    model?: string;
    estimated_points?: number | null;
    /** speak：台词音轨时长（秒）—— 也就是计费时长 */
    duration?: number | null;
    /** speak：成片本身的时长（秒），由本地 mp4 读出来 */
    output_duration?: number | null;
    resolution?: string;
    aspect_ratio?: string;
  } | null;
  error: JobError | null;
  created_at: string;
  updated_at: string;
}

/* ---------- 创作（让角色开口说话） ---------- */

/**
 * 玩法。现在只有一种：让角色开口说话 —— 拿着角色的形象和音色，把一段台词说成视频。
 *
 * 收敛成单一类型是有意的：「选类型 → 编排动画 → 预览」那套向导对这件事是多余的。
 * 用户要的东西只有两样 —— 一张脸（已经做好了）和一句话（用户自己写）。
 */
export type CreationType = "speak";

export interface Creation {
  id: string;
  avatar_id: string;
  type: CreationType;
  title: string;
  /** 角色说的台词 */
  script: string;
  created_at: string;
  updated_at: string;

  /** 成片地址（本后端 /api/jobs/{id}/video） */
  video_url?: string | null;
  /** 成片的台词音轨，可单独听 */
  voice_url?: string | null;
  /** 角色形象图（列表与预览的封面） */
  cover_url?: string | null;
  /** 产出这条成片的任务 id，重新生成 / 查看进度都靠它 */
  job_id?: string;
  /** 成片时长（秒） */
  duration?: number | null;
  /** 这次生成消耗的点数 */
  points?: number | null;
}
