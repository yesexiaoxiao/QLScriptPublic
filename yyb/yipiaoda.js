// name: 华润壹票达
/*
------------------------------------------
@Description: 华润壹票达 - 微信小程序登录 + 每日签到
cron: 44 8 * * *
------------------------------------------


可选开关：
yipiaoda_phone_login  默认 1。首次登录若服务端只回 authToken（说明这个微信号还没绑过），
                      脚本会走 /wx/getphonenumber 完成手机号授权把账号建起来。
                      置 0 则不做授权，只打印提示。
------------------------------------------
契约（appid wx70c418a86bc52a9f，host crld.caiyicloud.com）：

每个请求都带一组公共查询串和一组固定请求头：
  query   currency=CNY&lang=zh&terminalSrc=WEIXIN_MINI&utcOffset=480&ver=4.63.0
  headers src / terminal-src / merchant-id / ver / utc-offset / front-trace-id
          鉴权时再加 access-token

登录分两段（实测这个账号必须走第二段）：
  ① POST /cyy_gatewayapi/mcommon/pub/v1/union_login
       {src, merchantId, ver, appId, unionType:"WEIXIN_MINI",
        wxParam:{code}, deviceInfo:{volcWebId}}
     -> statusCode==200；已绑账号直接给 data.accessToken，
        没绑的只给 data.authToken + data.openId
  ② POST /cyy_gatewayapi/mcommon/pub/v1/union_login/authorization
       {…, authToken, openId,
        wxParam:{openId, encryptPhoneNumber, initVector, authCode}, invitePageId:"",
        deviceInfo:{volcWebId}}
     encryptPhoneNumber/initVector 来自 smallcat /wx/getphonenumber 的 data.raw
     （encryptedData / iv），authCode 是它的 data.code
     -> statusCode==200，data.accessToken

签到  POST /cyy_gatewayapi/user/buyer/v1/check_in  {src, merchantId, ver, appId}
      -> statusCode==200，data.rewardAggPackage 里是本次奖励，data.streakCheckInDays 连续天数
日历  GET  /cyy_gatewayapi/user/buyer/v1/check_in_calendar（只读，用来判断今天签没签）

成功判定是 statusCode==200（不是 code），失败原因在 comments。
------------------------------------------
 YYB-Go 版：取码改走 YYB-Go（POST /wxapp/getCode），不再依赖原取码桥接服务。
 变量：YYB_SERVER 每行 地址@账号标识（例如 http://yyb-go:8000@1）；YYB_API_KEY 可选。
 原桥接版脚本见 wxapp/yipiaoda.js，业务接口、流程与缓存格式均未改动。
*/

const { Env } = require("../tools/env.js");
const $ = new Env("华润壹票达");
const axios = require("axios");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { YYBClient, yybAccounts } = require("./yyb.js");

const MINI_APP_ID = "wx70c418a86bc52a9f";
const BASE = "https://crld.caiyicloud.com";
const MERCHANT_ID = "6942616f50ef5900011a1d2e";
const VER = "4.63.0";
const SRC = "weixin_mini";
const TERMINAL_SRC = "WEIXIN_MINI";
const UTC_OFFSET = "480";
const TOKEN_CACHE_FILE = path.join(__dirname, "yipiaoda_token_cache.json");
const PHONE_LOGIN = String(process.env.yipiaoda_phone_login ?? "1") !== "0";
const USER_AGENT =
    "Mozilla/5.0 (Linux; Android 12; M2012K11AC Build/SKQ1.220303.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Version/4.0 Chrome/134.0.6998.136 Mobile Safari/537.36 MicroMessenger/8.0.48.2580(0x28003036) MiniProgramEnv/android";

const EP_UNION_LOGIN = "/cyy_gatewayapi/mcommon/pub/v1/union_login";
const EP_UNION_AUTH = "/cyy_gatewayapi/mcommon/pub/v1/union_login/authorization";
const EP_CHECK_IN = "/cyy_gatewayapi/user/buyer/v1/check_in";
const EP_CALENDAR = "/cyy_gatewayapi/user/buyer/v1/check_in_calendar";

const yyb = new YYBClient({ appid: MINI_APP_ID });

function readCache() {
    try {
        if (!fs.existsSync(TOKEN_CACHE_FILE)) return {};
        return JSON.parse(fs.readFileSync(TOKEN_CACHE_FILE, "utf8")) || {};
    } catch (e) {
        return {};
    }
}

function writeCache(cache) {
    try {
        fs.writeFileSync(TOKEN_CACHE_FILE, JSON.stringify(cache, null, 2), "utf8");
    } catch (e) {
        $.log(`写入token缓存失败: ${e.message || e}`);
    }
}

function parseAccount(raw = "") {
    const [id, remark] = String(raw).split("#").map((s) => (s || "").trim());
    return { openid: id, remark: remark || "" };
}

function short(v, n = 220) {
    const t = typeof v === "string" ? v : JSON.stringify(v);
    return !t ? "" : t.length > n ? `${t.slice(0, n)}...` : t;
}

const isOk = (res) => Number(res?.statusCode) === 200;
const msgOf = (res) => res?.comments || res?.errorCode || short(res);
const isAlreadyDone = (t) => /已签|已经签|签到过|重复|已完成|already/i.test(String(t || ""));
const isAuthError = (t) => /登录|token|未授权|未登录|失效|过期|重新/i.test(String(t || ""));

function commonQuery() {
    return { currency: "CNY", lang: "zh", terminalSrc: TERMINAL_SRC, utcOffset: UTC_OFFSET, ver: VER };
}

/** 本月区间（毫秒），日历接口要 */
function monthRangeMs() {
    const now = new Date();
    const begin = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59).getTime();
    return { begin, end };
}

class Task {
    constructor(raw) {
        this.index = $.userIdx++;
        this.account = parseAccount(raw);
        this.token = "";
        // volcWebId 按 openid 稳定派生：同一账号每次跑都一样，避免每次都像新设备
        const h = crypto.createHash("md5").update(String(this.account.openid || raw)).digest("hex");
        this.volcWebId = String(BigInt("0x" + h.slice(0, 15)) % 9000000000000000000n + 1000000000000000000n);
    }

    log(text) {
        $.log(`账号[${this.index}]${this.account.remark ? `[${this.account.remark}]` : ""} ${text}`);
    }

    headers(withToken = true) {
        return {
            "Content-Type": "application/json",
            Accept: "application/json, text/plain, */*",
            "User-Agent": USER_AGENT,
            Referer: `https://servicewechat.com/${MINI_APP_ID}/0/page-frame.html`,
            xweb_xhr: "1",
            src: SRC,
            "terminal-src": TERMINAL_SRC,
            "merchant-id": MERCHANT_ID,
            ver: VER,
            "utc-offset": UTC_OFFSET,
            "front-trace-id": crypto.randomBytes(16).toString("hex"),
            ...(withToken && this.token ? { "access-token": this.token } : {}),
        };
    }

    async request(method, apiPath, { query = null, body = null, withToken = true } = {}) {
        const res = await axios.request({
            method,
            url: `${BASE}${apiPath}`,
            params: { ...commonQuery(), ...(query || {}) },
            data: method.toUpperCase() === "GET" ? undefined : body || {},
            headers: this.headers(withToken),
            timeout: 20000,
            validateStatus: () => true,
        });
        if (res.status !== 200) throw new Error(`${apiPath} HTTP ${res.status}: ${short(res.data)}`);
        return res.data;
    }

    /** 取 wx.login code：YYB-Go /wxapp/getCode（一个账号一次请求，失败即抛错） */
    async getCode() {
        return yyb.getCode(this.account.openid);
    }

    /** 手机号授权包：code 用于 authCode，raw 里的 encryptedData/iv 用于加密手机号 */
    async getPhonePackage() {
        // YYB-Go：POST /wxapp/getPhoneNumber {ref, app_id}；能否返回真实授权包取决于账号与目标小程序。
        const data = await yyb.getPhoneNumber(this.account.openid);
        const d = data?.result || data || {};
        const raw = d.raw || data?.raw || {};
        if (!d.code && !raw.code) throw new Error(`取手机号授权包失败: ${short(data)}`);
        return {
            authCode: String(d.code || raw.code || ""),
            encryptPhoneNumber: raw.encryptedData || d.encryptedData || "",
            initVector: raw.iv || d.iv || "",
        };
    }

    baseBody() {
        return { src: SRC, merchantId: MERCHANT_ID, ver: VER, appId: MINI_APP_ID };
    }

    async login() {
        const code = await this.getCode();
        const first = await this.request("POST", EP_UNION_LOGIN, {
            withToken: false,
            body: {
                ...this.baseBody(),
                unionType: TERMINAL_SRC,
                wxParam: { code },
                deviceInfo: { volcWebId: this.volcWebId },
            },
        });
        if (!isOk(first)) throw new Error(`union_login 失败: ${msgOf(first)}`);
        const d1 = first.data || {};
        if (d1.accessToken) {
            this.token = String(d1.accessToken);
            this.saveToken();
            this.log("登录成功（已绑账号，直接拿到 access-token）");
            return;
        }

        // 只回 authToken 说明这个微信号还没在壹票达绑过，要用手机号授权把账号建起来
        if (!d1.authToken || !d1.openId) {
            throw new Error(`union_login 既没给 accessToken 也没给 authToken: ${short(first)}`);
        }
        if (!PHONE_LOGIN) {
            throw new Error(
                "该微信号还没在壹票达绑定（服务端只回 authToken）。" +
                "把变量 yipiaoda_phone_login 设为 1 可自动走手机号授权，或在小程序里手动登录一次"
            );
        }
        this.log("未绑账号，走手机号授权完成注册");
        const phone = await this.getPhonePackage();
        if (!phone.authCode && !phone.encryptPhoneNumber) {
            throw new Error("手机号授权包里既没有 authCode 也没有 encryptedData，无法完成 authorization");
        }
        const second = await this.request("POST", EP_UNION_AUTH, {
            withToken: false,
            body: {
                ...this.baseBody(),
                unionType: TERMINAL_SRC,
                authToken: d1.authToken,
                openId: d1.openId,
                wxParam: {
                    openId: d1.openId,
                    encryptPhoneNumber: phone.encryptPhoneNumber,
                    initVector: phone.initVector,
                    authCode: phone.authCode,
                },
                invitePageId: "",
                deviceInfo: { volcWebId: this.volcWebId },
            },
        });
        if (!isOk(second)) throw new Error(`手机号授权失败: ${msgOf(second)}`);
        const token = (second.data || {}).accessToken;
        if (!token) throw new Error(`授权成功但没返回 accessToken: ${short(second)}`);
        this.token = String(token);
        this.saveToken();
        this.log("登录成功（手机号授权）");
    }

    saveToken() {
        const cache = readCache();
        cache[this.account.openid] = { token: this.token, updatedAt: new Date().toISOString() };
        writeCache(cache);
    }

    async ensureLogin() {
        const cached = readCache()[this.account.openid] || {};
        if (!this.token && cached.token) {
            this.token = cached.token;
            if (await this.queryCalendar(false)) {
                this.log("使用缓存token");
                return;
            }
            this.log("缓存token失效，重新登录");
            this.token = "";
        }
        if (!this.token) await this.login();
    }

    /**
     * 只读，用来报连续天数 + 校验 token 是否还活着。
     * 不用它判「今天签没签」——日历里那个已签标记的字段名没核实过，
     * 实测会把已签的一天判成未签；签到接口本身回「今日已签」，靠它幂等更稳。
     */
    async queryCalendar(needLog = true) {
        const { begin, end } = monthRangeMs();
        const res = await this.request("GET", EP_CALENDAR, {
            query: {
                src: SRC, merchantId: MERCHANT_ID, appId: MINI_APP_ID,
                pageSource: "TASK_CENTER", beginDate: String(begin), endDate: String(end),
            },
        });
        if (!isOk(res)) {
            if (needLog) this.log(`读取签到日历失败: ${msgOf(res)}`);
            return false;
        }
        const d = res.data || {};
        if (needLog) this.log(`签到状态: 连续 ${d.streakCheckInDays ?? "?"} 天`);
        return true;
    }

    async sign(retry = true) {
        const res = await this.request("POST", EP_CHECK_IN, { body: this.baseBody() });
        if (isOk(res)) {
            const d = res.data || {};
            const rewards = (d.rewardAggPackage || [])
                .map((r) => `${r.reward}${r.rewardType === "POINT" ? "积分" : r.rewardType || ""}`)
                .join(" ");
            this.log(`✅ 签到成功${rewards ? `: ${rewards}` : ""}（连续 ${d.streakCheckInDays ?? "?"} 天）`);
            return;
        }
        if (isAlreadyDone(msgOf(res))) return this.log(`✅ 今日已签到（${msgOf(res)}）`);
        if (retry && isAuthError(msgOf(res))) {
            this.log("会话失效，重新登录后重试");
            this.token = "";
            await this.login();
            return this.sign(false);
        }
        this.log(`❌ 签到失败: ${msgOf(res)}`);
    }

    async run() {
        if (!this.account.openid) {
            this.log("跳过：变量值里没有 openid");
            return;
        }
        try {
            await this.ensureLogin();
            await this.queryCalendar();
            await this.sign();
        } catch (e) {
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
})()
    .catch((e) => $.log(e.message || e))
    .finally(() => $.done());
