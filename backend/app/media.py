"""媒体时长探测（纯 Python，不依赖 ffprobe）。

为什么必须自己读时长：说话视频**按输出秒数计费**（720p 20 点/秒）。台词 30 秒
就是 600 点，所以「这条要花多少钱」完全取决于音频有多长，必须在用户点「生成」
之前就把数字摊开给他看。本机没装 ffmpeg，部署时也不该依赖外部二进制，
所以这里直接解析容器格式。

  - `mp4_duration`：读 moov/mvhd box。用于量我们自己生成出来的成片；
  - `mp3_duration`：读第一个帧头拿码率，配合 Xing/Info 头能精确算帧数。

读不出来一律返回 None —— 上层按「不知道时长」处理（不给估价），绝不瞎猜一个
数字去糊弄用户。
"""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import BinaryIO, Iterator

log = logging.getLogger("media")


# ---------- 图片真实类型 ----------

# (魔数, MIME, 扩展名)。顺序无关，前缀互不重叠。
_IMAGE_SIGNATURES: tuple[tuple[bytes, str, str], ...] = (
    (b"\x89PNG\r\n\x1a\n", "image/png", ".png"),
    (b"\xff\xd8\xff", "image/jpeg", ".jpg"),
    (b"GIF87a", "image/gif", ".gif"),
    (b"GIF89a", "image/gif", ".gif"),
    (b"BM", "image/bmp", ".bmp"),
)


def image_content_type(path: Path) -> str:
    """按**内容**判断图片类型，不看扩展名。

    踩过的坑：上游文生图返回的是 PNG，我们却统一按 `{job}_{i}.jpg` 存、并且按
    `image/jpeg` 声明。把 PNG 字节说成 JPEG 传给模型，换来的是
    「The parameter combination is not supported.」——报错和真实原因差了十万八千里。
    浏览器会 sniff，所以这个谎一直不痛不痒；一旦要去调别的服务就原形毕露。

    认不出来就退回 application/octet-stream，让调用方自己决定（不猜 jpeg）。
    """
    try:
        head = Path(path).read_bytes()[:16]
    except OSError:  # pragma: no cover - 读不到就没什么可判断的
        return "application/octet-stream"

    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "image/webp"
    for magic, mime, _ext in _IMAGE_SIGNATURES:
        if head.startswith(magic):
            return mime
    return "application/octet-stream"


def image_extension(path: Path) -> str:
    """按内容给出正确的扩展名（认不出就沿用原扩展名）。"""
    try:
        head = Path(path).read_bytes()[:16]
    except OSError:  # pragma: no cover
        return Path(path).suffix or ".bin"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return ".webp"
    for magic, _mime, ext in _IMAGE_SIGNATURES:
        if head.startswith(magic):
            return ext
    return Path(path).suffix or ".bin"


# ---------- MP4 ----------


def _iter_boxes(fh: BinaryIO, end: int) -> Iterator[tuple[bytes, int, int]]:
    """遍历 MP4 的 box。产出 (类型, 内容起点, 结束位置)。

    box = size(4, big-endian) + type(4) + payload。size == 1 表示真正的长度在紧随其后的
    8 字节里（64 位）；size == 0 表示这个 box 一直延伸到文件末尾。
    """
    while fh.tell() < end:
        start = fh.tell()
        header = fh.read(8)
        if len(header) < 8:
            return
        size = int.from_bytes(header[:4], "big")
        box_type = header[4:8]
        head_size = 8
        if size == 1:
            ext = fh.read(8)
            if len(ext) < 8:
                return
            size = int.from_bytes(ext, "big")
            head_size = 16
        elif size == 0:
            size = end - start
        if size < head_size or start + size > end:
            return
        yield box_type, start + head_size, start + size
        fh.seek(start + size)


def mp4_duration(path: Path) -> float | None:
    """读 MP4 时长（秒）。读不出来返回 None。"""
    try:
        with Path(path).open("rb") as fh:
            fh.seek(0, os.SEEK_END)
            total = fh.tell()
            fh.seek(0)
            for box_type, body, box_end in _iter_boxes(fh, total):
                if box_type != b"moov":
                    continue
                fh.seek(body)
                for inner, inner_body, _ in _iter_boxes(fh, box_end):
                    if inner != b"mvhd":
                        continue
                    fh.seek(inner_body)
                    raw = fh.read(32)
                    if len(raw) < 20:
                        return None
                    if raw[0] == 1:  # version 1：时间字段是 64 位
                        timescale = int.from_bytes(raw[20:24], "big")
                        duration = int.from_bytes(raw[24:32], "big")
                    else:  # version 0：32 位
                        timescale = int.from_bytes(raw[12:16], "big")
                        duration = int.from_bytes(raw[16:20], "big")
                    if not timescale:
                        return None
                    return round(duration / timescale, 2)
    except OSError:
        return None
    return None


# ---------- MP3 ----------

# MPEG-1 Layer III 的码率表（kbps），索引就是帧头里的 4 位码率下标
_BITRATES_V1_L3 = (0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0)
_BITRATES_V2_L3 = (0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0)
_SAMPLE_RATES = {3: (44100, 48000, 32000), 2: (22050, 24000, 16000), 0: (11025, 12000, 8000)}


def _parse_frame_header(raw: bytes) -> tuple[int, int, int, str] | None:
    """解析 4 字节帧头，返回 (码率bps, 采样率, 每帧样本数, 版本层信息)。"""
    if len(raw) < 4 or raw[0] != 0xFF or (raw[1] & 0xE0) != 0xE0:
        return None
    version_bits = (raw[1] >> 3) & 0x03  # 3=MPEG1, 2=MPEG2, 0=MPEG2.5
    layer_bits = (raw[1] >> 1) & 0x03  # 1 = Layer III
    if version_bits == 1 or layer_bits == 0:
        return None
    bitrate_idx = (raw[2] >> 4) & 0x0F
    rate_idx = (raw[2] >> 2) & 0x03
    if rate_idx == 3:
        return None
    sample_rate = _SAMPLE_RATES.get(version_bits, (44100,))[rate_idx]
    table = _BITRATES_V1_L3 if version_bits == 3 else _BITRATES_V2_L3
    bitrate = table[bitrate_idx] * 1000
    if not bitrate:
        return None
    samples = 1152 if version_bits == 3 else 576
    return bitrate, sample_rate, samples, ""


def _xing_frames(data: bytes, offset: int) -> int | None:
    """Xing/Info 头里有精确帧数，读到就不必再靠码率估算。"""
    for tag in (b"Xing", b"Info"):
        idx = data.find(tag, offset, offset + 512)
        if idx == -1:
            continue
        flags = int.from_bytes(data[idx + 4 : idx + 8], "big")
        if flags & 0x0001:  # 第 0 位表示「有帧数字段」
            return int.from_bytes(data[idx + 8 : idx + 12], "big")
    return None


def mp3_duration(path: Path) -> float | None:
    """读 MP3 时长（秒）。优先用 Xing 帧数，退回按码率估算。"""
    try:
        with Path(path).open("rb") as fh:
            head = fh.read(65536)
    except OSError:
        return None
    if not head:
        return None

    # 找第一个真正的帧头。文件开头可能有 ID3v2 标签，所以要跳过它。
    offset = 0
    if head[:3] == b"ID3" and len(head) >= 10:
        size = ((head[6] & 0x7F) << 21) | ((head[7] & 0x7F) << 14) | ((head[8] & 0x7F) << 7) | (head[9] & 0x7F)
        offset = 10 + size

    parsed = None
    for i in range(offset, min(len(head) - 4, offset + 8192)):
        parsed = _parse_frame_header(head[i : i + 4])
        if parsed:
            offset = i
            break
    if not parsed:
        return None

    bitrate, sample_rate, samples, _ = parsed

    frames = _xing_frames(head, offset)
    if frames:
        return round(frames * samples / sample_rate, 2)

    # 没有 Xing 头：按恒定码率估算整段时长
    size = path.stat().st_size - offset
    return round(size * 8 / bitrate, 2)


def probe_duration(path: Path) -> float | None:
    """按后缀挑解析器。读不出来返回 None。"""
    suffix = Path(path).suffix.lower()
    if suffix in {".mp4", ".m4v", ".mov"}:
        return mp4_duration(path)
    if suffix == ".mp3":
        return mp3_duration(path)
    return None
