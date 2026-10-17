"""ThankYou Open API 客户端。

统一入口 POST /open/v1/generate，配合 /quote 估价、/generations/{id} 轮询。
所有对外调用都经过这里，便于统一处理超时、重试和错误码映射。

参考：https://thankyouai.com/developer/docs
"""

from __future__ import annotations

import asyncio
import logging
import mimetypes
from pathlib import Path
from typing import Any

import httpx

from .config import settings

log = logging.getLogger("thankyou")

TERMINAL = {"succeeded", "failed", "canceled"}


class ThankYouError(Exception):
    """调用 ThankYou 失败。code/message 可直接放进 Job.error。"""

    def __init__(self, code: str, message: str, status: int | None = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status

    def to_dict(self) -> dict[str, str]:
        return {"code": self.code, "message": self.message}


class ThankYouClient:
    def __init__(self, api_key: str | None = None, base_url: str | None = None):
        self.api_key = (api_key if api_key is not None else settings.thank_you_ai_key).strip()
        self.base_url = (base_url or settings.thankyou_base_url).rstrip("/")
        self._client: httpx.AsyncClient | None = None
        self._raw_client: httpx.AsyncClient | None = None

    # ---------- 生命周期 ----------

    async def _http(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(
                base_url=self.base_url,
                timeout=httpx.Timeout(settings.request_timeout, connect=15.0),
                headers={"Authorization": f"Bearer {self.api_key}"},
            )
        return self._client

    async def _raw_http(self) -> httpx.AsyncClient:
        """不带任何默认头的裸客户端，专门用来打**预签名地址**。

        预签名 URL 是对象存储自己签的，它认「签名在 query 里」。如果顺手带上我们
        API 的 `Authorization: Bearer ...`，存储会把那个头当成 SigV4 签名去校验，
        回一个 `Missing x-amz-content-sha256` 的 InvalidRequest —— 看起来像上传失败，
        实际是我们多送了一个头。
        """
        if self._raw_client is None:
            self._raw_client = httpx.AsyncClient(
                timeout=httpx.Timeout(settings.request_timeout, connect=15.0)
            )
        return self._raw_client

    async def aclose(self) -> None:
        for attr in ("_client", "_raw_client"):
            client = getattr(self, attr)
            if client is not None:
                await client.aclose()
                setattr(self, attr, None)

    def _require_key(self) -> None:
        if not self.api_key:
            raise ThankYouError(
                "CONFIG_ERROR",
                "未配置 THANK_YOU_AI_KEY，请在 backend/.env 或 voice-to-avater-demo/.env 中填入。",
                status=500,
            )

    # ---------- 基础请求 ----------

    async def _request(
        self,
        method: str,
        path: str,
        *,
        json_body: dict[str, Any] | None = None,
        params: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
        retries: int = 2,
    ) -> dict[str, Any]:
        self._require_key()
        client = await self._http()
        last: Exception | None = None

        for attempt in range(retries + 1):
            try:
                resp = await client.request(
                    method, path, json=json_body, params=params, headers=headers
                )
            except httpx.TimeoutException as exc:
                last = ThankYouError("UPSTREAM_TIMEOUT", f"请求超时：{exc}", status=504)
            except httpx.HTTPError as exc:
                last = ThankYouError("UPSTREAM_UNREACHABLE", f"网络异常：{exc}", status=502)
            else:
                if resp.status_code < 400:
                    if not resp.content:
                        return {}
                    try:
                        return resp.json()
                    except ValueError:
                        return {"raw": resp.text}

                code, message = self._parse_error(resp)
                # 4xx 是调用方问题，重试无意义；5xx / 429 才重试
                if resp.status_code < 500 and resp.status_code != 429:
                    raise ThankYouError(code, message, status=resp.status_code)
                last = ThankYouError(code, message, status=resp.status_code)

            if attempt < retries:
                await asyncio.sleep(1.0 * (attempt + 1))

        assert last is not None
        raise last

    @staticmethod
    def _parse_error(resp: httpx.Response) -> tuple[str, str]:
        code = f"HTTP_{resp.status_code}"
        message = resp.text[:400] or resp.reason_phrase
        try:
            body = resp.json()
        except ValueError:
            return code, message
        err = body.get("error") if isinstance(body, dict) else None
        if isinstance(err, dict):
            return str(err.get("code") or code), str(err.get("message") or message)
        if isinstance(body, dict) and body.get("detail"):
            return code, str(body["detail"])
        if isinstance(body, str):
            return code, body
        return code, message

    # ---------- 生成 ----------

    async def generate(self, model: str, payload: dict[str, Any], *, wait_seconds: int | None = None) -> dict:
        """提交一次生成。返回 generation 实体（可能是 queued）。"""
        headers = {"Prefer": f"wait={wait_seconds}"} if wait_seconds else None
        return await self._request(
            "POST", "/generate", json_body={"model": model, "input": payload}, headers=headers
        )

    async def quote(self, model: str, payload: dict[str, Any]) -> dict:
        """先估价再生成（面试要求：不要在循环里盲目调用真实服务）。"""
        return await self._request("POST", "/generate/quote", json_body={"model": model, "input": payload})

    async def get_generation(self, generation_id: str) -> dict:
        return await self._request("GET", f"/generations/{generation_id}")

    async def wait_generation(
        self, generation_id: str, *, interval: float | None = None, timeout: float | None = None
    ) -> dict:
        """轮询直到终态。queued → running → succeeded / failed。"""
        interval = interval or settings.poll_interval
        deadline = asyncio.get_event_loop().time() + (timeout or settings.poll_timeout)
        gen: dict = {}
        while True:
            gen = await self.get_generation(generation_id)
            status = gen.get("status")
            if status in TERMINAL:
                return gen
            if asyncio.get_event_loop().time() > deadline:
                raise ThankYouError(
                    "UPSTREAM_TIMEOUT",
                    f"生成超时（{timeout or settings.poll_timeout:.0f}s），任务 {generation_id} 仍在 {status}",
                    status=504,
                )
            await asyncio.sleep(interval)

    async def run(self, model: str, payload: dict[str, Any]) -> dict:
        """提交并等待到终态。失败时抛 ThankYouError。"""
        gen = await self.generate(model, payload)
        status = gen.get("status")
        if status not in TERMINAL:
            gen = await self.wait_generation(gen["id"])
        if gen.get("status") != "succeeded":
            err = gen.get("error") or {}
            raise ThankYouError(
                str(err.get("code") or "GENERATION_FAILED"),
                str(err.get("message") or f"生成失败（status={gen.get('status')}）"),
            )
        return gen

    # ---------- 端点：发现 ----------

    async def list_models(self) -> list[dict]:
        return (await self._request("GET", "/models")).get("models", [])

    async def list_voices(self, *, page: int = 1, page_size: int = 50, q: str | None = None) -> dict:
        params: dict[str, Any] = {"page": page, "page_size": page_size}
        if q:
            params["q"] = q
        return await self._request("GET", "/voices", params=params)

    async def usage(self, days: int = 30) -> dict:
        return await self._request("GET", "/usage", params={"period_days": days})

    # ---------- 资源上传 ----------

    async def upload_file(
        self,
        path: Path,
        *,
        content_type: str | None = None,
        filename: str | None = None,
        timeout: float = 300.0,
    ) -> dict:
        """把本地文件传到上游，返回 {file_id, url, content_type, size_bytes, ...}。

        用途：把**我们自己的中间产物**（合成的台词音轨、缓存下来的形象图）传给下一步
        模型当输入 —— 这些文件只在我们本地，上游按普通 URL 是取不到的。

        上游实际是**两段式**（它部署的版本和它发布的 openapi.json 不一致，两处差异
        都会一脚踩空，所以都写在注释里）：

          1. `POST /files` 只是「预留一个位置」，表单必须额外带 `content_type` 与
             `size_bytes`（文档说只有 `file` 必填，实际只传 `file` 会回 422），
             响应里会多给一个 `upload_url`（文档里没有这个字段）；
          2. **字节要自己 PUT 到 `upload_url`**，且必须带上与签名一致的头
             `Content-Type`（签名串是 `SignedHeaders=content-type;host`，不发就
             403 SignatureDoesNotMatch），同时**不能带我们的 `Authorization`**
             （带了存储会当 SigV4 解析，回 `Missing x-amz-content-sha256`）。
             只 POST 不 PUT 也会拿到 file_id，但那个 `url` 永远 404。
             **引用时用 `url`**：把 file_id 喂给 `reference_assets` 会被判
             `invalid_param`（即便字节确实传上去了），而同一个文件的 url 就通过。
        """
        self._require_key()
        src = Path(path)
        if not src.exists() or src.stat().st_size == 0:
            raise ThankYouError("FILE_NOT_FOUND", f"待上传的文件不存在或为空：{src}", 400)

        ct = content_type or mimetypes.guess_type(src.name)[0] or "application/octet-stream"
        name = filename or src.name
        data = src.read_bytes()
        http = await self._http()
        timeout_cfg = httpx.Timeout(timeout, connect=15.0)

        try:
            resp = await http.post(
                "/files",
                files={"file": (name, data, ct)},
                data={"content_type": ct, "size_bytes": str(len(data))},
                timeout=timeout_cfg,
            )
        except httpx.TimeoutException as exc:
            raise ThankYouError("UPLOAD_TIMEOUT", f"上传超时：{exc}", 504) from exc
        except httpx.HTTPError as exc:
            raise ThankYouError("UPSTREAM_UNREACHABLE", f"上传网络异常：{exc}", 502) from exc

        if resp.status_code >= 400:
            code, message = self._parse_error(resp)
            raise ThankYouError(code, message, status=resp.status_code)

        info = resp.json()
        upload_url = info.get("upload_url")
        if upload_url:
            try:
                put = await (await self._raw_http()).put(
                    upload_url,  # 绝对地址，裸客户端不带 base_url
                    content=data,
                    headers={"Content-Type": ct},
                    timeout=timeout_cfg,
                )
            except httpx.TimeoutException as exc:
                raise ThankYouError("UPLOAD_TIMEOUT", f"上传超时（PUT 字节）：{exc}", 504) from exc
            except httpx.HTTPError as exc:
                raise ThankYouError("UPSTREAM_UNREACHABLE", f"上传网络异常（PUT 字节）：{exc}", 502) from exc

            if put.status_code >= 400:
                raise ThankYouError(
                    "UPLOAD_FAILED",
                    f"文件字节上传失败（HTTP {put.status_code}）：{put.text[:200]}",
                    status=502,
                )
        # 上游哪天改回「一次 POST 就绪」（没有 upload_url）也照样能跑

        url = info.get("url")
        if url and upload_url:
            # 只有走过两段式才有「可能没传上去」这回事，确认一下再交给模型
            await self._wait_fetchable(url)
        return info

    async def _wait_fetchable(self, url: str, *, attempts: int = 4, delay: float = 1.5) -> None:
        """确认刚上传的文件真的能被抓取到，抓不到就别往下走。

        上传分两段（预留 → PUT），只做第一段也会拿到一个 url，但它永远 404。
        而模型只关心「这个地址能不能取到」，取不到时报的是「参数组合不支持」这种
        驴唇不对马嘴的错误 —— 与其拿几百点去换一个误导性的报错，不如在这里说清楚。
        """
        last: int | None = None
        for attempt in range(attempts):
            try:
                resp = await (await self._raw_http()).head(url, timeout=httpx.Timeout(15.0))
            except httpx.HTTPError as exc:
                last = None
                log.debug("上传就绪探测异常（第 %s 次）：%s", attempt + 1, exc)
            else:
                if resp.status_code < 400:
                    return
                last = resp.status_code
            if attempt < attempts - 1:
                await asyncio.sleep(delay)

        raise ThankYouError(
            "UPLOAD_NOT_READY",
            f"文件上传后仍取不到（HTTP {last}）：{url}",
            status=502,
        )

    # ---------- 资源下载 ----------

    async def download(self, url: str, dest: Path) -> Path:
        """把生成结果（图片/音频/视频）落到本地。产物在 static.thankyouai.com。"""
        self._require_key()
        dest.parent.mkdir(parents=True, exist_ok=True)
        tmp = dest.with_suffix(dest.suffix + ".part")
        client = await self._http()
        try:
            async with client.stream("GET", url) as resp:
                if resp.status_code >= 400:
                    raise ThankYouError(
                        "ASSET_DOWNLOAD_FAILED", f"下载产物失败 HTTP {resp.status_code}", resp.status_code
                    )
                with tmp.open("wb") as fh:
                    async for chunk in resp.aiter_bytes(64 * 1024):
                        fh.write(chunk)
        except httpx.HTTPError as exc:
            raise ThankYouError("ASSET_DOWNLOAD_FAILED", f"下载产物网络异常：{exc}", 502) from exc
        tmp.replace(dest)
        return dest

    @staticmethod
    def first_url(generation: dict) -> str | None:
        out = generation.get("output") or []
        if isinstance(out, list) and out:
            item = out[0]
            if isinstance(item, dict):
                return item.get("url")
        if isinstance(out, dict):
            return out.get("url") or out.get("audio_url") or out.get("video_url")
        return None


client = ThankYouClient()
