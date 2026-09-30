// name: 捷停车签到
/*
------------------------------------------
@Description: 捷停车 - 微信小程序静默登录 + 每日签到
cron: 57 8 * * *
------------------------------------------

------------------------------------------
契约（appid wx24b70f0ad2a9a89a，登录 www.jslife.com.cn / 业务 sytgate.jslife.com.cn）：
（迁移自 YYB-GO 系脚本，原脚本已 code 登录）

登录  POST https://www.jslife.com.cn/wxhttp/weixin/xcx/get_openid_by_code?t=<ts> {code, userType:"WX_XCX_JTC", appId}
        -> resultCode=="0"，obj.token（JWT）；解 JWT 的 sub → userId
签到  头 Authorization: Bearer <token>
      ① POST /base-gateway/integral/v2/sign-in-task/query {userId, platformType:"WX_XCX_JTC"}
      ② POST /base-gateway/integral/v2/task/receive {userId, taskNo:"T00", reqSource:"WX_XCX_JTC", platformType:"WX_XCX_JTC", osType:"WINDOWS", token}
        -> resultCode=="0" 成功；已领/已签有对应提示
------------------------------------------
 YYB-Go 版：取码改走 YYB-Go（POST /wxapp/getCode），不再依赖原取码桥接服务。
 变量：YYB_SERVER 每行 地址@账号标识（例如 http://yyb-go:8000@1）；YYB_API_KEY 可选。
 原桥接版脚本见 wxapp/jtc.js，业务接口、流程与缓存格式均未改动。
*/

const { Env } = require("../tools/env.js");
const $ = new Env("捷停车签到");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { YYBClient, yybAccounts } = require("./yyb.js");

const MINI_APP_ID = "wx24b70f0ad2a9a89a";
const APP_VERSION = "312";
const TOKEN_URL = "https://www.jslife.com.cn/wxhttp/weixin/xcx/get_openid_by_code";
const BASE = "https://sytgate.jslife.com.cn";
const TOKEN_CACHE_FILE = path.join(__dirname, "jtc_token_cache.json");
const UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
    "MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF";

const EP_SIGN_QUERY = "/base-gateway/integral/v2/sign-in-task/query";
const EP_TASK_RECEIVE = "/base-gateway/integral/v2/task/receive";

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
function short(v, n = 200) {
    const t = typeof v === "string" ? v : JSON.stringify(v);
    return !t ? "" : t.length > n ? `${t.slice(0, n)}...` : t;
}
/** 解 JWT 的 sub（一个 JSON 字符串）里的 userId */
function userIdFromJwt(token) {
    try {
        let p = String(token).split(".")[1];
        p += "=".repeat((4 - (p.length % 4)) % 4);
        const payload = JSON.parse(Buffer.from(p.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
        const sub = typeof payload.sub === "string" ? JSON.parse(payload.sub) : payload.sub || {};
        return String(sub.userId || payload.userId || "");
    } catch (e) {
        return "";
    }
}

class Task {
    constructor(raw) {
        this.index = $.userIdx++;
        this.account = parseAccount(raw);
        this.token = "";
        this.userId = "";
    }
    log(text) {
        $.log(`账号[${this.index}]${this.account.remark ? `[${this.account.remark}]` : ""} ${text}`);
    }
    /** 取 wx.login code：YYB-Go /wxapp/getCode（一个账号一次请求，失败即抛错） */
    async getCode() {
        return yyb.getCode(this.account.openid);
    }
    async login() {
        const code = await this.getCode();
        const res = await axios.request({
            method: "POST", url: `${TOKEN_URL}?t=${Date.now()}`,
            data: { code, userType: "WX_XCX_JTC", appId: MINI_APP_ID },
            headers: { Host: "www.jslife.com.cn", applicationVersion: "1.0.1", "User-Agent": UA, xweb_xhr: "1", "Content-Type": "application/json;charset=UTF-8", Accept: "*/*", Referer: `https://servicewechat.com/${MINI_APP_ID}/${APP_VERSION}/page-frame.html` },
            timeout: 20000, validateStatus: () => true,
        });
        const d = res.data || {};
        this.token = (d.obj && d.obj.token) || (d.data && d.data.token) || "";
        if (!this.token) throw new Error(`登录失败: ${d.message || short(d)}`);
        this.userId = userIdFromJwt(this.token);
        if (!this.userId) throw new Error(`登录 token 未解析出 userId: ${short(d)}`);
        const cache = readCache();
        cache[this.account.openid] = { token: this.token, userId: this.userId, updatedAt: new Date().toISOString() };
        writeCache(cache);
        this.log("登录成功");
    }
    async api(apiPath, body) {
        const res = await axios.request({
            method: "POST", url: `${BASE}${apiPath}`, data: body || {},
            headers: { "User-Agent": UA, Authorization: `Bearer ${this.token}`, "Content-Type": "application/json", Referer: `https://servicewechat.com/${MINI_APP_ID}/${APP_VERSION}/page-frame.html` },
            timeout: 20000, validateStatus: () => true,
        });
        return res.data || {};
    }
    async sign(retry = true) {
        const q = await this.api(EP_SIGN_QUERY, { userId: this.userId, platformType: "WX_XCX_JTC" });
        // 鉴权失效
        if (retry && /(未登录|token|登录失效|鉴权|unauthorized|401)/i.test(JSON.stringify(q))) {
            this.log("会话失效，重新登录后重试");
            this.token = ""; this.userId = "";
            await this.login();
            return this.sign(false);
        }
        const qd = q.obj || q.data || {};
        if (qd.todaySigned === true || qd.signed === true || qd.isSign === true) return this.log("✅ 今日已签到");
        const res = await this.api(EP_TASK_RECEIVE, { userId: this.userId, taskNo: "T00", reqSource: "WX_XCX_JTC", platformType: "WX_XCX_JTC", osType: "WINDOWS", token: this.token });
        const msg = res.message || res.msg || short(res);
        if (String(res.resultCode) === "0" || res.success) {
            const pts = (res.obj || res.data || {}).point || (res.obj || res.data || {}).integral;
            return this.log(`✅ 签到成功${pts ? `，积分+${pts}` : ""}`);
        }
        if (/已签|已领|签到过|重复|已完成/.test(String(msg))) return this.log(`✅ 今日已签到（${msg}）`);
        this.log(`❌ 签到失败: ${msg}`);
    }
    async ensureLogin() {
        const cached = readCache()[this.account.openid] || {};
        if (!this.token && cached.token && cached.userId) { this.token = cached.token; this.userId = cached.userId; this.log("使用缓存token"); return; }
        if (!this.token) await this.login();
    }
    async run() {
        if (!this.account.openid) { this.log("跳过：变量值里没有 openid"); return; }
        try {
            await this.ensureLogin();
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
