#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# name: 漓泉啤酒签到
# cron: 30 9 * * *
#
# 环境变量：
#   YYB_SERVER          每行：地址@账号标识（例如 http://yyb-go:8000@1）
#   YYB_API_KEY         可选；yyb-go 配置 YYB_PROTOCOL_TOKEN 时填同一令牌
#   LQPJ_NOTIFY         0 关闭青龙通知；默认 1
#
# 入口: 微信小程序「漓泉啤酒生态营地」-> 会员中心 -> 每日签到
# 接口契约 (来自小程序主包 common/vendor.js 反编译):
#   登录  GET  /mbr/members/wxLogin/{code}?appId=<appid>
#            -> errcode==0 且 data.b2cMemberId/openid 存在; data.token 为会话凭证
#   鉴权  请求头 Token: <token>   (响应拦截器: errcode||code, 200 成功, 401 会话失效)
#   状态  GET  /b2c/member/sign/task/list  -> data.signRes.{sign, signNum,
#            taskSignDtoList[{signTime, signStatus}]}   sign==true / 今日行
#            signStatus=="sign" 即今日已签 (幂等预检依据)
#   签到  POST /b2c/member/sign/task  body {}  -> code==200, data.signRes.sign==true
#   积分  GET  /b2c/member/pointsAndCouponCardNumAndShopCardInfo?unionId=<unionId>
#            -> data.MemberCouponShopPointsVo.pointsNum   (仅用于上报余额)
#
# 参考模版：Template/hsy.py —— 由 YYB-Go 的 /wxapp/getCode 取 wx.login code，
# 之后全部走漓泉会员自己的业务接口（不再依赖 wx_server_url / wx_auth 桥接服务）。
# 本文件是 wxapp/liquanpijiu.py 的 YYB-Go 版，原桥接版脚本保持不变。

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
MINI_APP_ID = "wx08dabaec2783f4e9"
BASE_URL = "https://api.mbr.liquan.com/api"          # vendor.js api_HOST
SUCCESS_CODE = 200
SESSION_INVALID_CODE = 401                            # 拦截器: 清 token 并重新登录
SIGNED = "sign"                                       # taskSignDtoList[].signStatus
TIMEOUT = 30                                          # YYB 取码 / 业务接口

TOKEN_CACHE_PATH = Path(__file__).with_name("liquanpijiu_token_cache.json")
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
def bj_now():
    return datetime.now(timezone(timedelta(hours=8)))


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
        print(f"[缓存] 写入token缓存失败: {e}")


def get_cached_session(ref):
    return read_token_cache().get(ref) or {}


def save_cached_session(ref, token, union_id):
    cache = read_token_cache()
    cache[ref] = {"token": token, "unionId": union_id,
                  "updatedAt": int(time.time())}
    write_token_cache(cache)


def remove_cached_session(ref):
    cache = read_token_cache()
    if ref in cache:
        del cache[ref]
        write_token_cache(cache)


# ---------------------------------------------------------------------------
# 漓泉会员 API
# ---------------------------------------------------------------------------
def api_headers(token=None):
    headers = {
        "Accept": "application/json, text/plain, */*",
        "Content-Type": "application/json;charset=UTF-8",
        "User-Agent": DEFAULT_UA,
        "Referer": f"https://servicewechat.com/{MINI_APP_ID}/0/page-frame.html",
    }
    if token:
        headers["Token"] = token            # 请求拦截器: headers.Token = 本地 token
    return headers


def api_get(path, token=None, params=None):
    resp = session.get(f"{BASE_URL}{path}", params=params or {},
                       headers=api_headers(token), timeout=TIMEOUT)
    resp.raise_for_status()
    return resp.json()


def api_post(path, body, token=None):
    resp = session.post(f"{BASE_URL}{path}",
                        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
                        headers=api_headers(token), timeout=TIMEOUT)
    resp.raise_for_status()
    return resp.json()


def resp_code(resp):
    """拦截器口径: errcode 优先, 否则 code。"""
    node = resp if isinstance(resp, dict) else {}
    for key in ("errcode", "code"):
        v = node.get(key)
        if v is not None:
            try:
                return int(v)
            except (TypeError, ValueError):
                pass
    return -1


def resp_msg(resp):
    node = resp if isinstance(resp, dict) else {}
    for key in ("errmsg", "message", "msg"):
        v = node.get(key)
        if v:
            return str(v)
    data = node.get("data")
    if isinstance(data, dict) and data.get("error"):
        return str(data["error"])
    return ""


# ---------------------------------------------------------------------------
# 登录 / 会话
# ---------------------------------------------------------------------------
def login(server, ref):
    """wx.login code -> wxLogin -> (token, unionId)。code 放在 URL 路径中。"""
    code = yyb_code(server, ref)
    resp = api_get(f"/mbr/members/wxLogin/{code}", params={"appId": MINI_APP_ID})
    if resp_code(resp) != 0:
        raise RuntimeError(f"登录失败: {resp_msg(resp) or resp_code(resp)}")
    data = resp.get("data") or {}
    token = data.get("token")
    union_id = data.get("unionid") or (data.get("wxUserInfo") or {}).get("unionId")
    if not (token and data.get("b2cMemberId")):
        raise RuntimeError("登录响应缺少 token/b2cMemberId, 需在小程序内登录一次后重试")
    return token, union_id


def obtain_session(server, ref, force=False):
    if force:
        remove_cached_session(ref)
    else:
        cached = get_cached_session(ref)
        if cached.get("token"):
            return cached["token"], cached.get("unionId"), f"使用缓存 token（{mask(cached['token'])}）"
    token, union_id = login(server, ref)
    save_cached_session(ref, token, union_id)
    return token, union_id, f"静默登录成功：{mask(token)}"


# ---------------------------------------------------------------------------
# 签到业务
# ---------------------------------------------------------------------------
def sign_state(token):
    return api_get("/b2c/member/sign/task/list", token=token)


def do_sign(token):
    return api_post("/b2c/member/sign/task", {}, token=token)


def points_balance(token, union_id):
    """仅读取积分余额用于上报, 失败返回 None (不影响签到结论)。"""
    if not union_id:
        return None
    try:
        resp = api_get("/b2c/member/pointsAndCouponCardNumAndShopCardInfo",
                       token=token, params={"unionId": union_id})
        if resp_code(resp) != SUCCESS_CODE:
            return None
        vo = (resp.get("data") or {}).get("MemberCouponShopPointsVo") or {}
        return vo.get("pointsNum")
    except Exception:
        return None


def sign_res(resp):
    data = resp.get("data") if isinstance(resp, dict) else None
    if isinstance(data, dict) and isinstance(data.get("signRes"), dict):
        return data["signRes"]
    return {}


def signed_today(res):
    """今日已签: signRes.sign 为真, 或今日日期行 signStatus == 'sign'。"""
    if res.get("sign") is True:
        return True
    today = bj_now().strftime("%Y-%m-%d")
    for row in res.get("taskSignDtoList") or []:
        if row.get("signTime") == today and row.get("signStatus") == SIGNED:
            return True
    return False


def fmt_num(value):
    """服务端 signNum 为浮点(1.0), 展示成整数更自然。"""
    try:
        f = float(value)
        return str(int(f)) if f == int(f) else str(f)
    except (TypeError, ValueError):
        return str(value)


def notify(lines):
    if os.getenv("LQPJ_NOTIFY", "1").lower() in {"0", "false", "no"}:
        return
    for path in (os.path.dirname(os.path.abspath(__file__)), "/ql/data/scripts", "/ql/scripts"):
        if path not in sys.path:
            sys.path.insert(0, path)
    try:
        from notify import send
        send("漓泉啤酒签到", "\n".join(lines))
    except Exception as exc:
        print(f"[通知] 发送失败（不影响任务）：{exc}")


def run_one(index, server, ref):
    result = [f"账号 {index}（YYB {mask(ref)}）"]
    try:
        token, union_id, note = obtain_session(server, ref)
        result.append(note)

        # 读取签到状态 (首个鉴权调用); 会话失效则强制重登重试一次
        state = sign_state(token)
        if resp_code(state) == SESSION_INVALID_CODE:
            result.append("会话失效，重新登录")
            token, union_id, note = obtain_session(server, ref, force=True)
            result.append(note)
            state = sign_state(token)

        scode = resp_code(state)
        if scode != SUCCESS_CODE:
            result.append(f"失败：{resp_msg(state) or f'获取签到状态失败 code={scode}'}")
            return result

        res = sign_res(state)

        # 幂等预检: 今日已签则不再提交
        if signed_today(res):
            result.append(f"今日已签到，无需重复（本周已签 {fmt_num(res.get('signNum'))} 天）")
            pts = points_balance(token, union_id)
            if pts is not None:
                result.append(f"当前积分: {pts}")
            return result

        # 执行一次签到
        body = do_sign(token)
        rcode = resp_code(body)
        if rcode == SESSION_INVALID_CODE:
            result.append("会话失效，重新登录后重试签到")
            token, union_id, note = obtain_session(server, ref, force=True)
            result.append(note)
            body = do_sign(token)
            rcode = resp_code(body)

        if rcode != SUCCESS_CODE:
            result.append(f"失败：{resp_msg(body) or f'签到失败 code={rcode}'}")
            return result

        res = sign_res(body)
        if not signed_today(res):
            result.append(f"失败：{resp_msg(body) or '签到接口返回成功但未标记已签, 请稍后重试'}")
            return result

        result.append(f"签到成功，本周已签 {fmt_num(res.get('signNum'))} 天")
        pts = points_balance(token, union_id)
        if pts is not None:
            result.append(f"当前积分: {pts}")
    except Exception as exc:
        result.append(f"失败：{exc}")
    print("\n".join(result))
    return result


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except AttributeError:
        pass

    output = ["漓泉啤酒：会员中心每日签到得积分"]
    for index, (server, ref) in enumerate(routes(), 1):
        output.extend(run_one(index, server, ref))
        time.sleep(1)
    notify(output)


if __name__ == "__main__":
    main()
