"""用户产出数据的持久化：角色 / 角色修改 / 删除的种子 / 创作记录。

这些数据之前只存在浏览器 localStorage 里。localStorage 按 origin 隔离，
换一个地址（localhost vs 局域网 IP）或换一台设备，数据就"丢"了。
现在统一入库（MongoDB / JSON 回退由 store 层决定），浏览器端只是缓存。

四个集合（与前端 src/data/mock.ts、src/data/creations.ts 的模型一一对应）：
  created_avatars       用户从候选图保存的新角色（完整文档）
  avatar_patches        对种子角色的修改（{id, patch}，patch 覆盖在种子上）
  deleted_seed_avatars  被用户删掉的种子角色 id（种子在代码里删不掉，只记账）
  creations             创作库条目（成片记录）
"""

from __future__ import annotations

from fastapi import APIRouter, Body, HTTPException

from ..store import store
from ..creation_media import (
    remove_avatar_media,
    remove_creation_media,
    snapshot_avatar_media,
    snapshot_avatar_patch,
    snapshot_creation,
)

router = APIRouter(prefix="/library", tags=["library"])

CREATED = "created_avatars"
PATCHES = "avatar_patches"
DELETED = "deleted_seed_avatars"
CREATIONS = "creations"


def _fail(status: int, code: str, message: str) -> HTTPException:
    return HTTPException(status_code=status, detail={"error": {"code": code, "message": message}})


@router.get("")
async def get_library() -> dict:
    """前端启动时拉一次，替代原来从 localStorage 读增量的逻辑。"""
    created = await store.list(CREATED)
    patch_docs = await store.list(PATCHES)
    deleted_docs = await store.list(DELETED)
    creations = await store.list(CREATIONS)
    return {
        "created_avatars": created,
        "avatar_patches": {d["id"]: d.get("patch") or {} for d in patch_docs},
        "deleted_seed_avatars": [d["id"] for d in deleted_docs],
        "creations": creations,
    }


# ---------- 新建角色 ----------


@router.put("/created-avatars/{avatar_id}")
async def put_created_avatar(avatar_id: str, doc: dict = Body(...)) -> dict:
    if not isinstance(doc.get("name"), str) or not doc["name"].strip():
        raise _fail(422, "VALIDATION_ERROR", "name 不能为空")
    # 三视图不与任务绑定：引用到的任务图片先拷进角色自己的媒体目录
    return await store.upsert(
        CREATED, "id", avatar_id, {**snapshot_avatar_media(doc), "id": avatar_id}
    )


@router.delete("/created-avatars/{avatar_id}")
async def delete_created_avatar(avatar_id: str) -> dict:
    deleted = await store.delete(CREATED, "id", avatar_id)
    # 连同角色自己的三视图快照一起清掉，不留孤儿文件
    remove_avatar_media(avatar_id)
    # 连带清理可能的补丁（该 id 同时也是种子 id 时才会出现）
    await store.delete(PATCHES, "id", avatar_id)
    return {"deleted": deleted, "id": avatar_id}


# ---------- 种子角色的修改 ----------


@router.put("/avatar-patches/{avatar_id}")
async def put_avatar_patch(avatar_id: str, body: dict = Body(...)) -> dict:
    patch = body.get("patch")
    if not isinstance(patch, dict):
        raise _fail(422, "VALIDATION_ERROR", "patch 必须是对象")
    # 补丁里的三视图同样与任务解耦
    return await store.upsert(
        PATCHES, "id", avatar_id, {**snapshot_avatar_patch({"id": avatar_id, "patch": patch})}
    )


@router.delete("/avatar-patches/{avatar_id}")
async def delete_avatar_patch(avatar_id: str) -> dict:
    deleted = await store.delete(PATCHES, "id", avatar_id)
    return {"deleted": deleted, "id": avatar_id}


# ---------- 被删除的种子角色 ----------


@router.put("/deleted-seeds/{avatar_id}")
async def put_deleted_seed(avatar_id: str) -> dict:
    return await store.upsert(DELETED, "id", avatar_id, {"id": avatar_id})


@router.delete("/deleted-seeds/{avatar_id}")
async def delete_deleted_seed(avatar_id: str) -> dict:
    """恢复一个被删掉的种子角色（回到默认列表）。"""
    deleted = await store.delete(DELETED, "id", avatar_id)
    return {"deleted": deleted, "id": avatar_id}


# ---------- 创作记录 ----------


@router.put("/creations/{creation_id}")
async def put_creation(creation_id: str, doc: dict = Body(...)) -> dict:
    if not isinstance(doc.get("avatar_id"), str) or not doc["avatar_id"]:
        raise _fail(422, "VALIDATION_ERROR", "avatar_id 不能为空")
    # 创作不与任务绑定：引用到的任务产物先拷进创作自己的媒体目录，
    # 之后删任务记录不影响这条创作。
    return await store.upsert(
        CREATIONS, "id", creation_id, {**snapshot_creation(doc), "id": creation_id}
    )


@router.delete("/creations/{creation_id}")
async def delete_creation(creation_id: str) -> dict:
    deleted = await store.delete(CREATIONS, "id", creation_id)
    # 连同创作自己的媒体快照一起清掉，不留孤儿文件
    remove_creation_media(creation_id)
    return {"deleted": deleted, "id": creation_id}
