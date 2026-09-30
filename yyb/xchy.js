// name: 携程会员签到
/*
------------------------------------------
@Description: 携程会员 - 微信小程序静默登录 + 每日签到
cron: 24 7,19 * * *
------------------------------------------

------------------------------------------
契约（appid wx0e6ed4f51db9d078，passport.ctrip.com / m.ctrip.com）：
（迁移自 YYB-GO 系脚本，原脚本已 code 登录；登录仅需 wx code，无需明文 openid/加密手机号）

登录三步（PASSPORT gateway，均包 {ReturnCode,Result}，ReturnCode==0 且 Result.resultStatus.returnCode==0）：
  1) soa2/14553/wechatLogin.json   {AccountHead:{},Data:{authCode:code,thirdConfigCode:ACCESS_CODE,Context:{}}} -> Result.wechatCode
  2) soa2/14553/authenticate.json  {AccountHead:{},Data:{authCode:wechatCode,thirdType:"wechat_app",thirdConfigCode:ACCESS_CODE,context:{encryptedData:"",iv:"",uuid:""}}} -> Result.token
  3) soa2/12559/thirdPartyLogin.json {...token,extendedProperties:{clientID:CLIENT_ID,thirdConfigCode:ACCESS_CODE,...}} -> Result.ticket(=cticket cookie)/duid/udl/uid
签到状态  POST m.ctrip.com/restapi/soa2/13012/getSignTodayInfoProxy （带 _fxpcqlniredt=CLIENT_ID + head.auth=ticket）
          注意：携程"运行态校验"可能 401 code=11001 拦截此代理接口
签到      POST m.ctrip.com/restapi/soa2/22769/signToday {openId} 头 Cookie: cticket=<ticket> -> ResponseStatus.Ack=Success
ACCESS_CODE(XTHYY69RNSKLWEICHATMINI)/CLIENT_ID/PACKAGE_VERSION 是这家小程序固定应用常量（原脚本硬编码，非个人凭证）。
------------------------------------------
 YYB-Go 版：取码改走 YYB-Go（POST /wxapp/getCode），不再依赖原取码桥接服务。
 变量：YYB_SERVER 每行 地址@账号标识（例如 http://yyb-go:8000@1）；YYB_API_KEY 可选。
 原桥接版脚本见 wxapp/xchy.js，业务接口、流程与缓存格式均未改动。
*/

const { Env } = require("../tools/env.js");
const $ = new Env("携程会员签到");
const axios = require("axios");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { YYBClient, yybAccounts } = require("./yyb.js");

const MINI_APP_ID = "wx0e6ed4f51db9d078";
const PACKAGE_VERSION = "1055";
const CLIENT_ID = "09031101311473737701";
const ACCESS_CODE = "XTHYY69RNSKLWEICHATMINI";
const API_BASE = "https://m.ctrip.com";
const PASSPORT_BASE = "https://passport.ctrip.com/gateway/api";
const TOKEN_CACHE_FILE = path.join(__dirname, "xchy_token_cache.json");
const UA_MP =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
    "MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF";

const DEBUG = process.env.xchy_debug === "1";

const yyb = new YYBClient({ appid: MINI_APP_ID });

function readCache() {
    try { if (!fs.existsSync(TOKEN_CACHE_FILE)) return {}; return JSON.parse(fs.readFileSync(TOKEN_CACHE_FILE, "utf8")) || {}; } catch (e) { return {}; }
}
function writeCache(c) {
    try { fs.writeFileSync(TOKEN_CACHE_FILE, JSON.stringify(c, null, 2), "utf8"); } catch (e) { $.log(`写入缓存失败: ${e.message || e}`); }
}
function parseAccount(raw = "") {
    const [id, remark] = String(raw).split("#").map((s) => (s || "").trim());
    return { openid: id, remark: remark || "" };
}
function short(v, n = 300) {
    const t = typeof v === "string" ? v : JSON.stringify(v);
    return !t ? "" : t.length > n ? `${t.slice(0, n)}...` : t;
}
function mask(value = "") {
    value = String(value);
    if (!value) return "";
    if (value.length <= 12) return `${value.slice(0, 3)}***`;
    return `${value.slice(0, 6)}***${value.slice(-6)}`;
}
function parseJsonMaybe(text) {
    if (!text || typeof text !== "string") return text;
    try { return JSON.parse(text); } catch { return text; }
}
function okResponseStatus(data) {
    return data?.ResponseStatus?.Ack === "Success" || data?.responseStatus?.ack === "Success";
}

class Task {
    constructor(raw) {
        this.index = $.userIdx++;
        this.account = parseAccount(raw);
        this.openid = this.account.openid || "";
        this.ticket = "";
        this.duid = "";
        this.udl = "";
        this.uid = "";
    }
    log(text) {
        $.log(`账号[${this.index}]${this.account.remark ? `[${this.account.remark}]` : ""} ${text}`);
    }

    /** 取 wx.login code：YYB-Go /wxapp/getCode（一个账号一次请求，失败即抛错） */
    async getCode() {
        return yyb.getCode(this.openid);
    }

    // PASSPORT gateway：body 为 JSON 字符串，返回 {ReturnCode, Result(字符串)}
    async gateway(pathname, data) {
        const res = await axios.post(`${PASSPORT_BASE}/${pathname}`, JSON.stringify(data), {
            timeout: 30000,
            validateStatus: () => true,
            headers: {
                "Content-Type": "application/json",
                "User-Agent": UA_MP,
                Referer: `https://servicewechat.com/${MINI_APP_ID}/${PACKAGE_VERSION}/page-frame.html`,
            },
        });
        if (DEBUG) this.log(`gateway ${pathname} [${res.status}]: ${short(res.data, 500)}`);
        if (res.status !== 200 || Number(res.data?.ReturnCode) !== 0) {
            throw new Error(`${pathname} 失败[${res.status}]: ${short(res.data)}`);
        }
        return parseJsonMaybe(res.data.Result || "{}");
    }

    // m.ctrip.com H5 接口（cticket cookie 鉴权）
    async h5Api(pathname, data) {
        const cookies = [];
        if (this.ticket) cookies.push(`cticket=${this.ticket}`);
        if (this.duid) cookies.push(`DUID=${encodeURIComponent(this.duid)}`);
        if (this.udl) cookies.push(`_udl=${this.udl}`);
        cookies.push(`GUID=${CLIENT_ID}`);
        const res = await axios.post(`${API_BASE}${pathname}`, JSON.stringify(data || {}), {
            timeout: 30000,
            validateStatus: () => true,
            headers: {
                "Content-Type": "application/json",
                "User-Agent": UA_MP,
                Referer: "https://m.ctrip.com/",
                Cookie: `${cookies.join("; ")};`,
            },
        });
        return { status: res.status, data: res.data, text: typeof res.data === "string" ? res.data : JSON.stringify(res.data) };
    }

    async login() {
        const code = await this.getCode();

        const wxLogin = await this.gateway("soa2/14553/wechatLogin.json", {
            AccountHead: {},
            Data: { authCode: code, thirdConfigCode: ACCESS_CODE, Context: {} },
        });
        if (!wxLogin?.wechatCode || wxLogin?.resultStatus?.returnCode !== 0) {
            throw new Error(`wechatLogin未返回wechatCode: ${short(wxLogin)}`);
        }

        const auth = await this.gateway("soa2/14553/authenticate.json", {
            AccountHead: {},
            Data: {
                authCode: wxLogin.wechatCode, thirdType: "wechat_app", thirdConfigCode: ACCESS_CODE,
                context: { encryptedData: "", iv: "", uuid: "" },
            },
        });
        if (!auth?.token || auth?.resultStatus?.returnCode !== 0) {
            throw new Error(`authenticate未返回token: ${short(auth)}`);
        }

        const login = await this.gateway("soa2/12559/thirdPartyLogin.json", {
            AccountHead: {},
            Data: {
                accountHead: { locale: "zh_CN", platform: "MINIAPP" },
                token: auth.token,
                extendedProperties: {
                    clientID: CLIENT_ID, page_id: "", Url: "", thirdConfigCode: ACCESS_CODE,
                    deviceName: "Windows PC", OsType: "windows",
                },
            },
        });
        if (!login?.ticket || login?.resultStatus?.returnCode !== 0) {
            // 登录链走通但没换到 ticket —— 视作该微信号未在携程注册/绑定
            this.unregistered = true;
            throw new Error(`NO_ACCOUNT:thirdPartyLogin未返回ticket: ${short(login)}`);
        }

        this.ticket = login.ticket;
        this.duid = login.duid || login.extendedProperties?.duid || "";
        this.udl = login.udl || "";
        this.uid = login.uid || login.extendedProperties?.uid || "";
        // 若登录响应里带明文 openId，则优先用它做 signToday（否则用账号 openid）
        this.ctripOpenId = login.openId || login.extendedProperties?.openId || "";
        const cache = readCache();
        cache[this.openid] = {
            ticket: this.ticket, duid: this.duid, udl: this.udl, uid: this.uid,
            ctripOpenId: this.ctripOpenId, updatedAt: new Date().toISOString(),
        };
        writeCache(cache);
        this.log(`登录成功: ${mask(this.uid || this.ticket)}`);
    }

    async ensureLogin() {
        const cached = readCache()[this.openid] || {};
        if (!this.ticket && cached.ticket) {
            this.ticket = cached.ticket; this.duid = cached.duid || ""; this.udl = cached.udl || "";
            this.uid = cached.uid || ""; this.ctripOpenId = cached.ctripOpenId || "";
            this.log("使用缓存ticket");
            return;
        }
        if (!this.ticket) await this.login();
    }

    async querySignStatus() {
        // getSignTodayInfoProxy 走 Cookie 直连通道可读（_fxpcqlniredt 代理通道会被运行态校验 401/11001 拦截）
        const res = await this.h5Api("/restapi/soa2/13012/getSignTodayInfoProxy", {});
        if (res.status !== 200 || !okResponseStatus(res.data)) {
            if (DEBUG) this.log(`签到状态查询异常[${res.status}]: ${short(res.text, 400)}`);
            return null;
        }
        const info = parseJsonMaybe(res.data.responseJson || "{}");
        const signed = !!(info && (info.sign === true));
        this.log(`今日签到状态: ${signed ? "已签到" : "未签到"}${info.totalPoint !== undefined ? `，积分${info.totalPoint}` : ""}`);
        return { signed, raw: info };
    }

    async sign(retry = true) {
        const st = await this.querySignStatus();
        if (st && st.signed) return this.log("✅ 今日已签到");

        const openId = this.ctripOpenId || this.openid || "";
        const res = await this.h5Api("/restapi/soa2/22769/signToday", { openId });
        if (DEBUG) this.log(`signToday [${res.status}]: ${short(res.text, 500)}`);

        if (res.status === 401 && (res.data?.code === "11001" || res.data?.code === 11001)) {
            this.log(`❌ 签到接口被携程运行态校验拦截(401/11001)：${res.data.message || ""}`);
            return { blocked: true };
        }
        if (res.status !== 200) {
            // 会话失效重登重试一次
            if (retry && (res.status === 403 || /token|登录|未授权|失效|过期|未登录|鉴权/i.test(res.text))) {
                this.log("会话可能失效，重新登录后重试");
                this.ticket = ""; delete readCache()[this.openid];
                await this.login();
                return this.sign(false);
            }
            this.log(`❌ 签到请求异常[${res.status}]: ${short(res.text, 500)}`);
            return;
        }
        const d = res.data || {};
        const message = d.message || d.Message || "";
        const code = Number(d.code);
        const points = Number(d.baseIntegratedPoint || 0) + Number(d.extraIntegratedPoint || 0);
        if (okResponseStatus(d) && (code === 0 || /成功/.test(message))) {
            return this.log(`✅ 签到成功${message ? `：${message}` : ""}${points ? `，积分+${points}` : ""}`);
        }
        if (/已签到|已经签到|无法补签|重复/.test(message) || code === 400001) {
            return this.log(`✅ 今日已签到（${message || code}）`);
        }
        // 404002「未满足当前活动参与条件」= 携程运行态校验(风控)：真正的签到走 _fxpcqlniredt 代理通道，
        // 需小程序运行态生成的私有签名(n-payload-source/cSign)，Cookie 直连通道拿不到该上下文 -> 被拦。
        if (code === 404002 || /未满足当前活动参与条件/.test(message)) {
            return this.log(`⚠️ 签到被携程运行态校验(风控)拦截：${message || code}（登录/状态查询正常，写操作需运行态私有签名，无法绕过）`);
        }
        if (okResponseStatus(d)) {
            return this.log(`签到返回：${short(res.text, 500)}`);
        }
        // 未授权类 -> 重登重试
        if (retry && /token|登录|未授权|失效|过期|未登录|鉴权/i.test(res.text)) {
            this.log("会话可能失效，重新登录后重试");
            this.ticket = "";
            await this.login();
            return this.sign(false);
        }
        this.log(`❌ 签到失败：${short(res.text, 500)}`);
    }

    async run() {
        if (!this.openid) { this.log("跳过：变量值里没有 openid"); return; }
        try {
            await this.ensureLogin();
            await this.sign();
        } catch (e) {
            if (String(e.message).startsWith("NO_ACCOUNT")) {
                this.log("⚠️ 该微信号还没在携程注册/绑定会员，先在小程序里登录一次再跑");
                return;
            }
            this.log(`执行失败: ${e.message || e}`);
        }
    }
}

!(async () => {
    let accounts;
    try { accounts = yybAccounts(); } catch (e) { $.log(`❌ ${e.message || e}`); return; }
    $.log(`共找到${accounts.length}个YYB账号`);
    for (let i = 0; i < accounts.length; i++) {
        await new Task(accounts[i]).run();
        if (i < accounts.length - 1) await $.wait(1500, 3000);
    }
})().catch((e) => $.log(e.message || e)).finally(() => $.done());
