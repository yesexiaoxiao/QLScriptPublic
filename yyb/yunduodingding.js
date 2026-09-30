// name: 云朵叮叮微信小程序签到
/*
------------------------------------------
@Author: sm
@Date: 2026.06.01
@Description: 云朵叮叮微信小程序签到
cron: 30 8 * * *
------------------------------------------
------------------------------------------
 YYB-Go 版：取码改走 YYB-Go（POST /wxapp/getCode），不再依赖原取码桥接服务。
 变量：YYB_SERVER 每行 地址@账号标识（例如 http://yyb-go:8000@1）；YYB_API_KEY 可选。
 原桥接版脚本见 wxapp/yunduodingding.js，业务接口、流程与缓存格式均未改动。
*/

const { Env } = require("../tools/env.js");
const { YYBClient, yybAccounts } = require("./yyb.js");
const $ = new Env("云朵叮叮微信小程序签到");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const querystring = require("querystring");

const MINI_APP_ID = "wx5dbc7b1ca99bca9c";

const yyb = new YYBClient({ appid: MINI_APP_ID });
const KDT_ID = "152281203";
const USER_VERSION = "2.213.1";
const CLIENT_ID = "4d65249d377b2c3ed8";
const CLIENT_SECRET = "1cdc05151d64f3a4a6ebd0e9de64422a";
const GRANT_TYPE = "yz_union";
const API_BASE = "https://h5.youzan.com";
const TOKEN_CACHE_FILE = path.join(__dirname, "yunduodingding_token_cache.json");
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) MicroMessenger/3.9.12 MiniProgramEnv/Windows WindowsWechat/WMPF";

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

function maskToken(token = "") {
    const value = String(token || "");
    return value ? `${value.slice(0, 6)}***${value.slice(-6)}` : "";
}

class Task {
    constructor(openid) {
        this.index = $.userIdx++;
        this.openid = String(openid || "").trim();
        this.token = {};
        this.checkinId = "";
    }

    get accessToken() {
        return this.token.accessToken || this.token.access_token || "";
    }

    get sessionId() {
        return this.token.sessionId || this.token.session_id || "";
    }

    async run() {
        const cached = this.getCachedToken();
        if (cached) {
            this.token = cached;
            $.log(`账号[${this.index}] 使用缓存token: ${maskToken(this.accessToken)}`);
            if (!(await this.checkToken())) {
                this.removeCachedToken();
                $.log(`账号[${this.index}] 缓存token失效，重新code登录`);
            }
        }

        if (!this.accessToken) {
            await this.loginByWxCode();
            if (!this.accessToken) return;
        }

        await this.getPoints("签到前");
        await this.getCheckinInfo();
        await this.doCheckin();
        await this.getPoints("签到后");
    }

    getCachedToken() {
        const cache = readTokenCache();
        return cache[this.openid] || null;
    }

    saveCachedToken() {
        if (!this.accessToken) return;
        const cache = readTokenCache();
        cache[this.openid] = {
            ...this.token,
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
        this.token = {};
    }

    buildExtraData() {
        return JSON.stringify({
            is_weapp: 1,
            sid: this.sessionId,
            version: USER_VERSION,
            client: "weapp",
            bizEnv: "wsc",
        });
    }

    buildUrl(apiPath, query = {}) {
        const pathname = apiPath.replace(/^\/+/, "");
        const params = querystring.stringify({
            store_id: "",
            app_id: MINI_APP_ID,
            kdt_id: KDT_ID,
            access_token: this.accessToken,
            ...query,
        });
        return `${API_BASE}/${pathname}?${params}`;
    }

    getHeaders(extra = {}) {
        return {
            "User-Agent": USER_AGENT,
            "Referer": `https://servicewechat.com/${MINI_APP_ID}/64/page-frame.html`,
            "Extra-Data": this.buildExtraData(),
            "Accept": "application/json, text/plain, */*",
            ...extra,
        };
    }

    async request({ method = "GET", apiPath, query = {}, data = {}, skipToken = false }) {
        const oldToken = this.token;
        if (skipToken) this.token = {};
        const options = {
            method,
            url: this.buildUrl(apiPath, query),
            headers: this.getHeaders(method === "POST" ? { "Content-Type": "application/json" } : {}),
            timeout: 15000,
            validateStatus: () => true,
        };
        if (method !== "GET") options.data = data;
        if (skipToken) this.token = oldToken;

        const { status, data: result } = await axios.request(options);
        if (status !== 200) throw new Error(`HTTP ${status}: ${typeof result === "string" ? result.slice(0, 200) : JSON.stringify(result)}`);
        if (!result || result.code !== 0) {
            const err = new Error(result?.msg || result?.message || JSON.stringify(result));
            err.code = result?.code;
            throw err;
        }
        return result.data;
    }

    /** 取 wx.login code：YYB-Go /wxapp/getCode（一个账号一次请求，失败即抛错） */
    async getWxCode() {
        return yyb.getCode(this.openid);
    }

    async loginByWxCode() {
        try {
            const code = await this.getWxCode();
            const data = await this.request({
                method: "POST",
                apiPath: "wscshop/weapp/authorize.json",
                skipToken: true,
                data: {
                    appId: MINI_APP_ID,
                    clientId: CLIENT_ID,
                    clientSecret: CLIENT_SECRET,
                    grantType: GRANT_TYPE,
                    code,
                },
            });
            this.token = data || {};
            this.saveCachedToken();
            $.log(`账号[${this.index}] 登录成功: ${data?.nick_name || data?.nickName || ""} ${maskPhone(data?.mobile)}`);
        } catch (e) {
            $.log(`账号[${this.index}] 登录失败: ${e.message || e}`);
        }
    }

    async checkToken() {
        try {
            await this.getPoints("缓存校验");
            return true;
        } catch (e) {
            return false;
        }
    }

    async getPoints(label = "积分") {
        const data = await this.request({ apiPath: "wscump/integral/user_points.json" });
        const points = data?.current_points ?? data?.real_points ?? data?.total_points ?? "未知";
        $.log(`账号[${this.index}] ${label}: ${points}小云朵`);
        return data;
    }

    async getCheckinInfo() {
        const data = await this.request({ apiPath: "wscump/checkin/show_checkin_page_v2.json" });
        this.checkinId = data?.checkinId || data?.checkin_id || "";
        $.log(`账号[${this.index}] 签到活动: checkinId=${this.checkinId || "未获取"} isShow=${data?.isShow} showPage=${data?.showPage}`);
        return data;
    }

    async doCheckin() {
        if (!this.checkinId) {
            $.log(`账号[${this.index}] 未获取到签到活动，跳过`);
            return;
        }
        try {
            const data = await this.request({
                apiPath: "wscump/checkin/checkinV2.json",
                query: { checkinId: this.checkinId },
            });
            const award = (data?.list || [])
                .map((item) => item?.infos?.title || item?.infos?.desc || "")
                .filter(Boolean)
                .join(", ");
            $.log(`账号[${this.index}] 签到成功: ${data?.desc || ""}${award ? ` ${award}` : ""}`);
        } catch (e) {
            const message = String(e.message || e);
            if (/已签到|已经签到|重复|今日.*签|参与次数/.test(message)) {
                $.log(`账号[${this.index}] 今日已签到`);
                return;
            }
            $.log(`账号[${this.index}] 签到失败: ${message}`);
            if (e.code === -1 || e.code === 40010 || e.code === 40009 || /登录|token|access/i.test(message)) this.removeCachedToken();
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
