#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
name: 会员通签到（ezrpro，品牌 7148）
cron: 18 11 * * *

青龙环境变量：
  YYB_SERVER  必填，YYB-Go-Enhanced地址@微信账号标识，多账号每行一条
              例：yyb-go:8000@1
  EZR_CACHE_FILE  可选，会话缓存路径，默认 /ql/data/config/wx0d6431d3cfefd889.json
  EZR_LOGIN_BACKOFF  可选，登录限流重试间隔秒数，逗号分隔，默认 30,60,120
  EZR_PROXY  可选，走代理请求网关（如 http://127.0.0.1:7890），用于更换出口 IP

依赖：requests、pycryptodome
通知：使用青龙内置 notify.py；通知失败不影响签到任务结果。
缓存：Fields 认证头（登录后下发），失效后自动通过 YYB-Go-Enhanced 重新登录。
功能：自动登录、查询签到状态、签到领积分/优惠券，并通知连续签到天数与本次奖励；
      登录态失效自动重登（取新 code），网关限流（太快了/429）按 6s/15s 退避重试。

小程序：wx0d6431d3cfefd889（ezrpro 会员通多品牌模板，ext 配置 brandid=7148）
逆向依据（project/ 反编译源码，webpack 模块号对应 common.js/vendors.js）：
  - 网关配置（67506）：API_HOST_CENTRE = https://wxa-tp.ezrpro.com/myvip/
  - 请求封装（12894/46378）：
      * 固定头 ezr-sp（登录 "2"）、ezr-source=weapp、ezr-brand-id=品牌号，
        再把 storage 的 Fields JSON 逐键展开为请求头（即认证态）
      * 业务响应 {Status, Msg, Result}；Status 9000 = 登录失效
      * POST 白名单路径（85644）用固定 AES 加密：key/iv 均为 UTF-8 文本，
        key "0fc804296b1e23821a193a67678ac25c"（32B = AES-256）、iv "0000000000000000"，
        body 变为 {"SecretReqeust": "<b64>"}；响应 Result 为 b64 密文，同 key/iv 解密
  - 登录（1390）：wx.login code → POST Base/User/WxAppOnLoginNew（hasFields=false），
    Result.Fields（JSON 字符串）即认证头，附带 SessionId/VipId/BrandId
  - 签到（subPages/signIn/sign/sign.js）：
      * GET  Vip/SignIn/GetSignInDtlInfo?AutoGet=true
        → Result.{VipSignInDtl:{IsSigInToday,SignedDays,IsSignReminder}, SignInCfg:{ActId}}
      * POST Vip/SignIn/SignIn（加密路径）payload {ActId, ActRemindStatus}
        → 解密后 Result.{ErrMsg?, PresentType, BonusValue, CouponName}
"""
from __future__ import annotations

import base64
import importlib.util
import json
import os
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

import requests
from Crypto.Cipher import AES
from Crypto.Util.Padding import pad, unpad

APP_ID = "wx0d6431d3cfefd889"
API_HOST_CENTRE = "https://wxa-tp.ezrpro.com/myvip/"
BRAND_ID = 7148  # ext 配置 custom_config.brandid（app-config.json）
SUCCESS = 200
MEMBERSHIP_EXPIRED = 9000
# 85644：签到接口加密用的固定密钥（CryptoJS AES-CBC-PKCS7，key/iv 均按 UTF-8 文本）
AES_KEY = b"0fc804296b1e23821a193a67678ac25c"
AES_IV = b"0000000000000000"
TIMEOUT = 25
UA = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) "
    "AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 "
    "MicroMessenger/8.0.75(0x18004b21) NetType/WIFI Language/zh_CN"
)
# 微信运行时为 wx.request 自动附加的 Referer
REFERER = f"https://servicewechat.com/{APP_ID}/91/page-frame.html"
CACHE_FILE = Path(
    os.getenv(
        "EZR_CACHE_FILE",
        str(Path(__file__).resolve().parent / "tokencache" / "wx0d6431d3cfefd889.json"),
    )
)


class SessionExpired(Exception):
    """Status 9000：登录态失效，需要重新登录。"""


class GatewayThrottled(Exception):
    """网关限流（HTTP 429 或业务提示"太快/频繁"等），可退避后重试。"""


THROTTLE_HINTS = ("太快", "频繁", "稍后", "火爆", "休息", "繁忙", "拥挤")


def is_throttled(status: Any, msg: str) -> bool:
    return status == 429 or any(hint in (msg or "") for hint in THROTTLE_HINTS)


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


def aes_encrypt(plain: str) -> str:
    cipher = AES.new(AES_KEY, AES.MODE_CBC, AES_IV)
    return base64.b64encode(cipher.encrypt(pad(plain.encode(), 16))).decode()


def aes_decrypt(cipher_b64: str) -> str:
    raw = base64.b64decode(cipher_b64)
    return unpad(AES.new(AES_KEY, AES.MODE_CBC, AES_IV).decrypt(raw), 16).decode()


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
    # YYB_SERVER 每一条配置都对应一个微信账号，按原顺序全部执行。
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


class Ezr:
    def __init__(self, account: Account):
        self.account = account
        self.session = requests.Session()
        self.session.headers.update({"User-Agent": UA, "Referer": REFERER})
        proxy = os.getenv("EZR_PROXY", "").strip()
        if proxy:
            self.session.proxies.update({"http": proxy, "https": proxy})
        self.fields: Dict[str, Any] = {}
        self.fields_raw = ""
        self.vip_id = ""
        self.brand_id = BRAND_ID

    # ------------------------------------------------------------------ YYB
    def yyb(self, endpoint: str, extra: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
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
        code = str(nested(self.yyb("/wxapp/getCode"), "code") or "")
        if len(code) < 8:
            raise RuntimeError("YYB getCode 未返回有效微信登录 code")
        return code

    # --------------------------------------------------------------- 认证态
    def apply_fields(self, raw: str) -> None:
        if not raw:
            raise RuntimeError("登录响应未返回 Fields 认证头")
        try:
            fields = json.loads(raw) if isinstance(raw, str) else raw
        except json.JSONDecodeError as exc:
            raise RuntimeError(f"Fields 认证头解析失败：{safe_message(exc)}")
        if not isinstance(fields, dict) or not fields:
            raise RuntimeError("Fields 认证头格式异常")
        self.fields_raw = raw if isinstance(raw, str) else compact(raw)
        self.fields = fields

    def headers(self, *, ezr_sp: str = "2", with_fields: bool = True) -> Dict[str, str]:
        head = {
            "Content-Type": "application/json",
            "Referer": REFERER,
            "ezr-sp": ezr_sp,
            "ezr-source": "weapp",
            "ezr-brand-id": str(self.brand_id),
        }
        if with_fields:
            for key, value in self.fields.items():
                if isinstance(value, bool):
                    value = "true" if value else "false"
                elif isinstance(value, (dict, list)):
                    value = compact(value)
                head[str(key)] = str(value)
        return head

    # --------------------------------------------------------------- 请求
    def check_status(self, path: str, body: Dict[str, Any]) -> None:
        """业务状态检查：9000 触发重登；限流类可重试；其余直接报错（带 Status）。"""
        status = body.get("Status")
        if status == SUCCESS:
            return
        msg = safe_message(body.get("Msg") or status)
        if status == MEMBERSHIP_EXPIRED:
            raise SessionExpired(msg)
        if is_throttled(status, msg):
            raise GatewayThrottled(f"[Status={status}] {msg}")
        raise RuntimeError(f"{path}：[Status={status}] {msg}")

    def call(
        self,
        path: str,
        payload: Optional[Dict[str, Any]] = None,
        *,
        method: str = "POST",
        ezr_sp: str = "2",
        with_fields: bool = True,
    ) -> Dict[str, Any]:
        """对应 12894 请求器：非 200 HTTP 报错，Status 9000 触发重登，其余非 200 Status 报错。"""
        url = API_HOST_CENTRE + path.lstrip("/")
        payload = payload or {}
        if method.upper() == "GET":
            # wx.request 对 GET 的布尔参数序列化为 true/false
            params = {k: ("true" if v is True else "false" if v is False else v) for k, v in payload.items()}
            response = self.session.get(url, params=params, headers=self.headers(ezr_sp=ezr_sp, with_fields=with_fields), timeout=TIMEOUT)
        else:
            response = self.session.post(url, json=payload, headers=self.headers(ezr_sp=ezr_sp, with_fields=with_fields), timeout=TIMEOUT)
        if response.status_code == 429:
            raise GatewayThrottled(f"HTTP 429：{safe_message(getattr(response, 'reason', '') or '网关限流')}")
        response.raise_for_status()
        body = response.json()
        self.check_status(path, body)
        result = body.get("Result")
        return result if isinstance(result, dict) else ({} if result in (None, "") else {"Result": result})

    def invoke(self, step: Callable[[], Dict[str, Any]]) -> Dict[str, Any]:
        """统一重试：登录失效重登一次；网关限流按 6s/15s 退避重试（重登自动取新 code）。"""
        delays = (6, 15)
        relogged = False
        for attempt in range(len(delays) + 1):
            try:
                return step()
            except SessionExpired:
                if relogged:
                    raise
                relogged = True
                print("  登录态失效，重新登录")
                self.yyb_login()
            except GatewayThrottled as exc:
                if attempt == len(delays):
                    raise
                wait = delays[attempt]
                print(f"  网关限流，{wait}s 后重试（{attempt + 2}/{len(delays) + 1}）：{safe_message(exc)}")
                time.sleep(wait)

    # --------------------------------------------------------------- 登录
    @staticmethod
    def login_backoff() -> tuple:
        raw = os.getenv("EZR_LOGIN_BACKOFF", "30,60,120")
        try:
            delays = tuple(int(x) for x in raw.split(",") if x.strip())
        except ValueError:
            delays = ()
        return delays or (30, 60, 120)

    def yyb_login(self) -> None:
        # 对应 1390 登录：wx.login code → WxAppOnLoginNew（hasFields=false）
        # 采用拦截器自动重登的 externalin 形态（ezr-sp=3, CommonIdType=VipWxUnionId），与存量会员恢复登录态一致
        delays = self.login_backoff()
        last: Exception = RuntimeError("登录未执行")
        for attempt in range(len(delays) + 1):
            try:
                code = self.wx_code()
                payload = {
                    "code": code,
                    "CommonIdType": "VipWxUnionId",
                    "CommonId": 0,
                    "ShopId": 0,
                    "CommonIdSource": 0,
                }
                result = self.call("Base/User/WxAppOnLoginNew", payload, ezr_sp="3", with_fields=False)
                self.apply_fields(str(result.get("Fields") or ""))
                self.vip_id = str(result.get("VipId") or "")
                if result.get("BrandId"):
                    self.brand_id = result["BrandId"]
                return
            except GatewayThrottled as exc:
                last = exc
                if attempt == len(delays):
                    break
                wait = delays[attempt]
                print(f"  登录被限流，{wait}s 后重试（{attempt + 2}/{len(delays) + 1}）")
                time.sleep(wait)
        raise RuntimeError(
            f"登录连续 {len(delays) + 1} 次被网关限流：{safe_message(last)}"
            "（登录频率风控，频繁重试会刷新限制窗口；建议等 5-10 分钟后再跑，"
            "避开刚打开小程序的时段，或配置 EZR_PROXY 更换出口 IP）"
        )

    def login(self, cached: Dict[str, Any]) -> None:
        if cached.get("fields"):
            try:
                self.apply_fields(str(cached["fields"]))
                self.vip_id = str(cached.get("vip_id") or "")
                self.brand_id = cached.get("brand_id") or BRAND_ID
                # 单次业务调用校验缓存有效性
                self.call("Vip/SignIn/GetSignInDtlInfo", {"AutoGet": True}, method="GET")
                print("  登录：缓存有效")
                return
            except SessionExpired:
                print("  缓存登录态失效，重新登录")
            except GatewayThrottled:
                print("  登录：缓存校验被限流，直接沿用缓存（主流程会自动重试）")
                return
            except Exception:
                self.fields, self.fields_raw, self.vip_id = {}, "", ""
        self.yyb_login()
        print("  登录：YYB-Go-Enhanced 成功" + (f"（VipId {self.vip_id}）" if self.vip_id else ""))

    def dump(self) -> Dict[str, Any]:
        return {
            "fields": self.fields_raw,
            "vip_id": self.vip_id,
            "brand_id": self.brand_id,
            "updated_at": int(time.time()),
        }

    # --------------------------------------------------------------- 签到
    def sign_detail(self) -> Dict[str, Any]:
        return self.invoke(lambda: self.call("Vip/SignIn/GetSignInDtlInfo", {"AutoGet": True}, method="GET"))

    def sign_in(self, act_id: Any, remind: bool) -> Dict[str, Any]:
        # SignIn 在 85644 加密白名单内：明文 payload → AES → SecretReqeust；响应 Result 同 key 解密
        plain = compact({"ActId": act_id, "ActRemindStatus": bool(remind)})
        body = {"SecretReqeust": aes_encrypt(plain)}
        url = API_HOST_CENTRE + "Vip/SignIn/SignIn"
        response = self.session.post(url, json=body, headers=self.headers(), timeout=TIMEOUT)
        if response.status_code == 429:
            raise GatewayThrottled(f"HTTP 429：{safe_message(getattr(response, 'reason', '') or '网关限流')}")
        response.raise_for_status()
        data = response.json()
        self.check_status("Vip/SignIn/SignIn", data)
        result = data.get("Result")
        if isinstance(result, str) and result:
            try:
                result = json.loads(aes_decrypt(result))
            except Exception as exc:
                raise RuntimeError(f"签到响应解密失败：{safe_message(exc)}")
        return result if isinstance(result, dict) else {}

    @staticmethod
    def describe_reward(result: Dict[str, Any]) -> str:
        # PresentType：BS=积分 BonusValue；CN/GB=优惠券 CouponName；NO/空=无奖励
        kind = str(result.get("PresentType") or "").upper()
        if kind == "BS":
            return f"{result.get('BonusValue') or 0}积分"
        if kind in ("CN", "GB"):
            return f"优惠券「{result.get('CouponName') or ''}」"
        return ""

    def run(self) -> Dict[str, Any]:
        detail = self.sign_detail()
        cfg = detail.get("SignInCfg") if isinstance(detail, dict) else {}
        vip = detail.get("VipSignInDtl") if isinstance(detail, dict) else {}
        act_id = (cfg or {}).get("ActId")
        if not act_id:
            raise RuntimeError("未获取到签到活动（可能活动未开始或品牌未配置）")
        already = bool((vip or {}).get("IsSigInToday"))
        signed_days = int((vip or {}).get("SignedDays") or 0)
        reward = ""
        if not already:
            result = self.invoke(lambda: self.sign_in(act_id, bool((vip or {}).get("IsSignReminder"))))
            if result.get("ErrMsg"):
                raise RuntimeError(safe_message(result["ErrMsg"]))
            reward = self.describe_reward(result)
            for wait in (1, 2, 4):
                time.sleep(wait)
                detail = self.sign_detail()
                vip = detail.get("VipSignInDtl") if isinstance(detail, dict) else {}
                if (vip or {}).get("IsSigInToday"):
                    signed_days = int((vip or {}).get("SignedDays") or signed_days)
                    break
            else:
                raise RuntimeError("签到接口已提交，但复查状态仍未签到")
        return {"already": already, "signed_days": signed_days, "reward": reward}


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
            spec = importlib.util.spec_from_file_location("ezr_qinglong_notify", path)
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
        func("会员通签到", text)
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
        client = Ezr(account)
        try:
            client.login(cache.get(account.ref) or {})
            cache[account.ref] = client.dump()
            save_cache(cache)
            result = client.run()
            status = "今日已签到" if result["already"] else "签到成功"
            lines = [f"{account.label}：{status}", f"已连续签到：{result['signed_days']} 天"]
            if result["reward"]:
                lines.append(f"本次奖励：{result['reward']}")
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
