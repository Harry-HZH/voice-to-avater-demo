"""对外数据契约。字段与 INTERVIEW.md 第 4 节的建议格式对齐，扩展字段均已注释说明。"""

from typing import Any, Literal

from pydantic import BaseModel, Field

JobStatus = Literal["queued", "running", "succeeded", "failed"]
# portrait=候选形象/三视图，tts=试听音轨，speak=让角色开口说话（人物图 + 台词音轨 → 视频）
JobType = Literal["portrait", "speak", "tts"]


class Voice(BaseModel):
    """声音。在 INTERVIEW.md 建议字段之外，补充了绑定信息与音源可用性。"""

    id: str
    name: str
    language: str
    tags: list[str] = Field(default_factory=list)
    description: str = ""
    # 试听音频地址。指向本后端的 /api/voices/{id}/sample，是真实可播放的人声
    sample_url: str = ""
    owner: str = "me"

    # --- 扩展字段 ---
    # 声音的来源：seed=内置人设，catalog=从 ThankYou 音色目录导入
    source: Literal["seed", "catalog"] = "seed"
    # 底层真实音色 id（Fish Audio），生成语音时使用
    provider_voice_id: str | None = None
    provider: str | None = None
    # 试听音频是否已就绪（未就绪时 sample_url 会 202，前端可轮询或稍后重试）
    sample_ready: bool = False


class VoicePreviewRequest(BaseModel):
    text: str = Field(min_length=1, max_length=2000)


class JobError(BaseModel):
    code: str
    message: str


class Job(BaseModel):
    id: str
    type: JobType
    status: JobStatus
    # 生成进度 0-100，仅 queued / running 阶段有意义（前端任务卡与生成页都用它显示进度）
    progress: float | None = None
    # 当前阶段的中文名（如「合成台词」「让角色开口」）。
    # 视频要跑好几分钟，光有百分比用户不知道卡在哪一步。
    stage: str | None = None
    input: dict[str, Any] = Field(default_factory=dict)
    output: dict[str, Any] | None = None
    error: JobError | None = None
    created_at: str
    updated_at: str


class ErrorBody(BaseModel):
    error: JobError


class HealthOut(BaseModel):
    status: str
    store_backend: str
    api_key_configured: bool
    voices_total: int
    samples_ready: int


class ImportVoiceRequest(BaseModel):
    """从 ThankYou 音色目录导入一个音色到我的声音库。"""

    provider_voice_id: str
    name: str | None = None
    language: str | None = None
    description: str | None = None
    tags: list[str] | None = None


class PortraitJobRequest(BaseModel):
    """提交一次候选形象生成。"""

    voice_id: str = Field(min_length=1, max_length=64)
    prompt: str = Field(default="", max_length=1000)
    count: int | None = Field(default=None, ge=1, le=6)
    # 第几批：同一个提示词想换一批新图时 +1（会清掉上一批的缓存重新生成）
    variant: int = Field(default=0, ge=0, le=9999)


class ViewsJobRequest(BaseModel):
    """用选定的候选图补侧面 / 背面。

    两种用法：
      1. 给 job_id + index —— 参考图从这条候选任务里取（创建流程走这条）；
      2. 只给 reference_url —— 保存过的形象后来想补视图，前端手里只有参考图地址（编辑页走这条）。
    """

    job_id: str | None = None
    index: int = Field(default=0, ge=0, le=5)
    views: list[str] | None = None
    # 可选：直接给参考图地址（默认从 source job 的 provider_urls 里取）
    reference_url: str | None = None
    # 无 job_id 时用来记录出处：这个形象属于哪个声音 / 当初的提示词是什么
    voice_id: str | None = None
    prompt: str | None = None


class RetryPortraitRequest(BaseModel):
    """重试 / 换一批。都不传就是原地重试（已成功的图会复用）。"""

    prompt: str | None = Field(default=None, max_length=1000)
    count: int | None = Field(default=None, ge=1, le=6)
    variant: int | None = Field(default=None, ge=0, le=9999)


class SpeakPreviewRequest(BaseModel):
    """先试听：只合成台词音轨（约 1.5 点），拿到真实秒数再决定要不要出片。

    视频按输出秒数计费（720p 20 点/秒），是 TTS 的上百倍 —— 所以这一步存在的
    唯一目的就是让「要花多少钱」变成算出来的数字，而不是点完之后才知道的账。
    """

    voice_id: str = Field(min_length=1, max_length=64)
    script: str = Field(min_length=1, max_length=1000)


class SpeakRequest(BaseModel):
    """让角色开口说话：人物图 + 台词音轨 → 会说话的视频。

    形象图的来源有两种，二选一：
      1. source_job_id + source_index —— 取那条候选形象任务里选中的那张（正常路径）；
      2. image_url —— 直接给一张图片地址（上游可访问的 http(s) 地址，或本后端的图片路径）。
    """

    voice_id: str = Field(min_length=1, max_length=64)
    script: str = Field(min_length=1, max_length=1000)

    source_job_id: str | None = None
    source_index: int = Field(default=0, ge=0, le=5)
    image_url: str | None = None

    # 竖屏 / 横屏。不传就用默认（settings.speak_aspect_ratio）
    aspect_ratio: str | None = None

    # --- 仅用于记录与前端展示，不参与生成 ---
    avatar_id: str | None = None
    avatar_name: str | None = None
    # 试听时记下的秒数，用于回显；真实值由后端从音轨重新读一遍
    duration: float | None = Field(default=None, ge=0, le=600)
