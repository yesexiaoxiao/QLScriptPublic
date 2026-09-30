// name: 万家乐会员俱乐部
/*
------------------------------------------
@Description: 万家乐会员俱乐部 - 微信小程序静默登录 + 每日签到
cron: 36 8 * * *
------------------------------------------

------------------------------------------
契约（appid wx07b7a339bb2cf065，host wakecloud.chinamacro.com）：

信封 {code, msg, data, success}，**成功码是 100**（不是 0 不是 200）。

登录  POST /wd-member/member/login
        {code, tenantId:473, appBuId:2065, wxAppId:<appid>, i3rdSystemCode:"CSP2.0"}
        三个租户常量取自解包 app-config.json 的 ext：
          {"maAppName":"万家乐会员俱乐部","tenantId":473,"appBuId":2065,"maAppId":"wx07b7a339bb2cf065"}
        源码里还传了 loginType(=platform)，实测**可省**，服务端自己填 0
        -> data.loginInfo.sessionId（注意：data.sessionId 是 null，真值在 loginInfo 里）
        服务端**不下 Set-Cookie**，要自己把它拼成请求头 Cookie: sessionId=<...>
        data.memberInfo / loginInfo.userId / loginInfo.phone 为 null = 这个微信号还没注册会员

状态  GET  /wd-member/app/member/checkSigned   -> data 布尔（true=今天签过了）
会员  GET  /wd-member/app/member/detail        -> 未注册会员时回 {code:130004,"查询不到指定的会员信息"}
签到  GET  /wd-member/app/member/sign          -> data 是获得的积分数
        **没有会员档案时它回的是 {code:105,"系统繁忙，请稍后再试"}** —— 这是后端的兜底文案，
        不是真的忙，所以本脚本先查 member/detail，用 130004 把原因翻译成人话。

不做：/mtool/app/luckywheel/draw（抽奖，采集来的脚本一天抽 3 次，按规则不做）；
      /mtool/app/sign/* 是另一套活动签到系统，会员俱乐部页面用的是 member/sign。
------------------------------------------
 YYB-Go 版：取码改走 YYB-Go（POST /wxapp/getCode），不再依赖原取码桥接服务。
 变量：YYB_SERVER 每行 地址@账号标识（例如 http://yyb-go:8000@1）；YYB_API_KEY 可选。
 原桥接版脚本见 wxapp/wanjiale.js，业务接口、流程与缓存格式均未改动。
*/

const { Env } = require("../tools/env.js");
const $ = new Env("万家乐会员俱乐部");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { YYBClient, yybAccounts } = require("./yyb.js");

const MINI_APP_ID = "wx07b7a339bb2cf065";
const BASE = "https://wakecloud.chinamacro.com";
const TENANT_ID = 473;
const APP_BU_ID = 2065;
const TOKEN_CACHE_FILE = path.join(__dirname, "wanjiale_token_cache.json");
const USER_AGENT =
    "Mozilla/5.0 (Linux; Android 12; M2012K11AC Build/SKQ1.220303.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Version/4.0 Chrome/134.0.6998.136 Mobile Safari/537.36 MicroMessenger/8.0.48.2580(0x28003036) MiniProgramEnv/android";

const EP_LOGIN = "/wd-member/member/login";
const EP_CHECK_SIGNED = "/wd-member/app/member/checkSigned";
const EP_MEMBER = "/wd-member/app/member/detail";
const EP_SIGN = "/wd-member/app/member/sign";

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

const isOk = (res) => res && res.success === true && Number(res.code) === 100;
const codeOf = (res) => Number(res?.code || 0);
const msgOf = (res) => res?.msg || res?.message || short(res);
const isAlreadyDone = (t) => /已签|已经签|签到过|重复|已完成|already/i.test(String(t || ""));
/** 401 是它的"会话失效"码 */
const isAuthError = (res) => codeOf(res) === 401 || /未登录|登录失效|重新登录/.test(msgOf(res));
/** 130004 = 查询不到会员信息，即这个微信号还没在万家乐注册会员 */
const NO_MEMBER = 130004;

class Task {
    constructor(raw) {
        this.index = $.userIdx++;
        this.account = parseAccount(raw);
        this.token = "";
    }

    log(text) {
        $.log(`账号[${this.index}]${this.account.remark ? `[${this.account.remark}]` : ""} ${text}`);
    }

    async request(apiPath, { method = "GET", body = null, withAuth = true } = {}) {
        const headers = {
            "Content-Type": "application/json",
            Accept: "application/json, text/plain, */*",
            "Accept-Language": "zh",
            Charset: "utf-8",
            "User-Agent": USER_AGENT,
            Referer: `https://servicewechat.com/${MINI_APP_ID}/117/page-frame.html`,
            xweb_xhr: "1",
        };
        // 服务端不下 Set-Cookie，会话得自己带
        if (withAuth && this.token) headers.Cookie = `sessionId=${this.token}`;
        const res = await axios.request({
            method,
            url: `${BASE}${apiPath}`,
            data: method === "GET" ? undefined : body || {},
            headers,
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
        const res = await this.request(EP_LOGIN, {
            method: "POST",
            withAuth: false,
            body: {
                code,
                tenantId: TENANT_ID,
                appBuId: APP_BU_ID,
                wxAppId: MINI_APP_ID,
                i3rdSystemCode: "CSP2.0",
            },
        });
        if (!isOk(res)) throw new Error(`登录失败: ${msgOf(res)}`);
        const d = res.data || {};
        const li = d.loginInfo || {};
        // sessionId 在 loginInfo 里，data.sessionId 恒为 null
        this.token = String(li.sessionId || d.sessionId || "");
        if (!this.token) throw new Error(`登录未返回 sessionId: ${short(res)}`);
        this.hasMember = !!(d.memberInfo || li.userId);
        const cache = readCache();
        cache[this.account.openid] = { token: this.token, updatedAt: new Date().toISOString() };
        writeCache(cache);
        this.log(`登录成功${this.hasMember ? "" : "（该微信号未注册会员）"}`);
    }

    /** 今天签过没：true/false；会话失效返回 null */
    async checkSigned(needLog = true) {
        const res = await this.request(EP_CHECK_SIGNED);
        if (!isOk(res)) {
            if (isAuthError(res)) return null;
            if (needLog) this.log(`读取签到状态失败: ${msgOf(res)}`);
            return null;
        }
        return res.data === true;
    }

    async ensureLogin() {
        const cached = readCache()[this.account.openid] || {};
        if (!this.token && cached.token) {
            this.token = cached.token;
            const signed = await this.checkSigned(false);
            if (signed !== null) {
                this.log("使用缓存会话");
                return signed;
            }
            this.log("缓存会话失效，重新登录");
            this.token = "";
        }
        if (!this.token) await this.login();
        return null;
    }

    async sign(signed) {
        if (signed === null || signed === undefined) signed = await this.checkSigned();
        if (signed === null) {
            this.log("❌ 会话无效，签到跳过");
            return;
        }
        if (signed) {
            this.log("✅ 今日已签到");
            return;
        }
        // 没有会员档案时签到接口只回"系统繁忙"，先问一句会员信息，把原因说清楚
        const member = await this.request(EP_MEMBER);
        if (!isOk(member) && codeOf(member) === NO_MEMBER) {
            this.log(`⚠️ ${msgOf(member)} —— 该微信号还没在万家乐注册会员，签到接口只会回「系统繁忙」，先在小程序里注册一次再跑`);
            return;
        }
        const res = await this.request(EP_SIGN);
        if (isOk(res)) {
            const gain = res.data;
            this.log(`✅ 签到成功${gain ? `，+${gain} 积分` : ""}`);
            return;
        }
        if (isAlreadyDone(msgOf(res))) return this.log(`✅ 今日已签到（${msgOf(res)}）`);
        if (codeOf(res) === 105) {
            this.log(`❌ 签到失败: ${msgOf(res)}（105 是后端兜底码，多半仍是会员档案问题，可去小程序里手点一次签到确认）`);
            return;
        }
        this.log(`❌ 签到失败: ${msgOf(res)}`);
    }

    async run() {
        if (!this.account.openid) {
            this.log("跳过：变量值里没有 openid");
            return;
        }
        try {
            const signed = await this.ensureLogin();
            await this.sign(signed);
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
