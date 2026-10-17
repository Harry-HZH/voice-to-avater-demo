"""文件上传：上游实际是两段式，这段逻辑必须钉死。

上游部署版本与它自己发布的 openapi.json 有两处不一致，两处都踩过：

  1. `POST /files` 表单除了 `file` 还必须带 `content_type` / `size_bytes`
     （文档只声明 `file` 必填）—— 少传直接 422；
  2. 响应里多一个 `upload_url`（文档里没有这个字段），**字节得自己 PUT 上去**，
     且 PUT 必须带与签名一致的 `Content-Type`（签名串是
     `SignedHeaders=content-type;host`，不带就 403 SignatureDoesNotMatch）。

只 POST 不 PUT 也会拿到 file_id，但那个公开 url 永远 404 —— 所以这里的断言是
「POST 之后必然发生一次 PUT」，而不是「POST 返回 200 就算成功」。

这条链路以前从没真跑过（形象生成走的是上游地址，没触发过本地回传），
真跑第一次就撞上了 —— 因此用 MockTransport 直接测真实实现，而不是打成假函数。
"""

from __future__ import annotations

import asyncio
from pathlib import Path

import httpx
import pytest

from app.thankyou import ThankYouClient, ThankYouError


def run(coro):
    return asyncio.run(coro)


def make_client(handler, *, auth_header: bool = False) -> ThankYouClient:
    """把一个真实客户端接到 MockTransport 上（不碰网络）。

    两个客户端都要接：`_client` 打 API，`_raw_client` 打预签名地址（不带默认头）
    —— 只接前者的话，上传字节那一步会去连真的 r2.test。
    """
    transport = httpx.MockTransport(handler)
    client = ThankYouClient(api_key="test-key", base_url="https://api.test/open/v1")
    client._client = httpx.AsyncClient(
        transport=transport,
        base_url="https://api.test/open/v1",
        headers={"Authorization": "Bearer test-key"} if auth_header else None,
    )
    client._raw_client = httpx.AsyncClient(transport=transport)
    return client


def make_file(tmp_path: Path, name: str = "voice.mp3", size: int = 4096) -> Path:
    p = tmp_path / name
    p.write_bytes(b"\xff\xfb\x90\x00" + b"x" * (size - 4))
    return p


# ---------- 正常路径 ----------


def test_upload_declares_content_type_and_size(tmp_path):
    """表单里必须带上 content_type / size_bytes —— 少传上游回 422。"""
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.method == "POST":
            return httpx.Response(
                201,
                json={
                    "file_id": "file_abc",
                    "url": "https://cdn.test/file_abc.mp3",
                    "upload_url": "https://r2.test/put/file_abc?sig=1",
                    "content_type": "audio/mpeg",
                    "size_bytes": 4096,
                },
            )
        return httpx.Response(200)

    src = make_file(tmp_path)
    info = run(make_client(handler).upload_file(src))

    assert info["file_id"] == "file_abc"
    post = seen[0]
    body = post.read().decode("utf-8", "replace")
    assert 'name="content_type"' in body
    assert 'name="size_bytes"' in body
    assert str(src.stat().st_size) in body
    assert "audio/mpeg" in body


def test_upload_puts_bytes_to_presigned_url(tmp_path):
    """POST 只是预留；字节要 PUT 到 upload_url，且必须带 content-type。"""
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.method == "POST":
            return httpx.Response(
                201,
                json={
                    "file_id": "file_abc",
                    "url": "https://cdn.test/file_abc.mp3",
                    "upload_url": "https://r2.test/put/file_abc?sig=1",
                },
            )
        return httpx.Response(200)

    src = make_file(tmp_path)
    data = src.read_bytes()
    info = run(make_client(handler).upload_file(src))

    assert [r.method for r in seen] == ["POST", "PUT", "HEAD"], "POST → PUT 字节 → 确认可抓取"
    assert info["url"] == "https://cdn.test/file_abc.mp3"

    put = seen[1]
    assert str(put.url) == "https://r2.test/put/file_abc?sig=1", "要打到预签名地址，不能拼 base_url"
    assert put.headers["content-type"] == "audio/mpeg", "签名含 content-type，不带会被拒"
    assert put.read() == data, "PUT 的字节要和原文件一致"


def test_upload_respects_explicit_content_type(tmp_path):
    """形象图会显式指定 image/jpeg —— PUT 时也要跟着变，不能写死。"""
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.method == "POST":
            return httpx.Response(201, json={"file_id": "file_img", "upload_url": "https://r2.test/put/img"})
        return httpx.Response(200)

    src = make_file(tmp_path, "portrait.jpg")
    run(make_client(handler).upload_file(src, content_type="image/jpeg"))

    assert seen[1].headers["content-type"] == "image/jpeg"


def test_upload_put_carries_no_authorization(tmp_path):
    """PUT 到预签名地址**绝不能带**我们的 Authorization 头。

    带了的话对象存储会把它当成 SigV4 签名去校验，回
    `Missing x-amz-content-sha256` 的 InvalidRequest —— 真跑时踩到的就是这个。
    所以这里用带默认鉴权头的客户端（和线上一样）来断言。
    """
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.method == "POST":
            return httpx.Response(201, json={"file_id": "file_x", "upload_url": "https://r2.test/put/x"})
        return httpx.Response(200)

    run(make_client(handler, auth_header=True).upload_file(make_file(tmp_path)))

    assert seen[0].headers.get("authorization") == "Bearer test-key", "POST 是正常带鉴权的"
    assert "authorization" not in seen[1].headers, "PUT 不能带鉴权头"


def test_upload_works_when_upstream_has_no_upload_url(tmp_path):
    """上游哪天改回「一次 POST 就绪」，也不能因此报错。"""
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.method)
        return httpx.Response(201, json={"file_id": "file_direct", "url": "https://cdn.test/x.mp3"})

    info = run(make_client(handler).upload_file(make_file(tmp_path)))
    assert info["file_id"] == "file_direct"
    assert calls == ["POST"], "没有 upload_url 就没有第二段，不必再探一次"


def test_upload_fails_when_url_never_becomes_fetchable(tmp_path):
    """只 POST 不 PUT 会拿到一个永远 404 的 url —— 必须在这里拦住。

    放过去的话，模型那边只会回一句「参数组合不支持」，跟真实原因差着十万八千里。
    """
    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "POST":
            return httpx.Response(
                201, json={"file_id": "file_x", "url": "https://cdn.test/x.mp3", "upload_url": "https://r2.test/put/x"}
            )
        if request.method == "HEAD":
            return httpx.Response(404)
        return httpx.Response(200)

    with pytest.raises(ThankYouError) as exc:
        run(make_client(handler).upload_file(make_file(tmp_path)))
    assert exc.value.code == "UPLOAD_NOT_READY"
    assert "404" in exc.value.message


# ---------- 失败路径 ----------


def test_upload_rejects_missing_file(tmp_path):
    """本地文件不存在 / 为空，不该白跑一趟上游。"""
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:  # pragma: no cover - 不该被调用
        calls.append(request.method)
        return httpx.Response(201, json={})

    missing = tmp_path / "nope.mp3"
    with pytest.raises(ThankYouError) as exc:
        run(make_client(handler).upload_file(missing))
    assert exc.value.code == "FILE_NOT_FOUND"
    assert calls == []

    empty = tmp_path / "empty.mp3"
    empty.write_bytes(b"")
    with pytest.raises(ThankYouError) as exc2:
        run(make_client(handler).upload_file(empty))
    assert exc2.value.code == "FILE_NOT_FOUND"
    assert calls == []


def test_upload_surfaces_post_rejection(tmp_path):
    """POST 被拒（如 422 少字段）时，把上游的原因带出来，不要吞成通用错误。"""
    detail = [{"loc": ["content_type"], "msg": "Field required"}]

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(422, json={"detail": detail})

    with pytest.raises(ThankYouError) as exc:
        run(make_client(handler).upload_file(make_file(tmp_path)))
    assert exc.value.status == 422
    assert "content_type" in exc.value.message


def test_upload_fails_when_put_rejected(tmp_path):
    """PUT 被拒就是真失败 —— 不能因为 POST 成功了就返回一个用不了的 file_id。"""
    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "POST":
            return httpx.Response(201, json={"file_id": "file_x", "upload_url": "https://r2.test/put/x"})
        return httpx.Response(403, text="<Error><Code>SignatureDoesNotMatch</Code></Error>")

    with pytest.raises(ThankYouError) as exc:
        run(make_client(handler).upload_file(make_file(tmp_path)))
    assert exc.value.code == "UPLOAD_FAILED"
    assert "403" in exc.value.message


def test_upload_maps_network_error(tmp_path):
    """网络层异常要映射成可展示的 code，而不是漏出 httpx 的原始异常。"""
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused")

    with pytest.raises(ThankYouError) as exc:
        run(make_client(handler).upload_file(make_file(tmp_path)))
    assert exc.value.code == "UPSTREAM_UNREACHABLE"
    assert exc.value.status == 502
