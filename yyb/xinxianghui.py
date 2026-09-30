#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# name: 芯享会签到
# cron: 20 9 * * *
#
# 环境变量：
#   YYB_SERVER          每行：地址@账号标识（例如 http://yyb-go:8000@1）
#   YYB_API_KEY         可选；yyb-go 配置 YYB_PROTOCOL_TOKEN 时填同一令牌
#   xxh_version         miniProgram.version，发布版通常为空串，一般无需修改
#   xxh_nickname        首次授权注册时提交的昵称；默认 微信用户
#   XXH_NOTIFY          0 关闭青龙通知；默认 1
#
# 入口: 微信小程序「芯享会」-> 我的(下拉/任务福利) -> 签到
#
# 参考模版：Template/hsy.py —— 由 YYB-Go 的 /wxapp/getCode 取 wx.login code，
# 之后全部走芯享会自己的业务接口（不再依赖 wx_server_url / wx_auth 桥接服务）。
# 本文件是 wxapp/xinxianghui.py 的 YYB-Go 版，原桥接版脚本保持不变。

import hashlib
import json
import os
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

# ---------------------------------------------------------------------------
# 常量 (均来自小程序反编译源码, 非机密)
# ---------------------------------------------------------------------------
MINI_APP_ID = "wx13ce9eedfb50ea1b"
BASE_URL = "https://jbl-xxh-api.91dh.com.cn"
SALT = "mGiz2csojwbADX9DETPK38jbFpw28YOj"          # utils/util.js 签名盐
SUCCESS_CODE = 10000                                # 1e4
SESSION_INVALID_CODE = 20003                        # 登录会话失效 -> 需重新登录
NEED_AUTH_CODES = (20008, 20010)                    # 需授权 / 需手机号 (账号前置条件)
TIMEOUT = 30                                        # YYB 取码 / 业务接口

# miniProgram.version, 发布版通常为空串; 服务端按传入值重算签名, 一般无需修改
VERSION = os.getenv("xxh_version", "")
# 首次登录(注册)时提交的昵称; 仅在账号未授权时使用, 不会覆盖已注册账号
NICKNAME = os.getenv("xxh_nickname", "微信用户")

TOKEN_CACHE_PATH = Path(__file__).with_name("xinxianghui_token_cache.json")
DEFAULT_UA = (
    "Mozilla/5.0 (Linux; Android 13; SM-G9910 Build/TP1A.220624.014) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Mobile Safari/537.36 "
    "MicroMessenger/8.0.49.2600(0x28003137) NetType/WIFI Language/zh_CN "
    "miniProgram/" + MINI_APP_ID
)

session = requests.Session()


# ---------------------------------------------------------------------------
# YYB-Go: 账号 -> wx.login code
# ---------------------------------------------------------------------------
def routes():
    # YYB_SERVER 每行：地址@账号标识（与 Template/hsy.py 一致）。
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


def yyb_code(server, ref):
    # YYB-Go：POST /wxapp/getCode {"ref": 账号标识, "app_id": 小程序 APPID}。
    # 同账号取码由 YYB-Go 串行化；code 短期且一次性，失败即抛错。
    headers = {"Content-Type": "application/json"}
    api_key = os.getenv("YYB_API_KEY", "").strip()
    if api_key:
        headers["Authorization"] = "Bearer " + api_key
    response = requests.post(
        f"{server}/wxapp/getCode",
        json={"ref": ref, "app_id": MINI_APP_ID},
        headers=headers,
        timeout=TIMEOUT,
    )
    response.raise_for_status()
    try:
        body = response.json()
    except ValueError as exc:
        raise RuntimeError(f"YYB 取 code 返回非 JSON：HTTP {response.status_code}") from exc
    if int(body.get("code", -1)) != 0:
        raise RuntimeError(f"YYB 取 code 失败：{body.get('msg') or body.get('message') or body}")
    result = (body.get("data") or {}).get("result")
    code = result if isinstance(result, str) else (result or {}).get("code")
    if not code:
        raise RuntimeError("YYB 未返回 data.result.code")
    return str(code)


# ---------------------------------------------------------------------------
# 工具函数
# ---------------------------------------------------------------------------
def now_time():
    """本地(北京)时间 YYYY-MM-DD HH:MM:SS, 对应 util.getNowTime()。"""
    return datetime.now(timezone(timedelta(hours=8))).strftime("%Y-%m-%d %H:%M:%S")


def mask(value):
    if not value:
        return ""
    value = str(value)
    if len(value) <= 12:
        return value[:2] + "***"
    return f"{value[:6]}***{value[-4:]}"


def sign_payload(fields):
    """复刻 util.getRequestData: 键名排序后拼接 key+value, sign=sha1(SALT+拼接+SALT)。"""
    concat = ""
    for key in sorted(fields.keys()):
        value = fields[key]
        if isinstance(value, (dict, list)):
            concat += key + json.dumps(value, separators=(",", ":"), ensure_ascii=False)
        else:
            concat += key + str(value)
    signed = dict(fields)
    signed["sign"] = hashlib.sha1((SALT + concat + SALT).encode("utf-8")).hexdigest()
    return signed


def read_token_cache():
    try:
        if not TOKEN_CACHE_PATH.exists():
            return {}
        return json.loads(TOKEN_CACHE_PATH.read_text(encoding="utf-8")) or {}
    except Exception:
        return {}


def write_token_cache(cache):
    try:
        TOKEN_CACHE_PATH.write_text(
            json.dumps(cache, ensure_ascii=False, indent=2), encoding="utf-8"
        )
    except Exception as e:
        print(f"[缓存] 写入token缓存失败: {e}")


def get_cached_token(ref):
    return (read_token_cache().get(ref) or {}).get("access_token")


def save_cached_token(ref, access_token):
    cache = read_token_cache()
    cache[ref] = {"access_token": access_token, "updatedAt": int(time.time())}
    write_token_cache(cache)


def remove_cached_token(ref):
    cache = read_token_cache()
    if ref in cache:
        del cache[ref]
        write_token_cache(cache)


# ---------------------------------------------------------------------------
# 芯享会 API
# ---------------------------------------------------------------------------
def api_request(endpoint, method, token, params=None):
    """复刻 utils/http.js httpReq: 签名后 GET 走 query、POST 走 body。"""
    fields = {
        "timestamp": now_time(),
        "access_token": token or "",
        "version": VERSION,
    }
    if params is not None and params != "":
        fields["params"] = json.dumps(params, separators=(",", ":"), ensure_ascii=False)
    signed = sign_payload(fields)

    url = f"{BASE_URL}{endpoint}?access_token={token or ''}"
    headers = {
        "content-type": "application/json",
        "User-Agent": DEFAULT_UA,
        "Referer": f"https://servicewechat.com/{MINI_APP_ID}/0/page-frame.html",
    }
    if method.upper() == "GET":
        resp = session.get(url, params=signed, headers=headers, timeout=TIMEOUT)
    else:
        resp = session.post(
            url,
            data=json.dumps(signed, separators=(",", ":"), ensure_ascii=False),
            headers=headers,
            timeout=TIMEOUT,
        )
    resp.raise_for_status()
    return resp.json()


def login(server, ref):
    """wx.login code -> access_token。

    优先走 /user-member/auto-login (刷新已注册账号会话, 非破坏性);
    若账号首次使用/未授权, 回退到 /user-member/user-auth 完成微信授权注册。
    """
    code = yyb_code(server, ref)
    result = api_request("/user-member/auto-login", "POST", "", {"wx_code": code})
    rcode = int(result.get("code", -1))
    if rcode == SUCCESS_CODE:
        data = result.get("data") or {}
        access_token = data.get("access_token")
        if not access_token:
            raise RuntimeError(f"登录响应缺少 access_token: {result}")
        member = data.get("member_info") or {}
        return access_token, (member.get("nickname") or member.get("nick_name") or "")

    # 首次登录: 未授权 -> 走 app 自身的授权注册流程 (user-auth)
    msg = str(result.get("msg") or "")
    if rcode in NEED_AUTH_CODES or "授权" in msg or "未注册" in msg:
        print(f"账号 {mask(ref)} 首次使用, 执行微信授权注册... ({msg})")
        code2 = yyb_code(server, ref)  # code 单次有效, 重新获取
        params = {"wx_code": code2, "nickname": NICKNAME, "avatar": "", "come_from": ""}
        auth = api_request("/user-member/user-auth", "POST", "", params)
        if int(auth.get("code", -1)) == SUCCESS_CODE:
            data = auth.get("data") or {}
            access_token = data.get("access_token")
            if not access_token:
                raise RuntimeError(f"授权响应缺少 access_token: {auth}")
            member = data.get("member_info") or {}
            return access_token, (member.get("nickname") or member.get("nick_name") or "")
        raise RuntimeError(f"授权注册失败: {auth.get('msg') or auth}")

    raise RuntimeError(f"code 登录失败: {msg or result}")


def token_for(server, ref, force=False):
    if not force:
        cached = get_cached_token(ref)
        if cached:
            return cached, f"使用缓存 token（{mask(cached)}）"
    access_token, nick = login(server, ref)
    save_cached_token(ref, access_token)
    note = "code 登录成功" + (f"（{nick}）" if nick else "")
    return access_token, f"{note}：{mask(access_token)}"


def sign_in_list(token):
    return api_request("/user-member/sign-in-list", "GET", token)


def do_sign_in(token):
    return api_request("/user-member/sign-in", "GET", token, {})


def notify(lines):
    if os.getenv("XXH_NOTIFY", "1").lower() in {"0", "false", "no"}:
        return
    for path in (os.path.dirname(os.path.abspath(__file__)), "/ql/data/scripts", "/ql/scripts"):
        if path not in sys.path:
            sys.path.insert(0, path)
    try:
        from notify import send
        send("芯享会签到", "\n".join(lines))
    except Exception as exc:
        print(f"[通知] 发送失败（不影响任务）：{exc}")


# ---------------------------------------------------------------------------
# 主流程 (每账号一次幂等签到)
# ---------------------------------------------------------------------------
def run_one(index, server, ref):
    result = [f"账号 {index}（YYB {mask(ref)}）"]
    try:
        token, note = token_for(server, ref)
        result.append(note)
        state = sign_in_list(token)

        # 会话失效 -> 强制重新登录后重试一次 (对应源码 20003 自动重登)
        if int(state.get("code", -1)) == SESSION_INVALID_CODE:
            result.append("会话失效，重新登录")
            remove_cached_token(ref)
            token, note = token_for(server, ref, force=True)
            result.append(note)
            state = sign_in_list(token)

        code = int(state.get("code", -1))
        if code in NEED_AUTH_CODES:
            if code == 20010:
                result.append("需先在小程序「我的→签到→手机号授权」绑定手机号后才能签到")
            else:
                result.append("需先在小程序内完成注册授权后才能签到")
            return result

        if code != SUCCESS_CODE:
            result.append(f"失败：{state.get('msg') or f'查询签到状态失败 code={code}'}")
            return result

        data = state.get("data") or {}
        status = data.get("status")
        xq_count = data.get("xqCount")

        # status==2 表示今日可签到 (welfare/index.wxml: 签到按钮 wx:if=status==2)
        if status != 2:
            result.append(f"今日无需签到（status={status}，连续签到 {xq_count} 天）")
            return result

        body = do_sign_in(token)
        rcode = int(body.get("code", -1))
        if rcode != SUCCESS_CODE:
            result.append(f"失败：{body.get('msg') or f'签到失败 code={rcode}'}")
            return result
        score = (body.get("data") or {}).get("score") or (body.get("data") or {}).get("point")
        result.append(f"签到成功，+{score} 好奇豆" if score else "签到成功")
    except Exception as exc:
        result.append(f"失败：{exc}")
    print("\n".join(result))
    return result


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except AttributeError:
        pass

    output = ["芯享会：签到得好奇豆"]
    for index, (server, ref) in enumerate(routes(), 1):
        output.extend(run_one(index, server, ref))
        time.sleep(1)
    notify(output)


if __name__ == "__main__":
    main()
