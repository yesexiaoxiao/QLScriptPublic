// name: 中通快递
/*
------------------------------------------
@Author: sm
@Date: 2026.06.09
@Description: 中通快递 登录/积分查询/签到
cron: 20 8 * * *
------------------------------------------

也支持：
1. token=<x-token>
2. {"openid":"xxx"}
3. {"token":"xxx","openId":"xxx"}

------------------------------------------
 YYB-Go 版：取码改走 YYB-Go（POST /wxapp/getCode），不再依赖原取码桥接服务。
 变量：YYB_SERVER 每行 地址@账号标识（例如 http://yyb-go:8000@1）；YYB_API_KEY 可选。
 原桥接版脚本见 wxapp/ztkd.js，业务接口、流程与缓存格式均未改动。
*/

const { Env } = require("../tools/env.js");
const { YYBClient, yybAccounts } = require("./yyb.js");

const yyb = new YYBClient({ appid: "wx7ddec43d9d27276a" });
const $ = new Env("中通快递");
const axios = require("axios");

const CK_NAME = "ztkd";
const APP = { name: "中通快递", appid: "wx7ddec43d9d27276a", version: 670 };
const MAIN_HOST = "https://hdgateway.zto.com/";
const MEMBER_HOST = "https://membergateway.zto.com/";
const USER_AGENT =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) MicroMessenger/3.9.12 MiniProgramEnv/Windows WindowsWechat/WMPF";

function splitAccounts(value = "") {
    return String(value)
        .split(/\n|&/)
        .map((item) => item.trim())
        .filter(Boolean);
}

function short(value, max = 320) {
    if (value === undefined || value === null) return "";
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return text.length > max ? `${text.slice(0, max)}...` : text;
}

function maskPhone(phone = "") {
    return String(phone || "").replace(/^(\d{3})\d{4}(\d{4})$/, "$1****$2");
}

function maskToken(token = "") {
    const value = String(token || "");
    if (!value) return "";
    return value.length > 18 ? `${value.slice(0, 10)}***${value.slice(-8)}` : `${value.slice(0, 4)}***`;
}

function pad(num) {
    return String(num).padStart(2, "0");
}

function formatDate(date) {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function parseAccount(raw) {
    const text = String(raw || "").trim();
    if (!text) return {};
    if (/^token=/i.test(text)) return { raw: text, token: text.replace(/^token=/i, "").trim() };
    if (text.startsWith("{")) {
        const data = JSON.parse(text);
        return {
            raw: text,
            openid: data.openid || data.openId || data.wxOpenid || "",
            openId: data.ztoOpenId || data.openId || "",
            token: data.token || data.xToken || "",
            remark: data.remark || data.name || "",
        };
    }
    return { raw: text, openid: text };
}

async function request(options) {
    const res = await axios.request({
        timeout: 20000,
        validateStatus: () => true,
        ...options,
        headers: {
            "User-Agent": USER_AGENT,
            Accept: "application/json, text/plain, */*",
            ...(options.headers || {}),
        },
    });
    return { status: res.status, data: res.data || {}, headers: res.headers || {} };
}

/** 取 wx.login code：YYB-Go /wxapp/getCode（一个账号一次请求，失败即抛错） */
async function getWxCode(openid) {
    return yyb.getCode(openid);
}

class ZtoExpress {
    constructor(account, index) {
        this.index = index;
        this.account = parseAccount(account);
        this.token = this.account.token || "";
        this.openId = this.account.openId || "";
        this.user = {};
        this.today = {};
    }

    headers(extra = {}) {
        return {
            "content-type": "application/json",
            "x-token": this.token || "",
            "x-version": "V8.153.1",
            "x-clientCode": "wechatMiniZtoHelper",
            "x-oid": this.openId || "",
            "x-ys-dt": "",
            "x-sv-v": "0.22.0",
            Referer: `https://servicewechat.com/${APP.appid}/${APP.version}/page-frame.html`,
            ...extra,
        };
    }

    async api(host, apiPath, data = {}, allowFail = false) {
        const res = await request({
            method: "POST",
            url: `${host}${apiPath}`,
            headers: this.headers(),
            data,
        });
        if (res.status !== 200 && !allowFail) throw new Error(`HTTP ${res.status}: ${short(res.data)}`);
        return res.data;
    }

    async login() {
        if (this.token) {
            $.log(`账号[${this.index}] 使用变量token: ${maskToken(this.token)}`);
            return;
        }
        if (!this.account.openid) throw new Error("未配置 openid 或 token");

        const code = await getWxCode(this.account.openid);
        const res = await this.api(MAIN_HOST, "auth_wechatMini_authByCode", { code }, true);
        const data = res.result || res.data || {};
        if (!data.token) throw new Error(`登录失败: ${short(res)}`);

        this.token = data.token;
        this.openId = data.openId || this.openId;
        this.user = data;
        $.log(
            `登录：成功 userId=${data.userId || "未知"} 手机=${maskPhone(data.mobile || "") || "未知"} openId=${data.openId || "未知"}`
        );
    }

    async queryPoints() {
        const res = await this.api(MEMBER_HOST, "member/getMemberPoints", {}, true);
        if (!res.success && !res.data) {
            $.log(`积分查询：失败，${short(res)}`);
            return;
        }
        const data = res.data || {};
        $.log(`积分查询：当前积分=${data.totalPoint ?? "未知"}，即将过期=${data.overDuePoint ?? 0}`);
    }

    signRange() {
        const today = new Date();
        const start = new Date(today);
        const end = new Date(today);
        start.setDate(today.getDate() - 3);
        end.setDate(today.getDate() + 3);
        return {
            startDate: `${formatDate(start)} 00:00:00`,
            endDate: `${formatDate(end)} 23:59:59`,
            todayDate: formatDate(today),
        };
    }

    async querySignInfo(prefix = "签到信息") {
        const range = this.signRange();
        const res = await this.api(
            MEMBER_HOST,
            "member/activity/queryRecentSign",
            { startDate: range.startDate, endDate: range.endDate },
            true
        );
        const data = res.result || res.data || {};
        const list = Array.isArray(data.dailyList) ? data.dailyList : [];
        this.today = list.find((item) => item.isToday || item.date === range.todayDate) || {};
        $.log(
            `${prefix}：今日${this.today.isSigned ? "已签到" : "未签到"}，可得积分=${this.today.pointsEarned ?? "未知"}，连续=${data.continuousDays ?? 0}天，总积分=${data.totalPoints ?? "未知"}`
        );
        return data;
    }

    async sign() {
        if (this.today?.isSigned) {
            $.log("签到：今日已签到");
            return;
        }
        const date = this.today?.date || formatDate(new Date());
        const res = await this.api(
            MEMBER_HOST,
            "member/activity/signIn",
            {
                signType: "TODAY_SIGN",
                signDate: `${date} 00:00:00`,
                supplementaryScene: null,
            },
            true
        );
        if (res.status || res.success || res.result) {
            const data = res.result || res.data || {};
            $.log(`签到：成功，获得=${data.pointsEarned ?? "未知"}积分，奖励=${data.awardType || "未知"}`);
            return;
        }
        const msg = res.message || res.errMessage || short(res);
        if (/已签|重复|already/i.test(String(msg))) $.log(`签到：今日已签到，${msg}`);
        else $.log(`签到：失败，${short(res)}`);
    }

    async run() {
        $.log(`\n========== ${APP.name} 账号[${this.index}] ${this.account.remark || this.account.openid || "token"} ==========`);
        await this.login();
        await this.queryPoints();
        await this.querySignInfo("签到前");
        await this.sign();
        await this.querySignInfo("签到后");
    }
}

(async () => {
    const accounts = yybAccounts();
    if (!accounts.length) {
        $.log(`未配置 ${CK_NAME}`);
        await $.done();
        return;
    }

    $.log(`共找到${accounts.length}个账号`);
    for (let i = 0; i < accounts.length; i++) {
        const runner = new ZtoExpress(accounts[i], i + 1);
        try {
            await runner.run();
        } catch (e) {
            $.log(`账号[${i + 1}] 执行失败：${e.message || e}`);
        }
        await $.wait(800);
    }
    await $.done();
})().catch(async (e) => {
    $.log(`脚本异常：${e.stack || e.message || e}`);
    await $.done();
});
