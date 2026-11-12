// name: ykb_huiyuan统一签到
/*
------------------------------------------
@Author: sm
@Date: 2026.06.05
@Description: ykb_huiyuan 小程序统一登录查询签到
cron: 45 8 * * *
------------------------------------------


------------------------------------------
 YYB-Go 版：取码改走 YYB-Go（POST /wxapp/getCode），不再依赖原取码桥接服务。
 变量：YYB_SERVER 每行 地址@账号标识（例如 http://yyb-go:8000@1）；YYB_API_KEY 可选。
 原桥接版脚本见 wxapp/ykb_all.js，业务接口、流程与缓存格式均未改动。
*/

// ==== 内联：Env 运行环境 + 青龙通知（原 ./env.js + ./ql-notify.js，30 秒超时保护与完成判定）====
const { Env } = (() => {
/*
------------------------------------------
 青龙通知助手（共享模块）
------------------------------------------
 统一加载青龙 sendNotify.js：候选路径依次尝试，加载结果模块级缓存。
 调用层带 30 秒超时保护（通道卡住不拖死任务），并输出明确的完成判定：
   ✅ 青龙通知调用完成（模块：xxx）
   ⚠️ 青龙通知未完成（不影响任务结果）：原因
 可用 QL_NOTIFY_TIMEOUT_MS 调整超时（默认 30000，设 0 关闭超时保护）。
------------------------------------------
*/
const fs = require("fs");
const path = require("path");

const NOTIFY_TIMEOUT_MS = Math.max(0, Number(process.env.QL_NOTIFY_TIMEOUT_MS || 30000));

const CANDIDATES = [
    "/ql/data/scripts/sendNotify.js",
    "/ql/data/sendNotify.js",
    path.join(__dirname, "sendNotify.js"),
    path.join(__dirname, "..", "sendNotify.js"),
    path.join(process.cwd(), "sendNotify.js"),
];

let cached = null; // { sender, modulePath }

function isQingLong() {
    if (process.env.QL_DIR) return true;
    try {
        return fs.existsSync("/ql/data");
    } catch (e) {
        return false;
    }
}

/** 逐候选路径加载 sendNotify，成功后缓存；失败时给出每个路径的具体原因 */
function loadSendNotify() {
    if (cached) return cached;
    const failures = [];
    for (const candidate of CANDIDATES) {
        if (!fs.existsSync(candidate)) {
            failures.push(`${candidate}: 文件不存在`);
            continue;
        }
        try {
            const mod = require(candidate);
            const sender =
                typeof mod === "function"
                    ? mod
                    : mod && (typeof mod.sendNotify === "function" ? mod.sendNotify : typeof mod.send === "function" ? mod.send : null);
            if (typeof sender !== "function") {
                failures.push(`${candidate}: 模块内无 sendNotify/send 函数`);
                continue;
            }
            cached = { sender, modulePath: candidate };
            return cached;
        } catch (e) {
            failures.push(`${candidate}: 加载失败 ${e.code || ""} ${e.message || e}`.trim());
        }
    }
    if (isQingLong()) {
        console.log(`⚠️ 未找到青龙 sendNotify 模块：${failures.join("；")}`);
    } else {
        const loadErrors = failures.filter((f) => !f.includes("文件不存在"));
        if (loadErrors.length) {
            // 文件存在但加载失败（如缺依赖）：如实打印原因，方便排查
            console.log(`⚠️ sendNotify 模块加载失败：${loadErrors.join("；")}`);
        } else {
            console.log("ℹ️ 当前非青龙环境且本地无 sendNotify.js，跳过青龙推送");
        }
    }
    return null;
}

function withTimeout(promise, ms) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`调用超过 ${Math.round(ms / 1000)} 秒未完成（超时）`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * 推送青龙通知。返回 { ok, modulePath?, reason? }，ok 表示「通知调用是否正常完成」。
 * 青龙 sendNotify 内部会吞掉各推送渠道自身的异常，脚本侧只能拿到调用层结果。
 */
async function sendQlNotify(title, content) {
    const found = loadSendNotify();
    if (!found) return { ok: false, reason: "MODULE_NOT_FOUND" };
    // async 包装：sender 同步抛错也会变成 rejected promise，统一走超时竞速
    const call = (async () => found.sender(title, content))();
    try {
        if (NOTIFY_TIMEOUT_MS > 0) {
            await withTimeout(call, NOTIFY_TIMEOUT_MS);
        } else {
            await call;
        }
        console.log(`✅ 青龙通知调用完成（模块：${found.modulePath}）`);
        return { ok: true, modulePath: found.modulePath };
    } catch (e) {
        console.log(`⚠️ 青龙通知未完成（不影响任务结果）：${e.message || e}`);
        return { ok: false, reason: e.message || String(e) };
    }
}

// prettier-ignore
// new/ 目录自治版 Env：与 tools/env.js 唯一差异是 sendMsg() —— 改用 ./ql-notify.js
// 统一推送（候选路径 + 30 秒超时保护 + 明确的完成判定），其余逻辑保持一致。
function Env(t, s) {
    return new (class {
        constructor(t, s) {
            this.userIdx = 1;
            this.userList = [];
            this.userCount = 0;
            this.name = t;
            this.notifyStr = [];
            this.logSeparator = "\n";
            this.startTime = new Date().getTime();
            Object.assign(this, s);
            this.log(`\ud83d\udd14${this.name},\u5f00\u59cb!`);
            this.bucket = this.bucket || ''
            this.fs = require("fs");
            if (this.isNode() && this.bucket) {
                try {
                    // bucket 为纯文件名时统一归入脚本目录的 tokencache/，避免散落在进程 cwd
                    const nodePath = require("path");
                    if (!nodePath.isAbsolute(this.bucket) && !/[/\\]/.test(this.bucket)) {
                        this.bucket = nodePath.join(__dirname, "tokencache", this.bucket);
                    }
                    const bucketDir = nodePath.dirname(this.bucket);
                    if (!this.fs.existsSync(bucketDir)) {
                        this.fs.mkdirSync(bucketDir, { recursive: true });
                    }
                    if (!this.fs.existsSync(this.bucket)) {
                        this.fs.writeFileSync(this.bucket, JSON.stringify({}, null, 2));
                        this.log(`📁 已创建 bucket 文件: ${this.bucket}`);
                    }
                } catch (e) {
                    this.log("❌ 初始化 bucket 失败: " + e.message);
                }
            }
        }
        async get(key, def = null) {
            if (!this.isNode()) return def;
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
            if (!this.isNode()) return;
            try {
                const data = await this.fs.promises.readFile(this.bucket, "utf-8");
                const json = JSON.parse(data);
                json[key] = value;
                await this.fs.promises.writeFile(this.bucket, JSON.stringify(json, null, 2));
            } catch (e) {
                this.log("❌ 写入bucket失败: " + e.message);
            }
        }
        checkEnv(ckName) {
            const envSplitor = ["&", "\n"];
            let userCookie = (this.isNode() ? process.env[ckName] : "") || "";
            this.userList = userCookie.split(envSplitor.find((o) => userCookie.includes(o)) || "&").filter((n) => n);
            this.userCount = this.userList.length;
            this.log(`共找到${this.userCount}个账号`);
        }
        toStr(v) {
            if (v instanceof Error) return v.stack || v.message;
            if (v && typeof v == "object") try { return JSON.stringify(v) } catch { return "[Complex Object]" }
            return String(v);
        }
        async sendMsg() {
            this.log("==============📣Center 通知📣==============")
            let message = this.notifyStr.join(this.logSeparator);
            if (this.isNode()) {
                if (!message || !message.trim()) {
                    console.log("⚠️ 无通知内容，跳过青龙推送");
                    return;
                }
                const result = await sendQlNotify(this.name, message);
                if (!result.ok) {
                    console.log("⚠️ 青龙通知未完成（不影响任务结果），请检查上方失败原因");
                }
            }
        }
        isNode() {
            return "undefined" != typeof module && !!module.exports;
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
            try {
                return JSON.parse(str) && typeof JSON.parse(str) === "object";
            } catch (e) {
                return false;
            }
        }
        isJson(obj) {
            var isjson =
                typeof obj == "object" &&
                Object.prototype.toString.call(obj).toLowerCase() ==
                "[object object]" &&
                !obj.length;
            return isjson;
        }

        randomNumber(length) {
            const characters = "0123456789";
            return Array.from(
                { length },
                () => characters[Math.floor(Math.random() * characters.length)]
            ).join("");
        }
        randomString(length) {
            const characters = "abcdefghijklmnopqrstuvwxyz0123456789";
            return Array.from(
                { length },
                () => characters[Math.floor(Math.random() * characters.length)]
            ).join("");
        }
        uuid() {
            return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(
                /[xy]/g,
                function (c) {
                    var r = (Math.random() * 16) | 0,
                        v = (c == "x" ? r : (r & 0x3) | 0x8) | 0;
                    return v.toString(16);
                }
            );
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
            /(y+)/.test(t) &&
                (t = t.replace(
                    RegExp.$1,
                    (new Date().getFullYear() + "").substr(4 - RegExp.$1.length)
                ));
            for (let e in s) {
                new RegExp("(" + e + ")").test(t) &&
                    (t = t.replace(
                        RegExp.$1,
                        1 == RegExp.$1.length
                            ? s[e]
                            : ("00" + s[e]).substr(("" + s[e]).length)
                    ));
            }
            return t;
        }

        log(content) {
            this.notifyStr.push(`[${this.time("HH:mm:ss")}]` + " " + this.toStr(content))
            console.log(content)
        }

        wait(min, max = null) {
            const ms = max == null ? min : Math.random() * (max - min + 1) + min | 0;
            ms >= 1000 && this.log(`等待 ${(ms / 1000).toFixed(2)} 秒...`, { notify: false });
            return new Promise(r => setTimeout(r, ms));
        }
        async done() {
            await this.sendMsg();
            const s = new Date().getTime(),
                e = (s - this.startTime) / 1e3;
            this.log(
                `\ud83d\udd14${this.name},\u7ed3\u675f!\ud83d\udd5b ${e}\u79d2`
            );
            if (this.isNode()) {
                process.exit(0);
            }
        }
        parseCookie(ck) {
            return typeof ck != "string" || !ck ? {} : Object.fromEntries(
                ck.split(/;\s*/).filter(v => v.includes("=")).map(v => [v.slice(0, v.indexOf("=")), v.slice(v.indexOf("=") + 1)])
            );
        }

    })(t, s);
}
return { Env };
})();
const $ = new Env("ykb_huiyuan统一签到");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
// ==== 内联：YYB 取码客户端（原 ./yyb.js，含微信协议接口 2 秒节流）====
const { YYBClient, yybAccounts } = (() => {
/*
------------------------------------------
 YYB-Go 取码客户端（共享模块）
------------------------------------------
 本仓库 wxapp/ 下的脚本原先通过 wxapp/wcs.js 调用 smallcat 桥接服务
 （wx_server_url + wx_auth，POST /wx/code）。本模块把这层换成 YYB-Go：
 直接取 wx.login code，其余业务逻辑（登录、签到、查询）保持原样。

 环境变量：
   YYB_SERVER    每行：地址@账号标识，例如
                 http://yyb-go:8000@1
                 http://yyb-go:8000@oX1y2z...    （ref 支持账号数字 ID 或 OpenID）
   YYB_API_KEY   可选；yyb-go 配置了 YYB_PROTOCOL_TOKEN 时填同一令牌
   YYB_TIMEOUT   可选；单次请求超时毫秒数，默认 30000
   YYB_CODE_DELAY_MS  可选；每次取码（调 wx.login）前的延时基准毫秒数，实际等待
                      该基准的 0.75~1.5 倍随机（默认 60000 → 等 45~90 秒），设 0 关闭

 接口（YYB-Go Enhanced，见 docs/protocol-api.md）：
   POST {server}/wxapp/getCode        {"ref","app_id"} -> data.result.code
   POST {server}/wxapp/getPhoneNumber {"ref","app_id"} 手机号授权包（真实 code 决定结果）
   GET  {server}/wx/getuserinfo       ref=账号标识，读 YYB 已保存的账号资料
   POST {server}/wxapp/operateWxData  {"ref","app_id","payload"} 完整协议 payload 转发
   POST {server}/wx/encryptkey        {"ref","app_id","payload"} 加密能力转发
   POST {server}/wx/cloud             {"ref","app_id","payload"} 云函数转发

 约定：
   · 同一个账号的取码由 YYB-Go 串行化，脚本侧不需要再手动 /wx/refresh。
   · 每次取码前先等 YYB_CODE_DELAY_MS 的 0.75~1.5 倍随机（默认 45~90 秒），避免密集取码。
   · wx.login code 短期且一次性，一次调用只取一个 code，失败即抛错（不重放业务请求）。
   · 统一响应信封 {code:0,msg,data}；code!=0 或 HTTP!=200 都按失败处理。
------------------------------------------
*/

const axios = require("axios");

const REQUEST_TIMEOUT = Number(process.env.YYB_TIMEOUT || 0) || 30000;

// ---------------------------------------------------------------------------
// 微信协议接口节流：与上一次微信协议接口调用至少间隔 2 秒，避免调用过频触发风控/封号。
// 覆盖 getCode / getPhoneNumber / operateWxData / encryptkey / cloud 这五类真正走
// 微信协议的接口；/wx/getuserinfo 读的是 YYB 本地账号资料，不受限。
// 需要更宽松的间隔时可设 YYB_WX_MIN_INTERVAL_MS（默认 2000）。
// ---------------------------------------------------------------------------
const WX_API_MIN_INTERVAL_MS = Math.max(0, Number(process.env.YYB_WX_MIN_INTERVAL_MS || 2000));
const WX_API_PATHS = new Set([
    "/wxapp/getCode",
    "/wxapp/getPhoneNumber",
    "/wxapp/operateWxData",
    "/wx/encryptkey",
    "/wx/cloud",
]);
let lastWxApiCallAt = 0;

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function throttleWxApi() {
    if (!(WX_API_MIN_INTERVAL_MS > 0)) return;
    const wait = lastWxApiCallAt + WX_API_MIN_INTERVAL_MS - Date.now();
    if (wait > 0) {
        console.log(`⏳ 微信协议接口节流，等待 ${(wait / 1000).toFixed(1)} 秒`);
        await sleep(wait);
    }
    lastWxApiCallAt = Date.now();
}
// 取码前延时：基准 YYB_CODE_DELAY_MS（默认 1 分钟），实际等基准的 0.75~1.5 倍随机（默认 45~90 秒）。
// 抖动是必要的：多个脚本常被同一波次拉起，固定延时会让它们在同一秒向同一账号取码；设 0 关闭。
const CODE_DELAY_BASE_MS = Number(process.env.YYB_CODE_DELAY_MS || 60000);
const CODE_DELAY_MIN_RATIO = 0.75;
const CODE_DELAY_MAX_RATIO = 1.5;

/** 调 wx.login 取码前的延时（基准 + 随机抖动）；实际等待时长打进日志，免得看起来像卡死 */
async function waitBeforeGetCode() {
    if (!(CODE_DELAY_BASE_MS > 0)) return;
    const ratio = CODE_DELAY_MIN_RATIO + Math.random() * (CODE_DELAY_MAX_RATIO - CODE_DELAY_MIN_RATIO);
    const ms = Math.round(CODE_DELAY_BASE_MS * ratio);
    console.log(`⏳ 取码前等待 ${(ms / 1000).toFixed(1)} 秒（调用 wx.login 前延时 + 随机抖动）`);
    await new Promise((resolve) => setTimeout(resolve, ms));
}

function short(value, max = 200) {
    if (value === undefined || value === null) return "";
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return !text ? "" : text.length > max ? `${text.slice(0, max)}...` : text;
}

/** 日志里只显示账号标识的前后几位，避免整串 openid 落到通知里 */
function maskRef(ref) {
    const text = String(ref || "");
    return text.length <= 12 ? text : `${text.slice(0, 6)}...${text.slice(-4)}`;
}

/**
 * 解析 YYB_SERVER（每行：地址@账号标识），返回 [{server, ref, label}]。
 * 这里严格按 YYB-Go 的约定校验，避免把账号标识当成服务地址（jyk.py 那类老问题）。
 */
function yybRoutes() {
    const routes = [];
    String(process.env.YYB_SERVER || "")
        .split(/\r?\n/)
        .forEach((raw, lineno) => {
            const line = raw.trim();
            if (!line) return;
            const at = line.lastIndexOf("@");
            if (at < 0) throw new Error(`YYB_SERVER 第 ${lineno + 1} 行格式错误，应为 地址@账号标识`);
            let server = line.slice(0, at).trim().replace(/\/+$/, "");
            const ref = line.slice(at + 1).trim();
            if (!server || !ref) throw new Error(`YYB_SERVER 第 ${lineno + 1} 行格式错误，应为 地址@账号标识`);
            if (!/^https?:\/\//i.test(server)) server = "http://" + server;
            routes.push({ server, ref, label: maskRef(ref) });
        });
    if (!routes.length) throw new Error("未配置 YYB_SERVER（每行：地址@账号标识）");
    return routes;
}

/** 账号标识（ref）列表，供脚本主循环直接当账号串用：for (const openid of yybAccounts()) */
function yybAccounts() {
    return yybRoutes().map((route) => route.ref);
}

class YYBClient {
    /**
     * @param {{appid?: string}} options appid 为目标小程序 AppID；
     *        多小程序脚本可以在取码前用 withAppId() 切换。
     */
    constructor(options = {}) {
        this.appid = options.appid || "";
        this.apiKey = String(process.env.YYB_API_KEY || "").trim();
        this._routes = null;
    }

    /** 懒解析 YYB_SERVER：构造时不抛错，方便脚本先输出提示再退出 */
    get routes() {
        if (!this._routes) this._routes = yybRoutes();
        return this._routes;
    }

    withAppId(appid) {
        this.appid = appid || "";
        return this;
    }

    /** 按账号标识定位服务地址；只有一个账号时允许用任意标识兜底 */
    routeOf(ref) {
        const key = String(ref === undefined || ref === null ? "" : ref).trim();
        const base = key.split("#")[0];
        // 兼容 ref#附加参数（例如 openid#appid#kdtId）这种写法：按 # 前一段匹配
        const hit = this.routes.find((route) => route.ref === key) || (base ? this.routes.find((route) => route.ref === base) : null);
        if (hit) return hit;
        if (this.routes.length === 1) return this.routes[0];
        throw new Error(`YYB_SERVER 中没有账号标识 ${key || "(空)"}`);
    }

    async call(route, method, apiPath, payload) {
        if (WX_API_PATHS.has(apiPath)) await throttleWxApi();
        const headers = { "Content-Type": "application/json" };
        if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
        const options = {
            method,
            url: `${route.server}${apiPath}`,
            headers,
            timeout: REQUEST_TIMEOUT,
            validateStatus: () => true,
        };
        if (method === "GET") options.params = payload || {};
        else options.data = payload || {};

        let response;
        try {
            response = await axios.request(options);
        } catch (e) {
            throw new Error(`YYB ${apiPath} 请求失败：${e.message || e}`);
        }
        const body = response.data;
        if (response.status !== 200) {
            throw new Error(`YYB ${apiPath} HTTP ${response.status}：${short(body)}`);
        }
        if (!body || typeof body !== "object") {
            throw new Error(`YYB ${apiPath} 返回非 JSON：${short(body)}`);
        }
        if (Number(body.code) !== 0) {
            throw new Error(`YYB ${apiPath} 失败：${body.msg || body.message || short(body)}`);
        }
        return body;
    }

    /** 取 wx.login code，返回 code 字符串；失败直接抛错 */
    async getCode(ref, appid) {
        await waitBeforeGetCode();
        const route = this.routeOf(ref);
        const body = await this.call(route, "POST", "/wxapp/getCode", {
            ref: route.ref,
            app_id: appid || this.appid,
        });
        const data = body.data || {};
        const result = data.result === undefined ? body.result : data.result;
        const code = typeof result === "string" ? result : (result || {}).code;
        const value = code || data.code || "";
        if (!value || typeof value !== "string") {
            throw new Error(`YYB 未返回 wx.login code：${short(body)}`);
        }
        return value;
    }

    /** 手机号能力结果；能否返回真实授权包取决于账号与目标小程序，不做任何伪造 */
    async getPhoneNumber(ref, appid) {
        const route = this.routeOf(ref);
        const body = await this.call(route, "POST", "/wxapp/getPhoneNumber", {
            ref: route.ref,
            app_id: appid || this.appid,
        });
        return body.data || body;
    }

    /** YYB 已保存的账号资料（备注、昵称等），用于日志展示 */
    async getAccountInfo(ref) {
        const route = this.routeOf(ref);
        const body = await this.call(route, "GET", "/wx/getuserinfo", { ref: route.ref });
        return body.data || body;
    }

    /** 完整 operateWxData 转发，payload 必须来自真实小程序请求 */
    async operateWxData(ref, payload, appid) {
        const route = this.routeOf(ref);
        const body = await this.call(route, "POST", "/wxapp/operateWxData", {
            ref: route.ref,
            app_id: appid || this.appid,
            payload,
        });
        return body.data || body;
    }

    async encryptKey(ref, payload, appid) {
        const route = this.routeOf(ref);
        const body = await this.call(route, "POST", "/wx/encryptkey", {
            ref: route.ref,
            app_id: appid || this.appid,
            payload,
        });
        return body.data || body;
    }

    async cloud(ref, payload, appid) {
        const route = this.routeOf(ref);
        const body = await this.call(route, "POST", "/wx/cloud", {
            ref: route.ref,
            app_id: appid || this.appid,
            payload,
        });
        return body.data || body;
    }
}

return { YYBClient, yybRoutes, yybAccounts, maskRef, short };
})();

const CK_NAME = "ykb_all";
const API_BASE = "https://pw.gzych.vip";
const TOKEN_CACHE_FILE = path.join(__dirname, "tokencache", "ykb_all_token_cache.json");
const USER_AGENT =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) MicroMessenger/3.9.12 MiniProgramEnv/Windows WindowsWechat/WMPF";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const APPS = [
    { ck: "ayldf", name: "爱游乐东方", appid: "wxf133aa0a4f191ffc", templateVersion: "game_2.32.0" },
    { ck: "ayljz", name: "爱游乐胶州", appid: "wx52005ba8c71a756a", templateVersion: "game_2.32.0" },
    { ck: "aylpld", name: "爱游乐蓬莱店", appid: "wxb4afba83d5ceadae", templateVersion: "game_2.31.0" },
    { ck: "bbwjtqzylzx", name: "宝贝王家庭亲子娱乐中心", appid: "wx61935615c3edb2d0", templateVersion: "game_2.24.3" },
    { ck: "bbwcqncly", name: "宝贝王重庆南川乐园", appid: "wx8fef16e51ca130db", templateVersion: "game_2.15.1" },
    { ck: "bbwhhxp", name: "宝贝王怀化溆浦店", appid: "wxbb9a887cca8663c2", templateVersion: "game_2.30.4" },
    { ck: "cwkjjtyl", name: "超玩空间家庭娱乐", appid: "wx1c59744a3a6ffef8", templateVersion: "game_2.30.4" },
    { ck: "dewbl", name: "第e玩+宝龙店", appid: "wx88fd603ba1ae66a2", templateVersion: "game_2.33.7" },
    { ck: "dlbfhx", name: "大连缤纷幻想", appid: "wx78b4c1140cefdcb0", templateVersion: "game_2.30.1" },
    { ck: "ddmxly", name: "迪迪冒险乐园", appid: "wxcd4a69c8c70a5419", templateVersion: "game_2.15.1" },
    { ck: "ddmxlyjzd", name: "迪迪冒险乐园玖洲道店", appid: "wx70dceb5a4f6daa56", templateVersion: "game_2.15.1" },
    { ck: "dqjtyl", name: "豆趣家庭娱乐中心", appid: "wxc9a77835500632bc", templateVersion: "game_2.23.3" },
    { ck: "fcgxmcws", name: "防城港星梦潮玩社", appid: "wx6683f77a42e1595e", templateVersion: "game_2.30.4" },
    { ck: "fckwjnhdmly", name: "丰城市酷玩嘉年华动漫乐园", appid: "wxb8739c52e9702339", templateVersion: "game_2.20.6" },
    { ck: "fmwg", name: "飞马王国", appid: "wx9703d60d09a566e7", templateVersion: "game_2.15.1" },
    { ck: "fxjnh", name: "纷享X嘉年华", appid: "wxcdbcf18be89c4d47", templateVersion: "game_2.15.1" },
    { ck: "hblytx", name: "湖北乐游天下", appid: "wxf65bcc2eb8c4eeff", templateVersion: "game_2.16.1" },
    { ck: "hlsglc", name: "欢乐拾光乐昌店", appid: "wx5f972a9b4cd13634", templateVersion: "game_2.24.6" },
    { ck: "jddzdtw", name: "机动地带电玩城", appid: "wx0e5c8715d36d15e6", templateVersion: "game_2.30.4" },
    { ck: "jqdw", name: "鲸奇电玩中心", appid: "wxa6dc5cc49b137460", templateVersion: "game_2.30.1" },
    { ck: "jsdwj", name: "九顺大玩家", appid: "wxf99906d27f33fc1d", templateVersion: "game_2.30.2" },
    { ck: "kwkjshhqg", name: "酷玩空间上海环球港店", appid: "wxb08bbd1dd73a27ab", templateVersion: "game_2.32.0" },
    { ck: "kwkjshsjh", name: "酷玩空间上海世纪汇店", appid: "wxd1ca01877cfd33eb", templateVersion: "game_2.33.3" },
    { ck: "kwxqjbel", name: "酷玩猩球金宝二楼店", appid: "wx405ee9e38f6a2038", templateVersion: "game_2.30.2" },
    { ck: "kwxqjbsl", name: "酷玩猩球金宝三楼店", appid: "wxf79a0dc11791d955", templateVersion: "game_2.30.4" },
    { ck: "lmrjxdqxg", name: "蓝梦日记炫动柒栖谷店", appid: "wxa23df268c16943d7", templateVersion: "game_2.33.5" },
    { ck: "lqclnd", name: "乐其城柳南店", appid: "wx25a19136c041f337", templateVersion: "game_2.33.7" },
    { ck: "lqcwgcd", name: "乐其潮玩广场店", appid: "wx1f4ee737668cf5a1", templateVersion: "game_2.33.7" },
    { ck: "lqcwyl", name: "乐其潮玩玉林店", appid: "wxf0e4c545914bd807", templateVersion: "game_2.33.7" },
    { ck: "lzsczqcjl", name: "柳州市城中区超级乐", appid: "wxd4521567cc4b39c0", templateVersion: "game_2.33.7" },
    { ck: "mhdcwdw", name: "梦幻岛潮玩电玩", appid: "wx226c9fbd60679a74", templateVersion: "game_2.15.1" },
    { ck: "mhelhyzhd", name: "萌孩儿乐园海洋振华店", appid: "wx420705aa0369e3f9", templateVersion: "game_2.28.0" },
    { ck: "mqyyc", name: "米其游艺城", appid: "wx0ce00dae4a87ad54", templateVersion: "game_2.30.1" },
    { ck: "mcyxcw", name: "麻涌嬉游潮玩家庭娱乐中心", appid: "wx4d303dc69f029e4e", templateVersion: "game_2.30.2" },
    { ck: "mydyl", name: "梦游岛娱乐", appid: "wxb7ad7be346c73a5e", templateVersion: "game_2.30.4" },
    { ck: "phtkzcwy", name: "平湖天空之城吾悦", appid: "wx387274288d2dcbc2", templateVersion: "game_2.15.1" },
    { ck: "ppxjtczly", name: "派派星家庭成长乐园", appid: "wxce55874aeb73adc2", templateVersion: "game_2.30.4" },
    { ck: "qqyydmly", name: "奇奇游艺动漫乐园", appid: "wx17446921ce05b350", templateVersion: "game_2.24.5" },
    { ck: "qqyyly", name: "奇奇游艺乐园", appid: "wx1cb50cac06c8f487", templateVersion: "game_2.30.1" },
    { ck: "rdsgdlhq", name: "热带时光大沥黄岐店", appid: "wxb1993ab85850dc69", templateVersion: "game_2.30.4" },
    { ck: "rdsghp", name: "热带时光黄埔店", appid: "wxa5ad3ec98ea33db0", templateVersion: "game_2.30.1" },
    { ck: "rdsgsz", name: "热带时光家庭娱乐中心深圳店", appid: "wxc6b29b0eaf5331b8", templateVersion: "game_2.27.0" },
    { ck: "sgcwly", name: "拾光潮玩乐园", appid: "wxbffd1cdbe3f11d33", templateVersion: "game_2.23.3" },
    { ck: "sgsscw", name: "拾光松鼠潮玩店", appid: "wx2823161452551c9e", templateVersion: "game_2.29.3" },
    { ck: "tdxly", name: "泰迪熊乐园", appid: "wx5cfc933a4a2a93f4", templateVersion: "game_2.30.2" },
    { ck: "topwjycccpark", name: "TOP玩家 银川cc park店", appid: "wxc86c913d8d9a4ab4", templateVersion: "game_2.15.1" },
    { ck: "wjfb", name: "玩家风暴", appid: "wx27625bb2d9a8384e", templateVersion: "game_2.15.1" },
    { ck: "xjddw", name: "X机地电玩", appid: "wx1652d4e11cc0a1c2", templateVersion: "game_2.23.3" },
    { ck: "xcdwhtgcd", name: "猩潮电玩恒天广场店", appid: "wx2ad6d80d65b237af", templateVersion: "game_2.19.3" },
    { ck: "xnhhwdbbw", name: "西宁海湖万达宝贝王", appid: "wx7a3335dc207999f3", templateVersion: "game_2.27.0" },
    { ck: "xqlddylc", name: "享区乐到底游乐场", appid: "wx070d007b211099d9", templateVersion: "game_2.24.5" },
    { ck: "ybxwcw", name: "月伴星玩潮玩店", appid: "wxb5e0812b9a0ccc8c", templateVersion: "game_2.30.4" },
    { ck: "ykb", name: "太空橙电玩城", appid: "wxcd8a2d92245ee75b", templateVersion: "game_2.30.4" },
    { ck: "ylsyzqqjwlc", name: "玉林市玉州区奇迹未来城潮漫电玩", appid: "wx4e02b4d9520d6df1", templateVersion: "game_2.28.0" },
    { ck: "ylycmdwd", name: "壹零壹潮漫电玩店", appid: "wx49deb1f94bab5091", templateVersion: "game_2.30.4" },
    { ck: "yyhwqldcw", name: "酉阳红卫桥乐动潮玩", appid: "wx263d7c4bbca7feca", templateVersion: "game_2.30.2" },
    { ck: "zbbbwl", name: "重百宝贝王乐园", appid: "wx9dc5d73cb2d62bdc", templateVersion: "game_2.30.4" },
    { ck: "zjmxwt", name: "终极梦想沃特", appid: "wx733a59c79a4bb702", templateVersion: "game_2.31.0" },
].map((app) => ({
    apiBase: process.env[`${app.ck}_api_base`] || API_BASE,
    wechatVersion: process.env[`${app.ck}_wechat_version`] || "3.9.12",
    mobilePlatform: process.env[`${app.ck}_mobile_platform`] || "windows",
    ...app,
    appid: process.env[`${app.ck}_appid`] || app.appid,
    templateVersion: process.env[`${app.ck}_template_version`] || app.templateVersion,
}));

function splitAccounts(value = "") {
    return String(value)
        .split(/\n|&/)
        .map((item) => item.trim())
        .filter(Boolean);
}

function unique(items = []) {
    return [...new Set(items.map((item) => String(item || "").trim()).filter(Boolean))];
}

function parseUnifiedEnv() {
    const raw = process.env[CK_NAME] || "";
    const result = { global: [], byKey: {} };
    for (const item of splitAccounts(raw)) {
        const idx = item.indexOf("=");
        if (idx === -1) {
            result.global.push(item);
            continue;
        }
        const key = item.slice(0, idx).trim().toLowerCase();
        const value = item.slice(idx + 1).trim();
        if (!key || !value) continue;
        result.byKey[key] = result.byKey[key] || [];
        result.byKey[key].push(value);
    }
    result.global = unique(result.global);
    return result;
}

const unifiedEnv = parseUnifiedEnv();

function getAccounts(app) {
    const keys = [app.ck, app.appid, app.name].map((item) => item.toLowerCase());
    const accounts = yybAccounts();
    if (unifiedEnv.global.length) accounts.push(...unifiedEnv.global);
    for (const key of keys) accounts.push(...(unifiedEnv.byKey[key] || []));
    accounts.push(...splitAccounts(process.env[app.ck] || ""));
    return unique(accounts);
}

function readTokenCache() {
    try {
        if (!fs.existsSync(TOKEN_CACHE_FILE)) return {};
        return JSON.parse(fs.readFileSync(TOKEN_CACHE_FILE, "utf8")) || {};
    } catch {
        return {};
    }
}

function writeTokenCache(cache) {
    try {
        fs.mkdirSync(path.dirname(TOKEN_CACHE_FILE), { recursive: true }); fs.writeFileSync(TOKEN_CACHE_FILE, JSON.stringify(cache, null, 2), "utf8");
    } catch (e) {
        $.log(`写入token缓存失败: ${e.message || e}`);
    }
}

function shortToken(token = "") {
    const value = String(token).replace(/^Token\s+/i, "");
    return value ? `${value.slice(0, 4)}***${value.slice(-4)}` : "";
}

function maskPhone(phone = "") {
    return String(phone).replace(/^(\d{3})\d{4}(\d{4})$/, "$1****$2");
}

function monthRange() {
    const now = new Date();
    const firstDay = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime();
    return {
        BeginDate: firstDay - 15 * 24 * 60 * 60 * 1000,
        EndDate: nextMonth - 1000 + 15 * 24 * 60 * 60 * 1000,
    };
}

function normalizeStatus(status = "") {
    const map = {
        Completed: "Complete",
        Failed: "Fail",
        Going: "Going",
        Complete: "Complete",
        Fail: "Fail",
    };
    return map[status] || status;
}

function rewardText(rewards = []) {
    if (!Array.isArray(rewards) || rewards.length === 0) return "";
    return rewards
        .map((item) => {
            const num = item.Num ?? item.Amount ?? "";
            const name = item.RewardName || item.Name || item.RewardAlias || item.RewardType || "";
            return `${num}${name}`.trim();
        })
        .filter(Boolean)
        .join("、");
}

function firstValue(source = {}, keys = []) {
    for (const key of keys) {
        const value = source?.[key];
        if (value !== undefined && value !== null && value !== "") return value;
    }
    return 0;
}

function isAuthError(e) {
    return /token|登录|授权|非法请求|1500000004/i.test(String(e?.message || e || ""));
}

class Task {
    constructor(app, account, index) {
        this.app = app;
        this.index = index;
        this.account = String(account || "").trim();
        this.token = "";
        this.openId = "";
        this.mallCode = "";
        this.h5Prefix = "";
        this.customerName = "";
        this.summary = {
            appName: app.name,
            account: this.account,
            member: "未查询",
            assets: "未查询",
            sign: "未执行",
        };
        this.yyb = new YYBClient({ appid: app.appid });
    }

    prefix() {
        return `[${this.app.name}][账号${this.index}]`;
    }

    log(message) {
        $.log(`${this.prefix()} ${message}`);
    }

    cacheKey() {
        return `${this.app.appid}:${this.account}`;
    }

    getCachedToken() {
        const cache = readTokenCache();
        return cache[this.cacheKey()] || null;
    }

    saveCachedToken() {
        if (!this.token) return;
        const cache = readTokenCache();
        cache[this.cacheKey()] = {
            token: this.token,
            openId: this.openId,
            mallCode: this.mallCode,
            h5Prefix: this.h5Prefix,
            customerName: this.customerName,
            appid: this.app.appid,
            appName: this.app.name,
            updatedAt: new Date().toISOString(),
        };
        writeTokenCache(cache);
    }

    removeCachedToken() {
        const cache = readTokenCache();
        delete cache[this.cacheKey()];
        writeTokenCache(cache);
        this.token = "";
    }

    applyToken(data = {}) {
        this.token = data.token || data.Token || "";
        this.openId = data.openId || data.OpenId || "";
        this.mallCode = data.mallCode || data.MallCode || "";
        this.h5Prefix = data.h5Prefix || data.RoterPrefix || "";
        this.customerName = data.customerName || data.CustomerName || "";
    }

    headers(extra = {}) {
        const headers = {
            "User-Agent": USER_AGENT,
            "Referer": `https://servicewechat.com/${this.app.appid}/1/page-frame.html`,
            "Accept": "application/json, text/plain, */*",
            "content-type": "application/json",
            ...extra,
        };
        if (this.token) headers.Authorization = this.token;
        return headers;
    }

    async request({ method = "GET", apiPath, params = {}, data = {}, skipToken = false }) {
        const options = {
            method,
            url: `${this.app.apiBase}${apiPath.startsWith("/") ? apiPath : `/${apiPath}`}`,
            headers: this.headers(),
            timeout: 20000,
            validateStatus: () => true,
        };
        if (skipToken) delete options.headers.Authorization;
        if (method === "GET") options.params = params;
        else options.data = data;

        const { data: result, status } = await axios.request(options);
        if (status !== 200) throw new Error(`HTTP ${status}: ${JSON.stringify(result)}`);

        const responseStatus = result && result.ResponseStatus;
        if (responseStatus) {
            const code = Number(responseStatus.ErrorCode);
            if (code !== 0) {
                const err = new Error(`${responseStatus.Message || JSON.stringify(result)}(${responseStatus.ErrorCode})`);
                err.raw = result;
                throw err;
            }
            return result.Data;
        }

        if (typeof result?.code !== "undefined" && Number(result.code) !== 0 && Number(result.code) !== 200) {
            throw new Error(result.msg || result.message || JSON.stringify(result));
        }
        return result?.Data ?? result?.data ?? result;
    }

    async run() {
        const cached = this.getCachedToken();
        if (cached) {
            this.applyToken(cached);
            this.log(`使用缓存token ${shortToken(this.token)}`);
            if (!(await this.checkToken())) {
                this.removeCachedToken();
                this.log("缓存token失效，重新登录");
            }
        }

        if (!this.token) await this.login();
        if (!this.token) {
            this.summary.sign = "登录失败";
            return this.summary;
        }

        await this.getMemberInfo();
        const done = await this.tryMemberCheckIn();
        if (!done) await this.tryTaskSign();
        return this.summary;
    }

    async checkToken() {
        try {
            await this.request({ apiPath: "/ykb_huiyuan/api/v1/MemberMine/Info" });
            return true;
        } catch {
            return false;
        }
    }

    async getLoginCode() {
        // 本脚本一次会遍历几十家门店，每店取一次 code，很容易撞上 YYB-Go 的取码频率窗口。
        // 只在「服务端明确没给出 code」时退避重试，避免整轮门店从中途开始全军覆没。
        const waits = [0, 45000, 90000];
        let last = null;
        for (let i = 0; i < waits.length; i++) {
            if (waits[i]) {
                this.log(`取code被限流，等待${waits[i] / 1000}秒后重试(${i}/${waits.length - 1})`);
                await sleep(waits[i]);
            }
            // YYB-Go：POST /wxapp/getCode（失败按原退避窗口重试）
            try {
                return await this.yyb.getCode(this.account);
            } catch (e) {
                last = e.message || e;
            }
        }
        throw new Error(`YYB-Go 未返回 code: ${JSON.stringify(last)}`);
    }

    async login() {
        const loginApis = [
            "/ykb_huiyuan/api/v3/MembeGameLogin/appletLogin",
            "/ykbmini/api/v1/HomeAny/appletLogin",
        ];

        for (const apiPath of loginApis) {
            try {
                const code = await this.getLoginCode();
                const data = await this.request({
                    method: "POST",
                    apiPath,
                    skipToken: true,
                    data: {
                        Code: code,
                        AppId: this.app.appid,
                        WechatVersion: this.app.wechatVersion,
                        MobilePlatform: this.app.mobilePlatform,
                        MallCode: this.mallCode || "",
                        TemplateVersion: this.app.templateVersion,
                        extra: { q: "" },
                    },
                });
                this.applyToken(data);
                if (!this.token) throw new Error(`登录响应无Token: ${JSON.stringify(data)}`);
                this.saveCachedToken();
                this.log(`登录成功(${apiPath}): ${this.customerName || ""} openId=${this.openId || ""}`);
                return;
            } catch (e) {
                this.log(`登录接口 ${apiPath} 失败: ${e.message || e}`);
            }
        }
    }

    async getMemberInfo() {
        try {
            const data = await this.request({ apiPath: "/ykb_huiyuan/api/v1/MemberMine/Info" });
            const name = data?.Name || data?.NickName || this.customerName || "未知";
            const phone = data?.Phone ? ` ${maskPhone(data.Phone)}` : "";
            const assets = await this.getAssets(data);
            this.summary.member = `${name}${phone}`;
            this.summary.assets = `代币=${assets.coin} 金币=${assets.goldCoin} 积分=${assets.integral} 彩票=${assets.ticket} 优惠券=${assets.coupon}`;
            this.log(`会员: ${this.summary.member} ${this.summary.assets}`);
        } catch (e) {
            this.summary.member = `查询失败: ${e.message || e}`;
            this.log(`查询会员信息失败: ${e.message || e}`);
            if (isAuthError(e)) this.removeCachedToken();
        }
    }

    async getAssets(memberInfo = {}) {
        const assets = {
            coin: firstValue(memberInfo, ["MyScrip", "Coin", "CoinAmount", "Scrip", "Balance"]),
            goldCoin: firstValue(memberInfo, ["GoldCoin", "GoldCoinAmount"]),
            integral: firstValue(memberInfo, ["ARTotalIntegral", "Integral", "Exchange", "Points"]),
            ticket: firstValue(memberInfo, ["Ticket", "TicketPackage", "TicketCount", "Lottery"]),
            coupon: firstValue(memberInfo, ["Coupon", "CouponCount"]),
        };

        try {
            const data = await this.request({ apiPath: "/ykb_huiyuan/api/v1/Member/GetMemberStoredValue" });
            const list = [
                ...(Array.isArray(data) ? data : []),
                ...(Array.isArray(data?.List) ? data.List : []),
                ...(Array.isArray(data?.Data) ? data.Data : []),
                ...(Array.isArray(data?.LeaguerValues) ? data.LeaguerValues : []),
                ...(Array.isArray(data?.Data?.LeaguerValues) ? data.Data.LeaguerValues : []),
                ...(Array.isArray(data?.StoredValueList) ? data.StoredValueList : []),
            ];
            const source = Array.isArray(data) ? {} : data || {};
            assets.coin = firstValue(source, ["BalanceNum", "MyScrip", "Coin", "CoinAmount", "Scrip", "Balance", "StoredCoin", "GameCoin"]);
            assets.goldCoin = firstValue(source, ["GoldCoin", "GoldCoinAmount"]);
            assets.integral = firstValue(source, ["ARTotalIntegral", "Integral", "Exchange", "Points", "Point"]);
            assets.ticket = firstValue(source, ["Ticket", "TicketPackage", "TicketCount", "Lottery", "LotteryTicket"]);
            assets.coupon = firstValue(source, ["Coupon", "CouponCount"]);
            for (const item of list) {
                const type = String(item.Equity || item.Type || item.StoredValueType || item.StoreCategory || item.Category || item.Name || item.Title || item.Key || "");
                const amount = firstValue(item, ["BalanceNum", "Balance", "AllAmount", "Amount", "Num", "Count", "Value", "Total", "Available", "StoredValue"]);
                if (/GoldCoin|金币/i.test(type)) assets.goldCoin = amount;
                else if (/Ticket|TicketPackage|彩票|票/i.test(type)) assets.ticket = amount;
                else if (/Coupon|优惠券|券/i.test(type)) assets.coupon = amount;
                else if (/Integral|Point|积分|Exchange/i.test(type)) assets.integral = amount;
                else if (/Coin|代币|MyScrip|币/i.test(type)) assets.coin = amount;
            }
        } catch (e) {
            this.log(`查询储值资产失败: ${e.message || e}`);
        }

        return assets;
    }

    async tryMemberCheckIn() {
        try {
            const detail = await this.request({
                apiPath: "/ykb_huiyuan/api/v1/MemberCheckIn/GetDetail",
                params: monthRange(),
            });
            const dailyReward = Array.isArray(detail?.RewardRules)
                ? detail.RewardRules.find((item) => item.CycleType === "Daily")
                : null;
            const dailyText = dailyReward ? `${dailyReward.Amount}${dailyReward.RewardAlias || ""}` : "未知";
            this.log(`会员签到状态: 已连续${detail?.Days ?? 0}天 今日奖励=${dailyText}`);

            if (detail?.IsCheckIn) {
                this.summary.sign = "今日已签到";
                this.log("今日已签到");
                return true;
            }

            const result = await this.request({
                apiPath: "/ykb_huiyuan/api/v1/MemberCheckIn/Submit",
            });
            const after = await this.request({
                apiPath: "/ykb_huiyuan/api/v1/MemberCheckIn/GetDetail",
                params: monthRange(),
            });
            this.summary.sign = `签到成功 signed=${!!after?.IsCheckIn}`;
            this.log(`签到成功${result?.Message ? `: ${result.Message}` : ""} signed=${!!after?.IsCheckIn}`);
            return true;
        } catch (e) {
            this.summary.sign = `会员签到失败: ${e.message || e}`;
            this.log(`会员签到接口不可用，改用任务签到: ${e.message || e}`);
            if (isAuthError(e)) this.removeCachedToken();
            return false;
        }
    }

    async getTaskList(taskType = "AllTask") {
        const data = await this.request({
            apiPath: "/hdb/api/v1/ClientTask/GetTaskListFromYDG",
            params: { TaskType: taskType },
        });
        return data?.List || data?.Data?.List || data?.list || [];
    }

    isSignTask(task = {}) {
        return /签到|每日|天天|登录|打卡|check.?in|sign/i.test(
            [task.TaskName, task.Name, task.Remark, task.Title, task.TaskType, task.TypeName].filter(Boolean).join(" ")
        );
    }

    async getTaskDetail(task) {
        if (task.UserTaskID) {
            return this.request({
                apiPath: "/hdb/api/v1/ClientTask/GetUserTaskDetail",
                params: { UserTaskID: task.UserTaskID },
            });
        }
        return this.request({
            apiPath: "/hdb/api/v1/ClientTask/GetTaskDetail",
            params: { TaskID: task.TaskID },
        });
    }

    async receiveTask(taskDetail, sourceTask) {
        const userTaskId = taskDetail?.UserTaskId || taskDetail?.UserTaskID || sourceTask?.UserTaskID || "";
        if (!userTaskId) throw new Error("缺少 UserTaskId");
        const data = await this.request({
            method: "POST",
            apiPath: "/hdb/api/v1/ClientTask/ReceiveTaskRewards",
            data: { UserTaskId: userTaskId },
        });
        const text = rewardText(data?.Rewards || data?.RewardList || []);
        this.summary.sign = `任务奖励已领取${text ? `: ${text}` : ""}`;
        this.log(`领取任务奖励成功${text ? `: ${text}` : ""}`);
    }

    async handleTask(task) {
        const name = task.TaskName || task.Name || task.TaskID || "未知任务";
        let detail = await this.getTaskDetail(task);
        detail.Status = normalizeStatus(detail.Status);
        this.log(`任务「${name}」状态=${detail.Status || "未知"}`);

        if (detail.Status === "Complete") {
            if (detail.RewardReceiveStatus === "UnReceive") await this.receiveTask(detail, task);
            else this.summary.sign = `任务已完成: ${name}`;
            return;
        }

        if (!task.TaskID) return;
        const challenge = await this.request({
            method: "POST",
            apiPath: "/hdb/api/v1/ClientTask/ReceiveTask",
            data: { ID: task.TaskID },
        });
        const userTaskId = challenge?.UserTaskId || challenge?.UserTaskID;
        if (userTaskId) {
            detail = await this.getTaskDetail({ UserTaskID: userTaskId });
            detail.Status = normalizeStatus(detail.Status);
            if (detail.Status === "Complete" && detail.RewardReceiveStatus === "UnReceive") {
                await this.receiveTask(detail, { ...task, UserTaskID: userTaskId });
            } else {
                this.summary.sign = `任务状态=${detail.Status || "未知"}`;
            }
        }
    }

    async tryTaskSign() {
        try {
            const tasks = await this.getTaskList();
            const signTasks = tasks.filter((task) => this.isSignTask(task));
            if (!signTasks.length) {
                this.summary.sign = "未找到签到/每日任务";
                this.log("未找到签到/每日任务");
                return;
            }
            for (const task of signTasks) await this.handleTask(task);
        } catch (e) {
            this.summary.sign = `任务签到失败: ${e.message || e}`;
            this.log(`任务签到失败: ${e.message || e}`);
        }
    }
}

!(async () => {
    const plan = APPS.map((app) => ({ app, accounts: getAccounts(app) })).filter((item) => item.accounts.length);
    const totalAccounts = plan.reduce((sum, item) => sum + item.accounts.length, 0);
    $.log(`共找到${plan.length}个小程序，${totalAccounts}个执行账号`);
    if (!plan.length) {
        $.log(`未配置 ${CK_NAME} 或原单脚本变量`);
        return;
    }

    const summaries = [];
    for (const { app, accounts } of plan) {
        $.log(`\n========== ${app.name} (${app.ck}) ==========`);
        let index = 1;
        for (const account of accounts) {
            summaries.push(await new Task(app, account, index++).run());
        }
    }

    $.log("\n========== 执行汇总 ==========");
    for (const item of summaries) {
        $.log(`${item.appName}: ${item.member} ${item.assets} 签到=${item.sign}`);
    }
})()
    .catch((e) => $.log(e.message || e))
    .finally(() => $.done());
