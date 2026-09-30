#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# name: 红色火箭签到
# cron: 25 8 * * *
#
# 环境变量：
#   YYB_SERVER          每行：地址@账号标识（例如 http://yyb-go:8000@1）
#   YYB_API_KEY         可选；yyb-go 配置 YYB_PROTOCOL_TOKEN 时填同一令牌
#   hshj_ticket         可选；手动 ticket, 格式 token 或 token#userId, 多账号按账号顺序换行/& 分割
#   hshj_phone_login    是否允许用手机号能力自动登录, 默认 1(开启), 置 0 关闭
#   hshj_ver            miniProgram.version, 默认 1.46.0
#   HSHJ_NOTIFY         0 关闭青龙通知；默认 1
#
# 入口: 微信小程序「红色火箭」-> 积分中心 -> 签到
# ---------------------------------------------------------------------------
# 接口契约(全部逆自反编译包 wx1b44c3ad181bde16 主包, 已逐行核对)
#   base: https://index.amcfortune.com                     common/vendor.js:6290 (模块 6c8e)
#   固定请求头: ticket / Bank-Type:main / pro / ver / pla / register_channel /
#              click_id / user_id / mini_program:wechat     vendor.js:6292-6301
#     pro    = "RedRocket"(本 appid) 或 "RedRocket-Pro"     vendor.js:12074 setupPlatform
#     pla    = rr_iphone / rr_Android / rr_<osName>         vendor.js:12070
#     ver    = getAccountInfoSync().miniProgram.version, 空则 "1.46.0"
#     user_id= 有 ticket 时才带                             vendor.js:6300
#   GET : 自动追加 query key=Date.now()                     vendor.js:6289
#   POST: 追加请求头 nonce / timestamp / signature /
#         key_version / openid                              vendor.js:6302-6308
#   签名(模块 b633, vendor.js:9643-9666 + 9760 c()):
#     t = {...body}; t.nonce ?= nonce; t.timestamp ?= timestamp;
#     t.appSecret = state.encryptKey; if (ticket!=null) t.ticket = ticket
#     raw = 键名升序 "k=v&" 拼接后去掉末尾 "&" (值为对象时 JSON.stringify)
#     signature = Base64(md5_hex_lowercase(utf8(raw)))
#       md5  : 模块 80d8 blueimp, h() 用 "0123456789abcdef" 小写十六进制,
#              g()=unescape(encodeURIComponent()) 即 UTF-8      vendor.js:6960-7000
#       Base64: 模块 b633 u.encode, 标准字母表 + "=" 补位         vendor.js:9720-9737
#     appSecret = wx.getUserCryptoManager().getLatestUserKey().encryptKey
#              -> YYB-Go POST /wx/encryptkey 的 data.encryptKey
#     key_version = 同一响应的 data.version
#   响应码(vendor.js:6341-6371): 0/200 成功; 7006 -> 重取 secure_path 加密列表;
#     7005 -> 刷新用户 key 后重试一次; 407 -> ticket 失效, 清空 ticket/userId
#   端点(模块 86ff):
#     POST /fundex-uc/uc/v1/getWxOpenIdAndUnionId {code}  -> data.openId/unionId
#                                                           vendor.js:10228
#     POST /fundex-uc/uc/v1/login {...}                   -> data.token(=ticket)
#                                                           components/loginBtns/loginBtns.js:176
#     POST /fundex-uc/uc/v1/getTokenStatus {token,source}  data.status=="0" 有效,
#                                                           data.newToken 轮换
#                                                           vendor.js:11959
#     GET  /fundex-activity/point/sign/getSignDays        vendor.js:7470
#     POST /fundex-activity/point/sign/userSignIn         vendor.js:7544
#     GET  /fundex-activity/point/account/getTotalPoint   vendor.js:7494 (silent)
#   userSignIn 不在加密列表内(secure_path 实测只含 redPacket/exchangeRedPacket、
#   watchWordCustom/doExchange、point/task/completeTaskV3), 故明文 body。
#
# 已知限制(如实说明, 不猜接口):
#   1. 签到页 pages_detail/ 在分包内, 分包 js 解包为空壳, 因此 getSignDays /
#      userSignIn 的**业务入参无法从源码还原**。本脚本按「无额外入参」发送
#      (GET 只带 key, POST 送 {}), 并在拿到 getSignDays 响应后把其中的
#      activityNo/activityId 等活动标识透传给 userSignIn(存在才带), 不构造任何
#      源码里没有的字段。
#   2. 全包唯一发 ticket 的入口是 /fundex-uc/uc/v1/login, 且只接受
#      wx.getPhoneNumber 的 code。实测服务端对本账号返回
#      loginStatus=fail / loginDesc=用户登录失败(已试过 isAuthorized、去
#      registerChannel、先建运行时会话、appSecret 冷启动态等多种忠实复刻),
#      属服务端注册/风控策略, 不做绕过。若遇此情况请先在小程序内手动登录一次,
#      或把 App 内已登录的 token 填到 hshj_ticket 变量。
#   3. /wx/encryptkey 与手机号能力都要求账号在目标小程序侧真实可用; yyb-go 不会
#      伪造 encryptData/签名, 取不到时脚本按失败上报。
# ---------------------------------------------------------------------------
#
# 参考模版：Template/hsy.py —— 由 YYB-Go 的 /wxapp/getCode 取 wx.login code，
# 之后全部走红色火箭自己的业务接口（不再依赖 wx_server_url / wx_auth 桥接服务）。
# 本文件是 wxapp/hongsehuojian.py 的 YYB-Go 版，原桥接版脚本保持不变。

import base64
import hashlib
import json
import os
import random
import sys
import time
from pathlib import Path

import requests

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

# ---------------------------------------------------------------------------
# 常量 (均来自反编译源码, 非机密)
# ---------------------------------------------------------------------------
MINI_APP_ID = "wx1b44c3ad181bde16"
BASE_URL = "https://index.amcfortune.com"
PRO = "RedRocket"
PLA = "rr_Android"
AGREEMENT = "阅读并同意用户协议、隐私政策，未注册的手机号认证后自动创建新账户"
TIMEOUT = 60                                  # YYB 取码 / 业务接口

EP_OPENID = "/fundex-uc/uc/v1/getWxOpenIdAndUnionId"
EP_LOGIN = "/fundex-uc/uc/v1/login"
EP_TOKEN_STATUS = "/fundex-uc/uc/v1/getTokenStatus"
EP_SIGN_DAYS = "/fundex-activity/point/sign/getSignDays"
EP_SIGN_RECORD = "/fundex-activity/point/sign/getRecordList"
EP_SIGN_IN = "/fundex-activity/point/sign/userSignIn"
EP_TOTAL_POINT = "/fundex-activity/point/account/getTotalPoint"

VERSION = os.getenv("hshj_ver", "1.46.0")
ALLOW_PHONE_LOGIN = os.getenv("hshj_phone_login", "1").strip().lower() not in ("0", "false", "no")

TOKEN_CACHE_PATH = Path(__file__).with_name("hongsehuojian_token_cache.json")

session = requests.Session()


# ---------------------------------------------------------------------------
# YYB-Go 协议调用
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


def yyb_call(server, ref, path, payload=None, appid=MINI_APP_ID):
    """调用 YYB-Go 协议接口，返回统一信封里的 data 节点。"""
    data = {"ref": ref, "app_id": appid}
    if payload is not None:
        data["payload"] = payload
    headers = {"Content-Type": "application/json"}
    api_key = os.getenv("YYB_API_KEY", "").strip()
    if api_key:
        headers["Authorization"] = "Bearer " + api_key
    response = requests.post(f"{server}{path}", json=data, headers=headers, timeout=TIMEOUT)
    response.raise_for_status()
    try:
        body = response.json()
    except ValueError as exc:
        raise RuntimeError(f"YYB {path} 返回非 JSON：HTTP {response.status_code}") from exc
    if not isinstance(body, dict):
        raise RuntimeError(f"YYB {path} 返回格式异常：{body!r}")
    if int(body.get("code", -1)) != 0:
        raise RuntimeError(f"YYB {path} 失败：{body.get('msg') or body.get('message') or body}")
    node = body.get("data")
    return node if isinstance(node, dict) else {}


def find_code(node, keys):
    """在协议响应里递归找一次性 code（YYP 各能力返回层级不完全一致）。"""
    if isinstance(node, dict):
        for key in keys:
            value = node.get(key)
            if isinstance(value, str) and value and value not in {"invalid", "null"}:
                return value
        for value in node.values():
            found = find_code(value, keys)
            if found:
                return found
    elif isinstance(node, list):
        for item in node:
            found = find_code(item, keys)
            if found:
                return found
    return None


def get_code(server, ref):
    """wx.login code（/wxapp/getCode）。code 短期且一次性。"""
    data = yyb_call(server, ref, "/wxapp/getCode")
    result = data.get("result")
    code = result if isinstance(result, str) else (result or {}).get("code")
    if not code:
        raise RuntimeError("YYB 未返回 data.result.code")
    return str(code)


def get_phone_code(server, ref):
    """手机号授权包里的 code（/wxapp/getPhoneNumber）。

    能否返回真实 code 取决于账号与目标小程序；yyb-go 不伪造授权结果。
    """
    data = yyb_call(server, ref, "/wxapp/getPhoneNumber")
    code = find_code(data, ("phone_code", "phoneCode", "wx_code", "login_code", "code"))
    if not code:
        raise RuntimeError("YYB 未返回手机号 code（该账号可能未获得手机号授权）")
    return code


def get_encrypt_key(server, ref):
    """getUserEncryptKey 能力（/wx/encryptkey）-> (encryptKey, version)。"""
    data = yyb_call(server, ref, "/wx/encryptkey", payload={"api_name": "getLatestUserKey"})
    result = data.get("result") if isinstance(data.get("result"), dict) else data
    encrypt_key = result.get("encryptKey") or result.get("encrypt_key")
    version = result.get("version") or result.get("keyVersion") or result.get("key_version")
    return encrypt_key, version


# ---------------------------------------------------------------------------
# 工具
# ---------------------------------------------------------------------------
def mask(value):
    if not value:
        return ""
    value = str(value)
    if len(value) <= 10:
        return value[:2] + "***"
    return f"{value[:4]}***{value[-4:]}"


def js_str(value):
    """复刻 JS 的字符串拼接语义, 保证签名串与小程序完全一致。"""
    if value is True:
        return "true"
    if value is False:
        return "false"
    if value is None:
        return "null"
    if isinstance(value, dict):
        # 源码: Object.prototype.toString.call(v) === "[object Object]" 时用 JSON.stringify
        return json.dumps(value, separators=(",", ":"), ensure_ascii=False)
    if isinstance(value, (list, tuple)):
        # JS 里数组走 "" + arr, 等价于 join(",")
        return ",".join(js_str(x) for x in value)
    return str(value)


def make_signature(body, nonce, timestamp, app_secret, ticket=None):
    """signature = Base64(md5_hex_lowercase(sorted "k=v&" join))  (vendor.js 模块 b633)"""
    fields = dict(body or {})
    fields.setdefault("nonce", nonce)
    fields.setdefault("timestamp", timestamp)
    fields["appSecret"] = app_secret
    if ticket is not None:
        fields["ticket"] = ticket
    raw = "".join(f"{k}={js_str(fields[k])}&" for k in sorted(fields.keys()))[:-1]
    digest = hashlib.md5(raw.encode("utf-8")).hexdigest()
    return base64.b64encode(digest.encode("utf-8")).decode("utf-8")


def make_nonce():
    # 源码: "" + (1e6*Math.random()).toFixed(0) + (1e6*Math.random()).toFixed(0)
    return f"{random.randint(0, 1000000)}{random.randint(0, 1000000)}"


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


# ---------------------------------------------------------------------------
# 红色火箭 客户端
# ---------------------------------------------------------------------------
class RedRocket:
    def __init__(self, server, ref, index):
        self.server = server
        self.ref = ref
        self.index = index
        self.ticket = ""
        self.user_id = ""
        self.openid = ""
        self.unionid = ""
        self.encrypt_key = None
        self.encrypt_ver = None

    # -- 传输层 ----------------------------------------------------------
    def request(self, path, data=None, method="POST", _retried=False):
        data = dict(data or {})
        headers = {
            "ticket": self.ticket or "",
            "Bank-Type": "main",
            "pro": PRO,
            "ver": VERSION,
            "pla": PLA,
            "register_channel": "",
            "click_id": "",
            "user_id": self.user_id if self.ticket else "",
            "mini_program": "wechat",
            "content-type": "application/json",
        }
        url = f"{BASE_URL}{path}"
        if method.upper() == "GET":
            data["key"] = int(time.time() * 1000)
            resp = session.get(url, params=data, headers=headers, timeout=TIMEOUT)
        else:
            nonce = make_nonce()
            timestamp = str(int(time.time() * 1000))
            headers.update({
                "nonce": nonce,
                "timestamp": timestamp,
                "signature": make_signature(data, nonce, timestamp, self.encrypt_key,
                                            self.ticket if self.ticket else None),
                "key_version": js_str(self.encrypt_ver),
                "openid": self.openid or "",
            })
            resp = session.post(
                url,
                data=json.dumps(data, separators=(",", ":"), ensure_ascii=False).encode("utf-8"),
                headers=headers,
                timeout=TIMEOUT,
            )
        resp.raise_for_status()
        resp.encoding = "utf-8"
        result = resp.json()

        code = str(result.get("code", ""))
        if code == "7005" and not _retried:
            # 用户加密 key 过期 -> 刷新后重试一次 (vendor.js:6358)
            self.encrypt_key, self.encrypt_ver = get_encrypt_key(self.server, self.ref)
            return self.request(path, data, method, _retried=True)
        if code == "7006":
            # 服务端要求重取加密路径清单; 本脚本不走加密体, 仅记录
            print(f"  [!] 服务端返回 7006(加密清单变更): {result.get('msg') or result.get('message')}")
        if code == "407":
            self.ticket = ""
            self.user_id = ""
            self.forget_ticket()
            raise RuntimeError("ticket 已失效(407), 需重新登录")
        return result

    @staticmethod
    def ok(result):
        return str(result.get("code", "")) in ("0", "200")

    @staticmethod
    def err(result):
        return result.get("msg") or result.get("message") or json.dumps(result, ensure_ascii=False)[:200]

    # -- 缓存 ------------------------------------------------------------
    def load_cache(self):
        entry = read_token_cache().get(self.ref) or {}
        self.ticket = entry.get("ticket") or ""
        self.user_id = str(entry.get("userId") or "")
        return bool(self.ticket)

    def save_cache(self):
        cache = read_token_cache()
        cache[self.ref] = {
            "ticket": self.ticket,
            "userId": self.user_id,
            "openId": self.openid,
            "updatedAt": int(time.time()),
        }
        write_token_cache(cache)

    def forget_ticket(self):
        cache = read_token_cache()
        if self.ref in cache:
            del cache[self.ref]
            write_token_cache(cache)

    # -- 登录 ------------------------------------------------------------
    def resolve_openid(self):
        """wx.login code -> openId / unionId (小程序 store 的 openid, 非 YYB 账号标识)。"""
        code = get_code(self.server, self.ref)
        result = self.request(EP_OPENID, {"code": code})
        if not self.ok(result):
            raise RuntimeError(f"获取 openId 失败: {self.err(result)}")
        data = result.get("data") or {}
        self.openid = data.get("openId") or ""
        self.unionid = data.get("unionId") or ""
        if not self.openid:
            raise RuntimeError(f"响应未包含 openId: {self.err(result)}")

    def check_ticket(self):
        """POST getTokenStatus: data.status=="0" 有效; newToken 需轮换。"""
        try:
            result = self.request(EP_TOKEN_STATUS,
                                  {"token": self.ticket, "source": "miniProgram"})
        except Exception as e:
            print(f"  校验 ticket 异常: {e}")
            return False
        if not self.ok(result):
            return False
        data = result.get("data") or {}
        if str(data.get("status", "")) != "0":
            return False
        if data.get("newToken"):
            self.ticket = data["newToken"]
            print("  ticket 已轮换")
        if data.get("userId"):
            self.user_id = str(data["userId"])
        self.save_cache()
        return True

    def login_by_phone(self):
        """唯一发 ticket 的入口, 需微信手机号能力的 code (用户已明确授权)。"""
        phone_code = get_phone_code(self.server, self.ref)
        body = {
            "loginWay": "miniprogram",
            "platform": "mini_fundex",
            "code": phone_code,
            "openId": self.openid,
            "unionId": self.unionid,
            "signAgreement": AGREEMENT,
            "registerChannel": "",
        }
        result = self.request(EP_LOGIN, body)
        data = result.get("data") or {}
        if str(data.get("loginStatus", "")).lower() != "success":
            raise RuntimeError(data.get("loginDesc") or self.err(result))
        self.ticket = data.get("token") or ""
        self.user_id = str(data.get("userId") or "")
        if not self.ticket:
            raise RuntimeError("登录成功但未返回 token")
        self.save_cache()
        return data.get("isRegister")

    # -- 签到 ------------------------------------------------------------
    def get_sign_days(self):
        """查询签到日历。

        实测 `point/sign/getSignDays` 需要一个只存在于分包里的业务入参, 不带参
        时服务端直接 500(`{"msg":"系统异常","data":{"cause":"cause null"}}`);
        而 `point/sign/getRecordList`(源码里的 homeQuery) 无参即可返回完整日历,
        且带服务端当天日期, 因此改用后者判定「今日是否已签」。
        """
        result = self.request(EP_SIGN_RECORD, {}, "GET")
        if not self.ok(result):
            raise RuntimeError(f"查询签到状态失败: {self.err(result)}")
        return result.get("data")

    @staticmethod
    def parse_sign_state(data):
        """从 getRecordList 响应里提取「今日是否已签」、连续天数与今日积分。

        实测响应形状:
            {"continuousDays": 0, "today": "2026-08-16",
             "signRecordList": [{"signDate": "2026-08-16", "point": 2,
                                 "signIn": false, "iconType": "5",
                                 "inflateDay": false}, ...]}
        以服务端 `today` 为准(不用本机时区)在 signRecordList 里找当天那条;
        读不到时返回 signed=None, 交由上层直接提交签到。
        """
        signed, days, today_point = None, None, None
        if isinstance(data, dict):
            days = data.get("continuousDays")
            today = data.get("today")
            records = data.get("signRecordList")
            if isinstance(records, list):
                for item in records:
                    if not isinstance(item, dict):
                        continue
                    if today and item.get("signDate") != today:
                        continue
                    value = item.get("signIn")
                    if isinstance(value, bool):
                        signed = value
                    elif isinstance(value, (int, str)) and str(value) in ("0", "1"):
                        signed = str(value) == "1"
                    today_point = item.get("point")
                    break
        return signed, days, today_point

    def sign_in(self):
        """POST point/sign/userSignIn。空 body: 全包无任何 activityNo/activityId,
        用户身份完全由 ticket 头承载。"""
        result = self.request(EP_SIGN_IN, {})
        return self.ok(result), result

    def total_point(self):
        try:
            result = self.request(EP_TOTAL_POINT, {}, "GET")
            if self.ok(result):
                data = result.get("data")
                if isinstance(data, dict):
                    for key in ("totalPoint", "total", "point", "points", "balance"):
                        if data.get(key) is not None:
                            return data[key]
                    return json.dumps(data, ensure_ascii=False)[:120]
                return data
        except Exception as e:
            print(f"  查询积分异常: {e}")
        return None


# ---------------------------------------------------------------------------
# 主流程 (每账号一次幂等签到)
# ---------------------------------------------------------------------------
def ensure_ticket(client, manual_ticket):
    if manual_ticket:
        token, _, uid = manual_ticket.partition("#")
        client.ticket = token.strip()
        client.user_id = uid.strip()
        print(f"账号 {client.index} 使用手动 ticket: {mask(client.ticket)}")
        if client.check_ticket():
            return True
        print(f"账号 {client.index} 手动 ticket 校验未通过, 继续尝试其他方式")
        client.ticket, client.user_id = "", ""

    if client.load_cache():
        print(f"账号 {client.index} 使用缓存 ticket: {mask(client.ticket)}")
        if client.check_ticket():
            return True
        print(f"账号 {client.index} 缓存 ticket 失效")
        client.ticket, client.user_id = "", ""
        client.forget_ticket()

    if not ALLOW_PHONE_LOGIN:
        raise RuntimeError("无可用 ticket, 且 hshj_phone_login=0 已关闭手机号登录")

    is_register = client.login_by_phone()
    print(f"账号 {client.index} 登录成功: userId={client.user_id} "
          f"{'(首次注册)' if str(is_register) == '1' else ''}")
    return True


def notify(lines):
    if os.getenv("HSHJ_NOTIFY", "1").lower() in {"0", "false", "no"}:
        return
    for path in (os.path.dirname(os.path.abspath(__file__)), "/ql/data/scripts", "/ql/scripts"):
        if path not in sys.path:
            sys.path.insert(0, path)
    try:
        from notify import send
        send("红色火箭签到", "\n".join(lines))
    except Exception as exc:
        print(f"[通知] 发送失败（不影响任务）：{exc}")


def run_one(index, server, ref):
    result = [f"账号 {index}（YYB {mask(ref)}）"]
    try:
        client = RedRocket(server, ref, index)

        client.encrypt_key, client.encrypt_ver = get_encrypt_key(server, ref)
        if not client.encrypt_key:
            result.append("失败：YYB 未返回 encryptKey（/wx/encryptkey 需要该账号在目标小程序侧可用），无法签名")
            return result
        client.resolve_openid()

        manual = MANUAL_TICKETS[index - 1] if index - 1 < len(MANUAL_TICKETS) else ""
        ensure_ticket(client, manual)

        state = client.get_sign_days()
        signed, days, today_point = RedRocket.parse_sign_state(state)

        if signed is True:
            # 幂等优先: 已签则不再提交, 但仍汇报积分余额
            result.append(f"今日已签到{f'，连续 {days} 天' if days is not None else ''}")
        else:
            ok, body = client.sign_in()
            if ok:
                data = body.get("data")
                gained = None
                if isinstance(data, dict):
                    gained = data.get("point") or data.get("points") or data.get("addPoint")
                gained = gained or today_point
                result.append(f"签到成功，+{gained} 积分" if gained else "签到成功")
            else:
                detail = RedRocket.err(body)
                if any(k in detail for k in ("已签", "重复", "已参与", "已领取")):
                    result.append("今日已签到")
                else:
                    result.append(f"失败：签到失败: {detail}")
                    return result

        point = client.total_point()
        if point is not None:
            result.append(f"当前积分: {point}")
    except Exception as exc:
        result.append(f"失败：{exc}")
    print("\n".join(result))
    return result


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except AttributeError:
        pass

    output = ["红色火箭：积分中心每日签到"]
    for index, (server, ref) in enumerate(routes(), 1):
        output.extend(run_one(index, server, ref))
        time.sleep(1)
    notify(output)


MANUAL_TICKETS = [
    x.strip() for x in os.getenv("hshj_ticket", "").replace("&", "\n").splitlines() if x.strip()
]

if __name__ == "__main__":
    main()
