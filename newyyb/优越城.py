#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
name: 优越城签到（yyb-go 版）
cron: 18 8 * * *

青龙环境变量：
  YYB_SERVER       必填，YYB-Go-Enhanced地址@微信账号标识，多账号每行一条
                   例：yyb-go:8000@1
  YYBGO_MALL_NO    可选，mallNo，默认 142（本小程序 ext 配置里的商城号）
  YYBGO_MALL_NO_VIRTUAL_GROUP
                   可选，设置后注册时改传该虚拟商城组编号（config.mallNoVirtualGroup）
  YYBGO_LAT/LON    可选，签到定位；缺省则不传 lat/lon（等同小程序未授权定位）
  YYBGO_CACHE_FILE 可选，会话缓存路径，默认 /ql/data/config/yyb_go_wx09d8a738c7d4d31d.json
  YYBGO_PLATFORM/YYBGO_BRAND/YYBGO_MODEL/YYBGO_SYSTEM/YYBGO_WX_VERSION/YYBGO_SDK_VERSION
                   可选，参与 deviceId 计算的设备信息（已生成 deviceId 后改动需清缓存）

依赖：requests、pycryptodome
通知：使用青龙内置 notify.py；通知失败不影响签到任务结果。
功能：通过 YYB-Go-Enhanced 取 wx.login code，完成 BOP 设备注册（RSA 交换会话密钥）建立会员登录态；
      注册响应不带会员标识时，按小程序链路调 member/unionapplogin 用 openId 补会员登录态；
      查询本周签到记录，未签到时调用会员签到接口，复查状态后通知签到结果、连续签到天数与今日奖励。

小程序：wx09d8a738c7d4d31d（mobcb 通用商城小程序，接口网关 https://bop.mobcb.com/api/v3/）
YYB 通信：与 hrt.py 一致（POST /wxapp/getCode，body {ref, app_id}，取 data.result.code）
说明：响应签名（Mobcb-Sign）未做校验（与 hrt.py 一样只验业务错误码），不影响签到结果。
逆向依据（wx09d8a738c7d4d31d/project/common/vendor.js，webpack 模块 b3af 及各配置模块）：
  - 请求器 GET_API_URL / PPD：
      * 公共参数由 U() 注入，clientType 取 public.getClientSource() = "mini_weixin"
      * 参数按 key 升序（public.sortProperty），sign = SHA256(
            [signWithPath ? encodeURIComponent(相对路径) : ""] + "k=v&…" + signKey )
        其中 signKey = devicesRegisterCheck ? 会话 signKey : wap_KEYS[timestamp % 10]
      * POST 业务参数整体进 body：EncryptBody=true 时为 {"reqBody": AES/3DES-CBC(Pkcs7)}，
        密钥 = 会话 workKey（base64），iv 见下；body 字段（JSON 文本）参与签名后从 query 里删除
      * query 中字符串值统一 encodeURIComponent（PPD 只对 phone 编码），
        避免 accessToken 里的 +/= 被 query 解码破坏，服务端解码后取值与签名原值一致
      * iv = devicesRegisterCheck ? 本地时间 "yyyyMMddhhmmss" + "00" : "yyyyMMdd"
        （Date.prototype.format 的 "h+" 取 getHours()，即 24 小时制；16 位 iv 走 AES，8 位走 3DES）
      * 响应体解密：devicesRegisterCheck 用 workKey，否则用 wap_KEYS[毫秒时间戳 % 10][:24]（base64）
        与 iv = 毫秒时间戳字符串后 8 位；实测网关加密响应体时常不回 Mobcb-Timestamp
        响应头，此时按 envelope 的 reqTime/serviceTime、再按本地时间多候选 iv 试解
  - 会话建立：GET securities/rsa/pubkey?appKey&deviceId&rnd → body.publicKey，
      POST securities/devices/register?appKey&deviceId&rnd（header EncryptRsa:true，
      body {"reqBody": 客户端公钥/密钥种子等 JSON 的 RSA(Pkcs1v1.5) 分段加密}）→
      返回 accessToken/workKey/signKey/registerTime/sessionValiditySeconds/useNewAlgorithm/
      signWithPath/loginVerifyResult；两个接口的 rnd 各自独立生成（M() 里 pubkey 用新 rnd），
      复用同一个 rnd 会被服务端按 nonce 判重，返回 PUB-00008「请勿重复请求」
  - 微信登录：store actions.updateUniLoginApiInfo 把 wx.login 的 code 写入 miniSessionData.uniLoginCode，
      注册时作为 loginVerify.code 提交（appId 取 config.mCloudApi.miniAppId，platform="wechat"）
  - 会话有效性（N()）：accessToken/workKey 非空且 now <= registerTime + sessionValiditySeconds
      - (sessionValiditySeconds <= 300 ? 0 : 300)
  - 会员登录：设备注册响应的 loginVerifyResult 只在「该微信已是本商城会员」时才带
      memberId/generalMemberId；否则 store.autoMiniLogin 会用 loginVerifyResult.openId
      调 POST member/unionapplogin 取 body.id（needBindPhone=0 时 userId=generalMemberId=id），
      脚本在注册未带回会员标识时补做这一步（mallId 由请求公共参数带上）
  - 商城信息：mallId 取自商城详情接口；mall/info 不带参数时服务端返回 -1「没有查询数据」，
      因此先按 mallNo 走 GET mall/mallNo/{mallNo}/info（对应 getMallDetailByMallNo），
      会员接口缺 mallId 会报 COM-00024
  - 业务接口：GET member/{uid}/signs/history（weekStart/weekEnd = 今天±3 天，monthStart/monthEnd = 日历月），
      POST member/{uid}/signs（lat/lon）签到（响应里的 continuousDays/maxContinuousDays 即连续天数），
      GET member/{uid}/ongoingsignnum 仅返回签到活动配置（无顶层 signNum），
      GET member/signs/rule 签到规则；weekSignIns 条目含 monthDay/today/signed/awardList/creditValue
"""
from __future__ import annotations

import base64
import hashlib
import importlib.util
import json
import math
import os
import random
import string
import sys
import time
import urllib.parse
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import requests
from Crypto.Cipher import AES, DES3, PKCS1_v1_5
from Crypto.PublicKey import RSA
from Crypto.Util.Padding import pad, unpad

APP_ID = "wx09d8a738c7d4d31d"
API_BASE = "https://bop.mobcb.com/api/v3/"
APP_KEY = "OW5OGNWC"
# config.apiSign.wap_KEYS：小程序未配置 appSecret 时使用内置的 10 个签名密钥。
WAP_KEYS = [
    "N94QKAZD289GQARELPOJQGZM8",
    "GFNCV79W9U1CYFEXQ904OI6BB",
    "C1BOEMXCP1A5KUBVQIXKGBH51",
    "0RU2DV7E67T7ZMPQXWAVD99MY",
    "EPOJKLVKIQQMGG9XWT9C28F5C",
    "8GTBBWEADC6RG237EUEC7KZFU",
    "1XP3TLH0BZMZS7TT3TF7JD500",
    "TNFVOH7WHTC4NCD6SI9QZ3W5N",
    "ZZNEL2ULF9TPAC9NU3493GL7I",
    "8SABWT2MB1JOHOM02QVN36TGI",
]
SUCCESS = "PUB-00000"
# code.PUB_*：会话失效（清会话重登）与微信 code 失效（需重新 wx.login）。
RELOGIN_CODES = {"PUB-00057", "PUB-00018", "PUB-00019", "PUB-00022", "PUB-00021", "SC00033"}
CODE_INVALID_CODES = {"PUB-02103", "SC00033"}
TIMEOUT = 25
UA = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) "
    "AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 "
    "MicroMessenger/8.0.75(0x18004b21) NetType/WIFI Language/zh_CN"
)
TZ = timezone(timedelta(hours=8))  # 小程序 iv/日期都用本地时间（境内为 UTC+8）
MALL_NO = os.getenv("YYBGO_MALL_NO", "142")
SIGN_LAT = os.getenv("YYBGO_LAT", "")
SIGN_LON = os.getenv("YYBGO_LON", "")
CACHE_FILE = Path(os.getenv("YYBGO_CACHE_FILE", "/ql/data/config/yyb_go_wx09d8a738c7d4d31d.json"))
# U() 注入的客户端字段（小程序端取自系统信息，脚本侧用固定合理值，可用环境变量覆盖）
CLIENT_TYPE = "mini_weixin"
CLIENT_APP_NAME = "memberClient"
PLATFORM = os.getenv("YYBGO_PLATFORM", "ios")
BRAND = os.getenv("YYBGO_BRAND", "iPhone")
DEVICE_MODEL = os.getenv("YYBGO_MODEL", "iPhone 16 Pro")
OS_VERSION_RAW = os.getenv("YYBGO_SYSTEM", "iOS 16.0")
WX_VERSION = os.getenv("YYBGO_WX_VERSION", "8.0.75")
SDK_VERSION = os.getenv("YYBGO_SDK_VERSION", "3.5.7")
MINI_VERSION = os.getenv("YYBGO_MINI_VERSION", "1.0.0")  # 小程序版本（appVersion）
CONFIG_VERSION = os.getenv("YYBGO_CONFIG_VERSION", "9")  # config.version（customVersion）


# --------------------------------------------------------------------- 通用
def compact(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def safe_message(value: Any, limit: int = 160) -> str:
    text = str(value or "未知错误").replace("\n", " ").strip()
    return text[:limit]


def nested(data: Any, *names: str) -> Any:
    queue = [data]
    while queue:
        item = queue.pop(0)
        if isinstance(item, dict):
            for name in names:
                if item.get(name) not in (None, ""):
                    return item[name]
            queue.extend(item.values())
        elif isinstance(item, list):
            queue.extend(item)
    return None


def no_space(text: Any) -> str:
    """对应 public.replaceSpace(value, true)：去掉全部空白。"""
    return "".join(str(text or "").split())


def error_text(payload: Any) -> str:
    """拼接 errorCode 与 errorMessage，便于定位服务端返回（如 PUB-00008 请勿重复请求）。"""
    if not isinstance(payload, dict):
        return safe_message(payload)
    code = str(payload.get("errorCode") or "")
    raw = payload.get("errorMessage")
    message = safe_message(raw) if raw else ""
    if code and message and message != code:
        return f"{code} {message}"
    return message or code or "未知错误"


def js_empty(value: Any) -> bool:
    """对应 public.isEmpty：null/undefined/""/"null"/"None"/"(null)" 视为空，0 与 false 不算空。"""
    return value is None or value == "" or value in ("null", "None", "undefined", "(null)")


def js_text(value: Any) -> str:
    """对应 JS 字符串拼接：布尔转 true/false，数组按逗号连接，对象转 [object Object]。"""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (list, tuple)):
        return ",".join(js_text(item) for item in value)
    if isinstance(value, dict):
        return "[object Object]"
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


def js_encode(value: Any) -> str:
    """对应 encodeURIComponent。"""
    return urllib.parse.quote(js_text(value), safe="!()*-._~'")


def sort_property(data: Dict[str, Any]) -> Dict[str, Any]:
    """对应 public.sortProperty：按 key 升序重建对象。"""
    return {key: data[key] for key in sorted(data.keys())}


def random_mixed(length: int) -> str:
    """对应 public.getGenerateMixed：数字 + 大写 + 小写字母随机串。"""
    pool = string.digits + string.ascii_uppercase + string.ascii_lowercase
    return "".join(random.choice(pool) for _ in range(length))


def md5_text(text: str) -> str:
    return hashlib.md5(text.encode()).hexdigest()


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def b64_text_to_bytes(text: str) -> bytes:
    text = (text or "").strip()
    return base64.b64decode(text + "=" * (-len(text) % 4))


# ------------------------------------------------------------- 加解密（b3af）
def iv_text(timestamp: int, new_algorithm: bool) -> str:
    """对应 k()：新算法 本地时间 yyyyMMddHHmmss + "00"（16 位 → AES），旧算法 yyyyMMdd（8 位 → 3DES）。"""
    moment = datetime.fromtimestamp(timestamp, TZ)
    if new_algorithm:
        return moment.strftime("%Y%m%d%H%M%S") + "00"
    return moment.strftime("%Y%m%d")


def sym_encrypt(plain: str, key_b64: str, iv: str) -> str:
    """对应 B()：CryptoJS AES/3DES-CBC + Pkcs7，算法按 iv 长度选择。"""
    key = b64_text_to_bytes(key_b64)
    iv_bytes = iv.encode()
    if len(iv_bytes) == 16:
        data = AES.new(key, AES.MODE_CBC, iv_bytes).encrypt(pad(plain.encode(), 16))
    else:
        data = DES3.new(key, DES3.MODE_CBC, iv_bytes).encrypt(pad(plain.encode(), 8))
    return base64.b64encode(data).decode()


def sym_decrypt(cipher_b64: str, key_b64: str, iv: str) -> str:
    """对应 x()：响应体解密。"""
    key = b64_text_to_bytes(key_b64)
    iv_bytes = iv.encode()
    raw = b64_text_to_bytes(cipher_b64)
    if len(iv_bytes) == 16:
        return unpad(AES.new(key, AES.MODE_CBC, iv_bytes).decrypt(raw), 16).decode()
    return unpad(DES3.new(key, DES3.MODE_CBC, iv_bytes).decrypt(raw), 8).decode()


def rsa_import_public(b64_key: str) -> RSA.RsaKey:
    """对应 JSEncrypt.setPublicKey：PEM 与裸 base64（DER）都接受。"""
    text = (b64_key or "").strip()
    if "BEGIN" in text:
        return RSA.import_key(text)
    text = "".join(text.split())
    return RSA.import_key(base64.b64decode(text + "=" * (-len(text) % 4)))


def rsa_public_b64(key: RSA.RsaKey) -> str:
    return base64.b64encode(key.publickey().export_key(format="DER")).decode()


def rsa_encrypt_text(key: RSA.RsaKey, text: str) -> bytes:
    """对应 JSEncrypt.encryptToHex：Pkcs1v1.5 分段加密，1024 位密钥每段最多 117 字节。"""
    cipher = PKCS1_v1_5.new(key)
    raw = text.encode()
    size = key.size_in_bytes() - 11
    out = b""
    for index in range(0, len(raw), size):
        out += cipher.encrypt(raw[index:index + size])
    return out


def rsa_decrypt_bytes(key: RSA.RsaKey, data: bytes) -> str:
    """对应 decrypt2Hex：按密钥长度分段解密。"""
    cipher = PKCS1_v1_5.new(key)
    size = key.size_in_bytes()
    out = b""
    for index in range(0, len(data), size):
        chunk = cipher.decrypt(data[index:index + size], None)
        if not chunk:
            raise RuntimeError("会话注册响应 RSA 解密失败")
        out += chunk
    return out.decode()


# ------------------------------------------------------------------ 日期区间
def week_range() -> Tuple[str, str]:
    """对应 store.getSignHistory：weekStart/weekEnd = 今天 ± 3 天（UTC+8，yyyy-MM-dd）。"""
    today = datetime.now(TZ).date()
    return (
        (today - timedelta(days=3)).strftime("%Y-%m-%d"),
        (today + timedelta(days=3)).strftime("%Y-%m-%d"),
    )


def month_range() -> Tuple[str, str]:
    """对应 date.ZeroCalendar().getDatesOfMonth：日历首格 ~ 最后一行的第 7 列（可能跨月）。"""
    today = datetime.now(TZ).date()
    first = today.replace(day=1)
    days = (first.replace(day=28) + timedelta(days=4)).replace(day=1) - first  # 本月天数
    offset = first.weekday()  # 首列为周一，offset = (1 日 getDay() + 6) % 7
    start = first - timedelta(days=offset)
    rows = math.ceil((offset + days.days) / 7)
    end = start + timedelta(days=rows * 7 - 1)
    return start.strftime("%Y-%m-%d"), end.strftime("%Y-%m-%d")


def summarize_awards(body: Any) -> str:
    """从签到响应里提取奖励描述（awardList/prizeList 等结构不固定，做通用遍历）。"""
    items: List[str] = []

    def walk(node: Any) -> None:
        if isinstance(node, dict):
            name = nested(node, "awardName", "prizeName", "couponName", "awardType", "type")
            value = nested(node, "credit", "awardNumber", "couponNumber", "creditValue", "awardValue")
            if name and not js_empty(value):
                items.append(f"{name}x{value}")
            for item in node.values():
                walk(item)
        elif isinstance(node, list):
            for item in node:
                walk(item)

    try:
        walk(body)
    except Exception:
        return ""
    unique: List[str] = []
    for item in items:
        if item not in unique:
            unique.append(item)
    return "、".join(unique[:6])


# --------------------------------------------------------------------- 账号
@dataclass
class Account:
    server: str
    ref: str
    index: int

    @property
    def label(self) -> str:
        return f"账号{self.index}"


def parse_accounts() -> List[Account]:
    accounts: List[Account] = []
    for line in os.getenv("YYB_SERVER", "").splitlines():
        line = line.strip()
        if not line or "@" not in line:
            continue
        server, ref = line.rsplit("@", 1)
        server, ref = server.strip().rstrip("/"), ref.strip()
        if not server.startswith(("http://", "https://")):
            server = "http://" + server
        if server and ref:
            accounts.append(Account(server, ref, len(accounts) + 1))
    if not accounts:
        raise RuntimeError("未配置 YYB_SERVER（格式：地址@微信账号标识，多账号换行）")
    return accounts


def load_cache() -> Dict[str, Any]:
    try:
        data = json.loads(CACHE_FILE.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def save_cache(cache: Dict[str, Any]) -> None:
    try:
        CACHE_FILE.parent.mkdir(parents=True, exist_ok=True)
        temp = CACHE_FILE.with_suffix(".tmp")
        temp.write_text(compact(cache), encoding="utf-8")
        os.chmod(temp, 0o600)
        temp.replace(CACHE_FILE)
        os.chmod(CACHE_FILE, 0o600)
    except Exception as exc:
        print(f"  缓存写入失败（不影响签到）：{safe_message(exc)}")


# ------------------------------------------------------------------ 会话数据
@dataclass
class SessionData:
    access_token: str = ""
    work_key: str = ""
    sign_key: str = ""
    register_time: int = 0
    session_validity_seconds: int = 0
    devices_register_check: bool = False
    sign_with_path: bool = False
    des_encrypt_flag: bool = True
    m_cloud_api_encrypt: bool = False
    uni_login_code: str = ""
    uni_login_anonymous_code: str = ""
    member_id: str = ""
    general_member_id: str = ""
    open_id: str = ""
    union_id: str = ""
    phone: str = ""
    device_id: str = ""

    @property
    def uid(self) -> str:
        return self.member_id or self.general_member_id


class Mobcb:
    def __init__(self, account: Account):
        self.account = account
        self.session = requests.Session()
        self.session.headers.update({"User-Agent": UA})
        self.data = SessionData()
        self.mall_id = ""

    # ------------------------------------------------------------- YYB 通信
    def yyb(self, endpoint: str, extra: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """与 hrt.py 相同的 YYB-Go-Enhanced 调用方式。"""
        body: Dict[str, Any] = {"ref": self.account.ref, "app_id": APP_ID}
        if extra:
            body.update(extra)
        response = self.session.post(self.account.server + endpoint, json=body, timeout=TIMEOUT)
        response.raise_for_status()
        outer = response.json()
        if int(outer.get("code", -1)) != 0:
            raise RuntimeError(f"YYB {endpoint}：{safe_message(outer.get('msg') or outer.get('message'))}")
        result = outer.get("data", {}).get("result")
        if isinstance(result, str):
            try:
                result = json.loads(result)
            except json.JSONDecodeError:
                pass
        if not isinstance(result, dict):
            raise RuntimeError(f"YYB {endpoint} 未返回有效对象")
        return result

    def wx_code(self) -> str:
        result = self.yyb("/wxapp/getCode")
        code = str(nested(result, "code") or "")
        if len(code) < 8:
            raise RuntimeError("YYB getCode 未返回有效微信登录 code")
        return code

    # --------------------------------------------------------- 缓存/设备信息
    def load(self, entry: Dict[str, Any]) -> None:
        session = entry.get("session") if isinstance(entry, dict) else None
        if isinstance(session, dict):
            known = {field: session[field] for field in SessionData().__dict__ if field in session}
            self.data = SessionData(**known)
        if isinstance(entry, dict) and entry.get("mall_id"):
            self.mall_id = str(entry["mall_id"])
        self.data.device_id = self.build_device_id(str((entry or {}).get("device_id") or ""))

    def dump(self) -> Dict[str, Any]:
        return {
            "session": asdict(self.data),
            "device_id": self.data.device_id,
            "mall_id": self.mall_id,
            "updated_at": int(time.time()),
        }

    def build_device_id(self, cached: str = "") -> str:
        """对应 public.getDeviceId(true)：MD5(platform+brand+model+system+version+SDKVersion+appId) + 10 位随机大写。"""
        seed = (
            no_space(PLATFORM)
            + no_space(BRAND)
            + no_space(DEVICE_MODEL)
            + no_space(OS_VERSION_RAW)
            + no_space(WX_VERSION)
            + no_space(SDK_VERSION)
            + APP_ID
        )
        prefix = md5_text(seed)
        if len(cached) == 42 and cached[:32] == prefix:
            return cached
        return (prefix + random_mixed(10).upper())[:42]

    # ------------------------------------------------------------ 会话注册
    def session_valid(self) -> bool:
        """对应 N()：accessToken/workKey 非空且未过期（有效期 <=300 秒时不预留续期时间）。"""
        data = self.data
        if not data.access_token or not data.work_key or not data.register_time:
            return False
        reserve = 0 if data.session_validity_seconds <= 300 else 300
        deadline = data.register_time + data.session_validity_seconds - reserve
        return int(time.time()) <= deadline

    def ensure_session(self, force: bool = False) -> None:
        if not force and self.session_valid():
            return
        print("  登录：重新注册 BOP 设备会话")
        self.register()

    def rsa_public_key(self, device_id: str, rnd: str) -> RSA.RsaKey:
        params = {"appKey": APP_KEY, "deviceId": device_id, "rnd": rnd}
        url = f"{API_BASE}securities/rsa/pubkey?{urllib.parse.urlencode(params)}"
        response = self.session.get(url, headers={"content-type": "application/json"}, timeout=TIMEOUT)
        response.raise_for_status()
        payload = response.json()
        body = payload.get("body") if isinstance(payload.get("body"), dict) else {}
        public_key = str(body.get("publicKey") or "")
        if payload.get("errorCode") != SUCCESS or not public_key:
            raise RuntimeError(f"获取 RSA 公钥失败：{safe_message(payload.get('errorMessage') or payload.get('errorCode'))}")
        return rsa_import_public(public_key)

    def register(self) -> None:
        """对应 M()：wx.login code 写入 uniLoginCode 后做设备注册，响应里带 accessToken/workKey。"""
        # updateUniLoginApiInfo：每次登录都重新取一次性 code，并保证有客户端 signKey
        self.data.uni_login_code = self.wx_code()
        self.data.uni_login_anonymous_code = ""
        if not self.data.sign_key:
            self.data.sign_key = random_mixed(32)
        # M()：register 用开头生成的 rnd，取公钥时另生成一个 rnd（两个 nonce 不能复用，
        # 复用会让服务端按 nonce 判重直接返回 PUB-00008「请勿重复请求」）
        register_rnd = random_mixed(20)
        device_id = self.data.device_id or self.build_device_id()
        self.data.device_id = device_id
        server_key = self.rsa_public_key(device_id, random_mixed(20))
        client_key = RSA.generate(1024)
        payload: Dict[str, Any] = {
            "clientPublicKey": rsa_public_b64(client_key),
            "keySeed": random_mixed(30),
        }
        if self.data.sign_key:
            payload["signKey"] = self.data.sign_key
        if self.data.uni_login_code:
            payload["loginVerify"] = {
                "anonymousCode": self.data.uni_login_anonymous_code or "",
                "appId": APP_ID,
                "code": self.data.uni_login_code,
                "platform": "wechat",
            }
        # M()：mallNoVirtualGroup 优先，否则用 mallNo（本小程序 ext 配置里的商城号）
        virtual_group = os.getenv("YYBGO_MALL_NO_VIRTUAL_GROUP", "")
        if virtual_group:
            payload["mallNo"] = virtual_group
        elif MALL_NO:
            payload["mallNo"] = MALL_NO
        params = {"appKey": APP_KEY, "deviceId": device_id, "rnd": register_rnd}
        url = f"{API_BASE}securities/devices/register?{urllib.parse.urlencode(params)}"
        body = {"reqBody": base64.b64encode(rsa_encrypt_text(server_key, compact(payload))).decode()}
        response = self.session.post(
            url,
            json=body,
            headers={"Content-Type": "application/json", "EncryptRsa": "true"},
            timeout=TIMEOUT,
        )
        response.raise_for_status()
        result = response.json()
        if result.get("errorCode") != SUCCESS:
            message = error_text(result)
            if result.get("errorCode") in CODE_INVALID_CODES:
                message += "（微信登录 code 无效，请确认 YYB 微信账号已登录该小程序）"
            if result.get("errorCode") == "PUB-00008":
                message += "（服务端判定请求重复/过快，多为 rnd 等一次性参数被复用，或换登录态过于频繁）"
            raise RuntimeError(f"设备注册失败：{message}")
        data = result.get("body")
        if isinstance(data, str):
            data = rsa_decrypt_bytes(client_key, b64_text_to_bytes(data))
            data = json.loads(data)
        if not isinstance(data, dict):
            raise RuntimeError("设备注册响应格式异常")
        # 服务端下发的能力开关覆盖默认值：c = {desEncryptFlag:true, mCloudApiEncrypt:false}
        verify = data.get("loginVerifyResult") if isinstance(data.get("loginVerifyResult"), dict) else {}
        register_time = int(data.get("registerTime") or time.time())
        if register_time > 10 ** 11:  # 服务端若返回毫秒时间戳
            register_time //= 1000
        validity = int(data.get("sessionValiditySeconds") or 0)
        merged = self.data
        self.data = SessionData(
            access_token=str(data.get("accessToken") or merged.access_token or ""),
            work_key=str(data.get("workKey") or merged.work_key or ""),
            sign_key=str(data.get("signKey") or merged.sign_key or ""),
            register_time=register_time,
            session_validity_seconds=validity if validity > 0 else 3600,
            devices_register_check=bool(data.get("useNewAlgorithm")),
            sign_with_path=bool(data.get("signWithPath")),
            des_encrypt_flag=bool(data.get("desEncryptFlag", True)),
            m_cloud_api_encrypt=bool(data.get("mCloudApiEncrypt", False)),
            uni_login_code=merged.uni_login_code,
            uni_login_anonymous_code=merged.uni_login_anonymous_code,
            member_id=str(verify.get("memberId") or ""),
            general_member_id=str(verify.get("generalMemberId") or ""),
            open_id=str(verify.get("openId") or ""),
            union_id=str(verify.get("unionId") or ""),
            phone=str(verify.get("mobile") or verify.get("phone") or ""),
            device_id=device_id,
        )
        if not self.data.access_token or not self.data.work_key:
            raise RuntimeError("设备注册未返回 accessToken/workKey")
        # loginVerifyResult 的字段名决定能否自动补会员登录（member/unionapplogin），打印出来便于排查
        raw_verify = data.get("loginVerifyResult")
        if isinstance(raw_verify, dict):
            fields = "、".join(sorted(raw_verify)) or "空对象"
        elif raw_verify is None:
            fields = "无"
        else:
            fields = f"非对象（{type(raw_verify).__name__}）"
        print(f"  登录：BOP 设备注册成功（会员标识 {self.data.uid or '空'}；loginVerifyResult 字段：{fields}）")

    # --------------------------------------------------------------- 请求器
    def sign_key(self, timestamp: int) -> str:
        """对应 I()。"""
        if self.data.devices_register_check:
            return self.data.sign_key
        return WAP_KEYS[int(timestamp) % len(WAP_KEYS)]

    def common_params(self, timestamp: int) -> Dict[str, Any]:
        """对应 U()：注入公共参数（未取到会员手机号时 appUStatus=0）。"""
        uid = self.data.uid
        return {
            "clientType": CLIENT_TYPE,
            "appVersion": MINI_VERSION,
            "customVersion": CONFIG_VERSION,
            "osVersion": no_space(OS_VERSION_RAW),
            "model": no_space(DEVICE_MODEL),
            "clientAppName": CLIENT_APP_NAME,
            "rnd": random_mixed(30),
            "appKey": APP_KEY,
            "sid": uid,
            "appUid": uid,
            "appUStatus": 1 if self.data.phone else 0,
            "deviceId": self.data.device_id,
            "sdkVersion": SDK_VERSION,
            "programVersion": WX_VERSION,
            "dfvToken": "",
            "thirdAdChannel": "",
            "sceneType": "",
            "sceneValue": "",
        }

    @staticmethod
    def relative_path(path: str) -> str:
        """对应 _()：取 /api/v3/ 之后的相对路径；带域名时返回空串。"""
        candidate = path.split("?")[0].split("#")[0]
        marker = "/api/v3/"
        if marker in candidate:
            return candidate.split(marker, 1)[1].lstrip("/")
        if "://" in candidate:
            return ""
        stripped = candidate.lstrip("/")
        if stripped.startswith("api/v3/"):
            return stripped[len("api/v3/"):].lstrip("/")
        return stripped

    def sign_source(self, path: str, params: Dict[str, Any], timestamp: int) -> str:
        """对应签名拼串：可选路径前缀 + 升序 key=value&…（末尾 & 去掉后） + signKey。"""
        source = urllib.parse.quote(self.relative_path(path), safe="") if self.data.sign_with_path else ""
        for key, value in params.items():
            if not js_empty(value):
                source += f"{key}={js_text(value)}&"
        return source[:-1] + self.sign_key(timestamp)

    def request_headers(self) -> Dict[str, str]:
        """对应 F()。"""
        return {
            "Content-Type": "application/json",
            "EncryptBody": js_text(bool(self.data.des_encrypt_flag)),
            "Mobcb-Encrypt": js_text(bool(self.data.m_cloud_api_encrypt)),
            "Mobcb-DevicesRegisterCheck": js_text(bool(self.data.devices_register_check)),
        }

    def decode_response(self, payload: Dict[str, Any], headers: Any) -> Any:
        """对应 G()：按响应时间戳解密 body。

        实测 BOP 网关（devicesRegisterCheck=true 的会话）加密了业务响应体，却经常
        不带 Mobcb-Timestamp 响应头，此时按 G() 的逻辑会直接放弃解密，调用方只能拿到
        base64 密文。因此这里改为：响应头时间戳 > envelope 的 reqTime/serviceTime >
        本地时间多候选依次尝试（服务端 iv 用的是其本地时间 yyyyMMddHHmmss+"00"）。
        """
        body = payload.get("body")
        if not isinstance(body, str) or not body:
            return body
        stamp = str(headers.get("Mobcb-Timestamp") or headers.get("mobcb-timestamp") or "")
        encrypt_flag = str(headers.get("Mobcb-Encrypt") or headers.get("mobcb-encrypt") or "").lower()
        encrypted = payload.get("encrypted") is True or str(payload.get("encrypted")).lower() == "true"
        if self.data.devices_register_check:
            if not stamp and not encrypted:
                return body
            for seconds in self.response_stamp_candidates(payload, stamp):
                try:
                    plain = sym_decrypt(body, self.data.work_key, iv_text(seconds, True))
                except Exception:
                    continue
                try:
                    return json.loads(plain)
                except json.JSONDecodeError:
                    return plain
            print("  响应体解密失败（按明文处理，后续可能缺字段）")
            return body
        if encrypt_flag == "true" and stamp:
            try:
                key = base64.b64encode(WAP_KEYS[int(stamp) % len(WAP_KEYS)][:24].encode()).decode()
                body = sym_decrypt(body, key, stamp[-8:])
            except Exception as exc:
                print(f"  响应体解密失败（按明文处理）：{safe_message(exc)}")
                return payload.get("body")
            try:
                return json.loads(body)
            except (TypeError, json.JSONDecodeError):
                return body
        return body

    @staticmethod
    def response_stamp_candidates(payload: Dict[str, Any], stamp: str) -> List[int]:
        """响应体解密 iv 的时间戳（秒）候选：响应头 > envelope 时间 > 本地时间 ±2 秒。"""
        candidates: List[int] = []
        if stamp:
            try:
                candidates.append(int(int(stamp) / 1000))
            except (TypeError, ValueError):
                pass
        for name in ("reqTime", "serviceTime"):
            try:
                seconds = int(payload.get(name))
            except (TypeError, ValueError):
                continue
            if seconds > 10 ** 11:  # 服务端返回毫秒时间戳
                seconds //= 1000
            if seconds > 0:
                candidates.append(seconds)
        now = int(time.time())
        candidates.extend((now, now - 1, now + 1, now - 2, now + 2))
        unique: List[int] = []
        for item in candidates:
            if item not in unique:
                unique.append(item)
        return unique

    def call(self, method: str, path: str, params: Optional[Dict[str, Any]] = None) -> Any:
        params = dict(params or {})
        last_error = ""
        for attempt in range(2):
            try:
                self.ensure_session(force=attempt > 0)
            except Exception as exc:  # code 失效等场景重取一次 code
                last_error = safe_message(exc)
                if attempt == 0:
                    continue
                raise
            timestamp = int(time.time())
            headers = self.request_headers()
            if method.upper() == "POST":
                biz = dict(params)
                biz["mallId"] = biz.get("mallId") or self.mall_id
                biz = sort_property(biz)
                if self.data.des_encrypt_flag:
                    # EncryptBody=true：业务参数整体 AES/3DES 加密后放进 reqBody
                    data: Any = {"reqBody": sym_encrypt(compact(biz), self.data.work_key, iv_text(timestamp, self.data.devices_register_check))}
                else:
                    data = biz
                unsigned = self.common_params(timestamp)
                unsigned["mallId"] = biz.get("mallId") or self.mall_id
                unsigned["timestamp"] = timestamp
                unsigned["accessToken"] = self.data.access_token
                unsigned["body"] = compact(data)
                unsigned = sort_property(unsigned)
                sign = sha256_text(self.sign_source(path, unsigned, timestamp))
                sign_pool = {key: value for key, value in unsigned.items() if key != "body"}
                sign_pool["sign"] = sign
                sign_pool["signType"] = "sha"
                query = self.encode_query(sign_pool)
                url = API_BASE + self.relative_path(path) + "?" + query
                response = self.session.post(url, data=compact(data), headers=headers, timeout=TIMEOUT)
            else:
                merged = {**params, **self.common_params(timestamp)}
                merged["mallId"] = merged.get("mallId") or self.mall_id
                merged["timestamp"] = timestamp
                merged["accessToken"] = self.data.access_token
                merged = sort_property(merged)
                sign = sha256_text(self.sign_source(path, merged, timestamp))
                sign_pool = {**merged, "sign": sign, "signType": "sha"}
                query = self.encode_query(sign_pool)
                url = API_BASE + self.relative_path(path) + "?" + query
                response = self.session.get(url, headers=headers, timeout=TIMEOUT)
            response.raise_for_status()
            payload = response.json()
            code = str(payload.get("errorCode") or "")
            if code and code != SUCCESS:
                message = error_text(payload)
                if code in RELOGIN_CODES and attempt == 0:
                    print(f"  会话失效（{code}），重新注册微信登录态")
                    last_error = message
                    continue
                if code in CODE_INVALID_CODES:
                    message += "（微信登录 code 无效，请确认 YYB 微信账号已登录该小程序）"
                raise RuntimeError(f"{self.relative_path(path)}：{message}")
            return self.decode_response(payload, response.headers)
        raise RuntimeError(last_error or "请求失败")

    @staticmethod
    def encode_query(params: Dict[str, Any]) -> str:
        """query 序列化（照 GET_API_URL）：字符串值整体 encodeURIComponent，其余直接拼接。

        PPD 里只对 phone 做 encodeURIComponent，这里对所有字符串统一编码，避免 accessToken
        中的 +/= 被 query 解码规则破坏；服务端解码后取值与签名所用原值一致。
        """
        parts: List[str] = []
        for key, value in params.items():
            if js_empty(value):
                continue
            parts.append(f"{key}={js_encode(value) if isinstance(value, str) else js_text(value)}")
        return "&".join(parts)

    def get(self, path: str, params: Optional[Dict[str, Any]] = None) -> Any:
        return self.call("GET", path, params)

    def post(self, path: str, params: Optional[Dict[str, Any]] = None) -> Any:
        return self.call("POST", path, params)

    # --------------------------------------------------------------- 业务
    def member_login(self) -> None:
        """对应 autoMiniLogin→loginMini：注册响应没带会员标识时，用 openId 换会员登录态。

        真机注册（M()）只在 loginVerifyResult 带 memberId/generalMemberId 时写 userId，
        否则由 store.autoMiniLogin 用 openId 调 member/unionapplogin 取 body.id：
        needBindPhone=0 时 userId 与 generalMemberId 同为该 id，否则只有通用会员标识。
        """
        if self.data.uid:
            return
        if not self.data.open_id:
            print("  登录：设备注册未返回 openId，跳过会员自动登录")
            return
        payload: Dict[str, Any] = {
            "platform": "wechat",
            "openId": self.data.open_id,
            "deviceId": self.data.device_id,
        }
        if self.data.union_id:
            payload["unionid"] = self.data.union_id
            payload["unionId"] = self.data.union_id
        print("  登录：注册响应无会员标识，改用 member/unionapplogin 换取")
        try:
            body = self.post("member/unionapplogin", payload)
        except Exception as exc:
            print(f"  登录：member/unionapplogin 调用失败（继续执行）：{safe_message(exc)}")
            return
        if not isinstance(body, dict):
            print(f"  登录：member/unionapplogin 响应非对象（{type(body).__name__}），无法读取会员标识")
            return
        member_id = str(body.get("id") or "")
        if not member_id:
            fields = "、".join(sorted(body)) or "空对象"
            print(f"  登录：member/unionapplogin 未返回会员标识（返回字段：{fields}）")
            return
        self.data.general_member_id = member_id
        if body.get("needBindPhone") in (0, "0", False):
            self.data.member_id = member_id
            self.data.phone = str(body.get("mobile") or "")
        tip = "已绑定手机号" if self.data.member_id else "待绑定手机号"
        print(f"  登录：会员自动登录成功（会员标识 {self.data.uid}，{tip}）")

    def mall_detail(self) -> None:
        """商城信息：按 mallNo 取商城详情（对应 getMallDetailByMallNo），取 mallId 供业务请求使用。

        真机启动时 mallId 未定时走 query 带 mallNo 的 mall/mallNo/{mallNo}/info；
        已知 mallId 时才走 mall/info（mallDetailByMallNoOrMallId）。不带任何参数的
        mall/info 服务端会直接返回 -1「没有查询数据」。
        """
        if self.mall_id:
            return
        attempts: List[Tuple[str, Dict[str, Any]]] = []
        if MALL_NO:
            attempts.append((f"mall/mallNo/{MALL_NO}/info", {}))
            attempts.append(("mall/info", {"mallNo": MALL_NO}))
        attempts.append(("mall/info", {}))
        for path, params in attempts:
            try:
                data = self.get(path, params)
            except Exception as exc:
                print(f"  {path} 查询失败（继续执行）：{safe_message(exc)}")
                continue
            mall_id = ""
            if isinstance(data, dict):
                mall_id = str(data.get("id") or data.get("mallId") or "")
            elif isinstance(data, list) and data and isinstance(data[0], dict):
                mall_id = str(data[0].get("id") or data[0].get("mallId") or "")
            if mall_id:
                self.mall_id = mall_id
                mall_no = str(data.get("mallNo") or "") if isinstance(data, dict) else ""
                suffix = f"，mallNo={mall_no}" if mall_no else ""
                print(f"  商城信息：mallId={mall_id}{suffix}")
                return
            print(f"  {path} 未返回 mallId（响应类型 {type(data).__name__}）")
        print("  商城信息：未取到 mallId（会员接口会报 COM-00024，请核对 YYBGO_MALL_NO）")

    def sign_history(self) -> Dict[str, Any]:
        """GET member/{uid}/signs/history：weekStart/weekEnd = 今天±3 天，并带本月日历范围。"""
        week_start, week_end = week_range()
        month_start, month_end = month_range()
        data = self.get(
            f"member/{self.data.uid}/signs/history",
            {"weekStart": week_start, "weekEnd": week_end, "monthStart": month_start, "monthEnd": month_end},
        )
        return data if isinstance(data, dict) else {}

    @staticmethod
    def today_item(history: Dict[str, Any]) -> Dict[str, Any]:
        week = history.get("weekSignIns") or []
        for item in week:
            if isinstance(item, dict) and item.get("today"):
                return item
        return {}

    def sign_continuous_days(self) -> Dict[str, Any]:
        """GET member/{uid}/ongoingsignnum：signNum/maxSignNum 连续签到天数。"""
        try:
            data = self.get(f"member/{self.data.uid}/ongoingsignnum", {})
        except Exception as exc:
            print(f"  连续签到天数查询失败（继续执行）：{safe_message(exc)}")
            return {}
        return data if isinstance(data, dict) else {}

    def run(self) -> Dict[str, Any]:
        self.ensure_session()
        self.mall_detail()
        self.member_login()
        if not self.data.uid and not self.data.open_id:
            # 旧缓存里没存 openId：重新注册一次设备会话，才有机会补上会员自动登录
            print("  登录：缓存会话缺 openId，重新注册设备会话")
            self.register()
            self.member_login()
        if not self.data.uid:
            raise RuntimeError(
                "设备注册成功但未返回会员标识，微信登录态未建立"
                "（loginVerifyResult 无 memberId/generalMemberId，member/unionapplogin 也没换到会员；"
                "请确认 YYB 里的微信账号就是优越城小程序的会员微信，且已在小程序里登录/绑定手机号）"
            )
        history = self.sign_history()
        today = self.today_item(history)
        already = bool(today.get("signed"))
        reward = ""
        sign_result: Dict[str, Any] = {}
        if not already:
            payload: Dict[str, Any] = {}
            if SIGN_LAT and SIGN_LON:
                payload = {"lat": SIGN_LAT, "lon": SIGN_LON}
            result = self.post(f"member/{self.data.uid}/signs", payload)
            sign_result = result if isinstance(result, dict) else {}
            reward = summarize_awards(result)
            for wait in (1, 2, 4):
                time.sleep(wait)
                history = self.sign_history()
                today = self.today_item(history)
                if today.get("signed"):
                    break
            else:
                raise RuntimeError("签到接口已提交，但复查签到记录仍未签到")
        if not reward:
            credit = nested(today, "creditValue")
            activity = nested(today, "activityCreditValue")
            parts = [f"积分x{credit}" if not js_empty(credit) else "", f"活动积分x{activity}" if not js_empty(activity) else ""]
            reward = "、".join(part for part in parts if part)
        days = self.sign_continuous_days()
        # ongoingsignnum 实测只返回签到活动配置（无顶层 signNum），连续天数改从签到响应取
        sign_num = days.get("signNum")
        max_sign_num = days.get("maxSignNum")
        if js_empty(sign_num) and not js_empty(sign_result.get("continuousDays")):
            sign_num = sign_result.get("continuousDays")
            max_sign_num = sign_result.get("maxContinuousDays")
        signed_days = sum(1 for item in (history.get("weekSignIns") or []) if isinstance(item, dict) and item.get("signed"))
        return {
            "already": already,
            "reward": reward,
            "signed_days": signed_days,
            "sign_num": None if js_empty(sign_num) else sign_num,
            "max_sign_num": None if js_empty(max_sign_num) else max_sign_num,
        }


# -------------------------------------------------------------------- 通知
def load_notify():
    candidates = [
        Path("/ql/data/scripts/notify.py"),
        Path("/ql/data/notify.py"),
        Path(__file__).with_name("notify.py"),
    ]
    for path in candidates:
        if not path.is_file():
            continue
        try:
            spec = importlib.util.spec_from_file_location("yybgo_qinglong_notify", path)
            module = importlib.util.module_from_spec(spec)
            assert spec and spec.loader
            spec.loader.exec_module(module)
            for name in ("send", "sendNotify"):
                func = getattr(module, name, None)
                if callable(func):
                    return func
        except Exception as exc:
            print(f"通知模块加载失败：{safe_message(exc)}")
    return None


def notify(text: str) -> None:
    func = load_notify()
    if not func:
        print("未找到青龙 notify.py，跳过通知")
        return
    try:
        func("优越城签到", text)
        print("青龙通知模块调用完成")
    except Exception as exc:
        print(f"青龙通知发送失败（不影响签到结果）：{safe_message(exc)}")


def main() -> int:
    try:
        accounts = parse_accounts()
    except Exception as exc:
        print(f"配置错误：{safe_message(exc)}")
        return 1
    cache = load_cache()
    messages: List[str] = []
    failures = 0
    for account in accounts:
        print(f"\n===== {account.label} =====")
        client = Mobcb(account)
        try:
            client.load(cache.get(account.ref) or {})
            result = client.run()
            cache[account.ref] = client.dump()
            save_cache(cache)
            status = "今日已签到" if result["already"] else "签到成功"
            lines = [f"{account.label}：{status}"]
            if result["sign_num"] is not None:
                lines.append(f"连续签到：{result['sign_num']} 天（历史最高 {result['max_sign_num']} 天）")
            lines.append(f"本周已签到：{result['signed_days']} 天")
            if result["reward"]:
                lines.append(f"今日奖励：{result['reward']}")
            line = "\n".join(lines)
            print(line)
            messages.append(line)
        except Exception as exc:
            failures += 1
            line = f"{account.label}：失败\n原因：{safe_message(exc)}"
            print(line)
            messages.append(line)
    content = "\n\n".join(messages)
    notify(content)
    print("\n===== 汇总 =====\n" + content)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
