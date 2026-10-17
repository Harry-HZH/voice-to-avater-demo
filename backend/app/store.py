"""存储层：MongoDB 优先，连不上自动回退到本地 JSON 文件。

面试要求后端是 FastAPI + MongoDB。实际开发环境经常没有 Docker / Mongo，
所以这里把存储做成可插拔：启动时探测 MONGO_URL，能连上就用 Mongo，
连不上就用 backend/data/store.json。两者对外暴露同一套异步接口，
上层业务代码不感知差异（/api/health 会回报当前用的是哪个）。
"""

from __future__ import annotations

import asyncio
import json
import logging
from pathlib import Path
from typing import Any

from .config import STORE_FILE, settings

log = logging.getLogger("store")


class Store:
    def __init__(self) -> None:
        self.backend_name: str = "json"
        self._lock = asyncio.Lock()
        self._mem: dict[str, list[dict]] = {"jobs": [], "voices": []}
        self._mongo_db = None
        self._mongo_client = None

    # ---------- 初始化 ----------

    async def init(self) -> None:
        if await self._try_mongo():
            self.backend_name = "mongodb"
            log.info("存储后端：MongoDB (%s)", settings.mongo_url)
        else:
            self.backend_name = "json"
            self._load_json()
            log.info("存储后端：JSON 文件 (%s)", STORE_FILE)

    async def _try_mongo(self) -> bool:
        try:
            from pymongo import MongoClient  # 可选依赖，没装直接回退
        except ImportError:
            return False
        try:
            client = await asyncio.to_thread(
                MongoClient,
                settings.mongo_url,
                serverSelectionTimeoutMS=settings.mongo_timeout_ms,
                connectTimeoutMS=settings.mongo_timeout_ms,
            )
            await asyncio.to_thread(client.admin.command, "ping")
        except Exception as exc:  # noqa: BLE001 - 任何连接问题都回退
            log.info("MongoDB 不可用（%s），回退到 JSON 存储", type(exc).__name__)
            return False
        self._mongo_client = client
        self._mongo_db = client[settings.mongo_db]
        return True

    async def close(self) -> None:
        if self._mongo_client is not None:
            await asyncio.to_thread(self._mongo_client.close)

    # ---------- JSON 后端 ----------

    def _load_json(self) -> None:
        if STORE_FILE.exists():
            try:
                self._mem = json.loads(STORE_FILE.read_text(encoding="utf-8"))
            except (ValueError, OSError):
                log.warning("store.json 解析失败，使用空存储")
                self._mem = {"jobs": [], "voices": []}
        for key in ("jobs", "voices"):
            self._mem.setdefault(key, [])

    def _save_json(self) -> None:
        tmp = Path(str(STORE_FILE) + ".tmp")
        tmp.write_text(json.dumps(self._mem, ensure_ascii=False, indent=1), encoding="utf-8")
        tmp.replace(STORE_FILE)

    # ---------- 统一接口 ----------

    async def insert(self, collection: str, doc: dict[str, Any]) -> dict[str, Any]:
        async with self._lock:
            if self._mongo_db is not None:
                await asyncio.to_thread(self._mongo_db[collection].insert_one, dict(doc))
                return doc
            self._mem.setdefault(collection, []).insert(0, doc)
            self._save_json()
            return doc

    async def upsert(self, collection: str, key: str, value: Any, doc: dict[str, Any]) -> dict[str, Any]:
        async with self._lock:
            if self._mongo_db is not None:
                await asyncio.to_thread(
                    self._mongo_db[collection].replace_one, {key: value}, dict(doc), True
                )
                return doc
            items = self._mem.setdefault(collection, [])
            for i, item in enumerate(items):
                if item.get(key) == value:
                    items[i] = doc
                    break
            else:
                items.insert(0, doc)
            self._save_json()
            return doc

    async def list(self, collection: str, **filters: Any) -> list[dict[str, Any]]:
        if self._mongo_db is not None:
            query = {k: v for k, v in filters.items() if v is not None}
            docs = await asyncio.to_thread(
                lambda: list(self._mongo_db[collection].find(query, {"_id": 0}))
            )
            return docs
        items = list(self._mem.get(collection, []))
        for k, v in filters.items():
            if v is not None:
                items = [d for d in items if d.get(k) == v]
        return items

    async def get(self, collection: str, key: str, value: Any) -> dict[str, Any] | None:
        async with self._lock:
            if self._mongo_db is not None:
                return await asyncio.to_thread(
                    self._mongo_db[collection].find_one, {key: value}, {"_id": 0}
                )
            for item in self._mem.get(collection, []):
                if item.get(key) == value:
                    return item
            return None

    async def update(self, collection: str, key: str, value: Any, patch: dict[str, Any]) -> dict[str, Any] | None:
        async with self._lock:
            if self._mongo_db is not None:
                await asyncio.to_thread(
                    self._mongo_db[collection].update_one, {key: value}, {"$set": patch}
                )
                return await asyncio.to_thread(
                    self._mongo_db[collection].find_one, {key: value}, {"_id": 0}
                )
            for item in self._mem.get(collection, []):
                if item.get(key) == value:
                    item.update(patch)
                    self._save_json()
                    return item
            return None

    async def delete(self, collection: str, key: str, value: Any) -> bool:
        """按 key 删一条文档，返回是否真的删掉了。"""
        async with self._lock:
            if self._mongo_db is not None:
                result = await asyncio.to_thread(
                    self._mongo_db[collection].delete_one, {key: value}
                )
                return result.deleted_count > 0
            items = self._mem.setdefault(collection, [])
            for i, item in enumerate(items):
                if item.get(key) == value:
                    items.pop(i)
                    self._save_json()
                    return True
            return False


store = Store()
