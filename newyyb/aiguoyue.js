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

// name: 爱果乐之家微信小程序签到
// cron: 5 6 * * *
// 变量：YYB_SERVER 每行「地址@账号标识」；账号直接来自 YYB_SERVER，不再读取原脚本账号变量
/*
------------------------------------------
@Author: sm
@Date: 2026.06.01
@Description: 爱果乐之家微信小程序签到
cron: 5 6 * * *
------------------------------------------
变量名：aiguoyue
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
const $ = new Env("爱果乐之家微信小程序签到");
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
const querystring = require("querystring");

const MINI_APP_ID = "wxa1086b8081476f46";
const KDT_ID = "18774683";
const USER_VERSION = "2.195.7.101";
const CLIENT_ID = "4d65249d377b2c3ed8";
const CLIENT_SECRET = "1cdc05151d64f3a4a6ebd0e9de64422a";
const GRANT_TYPE = "yz_union";
const API_BASE = "https://h5.youzan.com";
const TOKEN_CACHE_FILE = path.join(__dirname, "aiguoyue_token_cache.json");
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) MicroMessenger/3.9.12 MiniProgramEnv/Windows WindowsWechat/WMPF";

let ckName = "aiguoyue";

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
    if (!token) return "";
    return token.length > 12 ? `${token.slice(0, 6)}***${token.slice(-6)}` : `${token.slice(0, 3)}***`;
}

class Task {
    constructor(openid) {
        this.index = $.userIdx++;
        this.openid = String(openid || "").trim();
        this.token = {};
        this.checkinId = "";
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
        }
        if (!this.accessToken) return;

        await this.getPoints("签到前");
        await this.getCheckinInfo();
        await this.getActivityInfo();
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

    get accessToken() {
        return this.token.accessToken || this.token.access_token || "";
    }

    get sessionId() {
        return this.token.sessionId || this.token.session_id || "";
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
            "Referer": `https://servicewechat.com/${MINI_APP_ID}/3/page-frame.html`,
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
        return await getSingleCode(MINI_APP_ID, this.openid);
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
        $.log(`账号[${this.index}] ${label}: ${points}积分`);
        return data;
    }

    async getCheckinInfo() {
        const data = await this.request({ apiPath: "wscump/checkin/check-in-info.json" });
        this.checkinId = data?.checkInId || data?.checkinId || data?.check_in_id || "";
        $.log(`账号[${this.index}] 签到活动: checkinId=${this.checkinId || "未获取"} ownerKdtId=${data?.activityOwnerKdtId || ""}`);
        return data;
    }

    async getActivityInfo() {
        if (!this.checkinId) return null;
        const data = await this.request({
            apiPath: "wscump/checkin/get_activity_by_yzuid_v2.json",
            query: { checkinId: this.checkinId },
        });
        this.isCheckin = !!data?.isCheckin;
        this.isOpen = data?.isOpen !== false;
        const reward = (data?.dailyRewards || []).map((item) => item?.desc).filter(Boolean).join(", ");
        $.log(`账号[${this.index}] 签到状态: ${this.isCheckin ? "已签" : "未签"} 连续${data?.continuesDay ?? 0}天${reward ? ` 今日奖励${reward}` : ""}`);
        return data;
    }

    async doCheckin() {
        if (!this.checkinId) {
            $.log(`账号[${this.index}] 未获取到签到活动，跳过`);
            return;
        }
        if (this.isCheckin) {
            $.log(`账号[${this.index}] 今日已签到`);
            return;
        }
        if (!this.isOpen) {
            $.log(`账号[${this.index}] 签到活动未开启`);
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
    await $.checkEnv(ckName);
    for (const openid of $.userList) {
        await new Task(openid).run();
    }
})()
    .catch((e) => $.log(e.message || e))
    .finally(() => $.done());
