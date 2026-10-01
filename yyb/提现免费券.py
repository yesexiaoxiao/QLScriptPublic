#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# name: 提现免费券
# cron: 12 9 * * *
#
# 环境变量：
#   YYB_SERVER     每行：地址@账号标识（例如 http://yyb-go:8000@1）
#   YYB_API_KEY    可选；yyb-go 配置 YYB_PROTOCOL_TOKEN 时填同一令牌
#   TXFREE_NOTIFY  0 关闭青龙通知；默认 1
#
# 参考模版：Template/hsy.py —— 由 YYB-Go 的 /wxapp/getCode 取 wx.login code，
# 之后全部走小程序业务接口（不再依赖 wx_server_url / wx_auth 桥接服务）。
# 本文件是 wxapp/提现免费券.py 的 YYB-Go 版本，原桥接版脚本保持不变。

from __future__ import annotations

import os
import random
import secrets
import string
import sys
import time
from typing import Any

import requests
import urllib3

urllib3.disable_warnings()

# ── 小程序 & 接口 ──
APPID = "wxdb3c0e388702f785"
DOMAIN = "https://discount.wxpapp.wechatpay.cn"
PAGE = "pages/gift/index"
MODULE_NAME = "mmpaytxbbsmp"
PAGE_FRAME_VERSION = "180"
SESSION_SCENE = "daily_reward"
USER_AGENT = (
    "Mozilla/5.0 (Linux; Android 13; Mobile) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 "
    "Chrome/132.0.0.0 Mobile Safari/537.36 "
    "MicroMessenger/8.0.50 NetType/WIFI Language/zh_CN "
    "ABI/arm64 MiniProgramEnv/android"
)

# ── 领券策略 ──
TARGET_COUPON_ID: int | None = None  # None=自动选未领取的券，或指定券ID

# ── 超时 ──
TIMEOUT = 30  # YYB 取 code
API_TIMEOUT = 15  # 小程序业务接口


class ClaimError(RuntimeError):
    pass


def routes() -> list[tuple[str, str]]:
    values = []
    for lineno, raw in enumerate(os.getenv("YYB_SERVER", "").splitlines(), 1):
        raw = raw.strip()
        if not raw:
            continue
        if "@" not in raw:
            raise RuntimeError(f"YYB_SERVER 第 {lineno} 行格式错误，应为 地址@账号标识")
        server, ref = raw.rsplit("@", 1)
        server, ref = server.strip().rstrip("/"), ref.strip()
        if not server or not ref:
            raise RuntimeError(f"YYB_SERVER 第 {lineno} 行格式错误，应为 地址@账号标识")
        if not server.startswith(("http://", "https://")):
            server = "http://" + server
        values.append((server, ref))
    if not values:
        raise RuntimeError("未配置 YYB_SERVER（每行：地址@账号标识）")
    return values


def yyb_code(server: str, ref: str) -> str:
    # 调用 wx.login 取码前先等一会儿：基准 YYB_CODE_DELAY_MS（默认 60000），实际等 0.75~1.5 倍
    # 随机（默认 45~90 秒），避免多脚本同时启动后在同一秒向同一账号取码；设 0 关闭。
    base_ms = int(os.getenv("YYB_CODE_DELAY_MS", "60000") or 0)
    if base_ms > 0:
        delay_ms = int(base_ms * random.uniform(0.75, 1.5))
        print(f"⏳ 取码前等待 {delay_ms / 1000:g} 秒（调用 wx.login 前延时 + 随机抖动）", flush=True)
        time.sleep(delay_ms / 1000)
    # YYB-Go：POST /wxapp/getCode，body {"ref": 账号标识, "app_id": 小程序 APPID}。
    headers = {}
    api_key = os.getenv("YYB_API_KEY", "").strip()
    if api_key:
        headers["Authorization"] = "Bearer " + api_key
    try:
        response = requests.post(
            f"{server}/wxapp/getCode",
            json={"ref": ref, "app_id": APPID},
            headers=headers,
            timeout=TIMEOUT,
        )
        response.raise_for_status()
    except requests.RequestException as err:
        raise ClaimError(f"YYB 取 code 失败：{err}") from err
    try:
        body = response.json()
    except ValueError as err:
        raise ClaimError(f"YYB 取 code 返回非 JSON：HTTP {response.status_code}") from err
    if not isinstance(body, dict):
        raise ClaimError(f"YYB 取 code 返回格式异常：{body!r}")
    try:
        ok = int(body.get("code", -1)) == 0
    except (TypeError, ValueError):
        ok = False
    if not ok:
        raise ClaimError(f"YYB 取 code 失败：{body.get('msg') or body.get('message') or body}")
    data = body.get("data")
    result = data.get("result") if isinstance(data, dict) else None
    code = result if isinstance(result, str) else (result or {}).get("code")
    if not code:
        raise ClaimError("YYB 未返回 data.result.code")
    return str(code)


def login(session: requests.Session, server: str, ref: str, track_id: str) -> str:
    code = yyb_code(server, ref)
    data = api_get(
        session,
        "/txbbs-user/user/login",
        headers=make_headers(track_id, jscode=code),
    )
    token = data.get("session_token")
    if not isinstance(token, str) or not token:
        raise ClaimError(f"登录返回缺少 session_token：{data}")
    return token


def query_coupons(session: requests.Session, session_token: str, track_id: str) -> list[dict[str, Any]]:
    data = api_get(
        session,
        "/txbbs-mall/coupon/querydailygiftcoupons",
        headers=make_headers(track_id, session_token=session_token),
    )
    items = data.get("coupon_items")
    if not isinstance(items, list):
        raise ClaimError(f"查询返回缺少 coupon_items：{data}")
    return [item for item in items if isinstance(item, dict)]


def select_coupon(coupons: list[dict[str, Any]]) -> dict[str, Any] | None:
    if TARGET_COUPON_ID is not None:
        return next((item for item in coupons if coupon_id(item) == TARGET_COUPON_ID), None)
    return next((item for item in coupons if not item.get("is_claimed") and coupon_id(item)), None)


def claim_coupon(
    session: requests.Session,
    session_token: str,
    track_id: str,
    coupon: dict[str, Any],
) -> None:
    cid = coupon_id(coupon)
    gift_type = coupon.get("daily_gift_type")
    amount = coupon_face_value(coupon)

    if not isinstance(cid, int):
        raise ClaimError(f"券缺少 coupon_id：{coupon}")
    if not isinstance(gift_type, str) or not gift_type:
        raise ClaimError(f"券缺少 daily_gift_type：{coupon}")
    if not isinstance(amount, int):
        raise ClaimError(f"券缺少 face_value：{coupon}")

    api_post(
        session,
        "/txbbs-mall/coupon/claimdailygiftcoupon",
        headers=make_headers(
            track_id,
            session_token=session_token,
            session_id=make_session_id(),
        ),
        json={
            "daily_gift_type": gift_type,
            "coupon_id": cid,
            "expected_send_amount": amount,
        },
    )


def api_get(session: requests.Session, path: str, *, headers: dict[str, str]) -> dict[str, Any]:
    response = session.get(f"{DOMAIN}{path}", headers=headers, timeout=API_TIMEOUT)
    return unwrap_response(response, path)


def api_post(
    session: requests.Session,
    path: str,
    *,
    headers: dict[str, str],
    json: dict[str, Any],
) -> dict[str, Any]:
    response = session.post(f"{DOMAIN}{path}", headers=headers, json=json, timeout=API_TIMEOUT)
    return unwrap_response(response, path)


def unwrap_response(response: requests.Response, action: str) -> dict[str, Any]:
    try:
        response.raise_for_status()
        payload = response.json()
    except Exception as err:
        raise ClaimError(f"{action} 请求失败：{err}，响应：{response.text}") from err

    if not isinstance(payload, dict):
        raise ClaimError(f"{action} 返回格式异常：{payload!r}")
    if payload.get("errcode") != 0:
        raise ClaimError(f"{action} 返回失败：errcode={payload.get('errcode')}，{payload}")

    data = payload.get("data")
    return data if isinstance(data, dict) else {}


def make_headers(
    track_id: str,
    *,
    jscode: str | None = None,
    session_token: str | None = None,
    session_id: str | None = None,
) -> dict[str, str]:
    headers = {
        "User-Agent": USER_AGENT,
        "Content-Type": "application/json",
        "X-Page": PAGE,
        "X-Track-Id": track_id,
        "xweb_xhr": "1",
        "X-Module-Name": MODULE_NAME,
        "X-Appid": APPID,
        "Sec-Fetch-Site": "cross-site",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Dest": "empty",
        "Referer": f"https://servicewechat.com/{APPID}/{PAGE_FRAME_VERSION}/page-frame.html",
        "Accept-Language": "zh-CN,zh;q=0.9",
    }
    if jscode:
        headers["jscode"] = jscode
    if session_token:
        headers["session-token"] = session_token
    if session_id:
        headers["session-id"] = session_id
    return headers


def make_track_id() -> str:
    return "T" + "".join(secrets.choice("0123456789ABCDEF") for _ in range(31))


def make_session_id() -> str:
    alphabet = string.ascii_lowercase + string.digits
    random_part = "".join(secrets.choice(alphabet) for _ in range(10))
    return f"{SESSION_SCENE}-{int(time.time() * 1000)}-{random_part}"


def coupon_info(coupon: dict[str, Any]) -> dict[str, Any]:
    value = coupon.get("coupon_info")
    return value if isinstance(value, dict) else {}


def coupon_id(coupon: dict[str, Any]) -> int | None:
    value = coupon_info(coupon).get("coupon_id")
    return value if isinstance(value, int) else None


def coupon_face_value(coupon: dict[str, Any]) -> int | None:
    value = coupon_info(coupon).get("face_value")
    return value if isinstance(value, int) else None


def coupon_name(coupon: dict[str, Any]) -> str:
    name = coupon_info(coupon).get("name")
    if isinstance(name, str) and name:
        return name
    return f"coupon_id={coupon_id(coupon)}"


def coupon_amount(coupon: dict[str, Any]) -> str:
    amount = coupon_face_value(coupon)
    if not isinstance(amount, int):
        return "未知额度"
    return f"{amount // 100}元" if amount % 100 == 0 else f"{amount / 100:.2f}元"


def mask_ref(ref: str) -> str:
    return ref if len(ref) <= 12 else f"{ref[:6]}...{ref[-4:]}"


def notify(lines: list[str]) -> None:
    if os.getenv("TXFREE_NOTIFY", "1").lower() in {"0", "false", "no"}:
        return
    for path in (os.path.dirname(os.path.abspath(__file__)), "/ql/data/scripts", "/ql/scripts"):
        if path not in sys.path:
            sys.path.insert(0, path)
    try:
        from notify import send
        send("提现免费券", "\n".join(lines))
    except Exception as exc:
        print(f"[通知] 发送失败（不影响任务）：{exc}")


def run_one(index: int, server: str, ref: str) -> list[str]:
    result = [f"账号 {index}（YYB {mask_ref(ref)}）"]
    session = requests.Session()
    session.verify = False
    session.headers.update({"User-Agent": USER_AGENT})
    try:
        track_id = make_track_id()
        session_token = login(session, server, ref, track_id)
        result.append("登录成功")
        coupons = query_coupons(session, session_token, track_id)
        coupon = select_coupon(coupons)
        if coupon is None:
            claimed = next((item for item in coupons if item.get("is_claimed")), None)
            if claimed:
                result.append(f"今日已领取：{coupon_name(claimed)}（当前额度 {coupon_amount(claimed)}）")
            else:
                result.append("未查询到每日额度")
        elif coupon.get("is_claimed"):
            result.append(f"今日已领取：{coupon_name(coupon)}（当前额度 {coupon_amount(coupon)}）")
        else:
            claim_coupon(session, session_token, track_id, coupon)
            result.append(f"领取成功：{coupon_name(coupon)}，到账额度 {coupon_amount(coupon)}")
    except Exception as exc:
        result.append(f"失败：{exc}")
    print(" | ".join(result))
    return result


def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except AttributeError:
        pass

    output = ["提现免费券：领取微信支付每日提现免费券"]
    failures = 0
    for index, (server, ref) in enumerate(routes(), 1):
        lines = run_one(index, server, ref)
        output.extend(lines)
        if any(line.startswith("失败：") for line in lines):
            failures += 1
    notify(output)
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
