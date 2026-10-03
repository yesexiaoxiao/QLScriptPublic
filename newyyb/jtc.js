// YYB-Go-Enhanced 适配说明：配置多行 YYB_SERVER=地址@账号标识；通知使用青龙 sendNotify。
// ===== YYB-Go-Enhanced + QingLong standalone adapter =====
function _yybRoutes() {
    const routes = String(process.env.YYB_SERVER || '').split(/\r?\n/)
        .map(v => v.trim()).filter(Boolean).map((line, index) => {
            const at = line.lastIndexOf('@');
            if (at <= 0 || at >= line.length - 1) {
                throw new Error(`YYB_SERVER 第 ${index + 1} 行格式错误，应为 地址@账号标识`);
            }
            let server = line.slice(0, at).trim().replace(/\/+$/, '');
            if (!/^https?:\/\//i.test(server)) server = `http://${server}`;
            return { server, ref: line.slice(at + 1).trim() };
        });
    if (!routes.length) throw new Error('未配置 YYB_SERVER（每行：地址@账号标识）');
    return routes;
}

function _yybCleanRef(value) {
    return String(value || '').split('#')[0].replace(/^(wx|yyb|wmpf|syzs):/i, '').trim();
}

function _yybRouteFor(identifier) {
    const routes = _yybRoutes();
    const wanted = _yybCleanRef(identifier);
    const exact = routes.find(x => _yybCleanRef(x.ref) === wanted);
    if (exact) return exact;
    if (/^\d+$/.test(wanted) && routes[Number(wanted) - 1]) return routes[Number(wanted) - 1];
    if (routes.length === 1) return routes[0];
    throw new Error(`YYB_SERVER 中找不到账号标识：${wanted || '(空)'}`);
}

async function getSingleCode(appId, identifier) {
    const route = _yybRouteFor(identifier);
    const response = await axios.post(`${route.server}/wxapp/getCode`,
        { ref: route.ref, app_id: appId },
        { timeout: 30000, headers: { 'Content-Type': 'application/json' } });
    const body = response.data;
    if (!body || Number(body.code) !== 0) {
        throw new Error(`/wxapp/getCode 返回失败：${body?.msg || body?.message || JSON.stringify(body)}`);
    }
    const code = body.data?.result?.code;
    if (!code) throw new Error('/wxapp/getCode 未返回 data.result.code');
    return code;
}

async function _resolveYybAccounts(envName = '') {
    const structured = new Set(['qmai', 'quncrm']);
    const configured = structured.has(envName) ? String(process.env[envName] || '').trim() : '';
    if (configured) return configured.split(/[\r\n&]+/).map(v => v.trim()).filter(Boolean);
    return _yybRoutes().map(x => x.ref);
}
global.getSingleCode = getSingleCode;
global.resolveAccounts = _resolveYybAccounts;

async function _sendQingLongNotify(title, content) {
    const candidates = ['./sendNotify', '../sendNotify', '/ql/data/scripts/sendNotify', '/ql/scripts/sendNotify'];
    let lastError = null;
    for (const candidate of candidates) {
        try {
            const mod = require(candidate);
            const send = mod?.sendNotify || mod?.send;
            if (typeof send === 'function') {
                await send(title, content);
                return true;
            }
        } catch (error) { lastError = error; }
    }
    console.log(`青龙通知失败（不影响任务结果）：${lastError?.message || '未找到通知模块'}`);
    return false;
}
const qlNotify = { sendNotify: _sendQingLongNotify, send: _sendQingLongNotify };
// ===== adapter end =====

// name: 捷停车签到
// cron: 57 14 * * *
/*
------------------------------------------
@Description: 捷停车 - 微信小程序静默登录 + 每日签到
------------------------------------------
变量：
  YYB_SERVER     YYB-Go-Enhanced 路由，每行：地址@账号标识（例如 http://yyb-go:8000@1）
  账号直接来自 YYB_SERVER；无需配置 jtc 变量

取码：POST {YYB_SERVER}/wxapp/getCode {ref, app_id}（YYB-Go 调 wx.login）
      —— 原 wx_server_url / wx_auth 桥接取码（wxapp/wcs.js）已移除。

契约（appid wx24b70f0ad2a9a89a，登录 www.jslife.com.cn / 业务 sytgate.jslife.com.cn）：

登录  POST https://www.jslife.com.cn/wxhttp/weixin/xcx/get_openid_by_code?t=<ts> {code, userType:"WX_XCX_JTC", appId}
        -> resultCode=="0"，obj.token（JWT）；解 JWT 的 sub → userId
签到  头 Authorization: Bearer <token>
      ① POST /base-gateway/integral/v2/sign-in-task/query {userId, platformType:"WX_XCX_JTC"}
      ② POST /base-gateway/integral/v2/task/receive {userId, taskNo:"T00", reqSource:"WX_XCX_JTC", platformType:"WX_XCX_JTC", osType:"WINDOWS", token}
        -> resultCode=="0" 成功；已领/已签有对应提示
------------------------------------------
*/

class WeChatServer {
    constructor(config) { this.config = config || {}; }
    async getCode(wxid) {
        try {
            const ref = String(wxid).split('#')[0].trim();
            const code = await getSingleCode(this.config.appid, ref);
            return { data: { status: true, code, data: { code } } };
        } catch (e) {
            return { data: { status: false, message: e.message || String(e) } };
        }
    }
}

class Env {
    constructor(name) { this.name = name; this.userList = []; this.userIdx = 1; this.userCount = 0; this.logs = []; const originalLog = console.log; console.log = (...args) => { this.logs.push(args.join(" ")); originalLog.apply(console, args); }; }
    log(...args) { console.log(...args); }
    async wait(minMs, maxMs) { const ms = maxMs ? Math.floor(minMs + Math.random() * (maxMs - minMs)) : minMs; await new Promise(r => setTimeout(r, ms)); }
    async checkEnv(ckName) {
        const list = await global.resolveAccounts(ckName);
        this.userList = list;
        this.userCount = list.length;
        if (!this.userList.length) console.log('未配置可用的 YYB_SERVER 或脚本专用账号变量');
    }
    async done() { try { const notify = qlNotify; await notify.sendNotify(this.name, this.logs.join('\n')); } catch (e) { console.log('通知发送失败', e); } }
}

const $ = new Env("捷停车签到");
const axios = Object.assign(async function axios(config = {}) {
    const method = String(config.method || 'GET').toUpperCase();
    let url = String(config.url || '');
    if (config.params && typeof config.params === 'object') {
        const query = new URLSearchParams();
        for (const [key, value] of Object.entries(config.params)) {
            if (value !== undefined && value !== null) query.append(key, String(value));
        }
        const text = query.toString();
        if (text) url += (url.includes('?') ? '&' : '?') + text;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Number(config.timeout || 30000));
    const headers = { ...(config.headers || {}) };
    let body;
    if (!['GET', 'HEAD'].includes(method) && config.data !== undefined) {
        const contentType = Object.entries(headers).find(([key]) => key.toLowerCase() === 'content-type')?.[1] || '';
        body = typeof config.data === 'string' || Buffer.isBuffer(config.data)
            ? config.data
            : contentType.includes('application/x-www-form-urlencoded')
                ? new URLSearchParams(config.data).toString()
                : JSON.stringify(config.data);
        if (!contentType && typeof config.data === 'object') headers['Content-Type'] = 'application/json';
    }
    try {
        const response = await fetch(url, { method, headers, body, signal: controller.signal, redirect: 'follow' });
        const raw = await response.text();
        let data = raw;
        try { data = raw ? JSON.parse(raw) : ''; } catch {}
        const responseHeaders = Object.fromEntries(response.headers.entries());
        const setCookies = typeof response.headers.getSetCookie === 'function'
            ? response.headers.getSetCookie()
            : (response.headers.get('set-cookie') ? [response.headers.get('set-cookie')] : []);
        if (setCookies.length) responseHeaders['set-cookie'] = setCookies;
        const result = { status: response.status, statusText: response.statusText,
            headers: responseHeaders, data };
        const accepted = typeof config.validateStatus === 'function'
            ? config.validateStatus(response.status)
            : response.status >= 200 && response.status < 300;
        if (!accepted) {
            const error = new Error(`HTTP ${response.status}`);
            error.response = result;
            throw error;
        }
        return result;
    } finally {
        clearTimeout(timer);
    }
}, {
    request(config) { return axios(config); },
    get(url, config = {}) { return axios({ ...config, method: 'GET', url }); },
    post(url, data, config = {}) { return axios({ ...config, method: 'POST', url, data }); },
});
const fs = require("fs");
const path = require("path");

const ckName = "jtc";
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

const wechat = new WeChatServer({ appid: MINI_APP_ID });

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
    /** 取 wx.login code：YYB-Go /wxapp/getCode（失败会带 status:false 返回，必须自己判失败） */
    async getCode() {
        const { data } = await wechat.getCode(this.account.openid);
        if (data && data.status === false) throw new Error(`YYB 取code失败: ${data.message || short(data)}`);
        const code = data?.data?.code || data?.code;
        if (!code || typeof code !== "string") throw new Error(`YYB 未返回 code: ${short(data)}`);
        return code;
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
    await $.checkEnv(ckName);
    if (!$.userCount) { $.log(`未找到变量 ${ckName}`); return; }
    for (let i = 0; i < $.userList.length; i++) {
        await new Task($.userList[i]).run();
        if (i < $.userList.length - 1) await $.wait(1500, 3000);
    }
})().catch((e) => $.log(e.message || e)).finally(() => $.done());
