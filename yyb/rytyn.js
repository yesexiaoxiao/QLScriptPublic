// name: 认养一头牛签到
/*
------------------------------------------
@Description: 认养一头牛(牛奶卡商城) - 微信小程序手机号授权登录 + 每日签到
cron: 17 9 * * *
------------------------------------------

------------------------------------------
契约（appid wx0408f3f20d769a2f，host www.milkcard.mall.ryytngroup.com）：
（迁移自 YYB-GO 系脚本，原脚本为“手机号授权登录”）

登录  POST /mall/xhr/minilogin
        body {encryptedData, offset:<iv>, wxCode:<wx.login code>, code:<新式phoneCode>}
        - encryptedData/offset(iv)/phoneCode 均取自 YYB-Go 的 /wxapp/getPhoneNumber
          (data.result.raw.encryptedData / data.result.raw.iv / data.result.code)
        - wxCode 取自 /wxapp/getCode，且【手机号授权在前、取code在后】以保证 session_key 一致(参 haitian.js)
        -> token 在响应头 X-Auth-Token（或 body data.token / data.x-auth-token）
签到  POST /mall/xhr/task/checkin/save   头 X-Auth-Token:<token>
        -> code==200，data.{grade,phone,point}（该接口即“签到并返回状态”，幂等）
规则  GET  /mall/xhr/task/checkin/getRule 头 X-Auth-Token:<token>（辅助，可选）

说明：本店为“手机号一键登录/注册”，minilogin 用授权手机号建号；无独立“未注册”态。
      若 YYB-Go 取不到手机号，则无法登录，如实报告。不含任何作者个人凭证。
------------------------------------------
 YYB-Go 版：取码改走 YYB-Go（POST /wxapp/getCode），不再依赖原取码桥接服务。
 变量：YYB_SERVER 每行 地址@账号标识（例如 http://yyb-go:8000@1）；YYB_API_KEY 可选。
 原桥接版脚本见 wxapp/rytyn.js，业务接口、流程与缓存格式均未改动。
*/

const { Env } = require("../tools/env.js");
const $ = new Env("认养一头牛签到");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { YYBClient, yybAccounts } = require("./yyb.js");

const MINI_APP_ID = "wx0408f3f20d769a2f";
const BASE_URL = "https://www.milkcard.mall.ryytngroup.com";
const PAGE_VERSION = "323";
const TOKEN_CACHE_FILE = path.join(__dirname, "rytyn_token_cache.json");
const UA =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) " +
    "Mobile/15E148 MicroMessenger/8.0.61(0x18003d24) NetType/4G Language/zh_CN";

const EP_LOGIN = "/mall/xhr/minilogin";
const EP_CHECKIN = "/mall/xhr/task/checkin/save";
const EP_RULE = "/mall/xhr/task/checkin/getRule";


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
function maskPhone(p) {
    p = String(p || "");
    return p.length >= 11 ? `${p.slice(0, 3)}****${p.slice(-4)}` : p;
}
function maskToken(t) {
    t = String(t || "");
    return t.length <= 12 ? t : `${t.slice(0, 6)}****${t.slice(-4)}`;
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
    // 手机号授权数据：走 YYB-Go 的 /wxapp/getPhoneNumber（返回 encryptedData/iv/phoneCode 由账号与小程序决定）
    async getPhoneAuth() {
        const d = await yyb.getPhoneNumber(this.account.openid);
        const env = d?.result || d || {};
        const raw = env.raw || d?.raw || {};
        const encryptedData = raw.encryptedData || env.encryptedData || "";
        const iv = raw.iv || env.iv || "";
        const phoneCode = env.code || d?.code || raw.code || "";
        if (!encryptedData || !iv) throw new Error(`YYB-Go /wxapp/getPhoneNumber 未返回手机号加密数据: ${short(Object.keys(raw))} | ${short(env)}`);
        return { encryptedData, iv, phoneCode };
    }
    /** 取 wx.login code：YYB-Go /wxapp/getCode（一个账号一次请求，失败即抛错） */
    async getWxCode() {
        return yyb.getCode(this.account.openid);
    }
    async login() {
        const { encryptedData, iv, phoneCode } = await this.getPhoneAuth();
        const wxCode = await this.getWxCode();
        const body = { encryptedData, offset: iv, wxCode, code: phoneCode };
        const res = await axios.request({
            method: "POST", url: `${BASE_URL}${EP_LOGIN}`, data: body,
            headers: {
                "Content-Type": "application/json", Accept: "application/json", "User-Agent": UA,
                Referer: `https://servicewechat.com/${MINI_APP_ID}/${PAGE_VERSION}/page-frame.html`,
            },
            timeout: 30000, validateStatus: () => true,
        });
        // token 优先响应头 X-Auth-Token
        let token = res.headers?.["x-auth-token"] || res.headers?.["X-Auth-Token"] || "";
        const b = res.data;
        if (!token && b && typeof b === "object") {
            const dd = b.data || {};
            token = dd.token || dd["x-auth-token"] || dd.xAuthToken || b.token || "";
        }
        if (!token) {
            const msg = (b && (b.msg || b.message)) || short(b);
            throw new Error(`登录未返回 token: HTTP ${res.status} code=${b?.code} msg=${msg}`);
        }
        this.token = String(token);
        const cache = readCache();
        cache[this.account.openid] = { token: this.token, updatedAt: new Date().toISOString() };
        writeCache(cache);
        this.log(`登录成功 token:${maskToken(this.token)}`);
    }
    async api(method, apiPath, payload) {
        const res = await axios.request({
            method, url: `${BASE_URL}${apiPath}`, data: method === "GET" ? undefined : (payload || {}),
            headers: {
                "Content-Type": "application/json", Accept: "application/json", "User-Agent": UA,
                "X-Auth-Token": this.token,
                Referer: `https://servicewechat.com/${MINI_APP_ID}/305/page-frame.html`,
            },
            timeout: 30000, validateStatus: () => true,
        });
        return { status: res.status, data: res.data };
    }
    isAuthErr(codeOrMsg) {
        return /token|登录|未授权|失效|过期|未登录|鉴权|401|403/i.test(String(codeOrMsg));
    }
    async sign(retry = true) {
        // checkin/save = 签到并返回状态（幂等）
        const { status, data } = await this.api("POST", EP_CHECKIN, {});
        const code = data && data.code;
        const msg = (data && (data.msg || data.message)) || "";
        if (code === 200 || code === "200") {
            const d = (data && data.data) || {};
            const parts = [];
            if (d.point !== undefined) parts.push(`积分 ${d.point}`);
            if (d.phone) parts.push(`手机 ${maskPhone(d.phone)}`);
            if (d.grade !== undefined) parts.push(`等级 ${d.grade}`);
            this.log(`✅ 签到成功${parts.length ? "（" + parts.join("，") + "）" : ""}`);
            // 辅助拉一次规则（不影响结果）
            try { await this.api("GET", EP_RULE); } catch (e) {}
            return true;
        }
        if (/已签|签到过|重复|已完成|今日已/.test(String(msg))) { this.log(`✅ 今日已签到（${msg}）`); return true; }
        if (retry && (this.isAuthErr(code) || this.isAuthErr(msg) || status === 401 || status === 403)) {
            this.log("会话失效，重新登录后重试");
            this.token = "";
            await this.login();
            return this.sign(false);
        }
        this.log(`❌ 签到失败: HTTP ${status} code=${code} msg=${msg || short(data)}`);
        return false;
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
