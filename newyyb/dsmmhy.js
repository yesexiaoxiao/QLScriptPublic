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

// name: 袋鼠妈妈会员商城签到
// cron: 55 7 * * *
// 变量：YYB_SERVER 每行「地址@账号标识」；账号直接来自 YYB_SERVER，不再读取原脚本账号变量
/*
------------------------------------------
@Description: 袋鼠妈妈会员商城 - 微信小程序静默登录 + 每日签到（有赞平台）
cron: 55 7 * * *
------------------------------------------
变量名：dsmmhy
变量值：YYB-Go 里的 openid/账号标识，多账号用 & 或换行分隔（可加 #备注）

依赖变量：
------------------------------------------
契约（appid wxb27b46293d405a20，有赞店铺 kdtId=44587018，登录 uic.youzan.com / 业务 h5.youzan.com）：
（迁移自 YYB-GO 系脚本，原脚本已 code 登录；与本仓 youzan.js 通用登录同构）

  登录  POST https://uic.youzan.com/passport/general/auth.json?kdt_id=44587018&app_id=<appid>
        body {appId, code, platformName:"weapp", signature:"windows", clientBiz:"weapp_wsc",
              inWsc:true, kdtId, extraBizData:{enterOptions{...},guideBizDataMap,sceneData}}
        -> code==0，data.accessToken（=后续 token）、data.sessionId（=sid）、data.kdtId（真实店铺号）
        access_token 之后作为查询参数 access_token= 带在每个 h5.youzan.com 请求上（不是 cookie）
  会话  GET  https://h5.youzan.com/wscaccount/api/authorize/data.json  -> code==0 会话有效
  活动  GET  https://h5.youzan.com/wscump/checkin/check-in-info.json   -> data.checkInId（实时签到活动 id，防轮换）
  状态  GET  https://h5.youzan.com/wscump/checkin/get_activity_by_yzuid_v2.json?checkinId=  -> data.isCheckin(已签)
  签到  GET  https://h5.youzan.com/wscump/checkin/checkinV2.json?checkinId=&...
        -> code==0 成功（data.list[].infos.title 为奖励）；已签到走 msg / data.success==false&desc；
           code==1000000002「userId must be >= 1」= 该微信号还没在该店注册会员（账号态，不是脚本缺陷）
  KDT_ID=44587018 / CHECKIN_ID=17019 是这家店铺的固定应用常量（原脚本硬编码，非个人凭证）。
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
const $ = new Env("袋鼠妈妈会员商城签到");
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

const ckName = "dsmmhy";
const MINI_APP_ID = "wxb27b46293d405a20";
const KDT_ID = "44587018";
const CHECKIN_ID = "17019"; // 兜底；脚本优先用 check-in-info.json 的实时 checkinId（有赞活动 id 可能轮换）
const UIC = "https://uic.youzan.com";
const H5 = "https://h5.youzan.com";
const WEAPP_VERSION = "2.232.5.101";
const TOKEN_CACHE_FILE = path.join(__dirname, "dsmmhy_token_cache.json");
const USER_AGENT =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 " +
    "Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF";

const wechat = new WeChatServer({ appid: MINI_APP_ID });

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

const isOk = (res) => Number(res?.code) === 0;
const msgOf = (res) => res?.msg || res?.message || short(res);
const isAlreadyDone = (t) => /已签|已经签|签到过|重复|已完成|already/i.test(String(t || ""));
const isNotMember = (res) =>
    Number(res?.code) === 1000000002 || /userId must be|未注册|请先注册|注册会员|开通会员|没有会员/i.test(msgOf(res));

class Task {
    constructor(raw) {
        this.index = $.userIdx++;
        this.account = parseAccount(raw);
        this.cred = null;
    }

    log(text) {
        $.log(`账号[${this.index}]${this.account.remark ? `[${this.account.remark}]` : ""} ${text}`);
    }

    get kdt() {
        return (this.cred && this.cred.kdtId) || KDT_ID || "";
    }

    headers() {
        return {
            "Content-Type": "application/json",
            Accept: "application/json, text/plain, */*",
            "User-Agent": USER_AGENT,
            "Extra-Data": JSON.stringify({
                is_weapp: 1,
                sid: (this.cred && this.cred.sid) || "",
                version: WEAPP_VERSION,
                client: "weapp",
                bizEnv: "wsc",
            }),
            Referer: `https://servicewechat.com/${MINI_APP_ID}/39/page-frame.html`,
        };
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
        const body = {
            appId: MINI_APP_ID,
            code,
            platformName: "weapp",
            signature: "windows",
            clientBiz: "weapp_wsc",
            inWsc: true,
            kdtId: KDT_ID,
            extraBizData: {
                enterOptions: {
                    extKdtId: Number(KDT_ID) || 0,
                    path: "pages/home/dashboard/index",
                    query: {},
                    scene: 1005,
                    referrerInfo: {},
                    hostExtraData: {},
                    apiCategory: "default",
                },
                guideBizDataMap: { from_params: "" },
                sceneData: {},
            },
        };
        const { data } = await axios.post(
            `${UIC}/passport/general/auth.json?kdt_id=${KDT_ID}&app_id=${MINI_APP_ID}`,
            body,
            { headers: this.headers(), timeout: 20000, validateStatus: () => true }
        );
        if (!isOk(data) || !(data.data || {}).accessToken) {
            if (isNotMember(data)) {
                this.unregistered = true;
                throw new Error("NO_ACCOUNT:登录未注册");
            }
            throw new Error(`有赞登录失败: ${msgOf(data)}`);
        }
        const d = data.data;
        this.cred = {
            accessToken: d.accessToken,
            sid: d.sessionId || "",
            kdtId: String(d.kdtId || KDT_ID),
        };
        const cache = readCache();
        cache[this.account.openid] = { ...this.cred, updatedAt: new Date().toISOString() };
        writeCache(cache);
        this.log(`登录成功（店铺 kdtId=${this.cred.kdtId}${d.nickname ? `，${d.nickname}` : ""}）`);
    }

    async h5Get(apiPath, params = {}) {
        const q = new URLSearchParams({
            store_id: "",
            app_id: MINI_APP_ID,
            kdt_id: this.kdt,
            access_token: this.cred.accessToken,
            appId: MINI_APP_ID,
            kdtId: this.kdt,
            ...params,
        }).toString();
        const { data } = await axios.get(`${H5}${apiPath}?${q}`, {
            headers: this.headers(),
            timeout: 15000,
            validateStatus: () => true,
        });
        return data;
    }

    async checkSession() {
        try {
            const res = await this.h5Get("/wscaccount/api/authorize/data.json");
            return isOk(res);
        } catch (e) {
            return false;
        }
    }

    async ensureLogin() {
        const cached = readCache()[this.account.openid];
        if (!this.cred && cached && cached.accessToken) {
            this.cred = { accessToken: cached.accessToken, sid: cached.sid, kdtId: cached.kdtId };
            if (await this.checkSession()) {
                this.log("使用缓存ck");
                return;
            }
            this.log("缓存ck失效，重新登录");
            this.cred = null;
        }
        if (!this.cred) await this.login();
    }

    // 优先取实时 checkinId（防活动 id 轮换），失败回落到硬编码
    async resolveCheckinId() {
        try {
            const info = await this.h5Get("/wscump/checkin/check-in-info.json");
            if (isOk(info)) {
                const d = info.data || {};
                const cid = d.checkInId || d.checkinId || d.check_in_id || "";
                if (cid) return String(cid);
            } else if (isNotMember(info)) {
                this.notMember = true;
            }
        } catch (e) {}
        return CHECKIN_ID;
    }

    async sign() {
        const checkinId = await this.resolveCheckinId();
        if (this.notMember) {
            return this.log("⚠️ 该微信号还没在袋鼠妈妈注册会员（有赞签到要先注册），请在小程序里注册一次再跑");
        }
        if (!checkinId) {
            this.log("⚠️ 未取到 checkinId，只登录不签到");
            return;
        }

        // 预查签到状态，避免重复请求
        try {
            const act = await this.h5Get("/wscump/checkin/get_activity_by_yzuid_v2.json", { checkinId });
            if (isOk(act) && (act.data || {}).isCheckin) {
                return this.log(`✅ 今日已签到，连续 ${(act.data || {}).continuesDay ?? "?"} 天`);
            }
            if (isNotMember(act)) {
                return this.log("⚠️ 该微信号还没在袋鼠妈妈注册会员（有赞签到要先注册），请在小程序里注册一次再跑");
            }
        } catch (e) {}

        const res = await this.h5Get("/wscump/checkin/checkinV2.json", { checkinId });
        if (isOk(res)) {
            const d = res.data || {};
            if (d.success === false) {
                if (isAlreadyDone(d.desc)) return this.log(`✅ 今日已签到（${d.desc}）`);
                if (/手机号未授权|未授权手机|请先授权|未注册|未绑定|绑定手机/.test(String(d.desc || ""))) {
                    return this.log(`⚠️ 该微信号还没在袋鼠妈妈(有赞)授权手机号/注册会员（${d.desc}），先在小程序里授权登录一次再跑`);
                }
                return this.log(`❌ 签到失败: ${d.desc || msgOf(res)}`);
            }
            const award = (d.list || [])
                .map((x) => x?.infos?.title || x?.infos?.desc || "")
                .filter(Boolean)
                .join(", ");
            return this.log(`✅ 签到成功${award ? `: ${award}` : ""}${d.desc ? `（${d.desc}）` : ""}`);
        }
        if (isAlreadyDone(msgOf(res))) return this.log(`✅ 今日已签到（${msgOf(res)}）`);
        if (isNotMember(res)) {
            return this.log("⚠️ 该微信号还没在袋鼠妈妈注册会员（有赞签到要先注册），请在小程序里注册一次再跑");
        }
        if (/手机号未授权|未授权手机|请先授权|未注册|未绑定|绑定手机/.test(String(msgOf(res)))) {
            return this.log(`⚠️ 该微信号还没在袋鼠妈妈(有赞)授权手机号/注册会员（${msgOf(res)}），先在小程序里授权登录一次再跑`);
        }
        this.log(`❌ 签到失败: ${msgOf(res)}`);
    }

    async run() {
        if (!this.account.openid) {
            this.log("跳过：变量值里没有 openid");
            return;
        }
        try {
            await this.ensureLogin();
            await this.sign();
        } catch (e) {
            if (String(e.message).startsWith("NO_ACCOUNT")) {
                this.log("⚠️ 该微信号还没在袋鼠妈妈注册会员（有赞登录未激活），请在小程序里登录注册一次再跑");
                return;
            }
            this.log(`执行失败: ${e.message || e}`);
        }
    }
}

!(async () => {
    await $.checkEnv(ckName);
    if (!$.userCount) {
        $.log(`未找到变量 ${ckName}`);
        return;
    }
    for (let i = 0; i < $.userList.length; i++) {
        await new Task($.userList[i]).run();
        if (i < $.userList.length - 1) await $.wait(1500, 3000);
    }
})()
    .catch((e) => $.log(e.message || e))
    .finally(() => $.done());
