// name: BLUE DASH 布鲁大师签到
/*
------------------------------------------
@Author: sm
@Date: 2026.05.31
@Description: BLUE DASH 布鲁大师小程序签到
cron: 30 8 * * *
------------------------------------------
YYB-Go 版：取码改走 YYB-Go（POST /wxapp/getCode），不再依赖 wx_server_url / wx_auth。
变量：YYB_SERVER    每行 地址@账号标识，例如 http://yyb-go:8000@1
      YYB_API_KEY   可选；yyb-go 配置 YYB_PROTOCOL_TOKEN 时填同一令牌
原桥接版脚本见 wxapp/bluedash.js，业务接口、签到流程与 token 缓存格式均未改动。
------------------------------------------
*/

const { Env } = require("../tools/env.js");
const $ = new Env("BLUE DASH 布鲁大师签到");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { YYBClient, yybRoutes } = require("./yyb.js");

const MINI_APP_ID = "wx73555499305578f8";
const API_BASE = "https://wxsc.blue-dash.com/prod-api";
const LOGIN_TYPE = "34";
const LOGIN_STATE = "blue_dash";
const TOKEN_CACHE_FILE = path.join(__dirname, "bluedash_token_cache.json");
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) MicroMessenger/3.9.12 MiniProgramEnv/Windows WindowsWechat/WMPF";

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

function maskPhone(phone = "") {
    return String(phone).replace(/^(\d{3})\d{4}(\d{4})$/, "$1****$2");
}

class Task {
    constructor(route) {
        this.index = $.userIdx++;
        // YYB_SERVER 里「地址@账号标识」的账号标识（账号数字 ID 或 openid），同时作为缓存键
        this.route = route;
        this.openid = String(route.ref || "").trim();
        this.authorization = "";
        this.refreshToken = "";
        this.user = {};
    }

    async run() {
        const cached = this.getCachedToken();
        if (cached) {
            this.applyToken(cached);
            $.log(`账号[${this.index}] 使用缓存token`);
            if (!(await this.checkToken())) {
                this.removeCachedToken();
                $.log(`账号[${this.index}] 缓存token失效，重新登录`);
            }
        }

        if (!this.authorization) {
            await this.loginByWxCode();
            if (!this.authorization) return;
        }

        await this.getSignList();
        await this.doSign();
        await this.getUser();
    }

    getCachedToken() {
        const cache = readTokenCache();
        return cache[this.openid] || null;
    }

    saveCachedToken() {
        if (!this.authorization) return;
        const cache = readTokenCache();
        cache[this.openid] = {
            authorization: this.authorization,
            refreshToken: this.refreshToken,
            nickname: this.user.nickname || "",
            mobile: this.user.mobile || "",
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
        this.authorization = "";
        this.refreshToken = "";
    }

    applyToken(data = {}) {
        const accessToken = data.accessToken || data.access_token || "";
        this.authorization = data.authorization || data.Authorization || (accessToken ? `Bearer ${accessToken}` : "");
        this.refreshToken = data.refreshToken || data.refresh_token || "";
    }

    getHeaders(extra = {}) {
        const headers = {
            "User-Agent": USER_AGENT,
            "Referer": `https://servicewechat.com/${MINI_APP_ID}/39/page-frame.html`,
            "Accept": "application/json, text/plain, */*",
            ...extra,
        };
        if (this.authorization) headers.Authorization = this.authorization;
        return headers;
    }

    async request({ method = "GET", apiPath, params = {}, data = {}, skipToken = false }) {
        const options = {
            method,
            url: `${API_BASE}${apiPath}`,
            headers: this.getHeaders(method === "POST" ? { "Content-Type": "application/json" } : {}),
            timeout: 15000,
            validateStatus: () => true,
        };
        if (method === "GET") options.params = params;
        else options.data = data;
        if (skipToken) delete options.headers.Authorization;

        const { status, data: result } = await axios.request(options);
        if (status !== 200) throw new Error(`HTTP ${status}: ${JSON.stringify(result)}`);
        if (!result || result.code !== 0) {
            const message = result?.msg || result?.message || JSON.stringify(result);
            const err = new Error(message);
            err.code = result?.code;
            throw err;
        }
        return result.data;
    }

    /** 取 wx.login code：YYB-Go 一个账号一次请求，失败直接抛错（不再有 wx_server 的 status:false 陷阱） */
    async getLoginCode() {
        return yyb.getCode(this.openid);
    }

    async loginByWxCode() {
        try {
            const code = await this.getLoginCode();
            const data = await this.request({
                method: "POST",
                apiPath: "/app-api/member/auth/social-login",
                skipToken: true,
                data: {
                    code,
                    type: LOGIN_TYPE,
                    state: LOGIN_STATE,
                },
            });
            this.applyToken(data);
            this.saveCachedToken();
            $.log(`账号[${this.index}] 登录成功`);
        } catch (e) {
            $.log(`账号[${this.index}] 登录失败: ${e.message || e}`);
        }
    }

    async checkToken() {
        try {
            await this.getUser();
            return true;
        } catch (e) {
            return false;
        }
    }

    async getUser() {
        const data = await this.request({ apiPath: "/app-api/member/user/get" });
        this.user = data || {};
        this.saveCachedToken();
        $.log(`账号[${this.index}] 用户: ${data?.nickname || ""} ${maskPhone(data?.mobile) || ""} 积分=${data?.score ?? "未知"}`);
        return data;
    }

    async getSignList() {
        try {
            const data = await this.request({
                apiPath: "/app-api/member/sign-log/page",
                params: {
                    pageNo: 1,
                    pageSize: 100,
                },
            });
            const list = data?.pageResult?.list || [];
            const today = new Date().toISOString().slice(0, 10);
            this.isTodaySign = list.some((item) => item?.date === today);
            $.log(`账号[${this.index}] 签到记录: 连续${data?.coiledDay || 0}天 今日=${this.isTodaySign ? "已签" : "未签"}`);
        } catch (e) {
            $.log(`账号[${this.index}] 查询签到记录失败: ${e.message || e}`);
            if (e.code === 401 || /token|登录|授权/i.test(String(e.message || e))) this.removeCachedToken();
        }
    }

    async doSign() {
        if (this.isTodaySign) {
            $.log(`账号[${this.index}] 今日已签到`);
            return;
        }
        try {
            const data = await this.request({
                method: "POST",
                apiPath: "/app-api/member/sign-log/sign",
            });
            $.log(`账号[${this.index}] 签到成功: +${data?.score ?? data ?? "未知"}积分`);
        } catch (e) {
            const message = String(e.message || e);
            if (/已签到|重复|今日.*签/i.test(message)) {
                $.log(`账号[${this.index}] 今日已签到`);
                return;
            }
            $.log(`账号[${this.index}] 签到失败: ${message}`);
            if (e.code === 401 || /token|登录|授权/i.test(message)) this.removeCachedToken();
        }
    }
}

!(async () => {
    let routes;
    try {
        routes = yybRoutes();
    } catch (e) {
        $.log(`❌ ${e.message || e}`);
        return;
    }
    $.log(`共找到${routes.length}个YYB账号`);
    for (const route of routes) {
        await new Task(route).run();
    }
})()
    .catch((e) => $.log(e.message || e))
    .finally(() => $.done());
