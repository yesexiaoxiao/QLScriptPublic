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

// name: 东风日产签到
// cron: 42 9 * * *
// 变量：YYB_SERVER 每行「地址@账号标识」；账号直接来自 YYB_SERVER，不再读取原脚本账号变量
/*
------------------------------------------
@Description: 东风日产 人车生活 - 微信小程序静默登录 + 每日签到
cron: 42 9 * * *
------------------------------------------
变量名：dfrc
变量值：YYB-Go 里的 openid/账号标识，多账号用 & 或换行分隔（可加 #备注）

依赖变量：
------------------------------------------
契约（appid wxe3fd49854884240e）：
（迁移自 YYB-GO 系脚本 东风日产.py，原脚本已 code 登录）

登录  GET https://ariya-api.dongfeng-nissan.com.cn/toc-login-service/nissan/v2/user/login/{code}
        ?wxUuid=..&sourcecode=&smartcode=   头 Accept-Encoding:identity
        -> rows/data { oneid, api_token(wxapi JWT), token(ariya 短 hex), openid }
        无 oneid = 未注册/未激活会员
查询  POST https://ariya-api.../dfn-growth/rest/ly-mp-growth-service/ly/mgs/checkin/signList
        body {brandCode:1,channel:"2",startTime,endTime}（ariya 签名）
        -> result=="1"，rows[*].signTime.startsWith(今天) 即已签
签到  GET  https://wxapi.dongfeng-nissan.com.cn/api/small/v4/signin/mgs/checkin/signSave?wxUuid=..
        头 Authorization:Bearer {api_token}, urid:{openid}
        -> code==10000 成功 / code==10010 或含"已" 今日已签
成长  POST https://ariya-api.../dfn-growth/rest/ly-mp-growth-service/ly/mgs/growth/growthvalue/medal
        body {}（ariya 签名） -> result=="1"，data.growthScore

ariya 签名（抓包已复现）：range 固定 "1"，body 不参与签名
  sign = SHA512(clientid + timestamp(ms) + token + noncestr + "1" + oneid)
  头：appCode:nissan appSkin:NISSANAPP clientid:nissanminiapp noncestr oneid uuid=oneid
      range:1 sign timestamp token
clientid/appCode/appSkin 是这家小程序固定应用常量（原脚本硬编码，非个人凭证）。
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
const $ = new Env("东风日产签到");
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

const ckName = "dfrc";
const MINI_APP_ID = "wxe3fd49854884240e";
const PAGE_VERSION = "1285";
const ARIYA_BASE = "https://ariya-api.dongfeng-nissan.com.cn";
const WXAPI_BASE = "https://wxapi.dongfeng-nissan.com.cn";
const CLIENT_ID = "nissanminiapp";
const APP_CODE = "nissan";
const APP_SKIN = "NISSANAPP";
const TOKEN_CACHE_FILE = path.join(__dirname, "dfrc_token_cache.json");
const UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 " +
    "MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090a1b)XWEB/14185";
const REFERER = `https://servicewechat.com/${MINI_APP_ID}/${PAGE_VERSION}/page-frame.html`;

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
// 复刻小程序 getNonce：32 位大写 hex，第 13 位（index 12）固定为 4
function genNoncestr() {
    const chars = "0123456789abcdef";
    const arr = [];
    for (let i = 0; i < 32; i++) arr.push(i === 12 ? "4" : chars[Math.floor(Math.random() * 16)]);
    return arr.join("").toUpperCase();
}
function randomUuid(len = 20) {
    const chars = "abcdef0123456789";
    let s = "";
    for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return s;
}
function sha512(text) {
    return crypto.createHash("sha512").update(text, "utf8").digest("hex");
}
function chinaDateStr() {
    const d = new Date(Date.now() + 8 * 3600 * 1000);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}
// 从多层壳里挖登录返回体（rows / data）
function digData(result) {
    if (!result || typeof result !== "object") return {};
    for (const key of ["rows", "data"]) {
        const v = result[key];
        if (v && typeof v === "object" && !Array.isArray(v)) return v;
    }
    return {};
}

class Task {
    constructor(raw) {
        this.index = $.userIdx++;
        this.account = parseAccount(raw);
        this.openid = this.account.openid; // smallcat 账号变量值本身就是 openid
        this.oneid = "";
        this.token = "";      // ariya 短 hex token（ariya 签名头用）
        this.apiToken = "";   // wxapi JWT（signSave 用）
        this.wxUuid = randomUuid();
    }
    log(text) {
        $.log(`账号[${this.index}]${this.account.remark ? `[${this.account.remark}]` : ""} ${text}`);
    }
    async getCode() {
        const { data } = await wechat.getCode(this.account.openid);
        if (data && data.status === false) throw new Error(`YYB-Go 取code失败: ${data.message || short(data)}`);
        const code = data?.data?.code || data?.code;
        if (!code || typeof code !== "string") throw new Error(`YYB-Go 未返回 code: ${short(data)}`);
        return code;
    }
    async login() {
        const code = await this.getCode();
        const res = await axios.request({
            method: "GET",
            url: `${ARIYA_BASE}/toc-login-service/nissan/v2/user/login/${encodeURIComponent(code)}`,
            params: { wxUuid: this.wxUuid, sourcecode: "", smartcode: "" },
            headers: {
                Accept: "*/*", "Accept-Encoding": "identity",
                "User-Agent": UA, Referer: REFERER, xweb_xhr: "1",
            },
            timeout: 20000, validateStatus: () => true,
        });
        const result = res.data;
        this.log(`登录响应: ${short(result, 300)}`);
        const data = digData(result);
        this.oneid = String(
            data.oneid || data.oneId || data.ly_user_id || data.uuid || data.uid ||
            data.userId || data.memberId || (result && result.oneid) || "");
        this.token = String(data.token || data.access_token || data.api_token || (result && result.token) || "");
        this.apiToken = String(data.api_token || "");
        const oid = data.openid || data.openId || "";
        if (oid) this.openid = oid;
        if (!this.oneid) {
            // 未取到成长体系标识 oneid：多为该微信号未在东风日产注册/激活会员
            throw new Error(`NO_ACCOUNT:登录未返回 oneid`);
        }
        const cache = readCache();
        cache[this.account.openid] = {
            oneid: this.oneid, token: this.token, apiToken: this.apiToken,
            openid: this.openid, updatedAt: new Date().toISOString(),
        };
        writeCache(cache);
        this.log(`登录成功 oneid=${short(this.oneid, 16)} token=${this.token ? "有" : "无"} jwt=${this.apiToken ? "有" : "无"}`);
    }
    // wxapi 域名 GET（JWT 鉴权）
    async wxapiGet(apiPath) {
        const sep = apiPath.includes("?") ? "&" : "?";
        const res = await axios.request({
            method: "GET",
            url: `${WXAPI_BASE}${apiPath}${sep}wxUuid=${this.wxUuid}`,
            headers: {
                Accept: "application/json",
                Authorization: `Bearer ${this.apiToken || this.token}`,
                "Content-Type": "application/json",
                "User-Agent": UA, Referer: REFERER,
                urid: this.openid || "", xweb_xhr: "1",
            },
            timeout: 20000, validateStatus: () => true,
        });
        return res.data || {};
    }
    // ariya 域名 POST（自动签名）
    async ariyaPost(apiPath, body) {
        const ts = Date.now();
        const nonce = genNoncestr();
        const rng = "1";
        const sign = sha512(`${CLIENT_ID}${ts}${this.token}${nonce}${rng}${this.oneid}`);
        const bodyStr = body != null ? JSON.stringify(body) : "";
        const res = await axios.request({
            method: "POST",
            url: `${ARIYA_BASE}${apiPath}`,
            data: bodyStr || undefined,
            headers: {
                Accept: "*/*", "Accept-Encoding": "identity",
                "Content-Type": "application/json",
                "User-Agent": UA, Referer: REFERER,
                appCode: APP_CODE, appSkin: APP_SKIN, clientid: CLIENT_ID,
                noncestr: nonce, oneid: this.oneid, uuid: this.oneid,
                range: rng, sign, timestamp: String(ts), token: this.token, xweb_xhr: "1",
            },
            timeout: 20000, validateStatus: () => true,
        });
        return res.data || {};
    }
    async sign(retry = true) {
        // 1) 先查今日签到记录（ariya 签名）
        const today = chinaDateStr();
        try {
            const sl = await this.ariyaPost(
                "/dfn-growth/rest/ly-mp-growth-service/ly/mgs/checkin/signList",
                { brandCode: 1, channel: "2", startTime: today, endTime: today });
            if (sl && String(sl.result) === "1") {
                for (const row of (sl.rows || [])) {
                    if (String(row.signTime || "").startsWith(today)) return this.log(`✅ 今日已签到`);
                }
            }
        } catch (e) { /* 查询失败不阻塞签到 */ }

        // 2) 执行签到（wxapi JWT，GET，无 body）
        const res = await this.wxapiGet("/api/small/v4/signin/mgs/checkin/signSave");
        const code = res.code;
        const msg = res.message || res.msg || short(res);
        if (code === 10000) return this.log(`✅ 签到成功`);
        if (code === 10010 || /已签|签到过|重复|已有签到/.test(String(msg))) return this.log(`✅ 今日已签到（${msg}）`);
        if (retry && /token|登录|未授权|失效|过期|未登录|鉴权|unauth|invalid/i.test(String(msg)) || res.code === 401 || res.status === 401) {
            this.log("会话失效，重新登录后重试");
            this.token = ""; this.apiToken = ""; this.oneid = "";
            await this.login();
            return this.sign(false);
        }
        this.log(`❌ 签到失败: ${msg}`);
    }
    async queryGrowth() {
        try {
            const res = await this.ariyaPost(
                "/dfn-growth/rest/ly-mp-growth-service/ly/mgs/growth/growthvalue/medal", {});
            if (res && String(res.result) === "1") {
                const d = res.data || {};
                if (d.growthScore !== undefined) this.log(`成长值: ${d.growthScore}${d.levelName ? `（${d.levelName}）` : ""}`);
            }
        } catch (e) { /* 非关键 */ }
    }
    async ensureLogin() {
        const cached = readCache()[this.account.openid] || {};
        if (!this.oneid && cached.oneid) {
            this.oneid = cached.oneid; this.token = cached.token || "";
            this.apiToken = cached.apiToken || ""; this.openid = cached.openid || this.openid;
            this.log("使用缓存登录态");
            return;
        }
        if (!this.oneid) await this.login();
    }
    async run() {
        if (!this.account.openid) { this.log("跳过：变量值里没有 openid"); return; }
        try {
            await this.ensureLogin();
            await this.sign();
            await this.queryGrowth();
        } catch (e) {
            if (String(e.message).startsWith("NO_ACCOUNT")) {
                this.log("⚠️ 该微信号还没在东风日产人车生活注册/激活会员，先在小程序里登录一次再跑");
                return;
            }
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
