// name: 杰士邦会员中心
/*
------------------------------------------
@Description: 杰士邦会员中心 - 微信小程序静默登录 + 每日签到
cron: 49 8 * * *
------------------------------------------
变量名：jsb
变量值：wx_server 里的 openid/账号标识，多账号用 & 或换行分隔（可加 #备注）

依赖变量：
YYB-Go 版：取码改走 YYB-Go（POST /wxapp/getCode），不再依赖原取码桥接服务。
变量：YYB_SERVER 每行 地址@账号标识（例如 http://yyb-go:8000@1）；YYB_API_KEY 可选。
原桥接版脚本见 wxapp/jsb.js，业务接口、流程与缓存格式均未改动。
------------------------------------------
契约（appid wx5966681b4a895dee，host api.vshop.hchiv.cn，海氏海诺 vshop 会员中台）：
（迁移自 YYB-GO 系脚本；原脚本已是 code 登录 + 纯 JSON 请求，无加密无签名）

请求：POST，body 由 buildData 合成 = {appId, openId, shopNick, timestamp, interfaceSource:0, ...data}
       url 带 query ?sideType=3&mob=&appId=&shopNick=&timestamp=（reqType2）
       响应里自动捕获 set-cookie→jsession、data.clientToken→Authorization Bearer、securePlatId
登录  POST /cloud/member/wechatlogin/authLoginApplet {wxInfo:<code>, extend:"{}", sessionIdForWxShop:""}
        -> data.openId/unionId；clientToken 由 api 自动从响应捕获
签状态 POST /cloud/activity/sign/load-sign {activityId}  -> data.signed(true=今日已签)
签到  POST /cloud/activity/sign/add-sign {activityId}    -> code==200 成功（data.prizeList/integralCount）
activityId=170630 是这家的固定签到活动（原脚本硬编码，会失效则需更新）。
------------------------------------------
*/

const { Env } = require("../tools/env.js");
const $ = new Env("杰士邦会员中心");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { YYBClient, yybAccounts } = require("./yyb.js");

const APP = { appid: "wx5966681b4a895dee", shopId: "467028", signActivityId: "170630" };
const BASE = "https://api.vshop.hchiv.cn/jfmb";
const TOKEN_CACHE_FILE = path.join(__dirname, "jsb_token_cache.json");
const USER_AGENT =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
    "MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF";

const EP_LOGIN = "/cloud/member/wechatlogin/authLoginApplet";
const EP_CLIENT = "/cloud/member/tblogin/getClientInfo";
const EP_SIGN_INFO = "/cloud/activity/sign/load-sign";
const EP_SIGN = "/cloud/activity/sign/add-sign";

const yyb = new YYBClient({
    appid: APP.appid,
});

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
        $.log(`写入缓存失败: ${e.message || e}`);
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

class Task {
    constructor(raw) {
        this.index = $.userIdx++;
        this.account = parseAccount(raw);
        this.openid = this.account.openid;
        this.global = { appId: APP.appid, openId: "", unionid: "", shopNick: "", mainShopNick: "", jsession: "", clientToken: "", securePlatId: "", phoneNumber: "" };
    }
    log(text) {
        $.log(`账号[${this.index}]${this.account.remark ? `[${this.account.remark}]` : ""} ${text}`);
    }
    buildData(data = {}, reqType = 2) {
        const timestamp = Date.now();
        const common = { appId: this.global.appId, openId: this.global.openId || this.openid, shopNick: this.global.shopNick || "", timestamp, interfaceSource: 0 };
        return reqType === 2 ? { ...common, ...data } : { ...data };
    }
    async api(apiPath, data = {}, { reqType = 2 } = {}) {
        const headers = { "content-type": "application/json", appenv: "test", "User-Agent": USER_AGENT, Referer: `https://servicewechat.com/${APP.appid}/1/page-frame.html` };
        if (this.global.jsession) headers.cookie = this.global.jsession;
        if (this.global.clientToken) headers.Authorization = `Bearer ${this.global.clientToken}`;
        const body = this.buildData(typeof data === "string" ? JSON.parse(data) : data, reqType);
        const timestamp = Date.now();
        const query = reqType === 2
            ? `?sideType=3&mob=${encodeURIComponent(this.global.phoneNumber || "")}&appId=${encodeURIComponent(this.global.appId)}&shopNick=${encodeURIComponent(this.global.mainShopNick || this.global.appId)}&timestamp=${timestamp}${this.global.securePlatId ? `&securePlatId=${encodeURIComponent(this.global.securePlatId)}` : ""}`
            : "";
        const res = await axios.request({ method: "POST", url: `${BASE}${apiPath}${query}`, headers, data: body, timeout: 20000, validateStatus: () => true });
        const setCookie = res.headers["set-cookie"];
        if (Array.isArray(setCookie) && setCookie[0]) this.global.jsession = setCookie[0].split(";")[0];
        const token = res.data?.data?.clientToken || res.data?.data?.data?.clientToken;
        if (token) this.global.clientToken = token;
        const securePlatId = res.data?.data?.data?.securePlatId || res.data?.securePlatId;
        if (securePlatId) this.global.securePlatId = securePlatId;
        return res.data;
    }
    async getCode() {
        // YYB-Go：POST /wxapp/getCode（一个账号一次请求，失败即抛错）
        return yyb.getCode(this.openid);
    }
    async login() {
        const code = await this.getCode();
        const auth = await this.api(EP_LOGIN, { wxInfo: code, extend: "{}", sessionIdForWxShop: "" });
        // 响应双层壳：auth.data = {code,message,data:{...}}
        const inner = auth?.data || {};
        const payload = inner?.data || {};
        this.global.openId = payload.openId || inner.openId || this.openid;
        this.global.unionid = payload.unionId || payload.unionid || "";
        if (!this.global.clientToken) {
            this.log("⚠️ authLoginApplet 未返回 clientToken（该微信号可能未在杰士邦注册会员）");
        } else {
            this.log("登录成功（clientToken 已获取）");
        }
        const cache = readCache();
        cache[this.openid] = { clientToken: this.global.clientToken, openId: this.global.openId, updatedAt: new Date().toISOString() };
        writeCache(cache);
    }
    async sign() {
        const activityId = APP.signActivityId;
        const info = await this.api(EP_SIGN_INFO, { activityId });
        const infoBody = info?.data || {};              // 内层 {code,message,data}
        const signInfo = infoBody?.data || {};          // 实际载荷 {signed,...}
        const infoMsg = infoBody.message || infoBody.msg || "";
        if (Number(infoBody.code) === 204 || /未登录|未注册/.test(infoMsg)) {
            return this.log(`⚠️ 该微信号还没在杰士邦注册会员（${infoMsg || "未登录"}），先在小程序里绑定手机号注册一次再跑`);
        }
        if (Number(infoBody.code) !== 200) return this.log(`❌ 签到活动查询失败 activityId=${activityId}: ${infoMsg || short(info)}`);
        if (signInfo.signed) return this.log(`✅ 今日已签到 连续=${signInfo.continuousSignNum ?? 0} 累计=${signInfo.totalSignNum ?? 0}`);
        const sign = await this.api(EP_SIGN, { activityId });
        const signBody = sign?.data || {};
        const data = signBody?.data || {};
        const signMsg = signBody.message || signBody.msg || "";
        if (Number(signBody.code) === 200) {
            const prizes = Array.isArray(data.prizeList) && data.prizeList.length ? ` 奖励=${data.prizeList.map((x) => x.prizeName || x.name || short(x, 40)).join("，")}` : "";
            return this.log(`✅ 签到成功 +${data.integralCount ?? "?"}积分 连续=${data.continuousSignNum ?? "?"}${prizes}`);
        }
        if (/已签|签到过|重复|已完成/.test(signMsg)) return this.log(`✅ 今日已签到（${signMsg}）`);
        this.log(`❌ 签到失败: ${signMsg || short(signBody)}`);
    }
    async run() {
        if (!this.account.openid) { this.log("跳过：变量值里没有 openid"); return; }
        try {
            await this.login();
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
