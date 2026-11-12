// name: jingjianx统一签到
/*
------------------------------------------
@Author: sm
@Date: 2026.06.05
@Description: jingjianx 小程序统一登录查询签到
cron: 30 8 * * *
------------------------------------------

也兼容原单脚本变量名，如 xswj、dywj、afdacw、super101cmdwyd 等。
总变量可用 appid=openid、变量名=openid、小程序名=openid 指定单个小程序账号。

------------------------------------------
 YYB-Go 版：取码改走 YYB-Go（POST /wxapp/getCode），不再依赖原取码桥接服务。
 变量：YYB_SERVER 每行 地址@账号标识（例如 http://yyb-go:8000@1）；YYB_API_KEY 可选。
 原桥接版脚本见 wxapp/jingjianx_all.js，业务接口、流程与缓存格式均未改动。
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
const $ = new Env("jingjianx统一签到");
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

const CK_NAME = "jingjianx_all";
const CACHE_FILE = path.join(__dirname, "tokencache", "jingjianx_all_token_cache.json");
const USER_AGENT =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) MicroMessenger/3.9.12 MiniProgramEnv/Windows WindowsWechat/WMPF";

const APPS = [
    {
        ck: "cwsjnbyyz",
        name: "潮玩社 JN北园银座店",
        appid: "wx533baf4b9428d47f",
        chainId: "8684",
        shops: [{ shopId: "15666", shopName: "潮玩社 JN北园银座店" }],
    },
    {
        ck: "afdacw",
        name: "阿凡达潮玩荟家庭娱乐中心",
        appid: "wxea93bab38fc144d1",
        chainId: "10967",
        shops: [
            { shopId: "21380", shopName: "阿凡达潮玩荟文水店" },
            { shopId: "21094", shopName: "阿凡达潮玩荟太原迎春街店" },
            { shopId: "20169", shopName: "阿凡达潮玩荟忻州店" },
            { shopId: "19075", shopName: "阿凡达潮玩荟榆次店" },
        ],
    },
    {
        ck: "dywj",
        name: "D1玩家",
        appid: "wxcced0bb82c738dd1",
        chainId: "3708",
        shops: [
            { shopId: "7960", shopName: "D1玩家-大丰保利店" },
            { shopId: "18811", shopName: "D1玩家友谊广场店" },
            { shopId: "14082", shopName: "D1玩家-大丰汇融店" },
            { shopId: "13473", shopName: "D1玩家-阳光新业店" },
            { shopId: "13190", shopName: "D1玩家-龙湖金楠天街店" },
            { shopId: "19190", shopName: "酷啦啦-甘孜店" },
            { shopId: "12302", shopName: "D1玩家-龙湖锦宸店" },
        ],
    },
    {
        ck: "gxdwj",
        name: "高新大玩家",
        appid: "wx7ec8c4f08046df18",
        chainId: "11279",
        shops: [{ shopId: "19642", shopName: "高新大玩家" }],
    },
    {
        ck: "dwjjxyl",
        name: "大玩家匠心娱乐",
        appid: "wxf64d5e147f9cc3b6",
        chainId: "9663",
        shops: [{ shopId: "17093", shopName: "大玩家匠心娱乐" }],
    },
    {
        ck: "wjsldwjxy",
        name: "玩家森林大玩家XY",
        appid: "wx6136bd123a990614",
        chainId: "9095",
        shops: [{ shopId: "18894", shopName: "玩家森林大玩家XY" }],
    },
    {
        ck: "jswjbzjk",
        name: "极速玩家巴中经开店",
        appid: "wx174a477493da1aeb",
        chainId: "4748",
        shops: [{ shopId: "19081", shopName: "极速玩家巴中经开店" }],
    },
    {
        ck: "jyxmhdylly",
        name: "嘉鱼县梦幻岛游乐园",
        appid: "wxb7fcdb0c375bac0c",
        chainId: "10762",
        shops: [{ shopId: "18752", shopName: "嘉鱼县梦幻岛游乐园" }],
    },
    {
        ck: "qccwc",
        name: "七彩潮玩城",
        appid: "wx72727cb43e04f838",
        chainId: "7243",
        shops: [{ shopId: "12860", shopName: "七彩潮玩城" }],
    },
    {
        ck: "jhjtylclc",
        name: "吉合家庭娱乐超乐场",
        appid: "wxdc43cd8bfcfd00ad",
        chainId: "3580",
        shops: [{ shopId: "8551", shopName: "吉合家庭娱乐超乐场" }],
    },
    {
        ck: "super101cmdwyd",
        name: "SUPER101潮漫电玩宜都店",
        appid: "wx1031a0ff78dbb777",
        chainId: "3091",
        shops: [{ shopId: "13516", shopName: "SUPER101潮漫电玩宜都店" }],
    },
    {
        ck: "wx_three_sign",
        name: "城市星空颖上恒太",
        appid: "wxab97f393b22fc3f0",
        chainId: "3900",
        shops: [{ shopId: "7726", shopName: "城市星空颖上恒太" }],
    },
    {
        ck: "wjcq",
        name: "维京传奇长春店",
        appid: "wxf4a3dae0d0cfd841",
        chainId: "11383",
        shops: [{ shopId: "19820", shopName: "维京传奇长春店" }],
    },
    {
        ck: "xswj",
        name: "像素玩家电玩城",
        appid: "wx16ad44c68249d573",
        chainId: "10557",
        shops: [{ shopId: "18417", shopName: "像素玩家电玩城" }],
    },
    {
        ck: "xblfysx",
        name: "星贝乐阜阳商厦中心店",
        appid: "wxf0a7f75ab1670953",
        chainId: "3900",
        shops: [{ shopId: "17457", shopName: "星贝乐阜阳商厦中心店" }],
    },
    {
        ck: "zjdmc",
        name: "中嘉动漫创美店",
        appid: "wx97b6b57988678880",
        chainId: "8006",
        shops: [{ shopId: "21310", shopName: "中嘉动漫创美店" }],
    },
    {
        ck: "zjdmzj",
        name: "中嘉动漫城樽憬店",
        appid: "wx334c4ec677c62f96",
        chainId: "8006",
        shops: [{ shopId: "16741", shopName: "中嘉动漫城樽憬店" }],
    },
];

for (const app of APPS) {
    app.apiBase = process.env[`${app.ck}_api_base`] || "https://capi.jingjianx.vip";
    app.chainId = process.env[`${app.ck}_chainid`] || app.chainId;
    app.version = process.env[`${app.ck}_version`] || "release";
    const shopIds = (process.env[`${app.ck}_shop_ids`] || "")
        .split(/[,，&;\n]+/)
        .map((item) => item.trim())
        .filter(Boolean);
    if (shopIds.length) {
        app.shops = app.shops
            .filter((shop) => shopIds.includes(String(shop.shopId)))
            .concat(
                shopIds
                    .filter((id) => !app.shops.some((shop) => String(shop.shopId) === id))
                    .map((id) => ({ shopId: id, shopName: `门店${id}` }))
            );
    }
}

function readCache() {
    try {
        if (!fs.existsSync(CACHE_FILE)) return {};
        return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")) || {};
    } catch {
        return {};
    }
}

function writeCache(cache) {
    try {
        fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true }); fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), "utf8");
    } catch (e) {
        $.log(`写入token缓存失败: ${e.message || e}`);
    }
}

function shortToken(token = "") {
    const value = String(token).replace(/^Bearer\s+/i, "");
    return value ? `${value.slice(0, 4)}***${value.slice(-4)}` : "";
}

function maskPhone(phone = "") {
    return String(phone).replace(/^(\d{3})\d{4}(\d{4})$/, "$1****$2");
}

function createGuid() {
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === "x" ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    });
}

function isToday(dateText = "") {
    if (!dateText) return false;
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, "0");
    const d = String(now.getDate()).padStart(2, "0");
    return String(dateText).startsWith(`${y}-${m}-${d}`);
}

function addStoreAsset(assets, category, value, name = "") {
    const amount = Number(value || 0);
    const label = String(name || "");
    if (label) {
        if (/积分|Point/i.test(label)) assets.integral += amount;
        else if (/彩票|票/.test(label)) assets.ticket += amount;
        else if (/游戏币|本币|代币/.test(label)) assets.coin += amount;
        return;
    }
    if ([101, 102, 103].includes(Number(category))) assets.coin += amount;
    else if (Number(category) === 105) assets.integral += amount;
    else if ([104, 106, 1001, 1002, 1003].includes(Number(category))) assets.ticket += amount;
}

function parseEntries(raw = "") {
    if (!raw.trim()) return [];
    if (/^\s*[\[{]/.test(raw)) {
        try {
            const data = JSON.parse(raw);
            if (Array.isArray(data)) return data.map(String).filter(Boolean);
            if (data && typeof data === "object") {
                return Object.entries(data).map(([key, value]) => `${key}=${value}`);
            }
        } catch {
            return [];
        }
    }
    return raw
        .split(/[\n&;|]+/)
        .map((item) => item.trim())
        .filter(Boolean);
}

function resolveAccounts(app, totalEntries) {
    const entries = totalEntries.length ? totalEntries : parseEntries(process.env[app.ck] || "");
    const mapped = [];
    const common = [];
    for (const entry of entries) {
        const index = entry.indexOf("=");
        if (index > 0) {
            const key = entry.slice(0, index).trim();
            const value = entry.slice(index + 1).trim();
            if (value && [app.appid, app.ck, app.name].includes(key)) mapped.push(value);
        } else {
            common.push(entry);
        }
    }
    return mapped.length ? mapped : common;
}

class AppContext {
    constructor(app) {
        this.app = app;
        this.yyb = new YYBClient({ appid: app.appid });
    }

    /** 取 wx.login code：YYB-Go /wxapp/getCode（一个账号一次请求，失败即抛错） */
    async getCode(openid) {
        return this.yyb.getCode(openid);
    }

    headers(shopId = "", token = "", extra = {}) {
        const headers = {
            "User-Agent": USER_AGENT,
            "Referer": `https://servicewechat.com/${this.app.appid}/1/page-frame.html`,
            "content-type": "application/json",
            "JJ-CHAINID": this.app.chainId,
            "BDSZH-SHOPID": shopId,
            "JJ-SHOPID": shopId,
            "JJ-MiniAppVersion": this.app.version,
            "JJ-AppId": this.app.appid,
            ...extra,
        };
        if (token) headers.Authorization = `Bearer ${token}`;
        return headers;
    }

    async request({ method = "GET", apiPath, shopId = "", token = "", params = {}, data = {}, bizCode = "" }) {
        const options = {
            method,
            url: `${this.app.apiBase}${apiPath}`,
            headers: this.headers(shopId, token, bizCode ? { "JJ-BizCode": bizCode } : {}),
            timeout: 20000,
            validateStatus: () => true,
        };
        if (method === "GET") options.params = params;
        else options.data = data;

        const { data: result, status } = await axios.request(options);
        if (status > 400) throw new Error(`HTTP ${status}: ${JSON.stringify(result)}`);
        return result;
    }
}

class ShopTask {
    constructor(ctx, shop, account, index) {
        this.ctx = ctx;
        this.app = ctx.app;
        this.shop = {
            shopId: String(shop.shopId),
            shopName: String(shop.shopName || `门店${shop.shopId}`).trim(),
        };
        this.account = String(account || "").trim();
        this.index = index;
        this.token = "";
        this.isMember = false;
        this.member = null;
        this.loginShopName = "";
    }

    prefix() {
        return `[${this.app.name}][${this.shop.shopName}][账号${this.index}]`;
    }

    cacheKey() {
        return `${this.app.appid}:${this.account}:${this.shop.shopId}`;
    }

    getCachedToken() {
        const cache = readCache();
        return cache[this.cacheKey()] || null;
    }

    saveToken() {
        if (!this.token) return;
        const cache = readCache();
        cache[this.cacheKey()] = {
            token: this.token,
            isMember: this.isMember,
            member: this.member,
            shopId: this.shop.shopId,
            shopName: this.loginShopName || this.shop.shopName,
            appid: this.app.appid,
            appName: this.app.name,
            updatedAt: new Date().toISOString(),
        };
        writeCache(cache);
    }

    clearToken() {
        const cache = readCache();
        delete cache[this.cacheKey()];
        writeCache(cache);
        this.token = "";
    }

    applyLogin(data = {}) {
        this.token = data.token || "";
        this.isMember = !!data.isMember;
        this.member = data.member || null;
        this.loginShopName = data.shopName || "";
    }

    async run() {
        const result = {
            appName: this.app.name,
            shopName: this.shop.shopName,
            loginShopName: "",
            member: false,
            memberText: "",
            assets: { coin: 0, integral: 0, ticket: 0, coupon: 0 },
            sign: "未执行",
        };

        const cached = this.getCachedToken();
        if (cached) {
            this.token = cached.token || "";
            this.isMember = !!cached.isMember;
            this.member = cached.member || null;
            this.loginShopName = cached.shopName || "";
            $.log(`${this.prefix()} 使用缓存token ${shortToken(this.token)}`);
            if (!(await this.checkToken())) {
                this.clearToken();
                $.log(`${this.prefix()} 缓存token失效，重新登录`);
            }
        }

        if (!this.token) await this.login();
        if (!this.token) {
            result.sign = "登录失败";
            $.log(`${this.prefix()} 结果=${result.sign}`);
            return result;
        }

        const memberText = this.member
            ? `${this.member.nickName || this.member.name || this.member.memberName || "member"}${this.member.phone ? ` ${maskPhone(this.member.phone)}` : ""}`
            : "非会员";
        const assets = this.isMember ? await this.getAssets() : result.assets;
        result.loginShopName = this.loginShopName || this.shop.shopName;
        result.member = this.isMember;
        result.memberText = memberText;
        result.assets = assets;

        $.log(
            `${this.prefix()} 查询: 登录门店=${result.loginShopName} member=${this.isMember} ${memberText} 代币=${assets.coin} 积分=${assets.integral} 彩票=${assets.ticket} 优惠券=${assets.coupon}`
        );

        if (!this.isMember) {
            result.sign = "非会员跳过";
            $.log(`${this.prefix()} 签到: ${result.sign}`);
            return result;
        }

        result.sign = await this.sign();
        $.log(`${this.prefix()} 签到: ${result.sign}`);
        return result;
    }

    async checkToken() {
        try {
            const result = await this.ctx.request({
                apiPath: "/signed/capp/signed/getreward",
                shopId: this.shop.shopId,
                token: this.token,
            });
            return !!result.success;
        } catch {
            return false;
        }
    }

    async login() {
        try {
            const code = await this.ctx.getCode(this.account);
            const result = await this.ctx.request({
                method: "POST",
                apiPath: "/capp/account/login",
                shopId: this.shop.shopId,
                data: { code },
            });
            if (!result.success) throw new Error(result.msg || JSON.stringify(result));
            this.applyLogin(result.data || {});
            if (!this.token) throw new Error(`登录响应无token: ${JSON.stringify(result)}`);
            this.saveToken();
            $.log(`${this.prefix()} 登录成功 token=${shortToken(this.token)}`);
        } catch (e) {
            $.log(`${this.prefix()} 登录失败: ${e.message || e}`);
        }
    }

    async getAssets() {
        const assets = { coin: 0, integral: 0, ticket: 0, coupon: 0 };
        const accountNames = {};
        try {
            const account = await this.ctx.request({
                apiPath: "/basic/shop/xcx/scene/getaccount",
                shopId: this.shop.shopId,
                token: this.token,
            });
            const list = Array.isArray(account?.data) ? account.data : [];
            for (const item of list) accountNames[Number(item.key)] = item.value;
        } catch (e) {
            $.log(`${this.prefix()} 查询账户类型失败: ${e.message || e}`);
        }

        try {
            const store = await this.ctx.request({
                apiPath: "/member/capp/member/store/get",
                shopId: this.shop.shopId,
                token: this.token,
            });
            const list = Array.isArray(store?.data) ? store.data : [];
            for (const item of list) addStoreAsset(assets, item.storeCategory, item.value, accountNames[Number(item.storeCategory)]);
        } catch (e) {
            $.log(`${this.prefix()} 查询资产失败: ${e.message || e}`);
        }
        try {
            const coupon = await this.ctx.request({
                apiPath: "/coupon/capp/membercoupon/count",
                shopId: this.shop.shopId,
                token: this.token,
            });
            if (coupon?.success) assets.coupon = Number(coupon.data || 0);
        } catch (e) {
            $.log(`${this.prefix()} 查询优惠券失败: ${e.message || e}`);
        }
        return assets;
    }

    async getReward() {
        const result = await this.ctx.request({
            apiPath: "/signed/capp/signed/getreward",
            shopId: this.shop.shopId,
            token: this.token,
        });
        if (!result.success) throw new Error(result.msg || JSON.stringify(result));
        return result.data || {};
    }

    async getProgress(signType) {
        const apiPath = Number(signType) === 0 ? "/signed/capp/signed/getprogress" : "/signed/capp/signed/getnewprogress";
        const result = await this.ctx.request({
            apiPath,
            shopId: this.shop.shopId,
            token: this.token,
        });
        if (!result.success) throw new Error(result.msg || JSON.stringify(result));
        return result.data || {};
    }

    getSignedState(reward, progress) {
        const signType = Number(reward.signCycle || 0);
        const signMode = Number(reward.signMode || 1);

        if (signType === 0) {
            return {
                signType,
                signMode,
                signed: !progress.isSigning,
                currentDay: progress.signInDays || 0,
                apiPath: "/signed/capp/signed/confirm",
            };
        }

        if (signMode === 2 && progress.totalDay) {
            return {
                signType,
                signMode,
                signed: !progress.totalDay.isSigning,
                currentDay: progress.totalDay.signInDays || 0,
                apiPath: "/signed/capp/signed/newconfirm",
            };
        }

        if (signMode === 3 && Array.isArray(progress.dailyDay)) {
            return {
                signType,
                signMode,
                signed: progress.dailyDay.some((item) => isToday(item.signDate)),
                currentDay: progress.dailyDay.length,
                apiPath: "/signed/capp/signed/newconfirm",
            };
        }

        return {
            signType,
            signMode,
            signed: progress.totalDay ? !progress.totalDay.isSigning : false,
            currentDay: progress.totalDay?.signInDays || 0,
            apiPath: "/signed/capp/signed/newconfirm",
        };
    }

    async sign() {
        try {
            const reward = await this.getReward();
            if (!reward.isEnabled) return "未开启签到";

            const progress = await this.getProgress(reward.signCycle);
            const state = this.getSignedState(reward, progress);
            $.log(`${this.prefix()} 签到状态: signType=${state.signType} signMode=${state.signMode} currentDay=${state.currentDay} signed=${state.signed}`);

            if (state.signed) return "今日已签到";

            const result = await this.ctx.request({
                method: "POST",
                apiPath: state.apiPath,
                shopId: this.shop.shopId,
                token: this.token,
                data: { longitude: 0, latitude: 0 },
                bizCode: createGuid(),
            });
            if (!result.success) throw new Error(result.msg || JSON.stringify(result));
            const data = result.data || {};
            return `签到成功${data.rewardName || data.prizeName ? ` 奖励=${data.rewardName || data.prizeName}` : ""}`;
        } catch (e) {
            return `签到失败: ${e.message || e}`;
        }
    }
}

!(async () => {
    const totalEntries = parseEntries(process.env[CK_NAME] || "");
    const summaries = [];

    for (const app of APPS) {
        const accounts = yybAccounts();
        if (!accounts.length) {
            $.log(`[${app.name}] 未配置账号，跳过`);
            continue;
        }

        $.log(`\n===== ${app.name} appid=${app.appid} chainId=${app.chainId} 门店数=${app.shops.length} =====`);
        const ctx = new AppContext(app);
        for (const shop of app.shops) {
            let index = 1;
            for (const account of accounts) {
                summaries.push(await new ShopTask(ctx, shop, account, index++).run());
            }
        }
    }

    if (!summaries.length) {
        $.log(`未找到账号，请配置 ${CK_NAME} 或原单脚本变量名`);
        return;
    }

    $.log("\n========== jingjianx 签到汇总 ==========");
    for (const item of summaries) {
        $.log(
            `${item.appName} | ${item.loginShopName || item.shopName} | ${item.memberText || "未知用户"} | 代币=${item.assets.coin} 积分=${item.assets.integral} 彩票=${item.assets.ticket} 优惠券=${item.assets.coupon} | ${item.sign}`
        );
    }
})()
    .catch((e) => $.log(e.message || e))
    .finally(() => $.done());
