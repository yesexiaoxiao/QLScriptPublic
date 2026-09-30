#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# 芯享会 - 每日签到得好奇豆
# 入口: 微信小程序「芯享会」-> 我的(下拉/任务福利) -> 签到
# name: 芯享会签到
# cron: 20 9 * * *
#
# 环境变量：
#   YYB_SERVER    每行：地址@账号标识（例如 http://yyb-go:8000@1）
#   YYB_API_KEY   可选；yyb-go 配置 YYB_PROTOCOL_TOKEN 时填同一令牌
#
# 参考模版：Template/hsy.py —— 由 YYB-Go 的 /wxapp/getCode 取 wx.login code，
# 之后全部走小程序自己的业务接口（不再依赖 wx_server_url / wx_auth 桥接服务）。
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

try:
    from notify import send
except Exception:
    def send(title, content):
        print(f"\n===== {title} =====\n{content}")

# ---------------------------------------------------------------------------
# 常量 (均来自小程序反编译源码, 非机密)
# ---------------------------------------------------------------------------
MINI_APP_ID = "wx13ce9eedfb50ea1b"
BASE_URL = "https://jbl-xxh-api.91dh.com.cn"
SALT = "mGiz2csojwbADX9DETPK38jbFpw28YOj"          # utils/util.js 签名盐
SUCCESS_CODE = 10000                                # 1e4
SESSION_INVALID_CODE = 20003                        # 登录会话失效 -> 需重新登录
NEED_AUTH_CODES = (20008, 20010)                    # 需授权 / 需手机号 (账号前置条件)

# smallcat / wx_server 配置 (机密, 从环境变量读取, 绝不硬编码)
# ---------------------------------------------------------------------------
# YYB-Go：账号与取码（参考 Template/hsy.py）
# ---------------------------------------------------------------------------
def routes():
    # YYB_SERVER 每行：地址@账号标识
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
    # wx.login code 短期且一次性，失败即抛错，不重放后面的业务请求。
    headers = {"Content-Type": "application/json"}
    api_key = os.getenv("YYB_API_KEY", "").strip()
    if api_key:
        headers["Authorization"] = "Bearer " + api_key
    response = requests.post(
        f"{server}/wxapp/getCode",
        json={"ref": ref, "app_id": MINI_APP_ID},
        headers=headers,
        timeout=30,
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


def mask(ref):
    return ref if len(ref) <= 12 else f"{ref[:6]}...{ref[-4:]}"

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
        print(f"⚠️ 写入token缓存失败: {e}")


def get_cached_token(account_id):
    return (read_token_cache().get(account_id) or {}).get("access_token")


def save_cached_token(account_id, access_token):
    cache = read_token_cache()
    cache[account_id] = {"access_token": access_token, "updatedAt": int(time.time())}
    write_token_cache(cache)


def remove_cached_token(account_id):
    cache = read_token_cache()
    if account_id in cache:
        del cache[account_id]
        write_token_cache(cache)


# ---------------------------------------------------------------------------
# smallcat: openid -> wx.login code
# ---------------------------------------------------------------------------
# 当前账号的 YYB 服务地址（main 遍历账号时通过 run_account 写入；取码需要 服务地址 + 账号标识）
YYB_SERVER_URL = ""


# YYB-Go: 账号标识 -> wx.login code（同账号取码由 YYB 串行处理，不需要再 /wx/refresh）
def get_wx_code(account_id):
    last_msg = ""
    for attempt in range(4):
        if attempt:
            time.sleep(3)
        try:
            return yyb_code(YYB_SERVER_URL, account_id)
        except Exception as exc:
            last_msg = str(exc)
    raise RuntimeError(f"YYB-Go 获取 code 失败(已重试): {last_msg}")

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
        resp = session.get(url, params=signed, headers=headers, timeout=30)
    else:
        resp = session.post(
            url,
            data=json.dumps(signed, separators=(",", ":"), ensure_ascii=False),
            headers=headers,
            timeout=30,
        )
    resp.raise_for_status()
    return resp.json()


def login(account_id):
    """wx.login code -> access_token。

    优先走 /user-member/auto-login (刷新已注册账号会话, 非破坏性);
    若账号首次使用/未授权, 回退到 /user-member/user-auth 完成微信授权注册。
    """
    code = get_wx_code(account_id)
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
        print(f"  账号首次使用, 执行微信授权注册... ({msg})")
        code2 = get_wx_code(account_id)  # code 单次有效, 重新获取
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


def get_token_for_account(account_id, index, force=False):
    if not force:
        cached = get_cached_token(account_id)
        if cached:
            print(f"账号 {index} 使用缓存 token: {mask(cached)}")
            return cached
    access_token, nick = login(account_id)
    save_cached_token(account_id, access_token)
    print(f"账号 {index} code 登录成功 {('(' + nick + ')') if nick else ''}: {mask(access_token)}")
    return access_token


def sign_in_list(token):
    return api_request("/user-member/sign-in-list", "GET", token)


def do_sign_in(token):
    return api_request("/user-member/sign-in", "GET", token, {})


# ---------------------------------------------------------------------------
# 主流程 (每账号一次幂等签到)
# ---------------------------------------------------------------------------
def run_account(account_id, index, server):
    global YYB_SERVER_URL
    YYB_SERVER_URL = server
    lines = [f"【账号 {index}】"]

    token = get_token_for_account(account_id, index)
    state = sign_in_list(token)

    # 会话失效 -> 强制重新登录后重试一次 (对应源码 20003 自动重登)
    if int(state.get("code", -1)) == SESSION_INVALID_CODE:
        print(f"账号 {index} 会话失效, 重新登录...")
        remove_cached_token(account_id)
        token = get_token_for_account(account_id, index, force=True)
        state = sign_in_list(token)

    code = int(state.get("code", -1))
    if code in NEED_AUTH_CODES:
        if code == 20010:
            msg = "需先在小程序「我的→签到→手机号授权」绑定手机号后才能签到"
        else:
            msg = "需先在小程序内完成注册授权后才能签到"
        print(f"⚠️ 账号 {index} {msg} (code={code})")
        lines.append(f"⚠️ {msg}")
        return "\n".join(lines), False

    if code != SUCCESS_CODE:
        msg = state.get("msg") or f"查询签到状态失败 code={code}"
        print(f"❌ 账号 {index} {msg}")
        lines.append(f"❌ {msg}")
        return "\n".join(lines), False

    data = state.get("data") or {}
    status = data.get("status")
    xq_count = data.get("xqCount")
    print(f"账号 {index} 签到状态 status={status} 连续签到={xq_count}")

    # status==2 表示今日可签到 (welfare/index.wxml: 签到按钮 wx:if=status==2)
    if status != 2:
        msg = f"今日无需签到 (status={status}, 连续签到 {xq_count} 天)"
        print(f"✅ 账号 {index} {msg}")
        lines.append(f"✅ {msg}")
        return "\n".join(lines), True

    result = do_sign_in(token)
    rcode = int(result.get("code", -1))
    if rcode == SUCCESS_CODE:
        msg = "签到成功"
        rdata = result.get("data") or {}
        score = rdata.get("score") or rdata.get("point")
        if score:
            msg += f", +{score} 好奇豆"
        print(f"🎉 账号 {index} {msg}")
        lines.append(f"🎉 {msg}")
        return "\n".join(lines), True

    msg = result.get("msg") or f"签到失败 code={rcode}"
    print(f"❌ 账号 {index} {msg}")
    lines.append(f"❌ {msg}")
    return "\n".join(lines), False


def main():
    try:
        route_list = routes()
    except RuntimeError as exc:
        print(f"❌ {exc}")
        return

    print("=============== 芯享会 签到开始 ===============")
    summaries = []
    ok_count = 0
    for i, (server, ref) in enumerate(route_list, 1):
        print(f"\n-------------- 账号 {i}({mask(ref)}) --------------")
        try:
            summary, ok = run_account(ref, i, server)
            summaries.append(summary)
            ok_count += 1 if ok else 0
        except Exception as e:
            print(f"❌ 账号 {i} 执行异常: {e}")
            summaries.append(f"【账号 {i}】\n❌ 执行异常: {e}")
        time.sleep(1)

    print("\n=============== 芯享会 签到结束 ===============")
    title = f"芯享会签到 {ok_count}/{len(route_list)} 成功"
    try:
        send(title, "\n\n".join(summaries))
    except Exception as e:
        print(f"⚠️ 通知发送失败: {e}")


if __name__ == "__main__":
    main()
