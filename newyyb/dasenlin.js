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
/** 统一的 YYB-Go 调用：GET 时 payload 作 query，POST 时作 body；code!=0 一律抛错 */
async function _yybCall(identifier, method, apiPath, payload) {
    const route = _yybRouteFor(identifier);
    const options = {
        method,
        url: `${route.server}${apiPath}`,
        timeout: 30000,
        headers: { 'Content-Type': 'application/json' },
    };
    if (method === 'GET') options.params = payload || {};
    else options.data = payload || {};
    const response = await axios.request(options);
    const body = response.data;
    if (!body || Number(body.code) !== 0) {
        throw new Error(`${apiPath} 返回失败：${body?.msg || body?.message || JSON.stringify(body)}`);
    }
    return body.data === undefined ? body : body.data;
}

/** 手机号授权包（YYB-Go /wxapp/getPhoneNumber；能否拿到真实包由账号与目标小程序决定） */
async function getPhoneNumber(appId, identifier) {
    const route = _yybRouteFor(identifier);
    return await _yybCall(route.ref, 'POST', '/wxapp/getPhoneNumber', { ref: route.ref, app_id: appId });
}

/** YYB 已保存的账号资料（YYB-Go GET /wx/getuserinfo） */
async function getAccountInfo(identifier) {
    const route = _yybRouteFor(identifier);
    return await _yybCall(route.ref, 'GET', '/wx/getuserinfo', { ref: route.ref });
}

/** 完整 operateWxData 转发（payload 必须来自真实小程序请求） */
async function operateWxData(appId, identifier, payload) {
    const route = _yybRouteFor(identifier);
    return await _yybCall(route.ref, 'POST', '/wxapp/operateWxData', { ref: route.ref, app_id: appId, payload });
}

/** 加密能力转发（encrypt_key/iv，payload 必须来自真实小程序请求） */
async function encryptKey(appId, identifier, payload) {
    const route = _yybRouteFor(identifier);
    return await _yybCall(route.ref, 'POST', '/wx/encryptkey', { ref: route.ref, app_id: appId, payload });
}

global.getPhoneNumber = getPhoneNumber;
global.getAccountInfo = getAccountInfo;
global.operateWxData = operateWxData;
global.encryptKey = encryptKey;

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

// name: 大参林小程序签到
// cron: 33 7 * * *
// 变量：YYB_SERVER 每行「地址@账号标识」；账号直接来自 YYB_SERVER，不再读取原脚本账号变量
/*
------------------------------------------
@Author: sm
@Date: 2026.05.31
@Description: 大参林 - 会员签到 + 种人参(浇水成长)活动
cron: 33 7 * * *
------------------------------------------
变量名：dasenlin
变量值：YYB-Go 里的 openid/账号标识，多账号用 & 或换行
------------------------------------------
接口约定（主包 app-startup-new.js 的 ajax 封装）：
  · 默认 GET，参数走查询串，并自动带上 type=1 与 mini_token
  · 成功判定 status ∈ {200,300,999} 或 code==="A0200"；活动服务另用 resp_code==="0000" + datas
  · 会员域 https://crmweixin.dslbuy.com，活动域 https://dcapi.dslbuy.com/dc-biz-activity

签到 sign.do 的坑（2026-08-17 实测定位）：
  签名参数必须拼在【查询串】上。旧版把 mobile/timestamp/sign 放进 axios 的 data，
  GET 请求根本不会带上，服务端固定回 {"status":403,"message":"签到失败","data":{"tored":1}}
  —— 长得像风控/活动限制，其实是参数没发出去。补齐后立刻变成正常的「今日已签到」。
  对照实验：缺参 403 / 全参 200 / 故意错签 403，说明这个站点的 sign 是真校验的
  （salt 与 md5(mobile+timestamp+salt) 的算法正确）。

种人参（templateId=200，活动服务）：
  · 活动发现  /applet/activity/selectActivityByStore {templateId:200} -> {activityId, effectStatus}
  · 成长状态  /applet/ginsengGameRecord/userLevelInfo {activityId}
             -> {level, levelName, dripTotal, wateringTimes, dripThreshold, disparityXUp, joinActivity, tips}
  · 浇水/领水滴接口在 apps/member/integralMall 分包里，下包 API 只给主包（两个 items 是同一个包，
    SHA-256 一致，不存在第二个包），因此脚本只能读状态、不能代浇。要自动浇水需要抓一次
    「种人参页点浇水」的请求（URL + method + body）。
  · 实测签到不产水滴（签完 dripTotal 仍为 0），水滴来自邀请助力/购物，脚本不做社交任务。
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
    /** 手机号授权包；与 getCode 一样用 {data:{status,...}} 传递失败 */
    async getPhoneNumber(wxid) {
        try {
            const data = await getPhoneNumber(this.config.appid, String(wxid).split('#')[0].trim());
            return { data: { status: true, data } };
        } catch (e) {
            return { data: { status: false, message: e.message || String(e) } };
        }
    }
    /** YYB 已保存的账号资料（备注、昵称等） */
    async getAccountInfo(wxid) {
        try {
            const data = await getAccountInfo(String(wxid).split('#')[0].trim());
            return { data: { status: true, data } };
        } catch (e) {
            return { data: { status: false, message: e.message || String(e) } };
        }
    }
    /** 完整 operateWxData 转发（payload 必须来自真实小程序请求） */
    async operateWxData(wxid, payload) {
        try {
            const data = await operateWxData(this.config.appid, String(wxid).split('#')[0].trim(), payload);
            return { data: { status: true, data } };
        } catch (e) {
            return { data: { status: false, message: e.message || String(e) } };
        }
    }
    /** 加密能力转发（encrypt_key/iv） */
    async encryptKey(wxid, payload) {
        try {
            const data = await encryptKey(this.config.appid, String(wxid).split('#')[0].trim(), payload);
            return { data: { status: true, data } };
        } catch (e) {
            return { data: { status: false, message: e.message || String(e) } };
        }
    }
}

class Env {
    constructor(name, options) {
        this.name = name; this.userList = []; this.userIdx = 1; this.userCount = 0; this.logs = [];
        this.logSeparator = "\n"; this.startTime = new Date().getTime();
        Object.assign(this, options || {});
        this.bucket = this.bucket || '';
        this.fs = require("fs");
        const originalLog = console.log; console.log = (...args) => { this.logs.push(args.join(" ")); originalLog.apply(console, args); };
        if (this.isNode() && this.bucket) {
            try {
                if (!this.fs.existsSync(this.bucket)) {
                    this.fs.writeFileSync(this.bucket, JSON.stringify({}, null, 2));
                    this.log(`📁 已创建 bucket 文件: ${this.bucket}`);
                }
            } catch (e) {
                this.log("❌ 初始化 bucket 失败: " + e.message);
            }
        }
    }
    log(...args) { console.log(...args); }
    toStr(v) {
        if (v instanceof Error) return v.stack || v.message;
        if (v && typeof v == "object") try { return JSON.stringify(v) } catch { return "[Complex Object]" }
        return String(v);
    }
    isNode() { return "undefined" != typeof module && !!module.exports; }
    async get(key, def = null) {
        if (!this.isNode() || !this.bucket) return def;
        try {
            const data = await this.fs.promises.readFile(this.bucket, "utf-8");
            const json = JSON.parse(data);
            return json.hasOwnProperty(key) ? json[key] : def;
        } catch (e) {
            this.log("❌ 读取bucket失败: " + e.message);
            return def;
        }
    }
    async set(key, value) {
        if (!this.isNode() || !this.bucket) return;
        try {
            const data = await this.fs.promises.readFile(this.bucket, "utf-8");
            const json = JSON.parse(data);
            json[key] = value;
            await this.fs.promises.writeFile(this.bucket, JSON.stringify(json, null, 2));
        } catch (e) {
            this.log("❌ 写入bucket失败: " + e.message);
        }
    }
    time(t) {
        let s = {
            "M+": new Date().getMonth() + 1,
            "d+": new Date().getDate(),
            "H+": new Date().getHours(),
            "m+": new Date().getMinutes(),
            "s+": new Date().getSeconds(),
            "q+": Math.floor((new Date().getMonth() + 3) / 3),
            S: new Date().getMilliseconds(),
        };
        /(y+)/.test(t) && (t = t.replace(RegExp.$1, (new Date().getFullYear() + "").substr(4 - RegExp.$1.length)));
        for (let e in s) {
            new RegExp("(" + e + ")").test(t) && (t = t.replace(RegExp.$1, 1 == RegExp.$1.length ? s[e] : ("00" + s[e]).substr(("" + s[e]).length)));
        }
        return t;
    }
    randomNumber(length) {
        const characters = "0123456789";
        return Array.from({ length }, () => characters[Math.floor(Math.random() * characters.length)]).join("");
    }
    randomString(length) {
        const characters = "abcdefghijklmnopqrstuvwxyz0123456789";
        return Array.from({ length }, () => characters[Math.floor(Math.random() * characters.length)]).join("");
    }
    uuid() {
        return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
            var r = (Math.random() * 16) | 0, v = c == "x" ? r : (r & 0x3) | 0x8;
            return v.toString(16);
        });
    }
    jsonToStr(obj, c = '&', encodeUrl = false) {
        let ret = []
        for (let keys of Object.keys(obj).sort()) {
            let v = obj[keys]
            if (v && encodeUrl) v = encodeURIComponent(v)
            ret.push(keys + '=' + v)
        }
        return ret.join(c);
    }
    getURLParams(url) {
        try { return Object.fromEntries(new URL(url, "http://localhost").searchParams) } catch { return {} }
    }
    isJSONString(str) {
        try { return JSON.parse(str) && typeof JSON.parse(str) === "object"; } catch (e) { return false; }
    }
    isJson(obj) {
        return typeof obj == "object" && Object.prototype.toString.call(obj).toLowerCase() == "[object object]" && !obj.length;
    }
    parseCookie(ck) {
        return typeof ck != "string" || !ck ? {} : Object.fromEntries(
            ck.split(/;\s*/).filter(v => v.includes("=")).map(v => [v.slice(0, v.indexOf("=")), v.slice(v.indexOf("=") + 1)])
        );
    }
    async wait(minMs, maxMs) { const ms = maxMs ? Math.floor(minMs + Math.random() * (maxMs - minMs)) : minMs; await new Promise(r => setTimeout(r, ms)); }
    async checkEnv(ckName) {
        const list = await global.resolveAccounts(ckName);
        this.userList = list;
        this.userCount = list.length;
        if (!this.userList.length) console.log('未配置可用的 YYB_SERVER 或脚本专用账号变量');
    }
    async done() { try { const notify = qlNotify; await notify.sendNotify(this.name, this.logs.join('\n')); } catch (e) { console.log('通知发送失败', e); } }
}
const $ = new Env("大参林小程序签到");
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
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const MINI_APP_ID = "wx16ed9a8bbb188228";
const PAGE_VERSION = "992";
const CRM_BASE = "https://crmweixin.dslbuy.com";
const ACT_BASE = "https://dcapi.dslbuy.com/dc-biz-activity";
const TOKEN_CACHE_FILE = path.join(__dirname, "dasenlin_token_cache.json");
const SIGN_SALT = "LYq76ucaPg2nsO7E";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) MicroMessenger/3.9.12 MiniProgramEnv/Windows WindowsWechat/WMPF";

const EP_LOGIN = "/member-center/entrance/registryByWeiXinCode";
const EP_SIGN_INFO = "/integralmall/signTemp/getByUser.do";
const EP_SIGN = "/integralmall/userSign/sign.do";
const EP_ACT_BY_STORE = "/applet/activity/selectActivityByStore";
const EP_GINSENG_LEVEL = "/applet/ginsengGameRecord/userLevelInfo";
const TEMPLATE_GINSENG = 200;

let ckName = "dasenlin";

const wechat = new WeChatServer({ appid: MINI_APP_ID });

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

function todayText() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
}

function maskPhone(phone = "") {
    return String(phone).replace(/^(\d{3})\d{4}(\d{4})$/, "$1****$2");
}

function md5(text) {
    return crypto.createHash("md5").update(String(text)).digest("hex").toLowerCase();
}

function getMessage(result) {
    return result?.message || result?.msg || result?.resp_msg || JSON.stringify(result);
}

function isSuccess(result) {
    if (!result) return false;
    const status = Number(result.status);
    if ([200, 300, 999].includes(status)) return true;
    return result.code === "A0200" || result.resp_code === "0000";
}

function isAlreadySigned(result) {
    return Number(result?.status) === 1 || /今日已签到|已签到|已经签到|重复/.test(getMessage(result));
}

function isTokenError(message) {
    return /300|311|token|登录|授权|未登录|无效|过期|您好，请登录/i.test(String(message || ""));
}

class Task {
    constructor(account) {
        this.index = $.userIdx++;
        this.account = String(account || "").trim();
        this.token = "";
        this.userInfo = {};
        this.signInfo = null;
    }

    log(text) {
        $.log(`账号[${this.index}] ${text}`);
    }

    async run() {
        const cached = this.getCachedToken();
        if (cached) {
            this.applyToken(cached);
            this.log("使用缓存token");
            if (!(await this.checkToken())) {
                this.removeCachedToken();
                this.log("缓存token失效，重新登录");
            }
        }

        if (!this.token) {
            await this.loginByWxCode();
            if (!this.token) return;
        }

        await this.getSignInfo();
        await this.signIn();
        await this.ginsengTask();
    }

    getCachedToken() {
        const cache = readTokenCache();
        const item = cache[this.account];
        return item && item.token ? item : null;
    }

    saveCachedToken() {
        if (!this.token) return;
        const cache = readTokenCache();
        cache[this.account] = {
            token: this.token,
            userInfo: this.userInfo || {},
            updatedAt: new Date().toISOString(),
        };
        writeTokenCache(cache);
    }

    removeCachedToken() {
        const cache = readTokenCache();
        if (cache[this.account]) {
            delete cache[this.account];
            writeTokenCache(cache);
        }
        this.token = "";
        this.userInfo = {};
    }

    applyToken(data = {}) {
        this.token = data.token || data.mini_token || "";
        this.userInfo = data.userInfo || {};
    }

    getHeaders(extra = {}) {
        return {
            "User-Agent": USER_AGENT,
            "Referer": `https://servicewechat.com/${MINI_APP_ID}/${PAGE_VERSION}/page-frame.html`,
            "Accept": "application/json, text/plain, */*",
            "Content-Type": "application/json",
            ...extra,
        };
    }

    /**
     * 复刻主包 ajax 的语义：GET 时业务参数一律走查询串（wx.request 的 data 在 GET 下就是 query），
     * 所以 data 和 params 必须合并——旧版只取 params，导致签到的签名参数被静默丢弃。
     */
    async request({ base = CRM_BASE, method = "GET", apiPath, params = {}, data = {}, raw = false, stringifyPost = false }) {
        const upperMethod = method.toUpperCase();
        const token = this.token;
        const query = { ...params, ...data };
        const options = {
            method: upperMethod,
            url: `${base}${apiPath.startsWith("/") ? apiPath : `/${apiPath}`}`,
            headers: this.getHeaders(),
            timeout: 20000,
            validateStatus: () => true,
        };

        if (upperMethod === "GET") {
            if (query.type === undefined) query.type = 1;
            if (token) query.mini_token = token;
            options.params = query;
        } else {
            const payload = { ...query };
            if (payload.type === undefined) payload.type = 1;
            if (token) payload.mini_token = token;
            options.data = stringifyPost ? JSON.stringify(payload) : payload;
        }

        const { data: result, status } = await axios.request(options);
        if (status !== 200) throw new Error(`HTTP ${status}: ${JSON.stringify(result)}`);
        if (raw) return result;
        if (!isSuccess(result)) throw new Error(getMessage(result));
        return result.data ?? result.datas ?? result;
    }

    async getLoginCode() {
        const { data } = await wechat.getCode(this.account);
        // wcs.getCode 在 status:false 时也会 resolve，必须显式判空，否则取码限流会被误报成登录失败
        if (data && data.status === false) {
            throw new Error(`YYB-Go 取code失败: ${data.message || JSON.stringify(data)}`);
        }
        const code = data?.data?.code || data?.code;
        if (!code || typeof code !== "string") {
            throw new Error(`YYB-Go 未返回 code: ${JSON.stringify(data)}`);
        }
        return code;
    }

    async loginByWxCode() {
        try {
            const code = await this.getLoginCode();
            const result = await axios.request({
                method: "POST",
                url: `${CRM_BASE}${EP_LOGIN}`,
                headers: this.getHeaders(),
                data: { code, storeNo: "" },
                timeout: 20000,
                validateStatus: () => true,
            });
            if (result.status !== 200) throw new Error(`HTTP ${result.status}: ${JSON.stringify(result.data)}`);
            const body = result.data;
            if (!isSuccess(body)) throw new Error(getMessage(body));
            const data = body.data || {};
            this.token = data.token || "";
            const crm = data.crmMemberInfo || {};
            const third = data.miniUserThirdVo || {};
            this.userInfo = {
                id: data.id || crm.id || "",
                name: crm.name || crm.nickName || data.nickName || "",
                phone: crm.phone || crm.mobile || data.phone || data.mobile || "",
                mobile: crm.mobile || crm.phone || data.mobile || data.phone || "",
                tier: crm.tier || data.tier || "",
                point: crm.point || data.point || "",
                openId: third.openId || "",
                unionId: third.unionId || "",
            };
            if (!this.token) throw new Error(`登录响应未返回token: ${JSON.stringify(body)}`);
            this.saveCachedToken();
            this.log(`登录成功${this.userInfo.phone ? `: ${maskPhone(this.userInfo.phone)}` : ""}`);
        } catch (e) {
            this.log(`登录失败: ${e.message || e}`);
        }
    }

    async checkToken() {
        try {
            await this.getSignInfo(false);
            return true;
        } catch (e) {
            return false;
        }
    }

    async getSignInfo(needLog = true) {
        const data = await this.request({ apiPath: EP_SIGN_INFO, raw: true });
        if (!isSuccess(data)) throw new Error(getMessage(data));
        const result = data?.data?.result || data?.datas?.result || {};
        this.signInfo = result;
        const member = data?.data?.member || {};
        const miniUser = data?.data?.miniUser || {};
        const phone = this.userInfo.phone || this.userInfo.mobile || member.phone || member.mobile || miniUser.mobile || "";
        this.userInfo = {
            ...this.userInfo,
            name: this.userInfo.name || member.name || miniUser.name || "",
            phone,
            mobile: phone,
            tier: this.userInfo.tier || member.tier || miniUser.tier || "",
            point: member.point ?? miniUser.point ?? this.userInfo.point ?? "",
        };
        this.saveCachedToken();

        if (needLog) {
            const userSign = result.userSign || {};
            const signed = this.isSignedToday(userSign.signDate);
            this.log(`会员: ${this.userInfo.name || "未知"} ${maskPhone(phone)}`);
            this.log(`签到状态: 连续${userSign.successionDay ?? userSign.signDay ?? 0}天 今日=${signed ? "已签" : "未签"} 抽奖机会=${userSign.lotteryCount ?? 0}`);
        }
        return result;
    }

    isSignedToday(signDate) {
        if (!signDate) return false;
        const date = new Date(Number(signDate) || signDate);
        if (Number.isNaN(date.getTime())) return false;
        const y = date.getFullYear();
        const m = String(date.getMonth() + 1).padStart(2, "0");
        const d = String(date.getDate()).padStart(2, "0");
        return `${y}-${m}-${d}` === todayText();
    }

    async signIn() {
        const userSign = this.signInfo?.userSign || {};
        if (this.isSignedToday(userSign.signDate)) {
            this.log("今日已签到");
            return;
        }

        const mobile = this.userInfo.phone || this.userInfo.mobile;
        if (!mobile) {
            this.log("签到跳过: 未取到会员手机号（sign.do 的签名以手机号为原料，缺了必然 403）");
            return;
        }

        try {
            const timestamp = Math.round(Date.now() / 1000);
            const result = await this.request({
                apiPath: EP_SIGN,
                // 必须走 GET 查询串，见文件头说明
                data: {
                    mobile,
                    timestamp,
                    sign: md5(`${mobile}${timestamp}${SIGN_SALT}`),
                    storeNo: "",
                },
                raw: true,
            });

            if (isAlreadySigned(result)) {
                this.log("今日已签到");
                return;
            }
            if (!isSuccess(result)) {
                throw new Error(`${getMessage(result) || "未知错误"} | 原始响应: ${JSON.stringify(result).slice(0, 200)}`);
            }

            const data = result.data || {};
            if (data.yearPointFull) {
                this.log("签到成功，本年签到积分已达上限(200)");
                return;
            }
            const integral = data.integral ?? "";
            this.log(`签到成功${integral !== "" && integral !== "0" ? `: +${integral}积分` : ""}`);
        } catch (e) {
            const message = String(e.message || e);
            if (/今日已签到|已签到/.test(message)) {
                this.log("今日已签到");
                return;
            }
            this.log(`签到失败: ${message}`);
            if (isTokenError(message)) this.removeCachedToken();
        }
    }

    async ginsengTask() {
        try {
            const act = await this.request({
                base: ACT_BASE,
                apiPath: EP_ACT_BY_STORE,
                params: { templateId: TEMPLATE_GINSENG },
                raw: true,
            });
            if (!isSuccess(act)) {
                this.log(`种人参: 活动查询失败 ${getMessage(act)}`);
                return;
            }
            const info = act.datas || act.data || {};
            if (!info.activityId) {
                this.log("种人参: 未发现活动（可能已下线）");
                return;
            }
            if (Number(info.effectStatus) !== 1) {
                this.log(`种人参: 活动未在进行中 (effectStatus=${info.effectStatus})`);
                return;
            }

            const detail = await this.request({
                base: ACT_BASE,
                apiPath: EP_GINSENG_LEVEL,
                params: { activityId: info.activityId },
                raw: true,
            });
            if (!isSuccess(detail)) {
                this.log(`种人参: 成长状态查询失败 ${getMessage(detail)}`);
                return;
            }
            const g = detail.datas || detail.data || {};

            if (g.neverJoin === true || g.joinActivity === false) {
                this.log("种人参: 尚未参与，请先在小程序【积分商城-签到】页进入种人参活动一次");
                return;
            }

            const drip = Number(g.dripTotal ?? 0);
            const need = Number(g.dripThreshold ?? 0);
            this.log(`种人参: Lv${g.level ?? "?"} ${g.levelName || ""} 已浇水${g.wateringTimes ?? 0}次 水滴${drip}${need ? `/${need}` : ""}`);
            if (g.tips) this.log(`种人参: ${String(g.tips).replace(/<[^>]+>/g, "")}`);

            if (need && drip >= need) {
                // 浇水接口在下不到的分包里，脚本不猜状态变更路径，只提醒
                this.log(`种人参: 水滴已够浇 ${Math.floor(drip / need)} 次，请到小程序里点浇水（浇水接口在分包内，脚本无法代浇）`);
            } else if (need) {
                this.log(`种人参: 还差 ${need - drip} 滴水才能浇一次（水滴来自邀请助力/购物，签到不产水滴）`);
            }
        } catch (e) {
            this.log(`种人参失败: ${e.message || e}`);
        }
    }
}

!(async () => {
    await $.checkEnv(ckName);
    for (const account of $.userList) {
        await new Task(account).run();
    }
})()
    .catch((e) => $.log(e.message || e))
    .finally(() => $.done());
