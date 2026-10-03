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

// name: CASETiFY 签到
// cron: 22 7 * * *
// 变量：YYB_SERVER 每行「地址@账号标识」；账号直接来自 YYB_SERVER，不再读取原脚本账号变量
/*
------------------------------------------
@Author: sm
@Date: 2026.05.31
@Description: CASETiFY 签到
cron: 22 7 * * *
------------------------------------------
变量名：casetify
变量值：YYB-Go 里的 openid/账号标识，多账号用 & 或换行
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
const $ = new Env("CASETiFY 签到");
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

const MINI_APP_ID = "wxd0c71d6bf928a416";
const PAGE_VERSION = "160";
const API_BASE = "https://mini-app-api.casetify.cn/api/v4";
const WECHAT_ID = 260;
const POINT_MALL_TYPE = 13;
const TOKEN_CACHE_FILE = path.join(__dirname, "casetify_token_cache.json");
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) MicroMessenger/3.9.12 MiniProgramEnv/Windows WindowsWechat/WMPF";

let ckName = "casetify";

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

function normalizeDate(value) {
    const parts = String(value || "").split("-");
    if (parts.length !== 3) return String(value || "");
    return `${parts[0]}-${String(Number(parts[1])).padStart(2, "0")}-${String(Number(parts[2])).padStart(2, "0")}`;
}

function today() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function isTokenError(message) {
    return /token|登录|授权|invalid|expire|过期|401|403/i.test(String(message || ""));
}

class Task {
    constructor(openid) {
        this.index = $.userIdx++;
        this.openid = String(openid || "").trim();
        this.token = "";
        this.memberId = "";
        this.customerNo = "";
        this.phone = "";
        this.levels = "";
        this.campaignId = "";
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

        if (!this.token) {
            await this.loginByWxCode();
            if (!this.token) return;
        }

        await this.getCampaignId();
        await this.doSign();
        this.saveCachedToken();
    }

    getCachedToken() {
        const cache = readTokenCache();
        return cache[this.openid] || null;
    }

    saveCachedToken() {
        if (!this.token) return;
        const cache = readTokenCache();
        cache[this.openid] = {
            token: this.token,
            memberId: this.memberId,
            customerNo: this.customerNo,
            phone: this.phone,
            levels: this.levels,
            campaignId: this.campaignId,
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
        this.token = "";
        this.memberId = "";
        this.customerNo = "";
        this.campaignId = "";
    }

    applyToken(data = {}) {
        this.token = data.token || "";
        this.memberId = data.memberId || data.id || "";
        this.customerNo = data.customerNo || "";
        this.phone = data.phone || "";
        this.levels = data.levels || "";
        this.campaignId = data.campaignId || "";
    }

    getHeaders(auth = false) {
        const headers = {
            "User-Agent": USER_AGENT,
            "Referer": `https://servicewechat.com/${MINI_APP_ID}/${PAGE_VERSION}/page-frame.html`,
            "Accept": "application/json, text/plain, */*",
            "Content-Type": "application/json",
        };
        if (!auth) headers.token = this.token || "";
        return headers;
    }

    async request(method, apiPath, data = {}, options = {}) {
        const requestOptions = {
            method,
            url: `${API_BASE}/${apiPath}`,
            headers: this.getHeaders(options.auth),
            timeout: 20000,
            validateStatus: () => true,
        };
        if (method === "GET") requestOptions.params = data;
        else requestOptions.data = data;

        const { status, data: result } = await axios.request(requestOptions);
        if (status !== 200) throw new Error(`HTTP ${status}: ${JSON.stringify(result)}`);
        if (!options.allowAnyCode && result?.resultCode !== "1") {
            const err = new Error(result?.msg || JSON.stringify(result));
            err.resultCode = result?.resultCode;
            throw err;
        }
        return result;
    }

    async getLoginCode() {
        const { data } = await wechat.getCode(this.openid);
        const code = data?.code || data?.data?.code;
        if (!code) throw new Error(`YYB-Go 未返回 code: ${JSON.stringify(data)}`);
        return code;
    }

    async loginByWxCode() {
        try {
            const code = await this.getLoginCode();
            const result = await this.request("GET", `estore/member/onLogin/${code}/${WECHAT_ID}`, {}, { auth: true });
            const user = result.data || {};
            this.applyToken({
                token: user.token,
                memberId: user.id,
                customerNo: user.customerNo,
                phone: user.phone,
                levels: user.levels,
            });
            this.saveCachedToken();
            $.log(`账号[${this.index}] 登录成功: ${this.levels || "会员"} ${this.customerNo || this.memberId || ""}`);
        } catch (e) {
            $.log(`账号[${this.index}] 登录失败: ${e.message || e}`);
        }
    }

    async checkToken() {
        try {
            await this.getCampaignId(true);
            return true;
        } catch (e) {
            return false;
        }
    }

    async getCampaignId(silent = false) {
        if (this.campaignId) return this.campaignId;
        const result = await this.request("GET", "estore-campaign/campaign/info/get", {
            campaignType: POINT_MALL_TYPE,
        });
        const campaignId = result.data?.detail?.campaignId || result.data?.campaignId || "";
        if (!campaignId) throw new Error("未找到积分商城活动");
        this.campaignId = campaignId;
        this.saveCachedToken();
        if (!silent) $.log(`账号[${this.index}] 积分商城活动: ${campaignId}`);
        return campaignId;
    }

    async getSignInfo() {
        if (!this.campaignId) await this.getCampaignId(true);
        const result = await this.request("GET", "estore-campaign/campaign/pointsMall/assignment/sign", {
            campaignId: this.campaignId,
        });
        return result.data || {};
    }

    async doSign() {
        try {
            const before = await this.getSignInfo();
            const signDays = Array.isArray(before.signDays) ? before.signDays : [];
            const todayStatus = signDays.find((item) => normalizeDate(item.signDay) === today());
            const dailyTask = Array.isArray(before.assignDetail)
                ? before.assignDetail.find((item) => item.assignmentName && item.assignmentName.includes("单日"))
                : null;
            if (todayStatus?.signStatus === 1 || dailyTask?.completeStatus === 1) {
                $.log(`账号[${this.index}] 今日已签到`);
                return;
            }

            const sign = await this.request("POST", "estore-campaign/member/sign/do", {}, { allowAnyCode: true });
            if (sign.resultCode !== "1") {
                const message = sign.msg || JSON.stringify(sign);
                if (/已签|重复/.test(message)) {
                    $.log(`账号[${this.index}] 今日已签到`);
                    return;
                }
                throw new Error(message);
            }

            const after = await this.getSignInfo();
            const task = Array.isArray(after.assignDetail)
                ? after.assignDetail.find((item) => item.assignmentName && item.assignmentName.includes("单日"))
                : null;
            $.log(`账号[${this.index}] 签到成功: +${task?.awardPrice || "未知"}积分`);
        } catch (e) {
            const message = e.message || e;
            $.log(`账号[${this.index}] 签到失败: ${message}`);
            if (isTokenError(message)) this.removeCachedToken();
        }
    }
}

!(async () => {
    await $.checkEnv(ckName);
    for (const openid of $.userList) {
        await new Task(openid).run();
    }
})()
    .catch((e) => $.log(e.message || e))
    .finally(() => $.done());
