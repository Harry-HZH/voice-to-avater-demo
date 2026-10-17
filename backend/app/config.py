"""应用配置。环境变量优先，其次读 backend/.env 与 voice-to-avater-demo/.env。"""

from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BACKEND_DIR / "data"
SAMPLE_DIR = DATA_DIR / "samples"
PORTRAIT_DIR = DATA_DIR / "portraits"
# 创作台词合成出来的音轨（试听与出片共用同一份）
SPEECH_DIR = DATA_DIR / "speech"
# 成片
VIDEO_DIR = DATA_DIR / "videos"
STORE_FILE = DATA_DIR / "store.json"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        # 后写的文件优先级更高；真实密钥放在 voice-to-avater-demo/.env
        env_file=(BACKEND_DIR / ".env", BACKEND_DIR.parent / ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    # --- ThankYou Open API ---
    thank_you_ai_key: str = ""
    thankyou_base_url: str = "https://api.thankyouai.com/open/v1"
    tts_model: str = "fish-audio/text-to-speech"
    # 候选形象：文生图。nano-banana 单张 6 点，便宜且人像质量够用；
    # 想要更好的人像细节可换成 bytedance/seedream/v4.5/text-to-image（10 点/张）。
    portrait_model: str = "google/nano-banana/text-to-image"
    portrait_aspect_ratio: str = "3:4"
    portrait_count: int = 3
    # 三视图补图：同一人物换视角，用参考图 + 文字（image-to-image）
    views_model: str = "google/nano-banana/text-to-image"

    # --- 让角色开口说话：人物图 + 台词音轨 → 会说话的视频 ---
    # 默认 heygen/avatar4/avatar：没有时长参数，成片长度跟着音轨走，
    # 不存在「帧数设少了把台词截断」的风险，而且默认就是 720p（真实计价档）
    # 且支持 9:16 竖屏。换成 infinitalk/avatar 也可以，但它的入参写法不同
    # （音轨的 role 叫 source_audio，且必须给 prompt 和 num_frames），
    # 差异都收敛在 videos.MODEL_SPECS 里。
    speak_model: str = "heygen/avatar4/avatar"
    speak_aspect_ratio: str = "9:16"
    # 只有按帧数出片的模型（infinitalk）才用得上：音轨秒数 → num_frames
    speak_fps: float = 25.0
    # 台词音轨时长上限。视频按秒计费，一条 30 秒就是 600 点，必须在合成前拦住
    speak_max_seconds: int = 30
    # 上游按输出秒数统一计价
    video_resolution: str = "720p"
    video_points_720p: float = 20.0
    video_points_1080p: float = 30.0

    # --- 网络与轮询 ---
    request_timeout: float = 60.0
    poll_interval: float = 2.0
    poll_timeout: float = 300.0
    # 候选形象并发生成数（一张一张排队太慢，一次最多同时跑几个）
    portrait_concurrency: int = 3

    # --- 存储 ---
    mongo_url: str = "mongodb://localhost:27017"
    mongo_db: str = "voice_avatar"
    mongo_timeout_ms: int = 800

    # --- HTTP ---
    cors_origins: str = "*"

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def api_key_configured(self) -> bool:
        return bool(self.thank_you_ai_key.strip())

    @property
    def video_points_per_second(self) -> float:
        """当前分辨率下单秒的点数。上游按输出秒数计费。"""
        return (
            self.video_points_1080p if self.video_resolution == "1080p" else self.video_points_720p
        )

    def speak_points(self, seconds: float | None) -> int | None:
        """一条说话成片的预估点数 = 音轨秒数 × 单秒单价。

        台词多长，成片就多长，所以音轨时长就是计费时长 —— 这是整个功能里
        唯一要提前给用户看清楚的数字。真实扣费以上游按实际输出时长结算为准。
        """
        if not seconds or seconds <= 0:
            return None
        return int(round(seconds * self.video_points_per_second))


settings = Settings()

DATA_DIR.mkdir(parents=True, exist_ok=True)
SAMPLE_DIR.mkdir(parents=True, exist_ok=True)
PORTRAIT_DIR.mkdir(parents=True, exist_ok=True)
SPEECH_DIR.mkdir(parents=True, exist_ok=True)
VIDEO_DIR.mkdir(parents=True, exist_ok=True)
