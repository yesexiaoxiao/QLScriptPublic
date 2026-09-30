#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# name: 北京环球签到
# cron: 15 9 * * *
#
# 环境变量：
#   YYB_SERVER          每行：地址@账号标识（例如 http://yyb-go:8000@1）
#   YYB_API_KEY         可选；yyb-go 配置 YYB_PROTOCOL_TOKEN 时填同一令牌
#   bjhqbwz_pool        奖池自动选择: ticket1/ticket2/hotel；默认 ticket2，置空关闭
#   BJHQBWZ_NOTIFY      0 关闭青龙通知；默认 1
#
# 入口: 微信小程序「北京环球度假区互动福利站」-> 签到
# 连续签到达标后会获得抽奖机会, 但抽奖属于领奖动作, 本脚本不自动触发, 仅完成签到。
#
# 参考模版：Template/hsy.py —— 由 YYB-Go 的 /wxapp/getCode 取 wx.login code，
# 之后全部走北京环球自己的业务接口（不再依赖 wx_server_url / wx_auth 桥接服务）。
# 本文件是 wxapp/bjhqbwz.py 的 YYB-Go 版，原桥接版脚本保持不变。

import base64
import hashlib
import hmac
import json
import os
import sys
import time
from datetime import datetime, timedelta, timezone
from email.utils import formatdate
from pathlib import Path

import requests

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

# ---------------------------------------------------------------------------
# 常量 (均来自小程序反编译源码, 非机密)
# ---------------------------------------------------------------------------
MINI_APP_ID = "wx21f6790118783b83"
BASE_URL = "https://bmp.app.universalbeijingresort.com"
PATH_PREFIX = "/2026_ubr_yunyingqiu"                 # app.js 路径前缀 (小写)
ACTIVITY_CODE = "2026_UBR_YUNYINGQIU"                # app.js activityCode (大写)
# HTTP-Signatures 签名密钥 (客户端内置, 生产环境; 非 appsecret)
HMAC_USERNAME = "ubr-bmp"
HMAC_SECRET = "aK@AtX5#Ck5x"
SUCCESS_CODE = 200
SESSION_CODES = (401, 403)                           # 会话失效 -> 需重新登录
NEED_GOV_CODE = 60002                                # 需补充身份证/实名
NEED_CERT_CODE = 60003                               # 需完成实名认证
MEMBER_IDENTITIES = ("NORMAL_MEMBER", "ANNUAL_CARD_MEMBER")
TIMEOUT = 30                                         # YYB 取码 / 业务接口
# 「连续签到5天抽门票」玩法(Surprise5)开启时, 首签前需选一个抽奖奖池(小程序内
# 为二次确认弹窗)。本脚本按用户授权的 bjhqbwz_pool 自动选定一次(幂等: 已选过/无
# 门槛则不重复选); 若置空/none 则不自动选, 仅如实上报由用户在小程序内手动选。
POOL_GATE_HINT = "奖池"
# 奖池自动选择(用户授权): ticket1=指定日门票5折 / ticket2=门票+优速通套餐5折 /
# hotel=酒店5折。默认 ticket2(门票+优速通)。置空或 none/off 关闭自动选。
POOL_CHOICE = os.getenv("bjhqbwz_pool", "ticket2").strip().lower()
POOL_LABELS = {
    "ticket1": "指定日门票5折优惠券",
    "ticket2": "门票+环球优速通套餐5折优惠券",
    "hotel": "度假区酒店5折优惠券",
}
POOL_GATE_MSG = (
    "本期开启了『连续签到5天抽门票』玩法, 首次签到前需选择一个奖池"
    "(①指定日门票5折 ②门票+优速通套餐5折 ③酒店5折)。当前未启用自动选池"
    "(bjhqbwz_pool 为空), 请在小程序「北京环球度假区互动福利站」首页弹窗中"
    "选定奖池后再运行, 或设置环境变量 bjhqbwz_pool=ticket2 由脚本自动选定。"
)

TOKEN_CACHE_PATH = Path(__file__).with_name("bjhqbwz_token_cache.json")
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


def get_cached_entity(ref):
    return read_token_cache().get(ref) or {}


def save_cached_entity(ref, entity):
    cache = read_token_cache()
    cache[ref] = {
        "token": entity.get("token"),
        "id": entity.get("id"),
        "uid": entity.get("uid"),
        "identity": entity.get("identity"),
        "identityCard": entity.get("identityCard"),
        "updatedAt": int(time.time()),
    }
    write_token_cache(cache)


def remove_cached_entity(ref):
    cache = read_token_cache()
    if ref in cache:
        del cache[ref]
        write_token_cache(cache)


# ---------------------------------------------------------------------------
# 北京环球 API (复刻 599C3084...js 的 HTTP-Signatures 签名)
# ---------------------------------------------------------------------------
def sign_headers(body_str, token=None, user_id=None):
    """复刻请求签名: digest=SHA-256(base64), 签名串 hmac-sha1(base64)。"""
    x_date = formatdate(usegmt=True)  # 对应 JS new Date().toUTCString()
    digest = "SHA-256=" + base64.b64encode(
        hashlib.sha256(body_str.encode("utf-8")).digest()
    ).decode("ascii")
    signing_string = f"x-date: {x_date}\ndigest: {digest}"
    signature = base64.b64encode(
        hmac.new(HMAC_SECRET.encode("utf-8"), signing_string.encode("utf-8"),
                 hashlib.sha1).digest()
    ).decode("ascii")
    headers = {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "X-date": x_date,
        "Digest": digest,
        "Authorization": (
            f'hmac username="{HMAC_USERNAME}", algorithm="hmac-sha1", '
            f'headers="x-date digest", signature="{signature}"'
        ),
        "User-Agent": DEFAULT_UA,
        "Referer": f"https://servicewechat.com/{MINI_APP_ID}/0/page-frame.html",
    }
    if token is not None:
        headers["ArrowAuthorization"] = token or ""
        headers["userId"] = str(user_id if user_id is not None else "")
    return headers


def api_post(path, body, token=None, user_id=None):
    """POST 业务接口: body 序列化后同时用于签名与请求体 (必须一致)。"""
    body_str = json.dumps(body, separators=(",", ":"), ensure_ascii=False)
    headers = sign_headers(body_str, token=token, user_id=user_id)
    resp = session.post(f"{BASE_URL}{path}", data=body_str.encode("utf-8"),
                        headers=headers, timeout=TIMEOUT)
    # 会话失效时服务端是用 HTTP 401/403 表达的, 不是 JSON 信封里的 code。
    # raise_for_status() 会在 run_one 的重登重放分支之前就把它抛成异常
    # (实测缓存 token 过期后直接报 "401 Client Error", 整个账号失败),
    # 所以这里把它翻译成带 code 的信封, 交给调用方去重登。
    if resp.status_code in SESSION_CODES:
        try:
            data = resp.json()
        except Exception:
            data = {}
        if not isinstance(data, dict):
            data = {}
        data["code"] = resp.status_code
        return data
    resp.raise_for_status()
    return resp.json()


def envelope_entity(resp):
    data = resp.get("data") if isinstance(resp, dict) else None
    if isinstance(data, dict) and isinstance(data.get("entity"), dict):
        return data["entity"]
    if isinstance(resp, dict) and isinstance(resp.get("entity"), dict):
        return resp["entity"]
    return {}


def resp_code(resp):
    for k in ("code", "status"):
        v = (resp or {}).get(k)
        if v is not None:
            try:
                return int(v)
            except (TypeError, ValueError):
                pass
    return -1


# ---------------------------------------------------------------------------
# 登录 / 会话
# ---------------------------------------------------------------------------
def is_member(entity):
    """源码: uid 非空 <=> 已完成手机号授权注册的会员 (isAuth/hasPhone 均以 uid 判定)。"""
    return bool(entity) and str(entity.get("id", "-1")) != "-1" and bool(entity.get("uid"))


def login(server, ref):
    """wx.login code -> user/login (postNoAuth, 无 ArrowAuthorization) -> entity。

    源码逻辑: 200 时若 data.entity.id 存在则为会员实体, 否则视为未注册
    (NONMEMBER, id=-1)。未注册用户需在小程序内经手机号授权 (wechatLogin) 注册,
    属于手机号 PII 前置条件, 本脚本不自动触发, 仅识别并如实上报。
    """
    code = yyb_code(server, ref)
    body = {"code": code, "registerSource": "", "activityCode": ACTIVITY_CODE}
    # 登录接口 postNoAuth: 仍签名, 但不带 ArrowAuthorization/userId
    resp = api_post(f"{PATH_PREFIX}/ubr/user/login", body)
    if resp_code(resp) != SUCCESS_CODE:
        raise RuntimeError(f"登录失败: {resp.get('message') or resp.get('msg') or resp}")
    entity = envelope_entity(resp)
    if not entity or str(entity.get("id", "-1")) == "-1":
        entity = {"id": "-1", "uid": "", "identity": "NONMEMBER"}
    return entity


def get_entity_for_account(server, ref, force=False):
    if not force:
        cached = get_cached_entity(ref)
        if cached.get("token") and is_member(cached):
            return cached, f"使用缓存 token（{mask(cached.get('token'))}）"
    entity = login(server, ref)
    if is_member(entity):
        save_cached_entity(ref, entity)
        return entity, f"code 登录成功：会员 {mask(entity.get('token'))}"
    remove_cached_entity(ref)
    return entity, "code 登录成功：未注册会员 (NONMEMBER)"


# ---------------------------------------------------------------------------
# 签到业务
# ---------------------------------------------------------------------------
def activity_detail(token, user_id):
    return api_post(f"{PATH_PREFIX}/business/activityRecord/detail",
                    {"userId": user_id, "activityCode": ACTIVITY_CODE,
                     "prePrizeIds": []}, token=token, user_id=user_id)


def sign_in_record(token, user_id, month):
    return api_post(f"{PATH_PREFIX}/business/yunyingqiu/signInRecord",
                    {"userId": user_id, "activityCode": ACTIVITY_CODE,
                     "month": month}, token=token, user_id=user_id)


def complete_quest(token, user_id, quest_template_id):
    return api_post(f"{PATH_PREFIX}/business/activityRecord/completeQuest",
                    {"userId": user_id, "activityCode": ACTIVITY_CODE,
                     "questTemplateId": quest_template_id},
                    token=token, user_id=user_id)


def select_surprise5_pool(token, user_id, prize):
    """一次性选择「连续签到5天」抽奖奖池 (surprise5select)。

    复刻小程序确认弹窗的提交: POST /business/surpriseFivePhase/selectedPrize
    body {selectedPrize:[prize], userId}, 成功 code==200。prize ∈ ticket1/ticket2/hotel。
    仅在检测到奖池门槛且用户已授权(bjhqbwz_pool)时调用一次, 服务端按活动/期次判定,
    已选过则再次签到不会触发门槛, 故天然幂等。
    """
    return api_post(f"{PATH_PREFIX}/business/surpriseFivePhase/selectedPrize",
                    {"selectedPrize": [prize], "userId": user_id},
                    token=token, user_id=user_id)


def find_sign_in_template_id(detail_resp):
    entity = envelope_entity(detail_resp)
    for quest in entity.get("questList") or []:
        if quest.get("templateCode") == "SIGN_IN":
            return quest.get("templateId")
    return None


def already_signed_today(record_resp):
    entity = envelope_entity(record_resp)
    today = bj_now().strftime("%Y-%m-%d")
    for info in entity.get("signInInfos") or []:
        if info.get("day") == today and info.get("signIn"):
            return True
    return False


def notify(lines):
    if os.getenv("BJHQBWZ_NOTIFY", "1").lower() in {"0", "false", "no"}:
        return
    for path in (os.path.dirname(os.path.abspath(__file__)), "/ql/data/scripts", "/ql/scripts"):
        if path not in sys.path:
            sys.path.insert(0, path)
    try:
        from notify import send
        send("北京环球签到", "\n".join(lines))
    except Exception as exc:
        print(f"[通知] 发送失败（不影响任务）：{exc}")


def run_one(index, server, ref):
    result = [f"账号 {index}（YYB {mask(ref)}）"]
    try:
        entity, note = get_entity_for_account(server, ref)
        result.append(note)

        # 前置条件: 未注册会员 (无手机号授权) 无法签到; 如实上报, 不自动触发手机号授权
        if not is_member(entity):
            result.append("该账号尚未注册, 需先在小程序「北京环球度假区互动福利站→签到」完成手机号授权注册后才能签到")
            return result

        token = entity.get("token")
        user_id = entity.get("id")
        if not token:
            result.append("登录未返回会话凭证 (token), 需在小程序内重新登录一次以生成会话后再运行")
            return result

        # 拉取任务详情 (首个鉴权调用); 会话失效则强制重登重试一次
        detail = activity_detail(token, user_id)
        if resp_code(detail) in SESSION_CODES:
            result.append("会话失效，重新登录")
            remove_cached_entity(ref)
            entity, note = get_entity_for_account(server, ref, force=True)
            result.append(note)
            token, user_id = entity.get("token"), entity.get("id")
            detail = activity_detail(token, user_id)

        dcode = resp_code(detail)
        if dcode in (NEED_GOV_CODE, NEED_CERT_CODE):
            result.append(f"需先在小程序内完成实名/身份证信息后才能签到（code={dcode}）")
            return result
        if dcode != SUCCESS_CODE:
            result.append(f"失败：{detail.get('message') or detail.get('msg') or f'获取活动详情失败 code={dcode}'}")
            return result

        template_id = find_sign_in_template_id(detail)
        if not template_id:
            result.append("未找到签到任务(SIGN_IN), 活动可能已结束")
            return result

        # 幂等预检: 今日是否已签到
        month = bj_now().strftime("%Y-%m")
        try:
            record = sign_in_record(token, user_id, month)
            if resp_code(record) == SUCCESS_CODE and already_signed_today(record):
                result.append("今日已签到, 无需重复")
                return result
        except Exception as e:
            print(f"账号 {index} 签到记录预检失败(忽略, 继续签到): {e}")

        body = complete_quest(token, user_id, template_id)
        rcode = resp_code(body)

        # 奖池门槛: 首签前需选一个抽奖奖池。按用户授权(bjhqbwz_pool)自动选定一次后重试;
        # 未授权(置空)则如实上报, 由用户在小程序内手动选。选池是一次性动作, 不触发抽奖。
        if rcode != SUCCESS_CODE and POOL_GATE_HINT in (body.get("message") or body.get("msg") or ""):
            if POOL_CHOICE in POOL_LABELS:
                label = POOL_LABELS[POOL_CHOICE]
                print(f"账号 {index} 检测到奖池门槛, 按授权自动选定奖池「{label}」...")
                sel = select_surprise5_pool(token, user_id, POOL_CHOICE)
                if resp_code(sel) == SUCCESS_CODE:
                    result.append(f"已按授权选定奖池「{label}」，重试签到")
                    body = complete_quest(token, user_id, template_id)
                    rcode = resp_code(body)
                else:
                    smsg = sel.get("message") or sel.get("msg") or f"code={resp_code(sel)}"
                    result.append(f"失败：选择奖池失败({smsg})。{POOL_GATE_MSG}")
                    return result
            else:
                result.append(POOL_GATE_MSG)
                return result

        if rcode in (NEED_GOV_CODE, NEED_CERT_CODE):
            result.append(f"需先在小程序内完成实名/身份证信息后才能签到（code={rcode}）")
            return result
        if rcode != SUCCESS_CODE:
            raw_msg = body.get("message") or body.get("msg") or ""
            if POOL_GATE_HINT in raw_msg:            # 选池后仍报门槛(异常), 转为可读上报
                result.append(POOL_GATE_MSG)
                return result
            result.append(f"失败：{raw_msg or f'签到失败 code={rcode}'}")
            return result

        rentity = envelope_entity(body)
        total = rentity.get("signInTotal")
        chances = rentity.get("chanceList") or []
        msg = "签到成功"
        if total is not None:
            msg += f"，连续签到 {total} 天"
        if chances:
            msg += f"，获得 {len(chances)} 次抽奖机会(请在小程序内手动抽奖)"
        result.append(msg)
    except Exception as exc:
        result.append(f"失败：{exc}")
    print("\n".join(result))
    return result


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except AttributeError:
        pass

    output = ["北京环球：互动福利站每日签到（抽奖需在小程序内手动进行）"]
    for index, (server, ref) in enumerate(routes(), 1):
        output.extend(run_one(index, server, ref))
        time.sleep(1)
    notify(output)


if __name__ == "__main__":
    main()
