"""声音库种子：20 个人设，以及它们绑定的真实音色。

为什么要「绑定」：
    seed/voices.json 里 20 个声音是**产品人设**（Aria、Mei、Yui…），
    它们的 sample_url 是占位音乐地址，本身没有真实音源。
    ThankYou 的 /open/v1/voices 提供 1000 个真实 Fish Audio 音色（带 voice_id），
    用这些 voice_id 调 fish-audio/text-to-speech 就能生成真实人声。

    于是这里做一次映射：人设 → 真实 voice_id（按语言 + 性别 + 音色挑选），
    这样既保留了产品叙事（精选声音库），又让每个声音都有真实可播的音源。

挑选依据：音色目录里的 name / languages 字段（如「央视配音」→ 男声新闻、
    「落ち着いた男性」→ 日文沉稳男声、「Voz Femenina Español」→ 西语女声）。
    每个声音都带若干候选，主音色失效时自动降级，见 samples.py。
"""

from dataclasses import dataclass, field

# 各语言的试听句模板（用该人设自己的声音念出来）
SAMPLE_TEXT: dict[str, str] = {
    "en": "Hi, I'm {name}. This is a sample of my voice — pick me and let's create your avatar.",
    "zh": "你好，我是{name}。这是我的声音试听，选我就可以开始创建你的数字形象。",
    "ja": "こんにちは、{name}です。これは私の声のサンプルです。",
    "es": "Hola, soy {name}. Esta es una muestra de mi voz.",
    "fr": "Bonjour, je suis {name}. Voici un aperçu de ma voix.",
    "de": "Hallo, ich bin {name}. Das ist eine Hörprobe meiner Stimme.",
    "ko": "안녕하세요, {name}입니다. 제 목소리 샘플입니다.",
    "pt": "Olá, eu sou {name}. Esta é uma amostra da minha voz.",
}


@dataclass(frozen=True)
class PersonaVoice:
    id: str
    name: str
    language: str
    tags: tuple[str, ...]
    description: str
    owner: str
    provider_voice_id: str
    provider_voice_name: str
    fallbacks: tuple[str, ...] = field(default_factory=tuple)

    def sample_text(self) -> str:
        tpl = SAMPLE_TEXT.get(self.language, SAMPLE_TEXT["en"])
        return tpl.format(name=self.name)


# 20 个声音：8 种语言
SEED_VOICES: tuple[PersonaVoice, ...] = (
    # ---------- English ----------
    PersonaVoice(
        "voice_001", "Aria", "en", ("female", "warm", "narration"),
        "A warm female voice for storytelling and audiobooks.", "me",
        "933563129e564b19a115bedd57b7406a", "Sarah",
        ("e9b134e4c0b547a3894793be502314f1", "711cf3ed00ab441a8f54a45058047b7a"),
    ),
    PersonaVoice(
        "voice_002", "Max", "en", ("male", "deep", "documentary"),
        "A deep male voice with a calm documentary tone.", "me",
        "536d3a5e000945adb7038665781a4aca", "Ethan",
        ("bf322df2096a46f18c579d0baa36f41d", "f48d143a59a946ab87c0130fd081f349"),
    ),
    PersonaVoice(
        "voice_003", "Luna", "en", ("female", "bright", "advertising"),
        "A bright, upbeat female voice for product ads.", "me",
        "b545c585f631496c914815291da4e893", "Friendly Women",
        ("98655a12fa944e26b274c535e5e03842", "933563129e564b19a115bedd57b7406a"),
    ),
    PersonaVoice(
        "voice_004", "Kai", "en", ("male", "energetic", "gaming"),
        "An energetic young male voice for game streaming.", "me",
        "802e3bc2b27e49c2995d23ef70e6ac89", "Energetic Male",
        ("c5f56a6cc2ec4fa8920cb4c5889a3fb7", "536d3a5e000945adb7038665781a4aca"),
    ),
    PersonaVoice(
        "voice_019", "Nora", "en", ("female", "calm", "meditation"),
        "A calm, soothing voice for meditation and sleep.", "me",
        "e9b134e4c0b547a3894793be502314f1", "Jasphina",
        ("8d21b053e2804e2a890e1cf62f267b6f", "933563129e564b19a115bedd57b7406a"),
    ),
    PersonaVoice(
        "voice_020", "Theo", "en", ("male", "playful", "character"),
        "A playful male voice for cartoon characters.", "me",
        "f48d143a59a946ab87c0130fd081f349", "Polo",
        ("9259a7392c454a1eb6436141abb5a558", "536d3a5e000945adb7038665781a4aca"),
    ),
    # ---------- 中文 ----------
    PersonaVoice(
        "voice_005", "Mei", "zh", ("female", "soft", "assistant"),
        "温柔的女声，适合智能助手和客服。", "me",
        "5c353fdb312f4888836a9a5680099ef0", "女大学生",
        ("57eab548c7ed4ddc974c4c153cb015b2", "b7f6ea6bf21246de894f6b9b499add43"),
    ),
    PersonaVoice(
        "voice_006", "Hao", "zh", ("male", "steady", "news"),
        "沉稳的男声，适合新闻播报。", "me",
        "59cb5986671546eaa6ca8ae6f29f6d22", "央视配音",
        ("6fc59d2b56cf402eb572934114c8d8aa", "21082ac382d945e29aea354e90380f11"),
    ),
    # ---------- 日本語 ----------
    PersonaVoice(
        "voice_007", "Yui", "ja", ("female", "cute", "anime"),
        "明るくて可愛い女性の声。アニメやゲーム向け。", "me",
        "5161d41404314212af1254556477c17d", "元気な女性",
        ("46745543e52548238593a3962be77e3a", "63bc41e652214372b15d9416a30a60b4"),
    ),
    PersonaVoice(
        "voice_008", "Ren", "ja", ("male", "calm", "narration"),
        "落ち着いた男性の声。ナレーション向け。", "me",
        "45c5d3723c9c42f598e4776dcfd5f02d", "落ち着いた男性",
        ("297a6fd278df47c3b9da9bfdf55ac89a", "bb3bf6a073cb48c1a5b6c436053ce243"),
    ),
    # ---------- Español ----------
    PersonaVoice(
        "voice_009", "Sofia", "es", ("female", "warm", "advertising"),
        "Voz femenina cálida para anuncios y promociones.", "me",
        "bfed5c0810a347dbb62e8ccce7f59c48", "Voz Femenina Español",
        ("35929683c49c4ec0bf779dc07d22620b", "a288bdc744da4ad194921adad6863175"),
    ),
    PersonaVoice(
        "voice_010", "Diego", "es", ("male", "raspy", "character"),
        "Voz masculina ronca para personajes y juegos.", "me",
        "3f45a7fd7a614655a61eb7027b955783", "voz de locutor k",
        ("a1fe2e1b6f324e27929d5088f2d09be3", "dfa5b230c8054f429e434f4a6e9bbdec"),
    ),
    # ---------- Français ----------
    PersonaVoice(
        "voice_011", "Chloe", "fr", ("female", "elegant", "audiobook"),
        "Une voix féminine élégante pour les livres audio.", "me",
        "a288bdc744da4ad194921adad6863175", "Clémence",
        ("5567200c7d8341738f0892bbacd3be3c", "690813f2df56491b82ee02a22d1c67fd"),
    ),
    PersonaVoice(
        "voice_012", "Louis", "fr", ("male", "smooth", "podcast"),
        "Une voix masculine douce pour les podcasts.", "me",
        "d704cf8f1216490cbfbed89955f0e938", "Arnold",
        ("9f0935a47689459480b820ed3f6d782d", "4f2a0684dd0247dda68f339738c780e6"),
    ),
    # ---------- Deutsch ----------
    PersonaVoice(
        "voice_013", "Hanna", "de", ("female", "clear", "education"),
        "Eine klare weibliche Stimme für Lerninhalte.", "me",
        "88b18e0d81474a0ca08e2ea6f9df5ff4", "Christa deutsch",
        ("c5b66a80d90749fc914c714e793d1a2f", "04774c638cfe4b40bccee5d8ddada7c9"),
    ),
    PersonaVoice(
        "voice_014", "Jonas", "de", ("male", "friendly", "assistant"),
        "Eine freundliche männliche Stimme für Assistenten.", "me",
        "71c095ed4c03459fb98500db63b88fbe", "Rainer Drachenlord",
        ("90042f762dbf49baa2e7776d011eee6b", "2fc4d003fe8544c4bf8c8b68b70bc2a6"),
    ),
    # ---------- 한국어 ----------
    PersonaVoice(
        "voice_015", "Ji-woo", "ko", ("female", "fresh", "vlog"),
        "산뜻한 여성 목소리. 브이로그와 SNS 영상에 적합.", "me",
        "4e118bfbb83e401c84699c09b5f08257", "20대 여자_나긋나긋 쇼츠",
        ("8cf5ee4cb0224c109852a206f185a05f",),
    ),
    PersonaVoice(
        "voice_016", "Min-jun", "ko", ("female", "bold", "trailer"),
        "힘 있는 여성 목소리. 예고편과 광고에 적합.", "me",
        "1dc6c2dc086b48c4b2a7f943401059b6", "announcer Super Smash Bros",
        ("8cf5ee4cb0224c109852a206f185a05f",),
    ),
    # ---------- Português ----------
    PersonaVoice(
        "voice_017", "Ana", "pt", ("female", "lively", "ecommerce"),
        "Voz feminina animada para vídeos de e-commerce.", "me",
        "5661bf8cb97740fcb10d2f756abf7779", "Isabela",
        ("97630cc4349d4a169bf242b8c819081c", "ca2ded615b7243629317ef7c804c6e56"),
    ),
    PersonaVoice(
        "voice_018", "Rafael", "pt", ("male", "warm", "storytelling"),
        "Voz masculina calorosa para contar histórias.", "me",
        "04736e4d6a644abab81e601a7d2ae4b9", "Waldo Morais",
        ("df1fa6d2ae194b3ebcbae60df48fde35", "2fcea8b2e83540fab786983017af01af"),
    ),
)

BY_ID: dict[str, PersonaVoice] = {v.id: v for v in SEED_VOICES}
