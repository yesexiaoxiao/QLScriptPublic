// name: 好人家签到
/*
------------------------------------------
@Author: sm
@Date: 2026.05.31
@Description: 好人家签到
cron: 36 8 * * *
------------------------------------------
------------------------------------------
 YYB-Go 版：取码改走 YYB-Go（POST /wxapp/getCode），不再依赖原取码桥接服务。
 变量：YYB_SERVER 每行 地址@账号标识（例如 http://yyb-go:8000@1）；YYB_API_KEY 可选。
 原桥接版脚本见 wxapp/hrj.js，业务接口、流程与缓存格式均未改动。
*/

const { Env } = require("../tools/env.js");
const $ = new Env("好人家签到");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { YYBClient, yybAccounts } = require("./yyb.js");

const MINI_APP_ID = "wx160c589739c6f8b0";
const PAGE_VERSION = "116";
const API_HOST = "https://xapi.weimob.com";
const API_BASE = `${API_HOST}/api3`;
const TOKEN_CACHE_FILE = path.join(__dirname, "hrj_token_cache.json");
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) MicroMessenger/3.9.12 MiniProgramEnv/Windows WindowsWechat/WMPF";

const FORM_BASIC_INFO = {
    bosId: "4021565647273",
    cid: "505934273",
    productInstanceId: "8689235273",
    tcode: "weimob",
    vid: "6015869513273",
};

const ONECRM_BASIC_INFO = {
    bosId: "4021565647273",
    cid: "505934273",
    productId: 146,
    productInstanceId: "8689224273",
    tcode: "weimob",
    vid: "6015869513273",
};

const EXTEND_INFO = {
    analysis: [],
    bosTemplateId: 1000002218,
    childTemplateIds: [
        { customId: 90004, version: "crm@0.1.90" },
        { customId: 90002, version: "ec@84.0" },
        { customId: 90006, version: "hudong@0.0.251" },
        { customId: 90008, version: "cms@0.0.529" },
        { customId: 90070, version: "1.0.19y" },
    ],
    quickdeliver: { enable: false },
    wxTemplateId: 8169,
    youshu: { enable: false },
    source: 1,
    channelsource: 1,
    mpScene: 1001,
};


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

function isTokenError(message) {
    return /token|登录|授权|invalid|expire|过期|1041|401|403/i.test(String(message || ""));
}

function rewardText(items) {
    if (!Array.isArray(items) || !items.length) return "";
    return items.map((item) => `${item.key || "奖励"}${item.value || ""}`).join(" ");
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
            uuid: this.session.uuid,
            bosId: this.session.bosId,
            wid: this.session.wid,
            appId: this.session.appId,
            cid: this.session.cid,
            scope: this.session.scope,
            status: this.session.status,
            sourceType: this.session.sourceType,
            source: this.session.source,
            token: this.session.token,
            expireTime: this.session.expireTime,
            latestExpireTime: this.session.latestExpireTime,
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

    getHeaders() {
        return {
            "Content-Type": "application/json",
            "X-WX-Token": this.session.token || "",
            "User-Agent": USER_AGENT,
            "Referer": `https://servicewechat.com/${MINI_APP_ID}/${PAGE_VERSION}/page-frame.html`,
            "weimob-bosId": ONECRM_BASIC_INFO.bosId,
            "weimob-pid": "N/A",
        };
    }

    buildWosBody(data = {}) {
        return {
            appid: MINI_APP_ID,
            basicInfo: { ...ONECRM_BASIC_INFO },
            extendInfo: { ...EXTEND_INFO },
            i18n: {
                language: "zh",
                timezone: "8",
            },
            ...data,
        };
    }

    async request(apiPath, data = {}) {
        const res = await axios.post(`${API_BASE}${apiPath}`, this.buildWosBody(data), {
            headers: this.getHeaders(),
            timeout: 20000,
            validateStatus: () => true,
        });
        if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
        if (`${res.data?.errcode}` !== "0") {
            const error = new Error(res.data?.errmsg || `接口错误: ${res.data?.errcode || "unknown"}`);
            error.data = res.data;
            throw error;
        }
        return res.data?.data;
    }

    /** 取 wx.login code：YYB-Go /wxapp/getCode（一个账号一次请求，失败即抛错） */
    async getLoginCode() {
        return yyb.getCode(this.openid);
    }

    async loginByWxCode() {
        try {
            const code = await this.getLoginCode();
            const loginBody = {
                appid: MINI_APP_ID,
                basicInfo: { ...FORM_BASIC_INFO },
                env: "production",
                extendInfo: { ...EXTEND_INFO },
                is_pre_fetch_open: true,
                parentVid: 0,
                pid: "",
                storeId: "",
                code,
                queryAuthConfig: true,
            };
            delete loginBody.basicInfo.productInstanceId;

            const res = await axios.post(`${API_HOST}/fe/mapi/user/loginX`, loginBody, {
                headers: {
                    "Content-Type": "application/json",
                    "User-Agent": USER_AGENT,
                    "Referer": `https://servicewechat.com/${MINI_APP_ID}/${PAGE_VERSION}/page-frame.html`,
                    "weimob-bosId": FORM_BASIC_INFO.bosId,
                    "weimob-cid": FORM_BASIC_INFO.cid,
                },
                timeout: 20000,
                validateStatus: () => true,
            });
            if (res.status !== 200 || Number(res.data?.errcode) !== 0) {
                throw new Error(res.data?.errmsg || res.data?.errormsg || `HTTP ${res.status}`);
            }
            this.session = res.data.data || {};
            this.saveCachedToken();
            $.log(`账号[${this.index}] 登录成功: wid ${this.session.wid || ""}`);
        } catch (e) {
            $.log(`账号[${this.index}] 登录失败: ${e.message || e}`);
        }
    }

    async checkToken() {
        try {
            await this.getSignMainInfo(true);
            return true;
        } catch (e) {
            return false;
        }
    }

    customInfo(extra = {}) {
        return {
            ...ONECRM_BASIC_INFO,
            source: 0,
            wid: this.session.wid,
            ...extra,
        };
    }

    async getSignMainInfo(silent = false) {
        const data = await this.request("/onecrm/mactivity/sign/misc/sign/activity/c/signMainInfo", {
            customInfo: this.customInfo(),
        });
        if (!silent) {
            $.log(`账号[${this.index}] 签到状态: ${data?.hasSign ? "今日已签" : "今日未签"} ${rewardText(data?.signForwardMsg)}`);
        }
        return data || {};
    }

    async doSign() {
        try {
            const info = await this.getSignMainInfo();
            if (info.hasSign) {
                $.log(`账号[${this.index}] 今日已签到`);
                return;
            }

            const data = await this.request("/onecrm/mactivity/sign/misc/sign/activity/core/c/sign", {
                customInfo: this.customInfo(),
            });
            const rewards = [
                rewardText(data?.fixedReward),
                rewardText(data?.extraReward),
            ].filter(Boolean).join(" ");
            $.log(`账号[${this.index}] 签到成功${rewards ? `: ${rewards}` : ""}`);
        } catch (e) {
            const message = e.message || e;
            if (/已签|重复|今日已|60070013000332/.test(String(message))) {
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
