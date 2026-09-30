// name: 旧衣客签到
/*
------------------------------------------
@Description: 旧衣客(JYK) - 微信小程序静默登录 + 每日签到
cron: 22 9 * * *
------------------------------------------

------------------------------------------
契约（appid wx3f0209cc35a953a4，host jyk.scjyx.com）：
（迁移自 YYB-GO 系脚本，原脚本已 code 登录）

登录  POST /api/index/get_openid {code, pid:"", device_info:"android_MEIZU_22_370"}
        -> errno==0，data.access_token；头 Authorization: Bearer <token> + X-Payconfig-Id:2
状态  GET /api/checkin/home -> data.{enabled, today_signed, can_sign}
签到  ① POST /api/checkin/prepare -> data.ad_token
      ② POST /api/checkin/sign {ad_token} -> errno==0 成功
响应壳：{errno:0, data}；errno!=0 视为失败/未开启。只做普通签到，不做广告签到。
------------------------------------------
 YYB-Go 版：取码改走 YYB-Go（POST /wxapp/getCode），不再依赖原取码桥接服务。
 变量：YYB_SERVER 每行 地址@账号标识（例如 http://yyb-go:8000@1）；YYB_API_KEY 可选。
 原桥接版脚本见 wxapp/jyk.js，业务接口、流程与缓存格式均未改动。
*/

const { Env } = require("../tools/env.js");
const $ = new Env("旧衣客签到");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { YYBClient, yybAccounts } = require("./yyb.js");

const MINI_APP_ID = "wx3f0209cc35a953a4";
const TARGET_VERSION = "68";
const BASE_URL = "https://jyk.scjyx.com";
const PAYCONFIG_ID = "2";
const PID = "";
const DEVICE_INFO = "android_MEIZU_22_370";
const TOKEN_CACHE_FILE = path.join(__dirname, "jyk_token_cache.json");
const USER_AGENT =
    "Mozilla/5.0 (Linux; Android 12; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 " +
    "Chrome/107.0.0.0 Mobile Safari/537.36 MicroMessenger/8.0.5 MiniProgramEnv/android";

const EP_LOGIN = "/api/index/get_openid";
const EP_HOME = "/api/checkin/home";
const EP_PREPARE = "/api/checkin/ad/prepare";
const EP_SIGN = "/api/checkin/sign";
const EP_AD_SIGN = "/api/checkin/ad/sign";

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
function short(v, n = 200) {
    const t = typeof v === "string" ? v : JSON.stringify(v);
    return !t ? "" : t.length > n ? `${t.slice(0, n)}...` : t;
}

class Task {
    constructor(raw) {
        this.index = $.userIdx++;
        this.account = parseAccount(raw);
        this.token = "";
    }
    log(text) {
        $.log(`账号[${this.index}]${this.account.remark ? `[${this.account.remark}]` : ""} ${text}`);
    }
    headers() {
        const h = {
            "content-type": "application/json",
            "X-Payconfig-Id": PAYCONFIG_ID,
            Referer: `https://servicewechat.com/${MINI_APP_ID}/${TARGET_VERSION}/page-frame.html`,
            "User-Agent": USER_AGENT,
        };
        if (this.token) h.Authorization = `Bearer ${this.token}`;
        return h;
    }
    async request(method, apiPath, payload) {
        const res = await axios.request({
            method,
            url: `${BASE_URL}${apiPath}`,
            data: method === "POST" ? payload || {} : undefined,
            headers: this.headers(),
            timeout: 20000,
            validateStatus: () => true,
        });
        if (res.status !== 200) {
            if (res.data && typeof res.data === "object") return res.data;
            throw new Error(`${apiPath} HTTP ${res.status}: ${short(res.data)}`);
        }
        return res.data;
    }
    /** 取 wx.login code：YYB-Go /wxapp/getCode（一个账号一次请求，失败即抛错） */
    async getCode() {
        return yyb.getCode(this.account.openid);
    }
    async login() {
        const code = await this.getCode();
        const res = await this.request("POST", EP_LOGIN, { code, pid: PID, device_info: DEVICE_INFO });
        if (Number(res?.errno) !== 0) throw new Error(`登录失败: ${res?.errmsg || res?.msg || short(res)}`);
        const info = res.data || {};
        this.token = String(info.access_token || "");
        if (!this.token) throw new Error(`登录未返回 access_token: ${short(res)}`);
        const cache = readCache();
        cache[this.account.openid] = { token: this.token, updatedAt: new Date().toISOString() };
        writeCache(cache);
        this.log("登录成功");
    }
    async home() {
        const res = await this.request("GET", EP_HOME);
        if (Number(res?.errno) !== 0) throw new Error(`home失败: ${res?.errmsg || short(res)}`);
        return res.data || {};
    }
    async sign() {
        const signed = await this.request("POST", EP_SIGN, {});
        if (Number(signed?.errno) === 0) {
            const d = signed.data || {};
            return this.log(`✅ 签到成功${d.score !== undefined ? `，获得 ${d.score} 积分` : ""}${d.integral !== undefined ? `，积分 ${d.integral}` : ""}`);
        }
        if (/已签|签到过|重复|已完成/.test(String(signed?.errmsg || signed?.msg || ""))) return this.log(`✅ 今日已签到（${signed.errmsg || signed.msg}）`);
        this.log(`❌ 签到失败: ${signed?.errmsg || signed?.msg || short(signed)}`);
    }
    async prepareAndSign() {
        const prepared = await this.request("POST", EP_PREPARE);
        if (Number(prepared?.errno) !== 0) return this.log(`❌ 广告签到 prepare 失败: ${short(prepared)}`);
        const adToken = String((prepared.data || {}).ad_token || "");
        if (!adToken) return this.log("❌ 广告签到 prepare 未返回 ad_token");
        await $.wait(10 * 1000)
        const signed = await this.request("POST", EP_AD_SIGN, { ad_token: adToken });
        if (Number(signed?.errno) === 0) {
            const d = signed.data || {};
            this.log(`✅ 广告签到成功${d.score !== undefined ? `，获得 ${d.score} 积分` : ""}${d.integral !== undefined ? `，积分 ${d.integral}` : ""}`);
            await $.wait(30 * 1000)
            await this.checkin_sign('ad');
            return
        }
        if (/已签|签到过|重复|已完成/.test(String(signed?.errmsg || signed?.msg || ""))) return this.log(`✅ 今日已签到（${signed.errmsg || signed.msg}）`);
        this.log(`❌ 广告签到失败: ${signed?.errmsg || signed?.msg || short(signed)}`);
    }
    async checkin_sign(type) {
        let home;
        try {
            home = await this.home();
        } catch (e) {
            if (/token|登录|未授权|失效|过期|401/i.test(String(e.message))) {
                this.token = "";
                await this.login();
                home = await this.home();
            } else throw e;
        }
        if (type == 'ad') {
            if (home.ad && home.ad.today_count < home.ad.daily_limit) {
                await this.prepareAndSign();
            } else {
                this.log("✅ 今日广告签到已完成签到或不可签")
            }
            
        } else {
            if (!home.enabled) return this.log("普通签到未开启");
            if (home.today_signed || !home.can_sign) {
                this.log("✅ 今日普通签到已签到或不可签")
            } else {
                await this.sign();
            }
            if (home.ad && home.ad.today_count < home.ad.daily_limit) {
                await this.prepareAndSign();
            } else {
                this.log("✅ 今日广告签到已完成签到或不可签")
            }
        }
    }
    async ensureLogin() {
        const cached = readCache()[this.account.openid] || {};
        if (!this.token && cached.token) { this.token = cached.token; this.log("使用缓存token"); return; }
        if (!this.token) await this.login();
    }
    async run() {
        if (!this.account.openid) { this.log("跳过：变量值里没有 openid"); return; }
        try {
            await this.ensureLogin();
            await this.checkin_sign();
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
})().catch((e) => $.log(e.message || e)).finally(() => $.done());
