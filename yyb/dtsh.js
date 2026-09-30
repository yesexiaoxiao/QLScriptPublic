// name: DT生活签到
/*
------------------------------------------
@Description: DT生活(ebeck) - 微信小程序静默登录 + 每日签到
cron: 33 8 * * *
------------------------------------------

------------------------------------------
契约（appid wx51a2021dd921f747，host ebeikeapi.ebeck.cn）：
（迁移自 YYB-GO 系脚本，原脚本已 code 登录，纯 JSON 无签名）

登录  POST /api/v2/user/userLogin {code, appId, client:"wxmp", version:"251", pid:"", channeltype:""}
        -> data.data.token（token 放在后续请求 body，不是头）
签到  POST /api/v2/user/userSign {version:"251", client:"wxmp", token}
        -> data.msg，data.data.points/sign_num；msg 含「已签」视为已签到
积分  POST /api/v2/user/userPointsGet（可选，未强用）
------------------------------------------
 YYB-Go 版：取码改走 YYB-Go（POST /wxapp/getCode），不再依赖原取码桥接服务。
 变量：YYB_SERVER 每行 地址@账号标识（例如 http://yyb-go:8000@1）；YYB_API_KEY 可选。
 原桥接版脚本见 wxapp/dtsh.js，业务接口、流程与缓存格式均未改动。
*/

const { Env } = require("../tools/env.js");
const $ = new Env("DT生活签到");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { YYBClient, yybAccounts } = require("./yyb.js");

const MINI_APP_ID = "wx51a2021dd921f747";
const BASE = "https://ebeikeapi.ebeck.cn";
const APP_VERSION = "251";
const TOKEN_CACHE_FILE = path.join(__dirname, "dtsh_token_cache.json");
const USER_AGENT =
    "Mozilla/5.0 (Linux; Android 12; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 " +
    "Chrome/107.0.0.0 Mobile Safari/537.36 MicroMessenger/8.0.5 MiniProgramEnv/android";

const EP_LOGIN = "/api/v2/user/userLogin";
const EP_SIGN = "/api/v2/user/userSign";

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

const isAlreadyDone = (t) => /已签|已经签|签到过|重复|已完成|already/i.test(String(t || ""));

class Task {
    constructor(raw) {
        this.index = $.userIdx++;
        this.account = parseAccount(raw);
        this.token = "";
    }
    log(text) {
        $.log(`账号[${this.index}]${this.account.remark ? `[${this.account.remark}]` : ""} ${text}`);
    }
    async request(apiPath, body) {
        const res = await axios.request({
            method: "POST", url: `${BASE}${apiPath}`, data: body || {},
            headers: { "Content-Type": "application/json", charset: "utf-8", "User-Agent": USER_AGENT },
            timeout: 20000, validateStatus: () => true,
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
        const res = await this.request(EP_LOGIN, { code, appId: MINI_APP_ID, client: "wxmp", version: APP_VERSION, pid: "", channeltype: "" });
        const d = res?.data || {};
        this.token = String(d.token || "");
        if (res?.status !== "ok" || !this.token) throw new Error(`登录失败: ${res?.msg || (typeof res?.data === "string" ? res.data : short(res))}`);
        // is_mobile==0 / is_user_info==0 = 未绑定手机号/未完善资料 = 未注册会员，签不了
        this.unregistered = Number(d.is_mobile) === 0;
        const cache = readCache();
        cache[this.account.openid] = { token: this.token, updatedAt: new Date().toISOString() };
        writeCache(cache);
        this.log(`登录成功${this.unregistered ? "（该微信号未绑定手机号/未注册会员）" : ""}`);
    }
    async sign(retry = true) {
        const res = await this.request(EP_SIGN, { version: APP_VERSION, client: "wxmp", token: this.token });
        const d = res?.data;
        const dataMsg = typeof d === "string" ? d : "";
        const msg = res?.msg || res?.message || dataMsg || "";
        if (res?.status === "ok") {
            const obj = d && typeof d === "object" ? d : {};
            return this.log(`✅ 签到成功${obj.points !== undefined ? `，积分+${obj.points}` : ""}${obj.sign_num !== undefined ? `，连续 ${obj.sign_num} 天` : ""}${msg ? `（${msg}）` : ""}`);
        }
        if (isAlreadyDone(msg)) return this.log(`✅ 今日已签到（${msg}）`);
        if (retry && /token|重新登录|未授权|失效|过期|未登录/i.test(msg)) {
            this.log("会话失效，重新登录后重试");
            this.token = "";
            await this.login();
            return this.sign(false);
        }
        this.log(`❌ 签到失败: ${msg || short(res)}`);
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
            if (this.unregistered) {
                this.log("⚠️ 该微信号还没在 DT生活 绑定手机号/注册会员，先在小程序里登录注册一次再跑");
                return;
            }
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
})().catch((e) => $.log(e.message || e)).finally(() => $.done());
