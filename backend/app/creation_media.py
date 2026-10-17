"""媒体快照：把引用任务产物的数据拷进自己的目录，与任务记录解耦。

任务记录（连同产物缓存）随时可能被删，删任务不能影响还在引用这些文件的
数据。目前覆盖三类：

1. 创作条目 → `data/creations/{creation_id}/`，
   URL 重写为 `/api/creation-media/{id}/{file}`；
2. 声音头像（voice_avatars 集合）→ `data/voice-media/{voice_id}/`，
   URL 重写为 `/api/voice-media/{voice_id}/{file}`；
3. 角色三视图（created_avatars 的 views / avatar_patches 的 views）→
   `data/avatar-media/{avatar_id}/`，URL 重写为 `/api/avatar-media/{id}/{file}`。
"""

from __future__ import annotations

import re
import shutil
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from .config import DATA_DIR
from .media import image_content_type, image_extension
from .portraits import image_path
from .videos import final_path, voice_path

router = APIRouter(prefix="/creation-media", tags=["creation-media"])

CREATION_MEDIA_DIR = DATA_DIR / "creations"
VOICE_MEDIA_DIR = DATA_DIR / "voice-media"
AVATAR_MEDIA_DIR = DATA_DIR / "avatar-media"

# 任务产物 URL（相对或带本服务域名的绝对地址均可）→ 解析 kind
_JOB_URL = re.compile(
    r"^(?:https?://[^/]+)?/api/jobs/(?P<job_id>[A-Za-z0-9_]+)/(?P<kind>video|audio|voice|image)(?:/(?P<index>\d+))?$"
)


def _source_path(job_id: str, kind: str, index: int | None) -> Path | None:
    if kind == "video":
        return final_path(job_id)
    if kind in ("audio", "voice"):
        return voice_path(job_id)
    if kind == "image" and index is not None:
        return image_path(job_id, index)
    return None


def snapshot_creation(creation: dict) -> dict:
    """把创作里引用的任务产物拷进创作目录，返回重写后的新 doc（不动入参）。"""
    cid = creation.get("id")
    if not isinstance(cid, str) or not cid:
        return creation
    dest_dir = CREATION_MEDIA_DIR / cid
    out = dict(creation)
    changed = False
    for field in ("video_url", "voice_url", "cover_url"):
        url = creation.get(field)
        if not isinstance(url, str) or "/api/jobs/" not in url:
            continue
        m = _JOB_URL.match(url)
        if not m:
            continue
        src = _source_path(m["job_id"], m["kind"], int(m["index"]) if m["index"] else None)
        if src is None or not src.exists() or src.stat().st_size == 0:
            continue  # 源文件不在了，保留原 URL（历史遗留，由迁移兜底）
        dest_dir.mkdir(parents=True, exist_ok=True)
        # 文件名带字段与序号，避免 video/cover 都是 image 时互踩
        suffix = src.suffix or image_extension(src)
        dest = dest_dir / f"{field}{suffix}"
        if not dest.exists() or dest.stat().st_size != src.stat().st_size:
            shutil.copyfile(src, dest)
        out[field] = f"/api/creation-media/{cid}/{dest.name}"
        changed = True
    if changed:
        out["media_snapshotted"] = True
    return out


def _snapshot_image_url(url: str, dest_dir: Path, name: str, url_prefix: str) -> str | None:
    """把一条任务图片 URL 快照进 dest_dir/name.ext，返回重写后的相对 URL。

    源文件不在了返回 None（保留原 URL，历史遗留由启动迁移兜底）。
    """
    m = _JOB_URL.match(url)
    if not m or m["kind"] != "image" or m["index"] is None:
        return None
    src = _source_path(m["job_id"], "image", int(m["index"]))
    if src is None or not src.exists() or src.stat().st_size == 0:
        return None
    dest_dir.mkdir(parents=True, exist_ok=True)
    suffix = src.suffix or image_extension(src)
    dest = dest_dir / f"{name}{suffix}"
    if not dest.exists() or dest.stat().st_size != src.stat().st_size:
        shutil.copyfile(src, dest)
    return f"{url_prefix}/{dest.name}"


def snapshot_voice_avatar(doc: dict) -> dict:
    """声音头像解耦：{id, url} 里引用任务图片的拷进 data/voice-media/{voice_id}/。"""
    vid = doc.get("id")
    url = doc.get("url")
    if not isinstance(vid, str) or not vid or not isinstance(url, str) or "/api/jobs/" not in url:
        return doc
    new_url = _snapshot_image_url(url, VOICE_MEDIA_DIR / vid, "avatar", f"/api/creation-media/voice/{vid}")
    if new_url is None:
        return doc
    return {**doc, "url": new_url}


_VIEWS_URL_PREFIX = "/api/creation-media/avatar"


def _snapshot_views(views: dict, dest_dir: Path, url_prefix: str) -> tuple[dict, bool]:
    """快照 front/side/back 三视图，返回（重写后的 views, 是否有改动）。"""
    out = dict(views)
    changed = False
    for field in ("front", "side", "back"):
        url = out.get(field)
        if not isinstance(url, str) or "/api/jobs/" not in url:
            continue
        new_url = _snapshot_image_url(url, dest_dir, field, f"{url_prefix}/{dest_dir.name}")
        if new_url is not None:
            out[field] = new_url
            changed = True
    return out, changed


def snapshot_avatar_media(avatar: dict) -> dict:
    """角色三视图解耦：views 里引用任务图片的拷进 data/avatar-media/{avatar_id}/。"""
    aid = avatar.get("id")
    views = avatar.get("views")
    if not isinstance(aid, str) or not aid or not isinstance(views, dict):
        return avatar
    new_views, changed = _snapshot_views(views, AVATAR_MEDIA_DIR / aid, _VIEWS_URL_PREFIX)
    if not changed:
        return avatar
    return {**avatar, "views": new_views, "media_snapshotted": True}


def snapshot_avatar_patch(doc: dict) -> dict:
    """种子角色补丁解耦：patch.views 里引用任务图片的同样快照。"""
    aid = doc.get("id")
    patch = doc.get("patch")
    if not isinstance(aid, str) or not aid or not isinstance(patch, dict):
        return doc
    views = patch.get("views")
    if not isinstance(views, dict):
        return doc
    new_views, changed = _snapshot_views(views, AVATAR_MEDIA_DIR / aid, _VIEWS_URL_PREFIX)
    if not changed:
        return doc
    return {**doc, "patch": {**patch, "views": new_views}}


async def migrate_media(creations: list[dict], voice_avatars: list[dict], created: list[dict], patches: list[dict]) -> str:
    """启动迁移：已经落库但还引用任务 URL 的数据补做快照。返回摘要日志文本。"""
    from .store import store

    done: list[str] = []
    for c in creations:
        if c.get("media_snapshotted"):
            continue
        snap = snapshot_creation(c)
        if snap.get("media_snapshotted"):
            await store.upsert("creations", "id", c["id"], snap)
            done.append("creations")
    va_done = 0
    for d in voice_avatars:
        snap = snapshot_voice_avatar(d)
        if snap is not d and snap.get("url") != d.get("url"):
            await store.upsert("voice_avatars", "id", d["id"], snap)
            va_done += 1
    if va_done:
        done.append(f"voice_avatars x{va_done}")
    av_done = 0
    for a in created:
        snap = snapshot_avatar_media(a)
        if snap.get("media_snapshotted") and not a.get("media_snapshotted"):
            await store.upsert("created_avatars", "id", a["id"], snap)
            av_done += 1
    p_done = 0
    for d in patches:
        snap = snapshot_avatar_patch(d)
        if snap is not d:
            await store.upsert("avatar_patches", "id", d["id"], snap)
            p_done += 1
    if av_done:
        done.append(f"created_avatars x{av_done}")
    if p_done:
        done.append(f"avatar_patches x{p_done}")
    return ", ".join(done)


async def migrate_existing(creations: list[dict]) -> int:
    """启动迁移：已经落库但还引用任务 URL 的创作补做快照。返回处理条数。"""
    done = 0
    for c in creations:
        if c.get("media_snapshotted"):
            continue
        snap = snapshot_creation(c)
        if snap.get("media_snapshotted"):
            from .store import store

            await store.upsert("creations", "id", c["id"], snap)
            done += 1
    return done


def remove_creation_media(creation_id: str) -> None:
    """删除创作时清掉它的媒体快照目录。"""
    if not re.fullmatch(r"[A-Za-z0-9_\-]+", creation_id):
        return
    dest_dir = CREATION_MEDIA_DIR / creation_id
    if dest_dir.exists():
        shutil.rmtree(dest_dir, ignore_errors=True)


def remove_avatar_media(avatar_id: str) -> None:
    """删除角色时清掉它的三视图快照目录。"""
    if not re.fullmatch(r"[A-Za-z0-9_\-]+", avatar_id):
        return
    dest_dir = AVATAR_MEDIA_DIR / avatar_id
    if dest_dir.exists():
        shutil.rmtree(dest_dir, ignore_errors=True)


def _serve_media(root: Path, owner_id: str, filename: str) -> FileResponse:
    if not re.fullmatch(r"[A-Za-z0-9_\-]+", owner_id) or not re.fullmatch(
        r"[A-Za-z0-9_.\-]+", filename
    ):
        raise HTTPException(status_code=404, detail="not found")
    path = root / owner_id / filename
    if not path.exists() or path.stat().st_size == 0:
        raise HTTPException(status_code=404, detail="not found")
    if path.suffix == ".mp4":
        media_type = "video/mp4"
    elif path.suffix in (".mp3", ".mpeg"):
        media_type = "audio/mpeg"
    else:
        media_type = image_content_type(path)
    return FileResponse(path, media_type=media_type, headers={"Cache-Control": "public, max-age=86400"})


def serve(creation_id: str, filename: str) -> FileResponse:
    """GET /api/creation-media/{id}/{file}。"""
    return _serve_media(CREATION_MEDIA_DIR, creation_id, filename)


@router.api_route("/voice/{voice_id}/{filename}", methods=["GET", "HEAD"])
async def voice_media_file(voice_id: str, filename: str):
    """声音自有的头像文件（快照自任务产物，任务删除后仍可访问）。"""
    return _serve_media(VOICE_MEDIA_DIR, voice_id, filename)


@router.api_route("/avatar/{avatar_id}/{filename}", methods=["GET", "HEAD"])
async def avatar_media_file(avatar_id: str, filename: str):
    """角色自有的三视图文件（快照自任务产物，任务删除后仍可访问）。"""
    return _serve_media(AVATAR_MEDIA_DIR, avatar_id, filename)


@router.api_route("/{creation_id}/{filename}", methods=["GET", "HEAD"])
async def creation_media_file(creation_id: str, filename: str):
    """创作自有的媒体文件（快照自任务产物，任务删除后仍可访问）。"""
    return serve(creation_id, filename)
