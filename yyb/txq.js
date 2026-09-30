// name: 汤星球
/*
------------------------------------------
@Description: 汤星球 - 微信小程序静默登录 + 每日签到
cron: 47 8 * * *
------------------------------------------

------------------------------------------
契约（appid wx9bb6d5ac457bd69d，host vip.by-health.com，base /vip-api）：

信封是两层的：{success, data:{rspCode, rspMsg, result}} —— 业务码在 data.rspCode，
成功是字符串 "00"，不是 0 也不是 200。判定/取值一律要先下钻到 res.data。

登录  POST /vip-api/auth/ma/login  {appId:<本包 appid>, code}
        -> data.result.{token, registerFlag, unionId}
        registerFlag 0 = 这个微信号还没在汤星球注册成会员（登录本身照样发 token）
        之后所有请求带请求头 Authorization: <token>（裸 token，不加 Bearer）

签到不在小程序里，在 web-view 的 H5 里（小程序侧只有 ne.navigate("/signIn")）：
        宿主 https://vip.by-health.com/web/vip-center-h5/#/signIn
        H5 bundle 是公开静态资源，端点从 assets/index-*.js 的 signIn 分块里取，
        与小程序共用同一个 token 和同一个 /vip-api 前缀。

状态  POST /vip-api/sign/activity/detail  {}   ← 空 body，activityId 就是从这里发现的
        -> data.result.{activityId, signFlag, ...}；signFlag 真 = 今天已经签过
        小程序主包里的 /check/* 那套是「社区打卡」，不是每日签到，别拿它当签到用
签到  POST /vip-api/sign/daily/create  {activityId}
        -> data.result.{accumulateDay, rewardType, undrawnFlag}
日历  POST /vip-api/sign/activity/calender  {startDate,endDate,activityId}（只读，未用）

同模块还有 /sign/daily/draw、/sign/daily/raffle（签到抽奖/领奖）——按规则不做，本脚本只签到。
未注册时 detail/create 都回 rspCode="REGISTER_REQUIRED" rspMsg="请先注册成为会员"，
这不是脚本缺陷：要先在小程序里注册一次会员（要手机号），注册后同一段代码即可签到。
------------------------------------------
 YYB-Go 版：取码改走 YYB-Go（POST /wxapp/getCode），不再依赖原取码桥接服务。
 变量：YYB_SERVER 每行 地址@账号标识（例如 http://yyb-go:8000@1）；YYB_API_KEY 可选。
 原桥接版脚本见 wxapp/txq.js，业务接口、流程与缓存格式均未改动。
*/

const { Env } = require("../tools/env.js");
const $ = new Env("汤星球");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { YYBClient, yybAccounts } = require("./yyb.js");

const MINI_APP_ID = "wx9bb6d5ac457bd69d";
const BASE = "https://vip.by-health.com/vip-api";
const H5_REFERER = "https://vip.by-health.com/web/vip-center-h5/";
const TOKEN_CACHE_FILE = path.join(__dirname, "txq_token_cache.json");
const USER_AGENT =
    "Mozilla/5.0 (Linux; Android 12; M2012K11AC Build/SKQ1.220303.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Version/4.0 Chrome/134.0.6998.136 Mobile Safari/537.36 MicroMessenger/8.0.48.2580(0x28003036) MiniProgramEnv/android";

const EP_LOGIN = "/auth/ma/login";
const EP_SIGN_DETAIL = "/sign/activity/detail";
const EP_SIGN_CREATE = "/sign/daily/create";

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

/** 业务层永远在 res.data 里 */
const bodyOf = (res) => (res && res.data) || {};
const isOk = (res) => String(bodyOf(res).rspCode) === "00";
const resultOf = (res) => bodyOf(res).result || {};
const msgOf = (res) => bodyOf(res).rspMsg || bodyOf(res).rspCode || short(res);
const codeOf = (res) => String(bodyOf(res).rspCode || "");
const isAlreadyDone = (t) => /已签|已经签|签到过|重复|已完成|already/i.test(String(t || ""));
const isAuthError = (res) =>
    /UNAUTHORIZED|TOKEN/i.test(codeOf(res)) || /登录|未授权|未登录|失效|过期|重新/.test(msgOf(res));
/** 账号态：这个微信号还没在汤星球注册会员 —— 不是脚本缺陷，别打 ❌ */
const isNotRegistered = (res) =>
    /REGISTER_REQUIRED|NOT_REGIST/i.test(codeOf(res)) || /未注册|请先注册|未成为会员/.test(msgOf(res));

class Task {
    constructor(raw) {
        this.index = $.userIdx++;
        this.account = parseAccount(raw);
        this.token = "";
        this.registerFlag = null;
    }

    log(text) {
        $.log(`账号[${this.index}]${this.account.remark ? `[${this.account.remark}]` : ""} ${text}`);
    }

    async request(apiPath, body = {}, withAuth = true) {
        const headers = {
            "Content-Type": "application/json;charset=utf-8",
            Accept: "application/json, text/plain, */*",
            "User-Agent": USER_AGENT,
            Referer: H5_REFERER,
            xweb_xhr: "1",
        };
        if (withAuth && this.token) headers.Authorization = this.token;
        const res = await axios.request({
            method: "POST",
            url: `${BASE}${apiPath}`,
            data: body,
            headers,
            timeout: 20000,
            validateStatus: () => true,
        });
        if (res.status !== 200) throw new Error(`${apiPath} HTTP ${res.status}: ${short(res.data)}`);
        return res.data;
    }

    /** 取 wx.login code：YYB-Go /wxapp/getCode（一个账号一次请求，失败即抛错） */
    async getCode() {
        return yyb.getCode(this.account.openid);
    }

    async login() {
        const code = await this.getCode();
        const res = await this.request(EP_LOGIN, { appId: MINI_APP_ID, code }, false);
        if (!isOk(res)) throw new Error(`登录失败: ${msgOf(res)}`);
        const r = resultOf(res);
        this.token = String(r.token || "");
        this.registerFlag = r.registerFlag === undefined ? null : Number(r.registerFlag);
        if (!this.token) throw new Error(`登录未返回 token: ${short(res)}`);
        const cache = readCache();
        cache[this.account.openid] = { token: this.token, updatedAt: new Date().toISOString() };
        writeCache(cache);
        this.log(`登录成功${this.registerFlag === 0 ? "（会员未注册）" : ""}`);
    }

    /** 读签到活动详情：既验证会话，又发现 activityId 和今日是否签过 */
    async signDetail(needLog = true) {
        const res = await this.request(EP_SIGN_DETAIL, {});
        if (!isOk(res)) {
            if (isNotRegistered(res)) return { notRegistered: true, msg: msgOf(res) };
            if (needLog) this.log(`读取签到活动失败: ${msgOf(res)}`);
            return isAuthError(res) ? null : { failed: true, msg: msgOf(res) };
        }
        const r = resultOf(res);
        return {
            activityId: r.activityId,
            signed: !!r.signFlag,
            accumulateDay: r.accumulateDay ?? r.continuousDay,
            remainingDay: r.remainingDay,
        };
    }

    async ensureLogin() {
        const cached = readCache()[this.account.openid] || {};
        if (!this.token && cached.token) {
            this.token = cached.token;
            const probe = await this.signDetail(false);
            if (probe !== null) {
                this.log("使用缓存token");
                return probe;
            }
            this.log("缓存token失效，重新登录");
            this.token = "";
        }
        if (!this.token) await this.login();
        return null;
    }

    async sign(detail) {
        if (detail === null || detail === undefined) detail = await this.signDetail();
        if (detail === null) {
            this.log("❌ 会话无效，签到跳过");
            return;
        }
        if (detail.notRegistered) {
            this.log(`⚠️ ${detail.msg} —— 该微信号还没在汤星球注册会员（注册要手机号），先在小程序里注册一次再跑`);
            return;
        }
        if (detail.failed) {
            this.log(`❌ 读取签到活动失败: ${detail.msg}`);
            return;
        }
        if (!detail.activityId) {
            this.log("❌ 签到活动详情里没有 activityId（活动可能未开始或已结束），不猜 id");
            return;
        }
        if (detail.signed) {
            this.log(`✅ 今日已签到（活动 ${detail.activityId}${detail.accumulateDay ? `，累计 ${detail.accumulateDay} 天` : ""}）`);
            return;
        }
        const res = await this.request(EP_SIGN_CREATE, { activityId: detail.activityId });
        if (isOk(res)) {
            const r = resultOf(res);
            const days = r.accumulateDay ?? r.continuousDay;
            this.log(`✅ 签到成功${days ? `，累计 ${days} 天` : ""}`);
            return;
        }
        if (isAlreadyDone(msgOf(res))) return this.log(`✅ 今日已签到（${msgOf(res)}）`);
        if (isNotRegistered(res)) {
            this.log(`⚠️ ${msgOf(res)} —— 该微信号还没在汤星球注册会员（注册要手机号），先在小程序里注册一次再跑`);
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
            const detail = await this.ensureLogin();
            await this.sign(detail);
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
