#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# 无影云电脑 - 每日签到得灵豆
# 入口: 微信小程序「无影云电脑」-> 我的 -> 签到  (灵豆可用于续费云电脑时长)
# name: 无影云电脑签到
# cron: 40 9 * * *
#
# 环境变量：
#   YYB_SERVER    每行：地址@账号标识（例如 http://yyb-go:8000@1）
#   YYB_API_KEY   可选；yyb-go 配置 YYB_PROTOCOL_TOKEN 时填同一令牌
#
# 参考模版：Template/hsy.py —— 由 YYB-Go 的 /wxapp/getCode 取 wx.login code，
# 之后全部走小程序自己的业务接口（不再依赖 wx_server_url / wx_auth 桥接服务）。
# 本文件是 wxapp/wuyingyundiannao.py 的 YYB-Go 版，原桥接版脚本保持不变。

import json
import os
import random
import sys
import time
import urllib.parse
import uuid
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
MINI_APP_ID = "wx66f97ce0a56f08c7"
# 阿里云账号 OAuth (SDK env=prod -> account.aliyun.com), 静默登录接口
OAUTH_BASE = "https://account.aliyun.com"
# 账号服务 (换取 LoginToken/SessionId)
ACCOUNT_EP = "https://appstream-center.cn-shanghai.aliyuncs.com"
ACCOUNT_VER = "2022-11-22"
# 桌面服务 (用户/活动/签到)
DESKTOP_EP = "https://wuying-personal-pc.cn-hangzhou.aliyuncs.com"
DESKTOP_VER = "2022-10-01"
APP_VERSION_INFO = "20260112"                 # genOpenApiUrl 内置 AppVersionInfo
FROM_CLIENT = "miniapp_weixin"
# 阿里云 OpenAPI 业务成功标识 (desktop/account 业务接口: Code==="success")
BIZ_OK = "success"
# 会话失效 -> 需重新登录
SESSION_INVALID = ("User.LoginInvalid", "InvalidLoginToken.Missing", "NOT_LOGIN")

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
    # 调用 wx.login 取码前先等一会儿：基准 YYB_CODE_DELAY_MS（默认 60000），实际等 0.75~1.5 倍
    # 随机（默认 45~90 秒），避免多脚本同时启动后在同一秒向同一账号取码；设 0 关闭。
    base_ms = int(os.getenv("YYB_CODE_DELAY_MS", "60000") or 0)
    if base_ms > 0:
        delay_ms = int(base_ms * random.uniform(0.75, 1.5))
        print(f"⏳ 取码前等待 {delay_ms / 1000:g} 秒（调用 wx.login 前延时 + 随机抖动）", flush=True)
        time.sleep(delay_ms / 1000)
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


TOKEN_CACHE_PATH = Path(__file__).with_name("wuyingyundiannao_token_cache.json")
# 手动会话逃生口: wuying_token = "LoginToken#SessionId", 按账号顺序换行/& 分割
MANUAL_SESSIONS = [x.strip() for x in
                   os.getenv("wuying_token", "").replace("&", "\n").splitlines()
                   if x.strip()]
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
def mask(value):
    if not value:
        return ""
    value = str(value)
    if len(value) <= 12:
        return value[:2] + "***"
    return f"{value[:6]}***{value[-4:]}"


def read_token_cache():
    try:
        if TOKEN_CACHE_PATH.exists():
            return json.loads(TOKEN_CACHE_PATH.read_text(encoding="utf-8")) or {}
    except Exception:
        pass
    return {}


def write_token_cache(cache):
    try:
        TOKEN_CACHE_PATH.write_text(
            json.dumps(cache, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception as e:
        print(f"⚠️ 写入token缓存失败: {e}")


def get_cached_session(openid):
    return read_token_cache().get(openid) or {}


def save_cached_session(openid, login_token, session_id):
    cache = read_token_cache()
    cache[openid] = {"LoginToken": login_token, "SessionId": session_id,
                     "updatedAt": int(time.time())}
    write_token_cache(cache)


def remove_cached_session(openid):
    cache = read_token_cache()
    if openid in cache:
        del cache[openid]
        write_token_cache(cache)


# ---------------------------------------------------------------------------
# smallcat: openid -> wx.login code
# ---------------------------------------------------------------------------
# 当前账号的 YYB 服务地址（main 遍历账号时通过 run_account 写入；取码需要 服务地址 + 账号标识）
YYB_SERVER_URL = ""


# YYB-Go: 账号标识 -> wx.login code（同账号取码由 YYB 串行处理，不需要再 /wx/refresh）
def get_wx_code(openid):
    last_msg = ""
    for attempt in range(4):
        if attempt:
            time.sleep(3)
        try:
            return yyb_code(YYB_SERVER_URL, openid)
        except Exception as exc:
            last_msg = str(exc)
    raise RuntimeError(f"YYB-Go 获取 code 失败(已重试): {last_msg}")

# ---------------------------------------------------------------------------
def aliyun_authlogin(code):
    """POST {OAUTH_BASE}/weixin/authLogin.html?code=..&appId=.. -> 响应 data。

    SDK 内部 resolve(response.data), 故取 body['data']。返回含 state/st 的节点。
    state: loginSuccess=已绑定(有 st) / register=未绑定阿里云账号(需注册)
           identityVerify=需实名 / 其它=异常。
    """
    qs = urllib.parse.urlencode({"code": code, "appId": MINI_APP_ID})
    resp = session.post(
        f"{OAUTH_BASE}/weixin/authLogin.html?{qs}",
        data=b"",
        headers={"content-type": "application/x-www-form-urlencoded",
                 "User-Agent": DEFAULT_UA,
                 "Referer": f"https://servicewechat.com/{MINI_APP_ID}/0/page-frame.html"},
        timeout=30,
    )
    resp.raise_for_status()
    body = resp.json()
    node = body.get("data") if isinstance(body.get("data"), dict) else body
    return node or {}


# ---------------------------------------------------------------------------
# 阿里云 OpenAPI (复刻 genOpenApiUrl: 通用参数, 客户端签名已禁用故无需签名)
# ---------------------------------------------------------------------------
def _open_api(endpoint, action, version, params, method="GET"):
    q = {
        "Action": action,
        "Format": "JSON",
        "SignatureMethod": "HMAC-SHA1",
        "SignatureNonce": uuid.uuid4().hex,
        "SignatureVersion": "1.0",
        "Timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "Version": version,
        "From": FROM_CLIENT,
        "AppVersionInfo": APP_VERSION_INFO,
    }
    q.update({k: v for k, v in params.items() if v is not None})
    headers = {"User-Agent": DEFAULT_UA,
               "Referer": f"https://servicewechat.com/{MINI_APP_ID}/0/page-frame.html"}
    url = f"{endpoint}?{urllib.parse.urlencode(sorted(q.items()))}"
    if method.upper() == "POST":
        resp = session.post(url, data={}, headers=headers, timeout=30)
    else:
        resp = session.get(url, headers=headers, timeout=30)
    resp.raise_for_status()
    return resp.json()


def get_login_token(st):
    """st -> GetLoginTokenByAuthCode -> {LoginToken, SessionId}。成功时 Code 为空。"""
    resp = _open_api(ACCOUNT_EP, "GetLoginTokenByAuthCode", ACCOUNT_VER, {
        "AuthCode": st, "AccountType": "aliyun",
        "Scene": "WEIXIN_MINI_APP_AUTO_LOGIN", "ClientType": FROM_CLIENT})
    node = resp.get("data") if isinstance(resp.get("data"), dict) else resp
    if node.get("Code"):                       # 登录类接口: 有 Code 即失败
        raise RuntimeError(f"换取登录凭证失败: {node.get('Code')} {node.get('Message', '')}")
    lt, sid = node.get("LoginToken"), node.get("SessionId")
    if not (lt and sid):
        raise RuntimeError("换取登录凭证响应缺少 LoginToken/SessionId")
    return lt, sid


def refresh_login_token(login_token, session_id):
    """RefreshLoginToken: 复用缓存会话。失败返回 None。"""
    try:
        resp = _open_api(ACCOUNT_EP, "RefreshLoginToken", ACCOUNT_VER, {
            "LoginToken": login_token, "SessionId": session_id,
            "ClientId": f"{session_id}0000", "ClientType": FROM_CLIENT})
        node = resp.get("data") if isinstance(resp.get("data"), dict) else resp
        if node.get("Code"):
            return None
        lt = node.get("LoginToken") or login_token
        sid = node.get("SessionId") or session_id
        return lt, sid
    except Exception:
        return None


# ---------------------------------------------------------------------------
# 签到业务 (desktop 服务; 业务接口 Code==="success")
# ---------------------------------------------------------------------------
def _biz_ok(resp):
    node = resp if isinstance(resp, dict) else {}
    return str(node.get("Code")) == BIZ_OK


def _biz_code(resp):
    return (resp or {}).get("Code")


def _is_session_invalid(resp):
    return str((resp or {}).get("Code")) in SESSION_INVALID


def describe_benefit_activities(lt, sid):
    return _open_api(DESKTOP_EP, "DescribeUserBenefitActivities", DESKTOP_VER, {
        "LoginToken": lt, "SessionId": sid, "Scene": "weixin",
        "ClientType": FROM_CLIENT})


def describe_operation_activities(lt, sid):
    return _open_api(DESKTOP_EP, "DescribeOperationActivities", DESKTOP_VER, {
        "LoginToken": lt, "SessionId": sid, "Scene": "weixin",
        "ActivityDisplayType": "Banner", "ClientType": FROM_CLIENT})


SIGNIN_HINT = ("signin", "sign_in", "attend", "checkin", "check_in", "dailycheck",
               "clockin", "签到", "打卡", "每日")


def _looks_like_signin(obj):
    """在活动卡片对象里判断是否为签到活动 (按类型/名称关键字启发式)。"""
    blob = json.dumps(obj, ensure_ascii=False).lower()
    return any(h in blob for h in SIGNIN_HINT)


def _iter_activities(resp):
    """从 DescribeUserBenefitActivities/OperationActivities 响应里迭代活动对象。"""
    node = resp.get("data") if isinstance(resp.get("data"), dict) else resp
    data = node.get("Data") if isinstance(node.get("Data"), dict) else node
    for key in ("OperationCards", "Activities", "ActivityList", "List", "Cards"):
        arr = data.get(key) if isinstance(data, dict) else None
        if isinstance(arr, list):
            for it in arr:
                if isinstance(it, dict):
                    yield it


def find_signin_activity_id(lt, sid):
    """运行时定位「每日签到」活动的 ActivityId。
    返回 (activity_id, act, session_bad)。定位不到时 activity_id 为 None。"""
    session_bad = False
    for fetch in (describe_benefit_activities, describe_operation_activities):
        try:
            resp = fetch(lt, sid)
        except Exception as e:
            print(f"  活动列表获取失败({fetch.__name__}): {e}")
            continue
        if _is_session_invalid(resp):
            session_bad = True
            break
        if not _biz_ok(resp):
            print(f"  活动列表返回 Code={_biz_code(resp)}")
            continue
        for act in _iter_activities(resp):
            if _looks_like_signin(act):
                aid = (act.get("ActivityId") or act.get("activityId")
                       or act.get("Id") or act.get("id"))
                if aid:
                    return str(aid), act, session_bad
    return None, None, session_bad


def attendance_count(lt, sid, activity_id):
    try:
        resp = _open_api(DESKTOP_EP, "DescribeUserActivityAttendanceCount",
                         DESKTOP_VER, {"LoginToken": lt, "SessionId": sid,
                                       "ActivityId": activity_id})
        node = resp.get("data") if isinstance(resp.get("data"), dict) else resp
        return node
    except Exception:
        return None


def attend_activity(lt, sid, activity_id):
    """AttendUserBenefitActivity (POST): 完成一次签到。返回 (成功?, 文案)。"""
    resp = _open_api(DESKTOP_EP, "AttendUserBenefitActivity", DESKTOP_VER, {
        "LoginToken": lt, "SessionId": sid, "ActivityId": activity_id},
        method="POST")
    node = resp.get("data") if isinstance(resp.get("data"), dict) else resp
    code = str(node.get("Code"))
    msg = node.get("Message") or ""
    if code == BIZ_OK:
        return True, "签到成功"
    # 服务端对重复签到通常返回可识别的 Code/Message, 视为幂等成功
    if any(k in (code + msg).lower() for k in ("already", "repeat", "duplicate",
                                               "已签", "已参与", "重复")):
        return True, "今日已签到"
    return False, f"签到失败: {code} {msg}".strip()


# ---------------------------------------------------------------------------
# 会话获取: 缓存(刷新) -> 静默登录
# ---------------------------------------------------------------------------
def obtain_session(openid, index, force=False):
    """返回 (login_token, session_id, state)。
    state 为 'ok' 表示已登录; 其余为前置条件说明字符串。force=True 跳过缓存强制重登。"""
    # 0) 手动会话(逃生口): 静默登录被阿里云风控拦下时, 用户可自行从小程序里取到
    #    LoginToken/SessionId 填进 wuying_token, 脚本用 RefreshLoginToken 续期。
    manual = MANUAL_SESSIONS[index - 1] if index - 1 < len(MANUAL_SESSIONS) else ""
    if manual and not force:
        parts = [p.strip() for p in manual.replace("&", "#").split("#") if p.strip()]
        if len(parts) >= 2:
            refreshed = refresh_login_token(parts[0], parts[1])
            if refreshed:
                lt, sid = refreshed
                save_cached_session(openid, lt, sid)
                print(f"账号 {index} 使用手动会话(已刷新): {mask(lt)}")
                return lt, sid, "ok"
            print(f"账号 {index} wuying_token 已失效, 回退到静默登录")
        else:
            print(f"账号 {index} wuying_token 格式应为 LoginToken#SessionId, 已忽略")

    # 1) 复用缓存并尝试刷新
    if force:
        remove_cached_session(openid)
    else:
        cached = get_cached_session(openid)
        if cached.get("LoginToken") and cached.get("SessionId"):
            refreshed = refresh_login_token(cached["LoginToken"], cached["SessionId"])
            if refreshed:
                lt, sid = refreshed
                save_cached_session(openid, lt, sid)
                print(f"账号 {index} 使用缓存会话(已刷新): {mask(lt)}")
                return lt, sid, "ok"
            remove_cached_session(openid)

    # 2) 静默登录 (wx.login code -> authLogin)
    code = get_wx_code(openid)
    node = aliyun_authlogin(code)
    state = node.get("state")
    st = node.get("st")
    if state == "loginSuccess" and st:
        lt, sid = get_login_token(st)
        save_cached_session(openid, lt, sid)
        print(f"账号 {index} 静默登录成功: {mask(lt)}")
        return lt, sid, "ok"

    # 3) 各类前置条件 (不自动触发注册/实名/手机号授权)
    if state in ("register", "NeedOAuth", None):
        return None, None, ("该微信身份尚未绑定阿里云账号, 需先在小程序「无影云电脑→我的→"
                            "签到/登录」完成手机号授权并绑定阿里云账号后才能签到")
    if state in ("identityVerify", "IV"):
        # 注意: 这不是「实名认证」——已实名的账号同样会收到。阿里云对本次静默登录
        # 下发了一次性「安全验证/身份核验」挑战: authLogin 只回 ivToken 不回 st,
        # 小程序的做法是 webview 打开 account.aliyun.com/iv/ivRender?ivToken=<token>
        # 让用户当场过挑战(见 vendor.js getIVHost / SignState.IV)。ivToken 每次
        # 请求都是新的, 说明是按登录上下文(IP/设备指纹)下发的风控挑战, 属风控边界,
        # 脚本不代为完成、也不绕过。
        return None, None, ("阿里云对本次静默登录下发了『安全验证』挑战(state="
                            "identityVerify, 与实名认证无关, 已实名也会遇到)。"
                            "脚本不会代过风控验证。两种解法: ① 在小程序「无影云电脑」"
                            "内登录一次并按提示完成安全验证, 让阿里云信任该登录环境; "
                            "② 从小程序里取到 LoginToken 与 SessionId, 填入变量 "
                            "wuying_token(格式 LoginToken#SessionId), 脚本会自动续期。")
    return None, None, f"登录状态异常(state={state}), 请在小程序内手动登录一次后重试"


# ---------------------------------------------------------------------------
# 主流程 (每账号一次幂等签到)
# ---------------------------------------------------------------------------
def run_account(openid, index, server):
    global YYB_SERVER_URL
    YYB_SERVER_URL = server
    lines = [f"【账号 {index}】"]

    lt, sid, state = obtain_session(openid, index)
    if state != "ok":
        print(f"⚠️ 账号 {index} {state}")
        lines.append(f"⚠️ {state}")
        return "\n".join(lines), False

    # 定位签到活动 (签到页在分包内为空壳, ActivityId 需运行时从活动列表发现)
    activity_id, act, session_bad = find_signin_activity_id(lt, sid)
    if session_bad:                       # 会话失效 -> 强制重登重试一次
        print(f"账号 {index} 会话失效, 重新登录...")
        lt, sid, state = obtain_session(openid, index, force=True)
        if state != "ok":
            print(f"⚠️ 账号 {index} {state}")
            lines.append(f"⚠️ {state}")
            return "\n".join(lines), False
        activity_id, act, session_bad = find_signin_activity_id(lt, sid)
    if not activity_id:
        msg = ("未能定位「每日签到」活动 (活动列表中无签到活动, 可能活动未上线, "
               "或需在小程序内进入签到页抓取 ActivityId)")
        print(f"⚠️ 账号 {index} {msg}")
        lines.append(f"⚠️ {msg}")
        return "\n".join(lines), False
    print(f"账号 {index} 定位到签到活动 ActivityId={activity_id}")

    # 幂等信号 (best-effort): 参与次数
    cnt = attendance_count(lt, sid, activity_id)
    if isinstance(cnt, dict) and cnt.get("Count") is not None:
        print(f"账号 {index} 当前参与次数: {cnt.get('Count')}")

    # 执行一次签到
    ok, msg = attend_activity(lt, sid, activity_id)
    if ok:
        print(f"🎉 账号 {index} {msg}")
        lines.append(f"🎉 {msg}")
        return "\n".join(lines), True
    print(f"❌ 账号 {index} {msg}")
    lines.append(f"❌ {msg}")
    return "\n".join(lines), False


def main():
    try:
        route_list = routes()
    except RuntimeError as exc:
        print(f"❌ {exc}")
        return

    print("=============== 无影云电脑 签到开始 ===============")
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

    print("\n=============== 无影云电脑 签到结束 ===============")
    title = f"无影云电脑签到 {ok_count}/{len(route_list)} 成功"
    try:
        send(title, "\n\n".join(summaries))
    except Exception as e:
        print(f"⚠️ 通知发送失败: {e}")


if __name__ == "__main__":
    main()
