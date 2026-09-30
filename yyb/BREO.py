#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# name: BREO
# cron: 8 9,10,11 * * *
#
# 环境变量：
#   YYB_SERVER          每行：地址@账号标识（例如 http://yyb-go:8000@1）
#   YYB_API_KEY         可选；yyb-go 配置 YYB_PROTOCOL_TOKEN 时填同一令牌
#   BREO_SKIP_COMMUNITY 置 1 跳过发帖/收藏/评论，只签到和逛商城
#   BREO_NOTIFY         0 关闭青龙通知；默认 1
#
# 作者 哆啦A梦；入口 http://mx.qrurl.net/h5/wxa/link?sid=26407uif5Oq
#
# 参考模版：Template/hsy.py —— 由 YYB-Go 的 /wxapp/getCode 取 wx.login code，
# 之后全部走 BREO 自己的业务接口（不再依赖 wx_server_url / wx_auth 桥接服务）。
# 本文件是 wxapp/BREO.py 的 YYB-Go 版，原桥接版脚本保持不变。

import json
import os
import sys
import time
from pathlib import Path

import requests

MINI_APP_ID = "wx61457400e4212cec"
LOGIN_BASE = "https://breoplus.breo.cn/app/minic"
APP_BASE = "https://breoplus.breo.cn/breo-app"
TOKEN_CACHE_PATH = Path(__file__).with_name("BREO_token_cache.json")
PAGE_FRAME_VERSION = "390"
DEFAULT_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) "
    "NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF"
)
TIMEOUT = 30  # YYB 取码 / 登录
APP_TIMEOUT = 20  # BREO 业务接口
POST_CONTENT = "这是一个自动发布的帖子"
POST_TITLE = "自动化测试"


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
    # wx.login code 短期且一次性，失败即抛错，不重放后面的业务请求。
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


def success(body):
    return body.get("success") is True or str(body.get("code")) in ("0000", "200", "200.0")


def message(body):
    return str(body.get("message") or body.get("msg") or body.get("error") or "未知响应")


def is_token_error(text):
    return any(key in str(text) for key in ["40101", "40102", "token", "登录", "授权", "过期", "失效"])


def app_headers(token=None):
    headers = {
        "User-Agent": DEFAULT_UA,
        "Content-Type": "application/json",
        "deviceInfo": "{}",
        "Referer": f"https://servicewechat.com/{MINI_APP_ID}/{PAGE_FRAME_VERSION}/page-frame.html",
    }
    if token:
        headers["token"] = token
    return headers


def task_headers(token):
    return {
        "token": token,
        "device-type": "Xiaomi",
        "device-version": "10",
        "channel": "Breo",
        "version_code": "30201",
        "version": "3.2.1",
        "encrypt": "1",
        "Content-Type": "application/json; charset=UTF-8",
        "Referer": f"https://servicewechat.com/{MINI_APP_ID}/{PAGE_FRAME_VERSION}/page-frame.html",
        "User-Agent": DEFAULT_UA,
    }


def app_post(session, path, payload=None, token=None, timeout=APP_TIMEOUT):
    # payload 为 None 时按原脚本不带请求体提交（punch / mall 两个接口就是这样）。
    kwargs = {"data": json.dumps(payload)} if payload is not None else {}
    response = session.post(f"{APP_BASE}{path}", headers=app_headers(token), timeout=timeout, **kwargs)
    response.raise_for_status()
    return response.json()


def task_post(session, path, token, payload=None, timeout=APP_TIMEOUT):
    kwargs = {"data": json.dumps(payload)} if payload is not None else {}
    response = session.post(f"{APP_BASE}{path}", headers=task_headers(token), timeout=timeout, **kwargs)
    response.raise_for_status()
    return response.json()


def read_token_cache():
    try:
        if not TOKEN_CACHE_PATH.exists():
            return {}
        return json.loads(TOKEN_CACHE_PATH.read_text(encoding="utf-8")) or {}
    except Exception:
        return {}


def write_token_cache(cache):
    try:
        TOKEN_CACHE_PATH.write_text(json.dumps(cache, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception as exc:
        print(f"[缓存] 写入 token 缓存失败（不影响任务）：{exc}")


def remove_cached_token(ref):
    cache = read_token_cache()
    if ref in cache:
        del cache[ref]
        write_token_cache(cache)


def validate_token(session, token):
    try:
        body = app_post(session, "/getUserLevelInfoByUid", token=token, timeout=15)
    except Exception:
        return False
    if success(body):
        return True
    return not is_token_error(body)


def login(session, server, ref):
    code = yyb_code(server, ref)
    response = session.get(f"{LOGIN_BASE}/login/{code}", headers=app_headers(), timeout=TIMEOUT)
    response.raise_for_status()
    body = response.json()
    data = body.get("data") or {}
    if str(body.get("code")) != "200" or not data:
        raise RuntimeError(f"code 登录失败：{message(body)}")
    uid = data.get("uid")
    if not uid:
        raise RuntimeError(f"登录响应缺少 uid：{json.dumps(body, ensure_ascii=False)}")

    token_body = app_post(
        session,
        "/customer/loginByUid",
        {"uid": uid, "openId": data.get("openId"), "unionId": data.get("unionId")},
    )
    token = (token_body.get("result") or {}).get("token")
    if not success(token_body) or not token:
        raise RuntimeError(f"业务 token 登录失败：{message(token_body)}")
    return {
        "token": str(token),
        "uid": uid,
        "openId": data.get("openId"),
        "unionId": data.get("unionId"),
        "userInfo": data,
        "customer": token_body.get("result") or {},
        "updatedAt": int(time.time()),
    }


def token_for(session, server, ref):
    # 缓存优先：code 是一次性的，能用缓存就不重新登录。
    cached = read_token_cache().get(ref) or {}
    token = str(cached.get("token") or "")
    if token:
        if validate_token(session, token):
            return token, "使用缓存 token"
        remove_cached_token(ref)
        print(f"账号 {ref} 缓存 token 失效，重新登录")
    auth = login(session, server, ref)
    cache = read_token_cache()
    cache[ref] = auth
    write_token_cache(cache)
    user = auth.get("userInfo") or {}
    return auth["token"], f"code 登录成功：{user.get('nickname') or user.get('telephone') or auth.get('uid')}"


def reward(body):
    result = body.get("result") or {}
    return f"点数 +{result.get('point', 0)}，成长值 +{result.get('grow', 0)}"


def punch_in(session, token):
    body = task_post(session, "/user/po-task-info/punch", token)
    return f"签到成功（{reward(body)}）" if success(body) else f"签到失败：{message(body)}"


def release_post(session, token):
    body = task_post(
        session,
        "/communityBaseInfo/releasePost",
        token,
        {
            "anonymoused": 1,
            "content": POST_CONTENT,
            "expressText": "",
            "images": [],
            "subTitle": "",
            "title": POST_TITLE,
            "topicText": "",
        },
    )
    if not success(body):
        return "", f"发帖失败：{message(body)}"
    post_id = str((body.get("result") or {}).get("id") or "")
    return post_id, f"发帖成功（帖子 {post_id}）"


def collect_post(session, token, post_id):
    body = task_post(session, "/communityBaseInfo/collect", token, {"postId": post_id})
    return f"收藏成功（{reward(body)}）" if success(body) else f"收藏失败：{message(body)}"


def one_word():
    # 原脚本用随机一言当评论内容；取不到就退回固定文案，不因此中断任务。
    try:
        response = requests.get("https://uapis.cn/api/say", timeout=10)
        if response.status_code == 200 and response.text.strip():
            return response.text.strip()
    except Exception as exc:
        print(f"[评论] 获取一言失败（不影响任务）：{exc}")
    return "自动化测试评论"


def comment_post(session, token, post_id):
    # 原脚本连续评论 2 次，中间隔 1 秒。
    lines = []
    for _ in range(2):
        body = task_post(
            session,
            "/communityBaseInfo/comment",
            token,
            {"anonymoused": 0, "commentText": one_word(), "postId": post_id},
        )
        lines.append(f"评论成功（{reward(body)}）" if success(body) else f"评论失败：{message(body)}")
        time.sleep(1)
    return lines


def browse_mall(session, token):
    body = task_post(session, "/user/po-task-info/mall", token)
    return f"浏览商城成功（{reward(body)}）" if success(body) else f"浏览商城失败：{message(body)}"


def skip_community():
    return os.getenv("BREO_SKIP_COMMUNITY", "").lower() in {"1", "true", "yes"}


def mask(ref):
    return ref if len(ref) <= 12 else f"{ref[:6]}...{ref[-4:]}"


def notify(lines):
    if os.getenv("BREO_NOTIFY", "1").lower() in {"0", "false", "no"}:
        return
    for path in (os.path.dirname(os.path.abspath(__file__)), "/ql/data/scripts", "/ql/scripts"):
        if path not in sys.path:
            sys.path.insert(0, path)
    try:
        from notify import send
        send("BREO 签到", "\n".join(lines))
    except Exception as exc:
        print(f"[通知] 发送失败（不影响任务）：{exc}")


def run_one(index, server, ref):
    result = [f"账号 {index}（YYB {mask(ref)}）"]
    session = requests.Session()
    session.headers.update({"User-Agent": DEFAULT_UA})
    try:
        token, note = token_for(session, server, ref)
        result.append(note)
        result.append(punch_in(session, token))
        if skip_community():
            result.append("已跳过发帖/收藏/评论")
        else:
            post_id, line = release_post(session, token)
            result.append(line)
            if post_id:
                result.append(collect_post(session, token, post_id))
                result.extend(comment_post(session, token, post_id))
            else:
                result.append("发帖失败，跳过收藏/评论")
        result.append(browse_mall(session, token))
    except Exception as exc:
        result.append(f"失败：{exc}")
    print("\n".join(result))
    return result


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except AttributeError:
        pass

    output = ["BREO：签到、发帖、收藏、评论、浏览商城"]
    for index, (server, ref) in enumerate(routes(), 1):
        output.extend(run_one(index, server, ref))
    notify(output)


if __name__ == "__main__":
    main()
