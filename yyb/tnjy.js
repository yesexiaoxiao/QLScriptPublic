// name: 天牛旧衣服回收签到
/*
------------------------------------------
@Author: sm
@Date: 2026.05.31
@Description: 天牛旧衣服回收签到
cron: 34 8 * * *
------------------------------------------
------------------------------------------
 YYB-Go 版：取码改走 YYB-Go（POST /wxapp/getCode），不再依赖原取码桥接服务。
 变量：YYB_SERVER 每行 地址@账号标识（例如 http://yyb-go:8000@1）；YYB_API_KEY 可选。
 原桥接版脚本见 wxapp/tnjy.js，业务接口、流程与缓存格式均未改动。
*/

const { Env } = require("../tools/env.js");
const $ = new Env("天牛旧衣服回收签到");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { YYBClient, yybAccounts } = require("./yyb.js");

const MINI_APP_ID = "wx887c2f947bffa76e";
const PAGE_VERSION = "6";
const API_BASE = "https://tianniunew.fzjingzhou.com";
const TOKEN_CACHE_FILE = path.join(__dirname, "tnjy_token_cache.json");
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) MicroMessenger/3.9.12 MiniProgramEnv/Windows WindowsWechat/WMPF";
const GUEST_TOKEN = "wek2020123456788wek";


const yyb = new YYBClient({ appid: MINI_APP_ID });

function readTokenCache() {
    try {
        if (!fs.existsSync(TOKEN_CACHE_FILE)) return {};
        return JSON.parse(fs.readFileSync(TOKEN_CACHE_FILE, "utf8")) || {};
    } catch (e) {
        return {};
    }
}

function writeTokenCache(cache) {
    try {
        fs.writeFileSync(TOKEN_CACHE_FILE, JSON.stringify(cache, null, 2), "utf8");
    } catch (e) {
        $.log(`写入token缓存失败: ${e.message || e}`);
    }
}

function formBody(data = {}) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(data)) {
        if (value !== undefined && value !== null) params.append(key, String(value));
    }
    return params;
}

function isTokenError(message) {
    return /token|登录|验证失败|9999|401|403|expire|过期|失效/i.test(String(message || ""));
}

class Task {
    constructor(openid) {
        this.index = $.userIdx++;
        this.openid = String(openid || "").trim();
        this.session = {};
    }

    async run() {
        const cached = this.getCachedToken();
        if (cached) {
            this.session = cached;
            $.log(`账号[${this.index}] 使用缓存token`);
            if (!(await this.checkToken())) {
                this.removeCachedToken();
                $.log(`账号[${this.index}] 缓存token失效，重新登录`);
            }
        }

        if (!this.session.token) {
            await this.loginByWxCode();
            if (!this.session.token) return;
        }

        await this.doSign();
        this.saveCachedToken();
    }

    getCachedToken() {
        const cache = readTokenCache();
        return cache[this.openid] || null;
    }

    saveCachedToken() {
        if (!this.session.token) return;
        const cache = readTokenCache();
        cache[this.openid] = {
            token: this.session.token,
            userInfo: this.session.userInfo || {},
            newOrder: this.session.newOrder || null,
            updatedAt: new Date().toISOString(),
        };
        writeTokenCache(cache);
    }

    removeCachedToken() {
        const cache = readTokenCache();
        if (cache[this.openid]) {
            delete cache[this.openid];
            writeTokenCache(cache);
        }
        this.session = {};
    }

    headers() {
        return {
            "content-type": "application/x-www-form-urlencoded",
            "platform": "MP-WEIXIN",
            "User-Agent": USER_AGENT,
            "Referer": `https://servicewechat.com/${MINI_APP_ID}/${PAGE_VERSION}/page-frame.html`,
        };
    }

    async request(apiPath, data = {}, options = {}) {
        const token = options.noauth ? GUEST_TOKEN : (this.session.token || GUEST_TOKEN);
        const res = await axios.post(`${API_BASE}${apiPath}`, formBody({
            ...(data || {}),
            token,
        }), {
            headers: this.headers(),
            timeout: 20000,
            validateStatus: () => true,
        });

        if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
        if (Number(res.data?.code) !== 1000) {
            const error = new Error(res.data?.msg || `接口错误: ${res.data?.code || "unknown"}`);
            error.data = res.data;
            throw error;
        }
        return res.data;
    }

    /** 取 wx.login code：YYB-Go /wxapp/getCode（一个账号一次请求，失败即抛错） */
    async getLoginCode() {
        return yyb.getCode(this.openid);
    }

    async loginByWxCode() {
        try {
            const code = await this.getLoginCode();
            const res = await this.request("/api/login/getWxMiniProgramSessionKey", {
                code,
                gdtVid: "",
            }, { noauth: true });
            const data = res.data || {};
            this.session = {
                token: data.token || res.token || "",
                userInfo: data.personInfo || {},
                newOrder: data.newOrder || null,
            };
            if (!this.session.token) throw new Error("登录未返回token");
            this.saveCachedToken();
            $.log(`账号[${this.index}] 登录成功`);
        } catch (e) {
            $.log(`账号[${this.index}] 登录失败: ${e.message || e}`);
        }
    }

    async checkToken() {
        try {
            const res = await this.request("/api/Person/index");
            if (res.data) this.session.userInfo = res.data;
            return true;
        } catch (e) {
            return false;
        }
    }

    async doSign() {
        try {
            const res = await this.request("/api/Person/sign");
            const beans = res.data;
            $.log(`账号[${this.index}] 签到成功${beans !== undefined ? `，获得${beans}环保币` : ""}`);
        } catch (e) {
            const message = e.message || e;
            if (/已签到|今日已|重复|已经签到/.test(String(message))) {
                $.log(`账号[${this.index}] 今日已签到`);
                return;
            }
            $.log(`账号[${this.index}] 签到失败: ${message}`);
            if (isTokenError(message)) this.removeCachedToken();
        }
    }
}

!(async () => {
    let accounts;
    try { accounts = yybAccounts(); } catch (e) { $.log(`❌ ${e.message || e}`); return; }
    $.log(`共找到${accounts.length}个YYB账号`);
    for (const openid of accounts) {
        await new Task(openid).run();
    }
})()
    .catch((e) => $.log(e.message || e))
    .finally(() => $.done());
