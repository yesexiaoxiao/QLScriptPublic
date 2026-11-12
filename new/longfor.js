// name: 龙湖天街签到
/*
------------------------------------------
@Author: sm
@Date: 2026.05.31
@Description: 龙湖天街小程序签到
cron: 35 8 * * *
------------------------------------------


可选变量：
longfor_dx_token     手动指定顶象 constID
longfor_gps          指定 gps，经纬度格式：longitude,latitude
------------------------------------------
 YYB-Go 版：取码改走 YYB-Go（POST /wxapp/getCode），不再依赖原取码桥接服务。
 变量：YYB_SERVER 每行 地址@账号标识（例如 http://yyb-go:8000@1）；YYB_API_KEY 可选。
 原桥接版脚本见 wxapp/longfor.js，业务接口、流程与缓存格式均未改动。
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
const $ = new Env("龙湖天街签到");
const axios = require("axios");
const crypto = require("crypto");
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

const MINI_APP_ID = "wx50282644351869da";
const PAGE_VERSION = "506";
const API_VERSION = "v1_25_0";
const APP_VERSION = "1.25.0";
const CHANNEL = "C2";
const BU_CODE = "C20400";
const BASE_HOST = "https://gw2c-hw-open.longfor.com/supera";
const MEMBER_HOST = `${BASE_HOST}/member`;
const TASK_HOST = "https://gw2c-hw-open.longfor.com/lmarketing-task-api-mvc-prod";
const MEMBER_GAIA_KEY = "98717e7a-a039-46af-8143-be7558a089c0";
const TASK_GAIA_KEY = "c06753f1-3e68-437d-b592-b94656ea5517";
const MINI_SIGN_SECRET = "Q74eKtH5LePYfSjIiflUbCL2gxjTa7rF";
const DX_MINI_CONFIG = {
    appId: "d1a43734fc59aeae9f1562dbd70fdf54",
    server: "https://ly-sta.longhu.net/udid/w1",
    cache: true,
    gps: true,
};
const DX_ALPHABET = "S0DOZN9bBJyPV-qczRa3oYvhGlUMrdjW7m2CkE5_FuKiTQXnwe6pg8fs4HAtIL1x=";
const DX_LID_KEY = "_dx_uzZo5y";
const DX_TOKEN_KEY = "_dx_raAh8q";
const DX_STORAGE = new Map();
const DX_KEY_MAP = {
    SDKVersion: "sv",
    accuracy: "ac",
    altitude: "att",
    available: "al",
    batteryLevel: "bl",
    benchmarkLevel: "bml",
    brand: "bd",
    BSSID: "bs",
    collectTime: "ct",
    discovering: "dc",
    fontSizeSetting: "fss",
    horizontalAccuracy: "ha",
    language: "lang",
    latitude: "lt",
    longitude: "lgt",
    model: "md",
    networkType: "nt",
    pixelRatio: "pr",
    platform: "pf",
    screenHeight: "sh",
    screenWidth: "sw",
    secure: "se",
    speed: "sp",
    signalStrength: "ss",
    statusBarHeight: "",
    supportMode: "sm",
    system: "sy",
    SSID: "si",
    version: "vs",
    verticalAccuracy: "va",
    windowHeight: "wh",
    windowWidth: "ww",
    gps: "gps",
};
const TOKEN_CACHE_FILE = path.join(__dirname, "tokencache", "longfor_token_cache.json");
const USER_AGENT =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) MicroMessenger/3.9.12 MiniProgramEnv/Windows WindowsWechat/WMPF";


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
        fs.mkdirSync(path.dirname(TOKEN_CACHE_FILE), { recursive: true }); fs.writeFileSync(TOKEN_CACHE_FILE, JSON.stringify(cache, null, 2), "utf8");
    } catch (e) {
        $.log(`写入token缓存失败: ${e.message || e}`);
    }
}

function shortValue(value = "") {
    const text = String(value || "");
    return text ? `${text.slice(0, 4)}***${text.slice(-4)}` : "";
}

function uuid() {
    return crypto.randomUUID().replace(/-/g, "");
}

function canonicalize(data = {}) {
    return Object.keys(data || {})
        .sort()
        .map((key) => {
            let value = data[key];
            if (Array.isArray(value)) {
                let text = "[";
                if (!value.length) text += "]";
                value.forEach((item, index) => {
                    if (Array.isArray(item)) text += JSON.stringify(item);
                    else if (typeof item === "object" && item !== null) text += `{${canonicalize(item)}}`;
                    else text += item;
                    text += index < value.length - 1 ? "," : "]";
                });
                value = text;
            } else if (typeof value === "object" && value !== null) {
                value = `{${canonicalize(value)}}`;
            }
            return `${value}`.trim() && `${value}` !== "null" ? `${key}=${value}` : "";
        })
        .filter(Boolean)
        .join("|");
}

function miniSign(data) {
    const timestamp = Date.now().toString();
    const body = canonicalize(JSON.parse(JSON.stringify(data || {})));
    const raw = `${body ? `${body}&` : ""}${timestamp}&${MINI_SIGN_SECRET}`;
    return {
        "X-LONGZHU-TimeStamp": timestamp,
        "X-Client-Type": "microApp",
        "X-LONGZHU-Sign": crypto.createHash("md5").update(raw).digest("hex"),
    };
}

function dxMakeLocalId(length = 32) {
    const chars = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
    let value = "";
    for (let i = 0; i < length; i++) value += chars.charAt(Math.floor(Math.random() * chars.length));
    return value;
}

function dxEncrypt(data) {
    const text = JSON.stringify(data) || "";
    let output = "";
    for (let index = 0; index < text.length; ) {
        const first = text.charCodeAt(index++);
        const second = text.charCodeAt(index++);
        const third = text.charCodeAt(index++);
        const a = first >> 2;
        const b = ((first & 3) << 4) | (second >> 4);
        let c = ((second & 15) << 2) | (third >> 6);
        let d = third & 63;
        if (Number.isNaN(second)) c = d = 64;
        else if (Number.isNaN(third)) d = 64;
        output += DX_ALPHABET.charAt(a) + DX_ALPHABET.charAt(b) + DX_ALPHABET.charAt(c) + DX_ALPHABET.charAt(d);
    }
    return output;
}

function dxSelectMethod(param) {
    return param && param.length > 1024 ? "POST" : "GET";
}

function dxShorten(data = {}) {
    const output = {};
    for (const key in data) output[DX_KEY_MAP[key] ? DX_KEY_MAP[key] : key] = data[key];
    return output;
}

function dxSystemInfo() {
    return {
        brand: "microsoft",
        model: "Windows WeChat",
        pixelRatio: 1,
        screenWidth: 414,
        screenHeight: 896,
        windowWidth: 414,
        windowHeight: 896,
        statusBarHeight: 0,
        language: "zh_CN",
        version: "8.0.58",
        system: "Windows 10 x64",
        platform: "windows",
        fontSizeSetting: 16,
        SDKVersion: "3.9.12",
        benchmarkLevel: 1,
        batteryLevel: 100,
    };
}

async function dxCollect(options = {}) {
    const start = Date.now();
    const data = {
        networkType: "wifi",
        ...dxSystemInfo(),
    };
    if (options.gps) data.gps = process.env.longfor_gps || "116.397128,39.916527";
    data.collectTime = Date.now() - start;
    return dxShorten(data);
}

class MiniDxConstId {
    constructor(options = {}) {
        this.options = { ...DX_MINI_CONFIG, ...options };
        this.options.appId = this.options.appId || this.options.appKey;
        if (!this.options.server || !this.options.appId) throw new Error("missing dx server/appId");
    }

    getToken() {
        return DX_STORAGE.get(DX_TOKEN_KEY) || "";
    }

    setToken(token) {
        DX_STORAGE.set(DX_TOKEN_KEY, token);
    }

    async getLid() {
        const lid = DX_STORAGE.get(DX_LID_KEY) || `${Date.now()}${dxMakeLocalId()}`;
        DX_STORAGE.set(DX_LID_KEY, lid);
        return lid;
    }

    mergeOptions(extra = {}) {
        const data = { ...extra };
        ["appId", "userId", "openId", "scene"].forEach((key) => {
            if (this.options[key]) data[key] = encodeURIComponent(this.options[key]);
        });
        data.appKey = data.appId;
        delete data.appId;
        return data;
    }

    async request(param, token = "") {
        const method = dxSelectMethod(param);
        const options = {
            method,
            url: this.options.server,
            headers: {
                Param: method === "POST" ? "" : param,
                "If-None-Match": token,
                "Content-Type": "application/x-www-form-urlencoded",
            },
            timeout: 15000,
            validateStatus: () => true,
        };
        if (method === "POST") options.data = new URLSearchParams({ Param: param }).toString();
        else options.params = { Param: "" };
        const { data } = await axios.request(options);
        return data;
    }

    async detect() {
        const lid = await this.getLid();
        const collected = await dxCollect(this.options);
        const param = dxEncrypt(this.mergeOptions({ lid, ...collected }));
        const data = await this.request(param, "");
        if (Number(data.status) === 2) {
            this.setToken(data.data);
            return data.data;
        }
        throw new Error(`dx status: ${data.status}`);
    }

    async generate() {
        const lid = await this.getLid();
        const param = dxEncrypt(this.mergeOptions({ lid, cache: !!this.options.cache }));
        const data = await this.request(param, this.getToken());
        const status = Number(data.status);
        if (status === 1 || status === 2) {
            this.setToken(data.data);
            return data.data;
        }
        if (status === -4 && data.data) {
            DX_STORAGE.set(DX_LID_KEY, data.data);
            return this.detect();
        }
        return this.detect();
    }
}

async function getDxToken() {
    if (process.env.longfor_dx_token) return process.env.longfor_dx_token;
    return new MiniDxConstId().generate();
}

function ok(code) {
    return ["200", "0000", "10000"].includes(String(code));
}

function tokenError(error) {
    return /token|登录|授权|未登录|801007|900005|900006/i.test(String(error?.message || error));
}

class Task {
    constructor(account) {
        this.index = $.userIdx++;
        this.account = String(account || "").trim();
        this.token = "";
        this.lmid = "";
        this.expire = 0;
        this.activityNo = "";
    }

    applyToken(data = {}) {
        this.token = data.token || "";
        this.lmid = data.lmid || "";
        this.expire = Number(data.expire || 0);
    }

    getCachedToken() {
        const item = readCache()[this.account];
        if (!item?.token) return null;
        if (item.expireAt && Number(item.expireAt) < Date.now() + 60000) return null;
        return item;
    }

    saveCachedToken() {
        if (!this.token) return;
        const cache = readCache();
        cache[this.account] = {
            token: this.token,
            lmid: this.lmid,
            expireAt: this.expire ? Date.now() + this.expire * 1000 : 0,
            updatedAt: new Date().toISOString(),
        };
        writeCache(cache);
    }

    removeCachedToken() {
        const cache = readCache();
        if (cache[this.account]) {
            delete cache[this.account];
            writeCache(cache);
        }
        this.token = "";
        this.lmid = "";
        this.expire = 0;
    }

    miniHeaders(data = null, member = false) {
        const headers = {
            "User-Agent": USER_AGENT,
            "Referer": `https://servicewechat.com/${MINI_APP_ID}/${PAGE_VERSION}/page-frame.html`,
            "Content-Type": "application/json",
            "lmToken": this.token || "",
            "X-LF-Bucode": BU_CODE,
            "X-LF-App-Version": APP_VERSION,
            "X-LF-RequestId": uuid(),
            "X-LF-Channel": CHANNEL,
            "X-LF-Api-Version": API_VERSION,
        };
        if (member) headers["X-Gaia-Api-Key"] = MEMBER_GAIA_KEY;
        if (data) Object.assign(headers, miniSign(data));
        return headers;
    }

    taskHeaders(dxToken = "") {
        const headers = {
            "User-Agent": USER_AGENT,
            "Referer": "https://longzhu.longfor.com/longball-homeh5/",
            "Content-Type": "application/json;charset=UTF-8",
            "X-GAIA-API-KEY": TASK_GAIA_KEY,
            "token": this.token,
            "X-LF-UserToken": this.token,
            "X-LF-Channel": CHANNEL,
            "X-LF-Bu-Code": BU_CODE,
        };
        if (dxToken) {
            headers["X-LF-DXRisk-Token"] = dxToken;
            headers["X-LF-DXRisk-Source"] = 3;
            headers["X-LF-DXRisk-Captcha-Token"] = "";
        }
        return headers;
    }

    async miniPost(url, data, member = false) {
        const { data: result, status } = await axios.post(url, data, {
            headers: this.miniHeaders(data, member),
            timeout: 20000,
            validateStatus: () => true,
        });
        if (status !== 200) throw new Error(`HTTP ${status}: ${JSON.stringify(result)}`);
        if (!ok(result?.code)) {
            const err = new Error(result?.msg || result?.message || JSON.stringify(result));
            err.code = result?.code;
            throw err;
        }
        return result.data;
    }

    async taskPost(pathname, data, dxToken = "") {
        const { data: result, status } = await axios.post(`${TASK_HOST}${pathname}`, data, {
            headers: this.taskHeaders(dxToken),
            timeout: 20000,
            validateStatus: () => true,
        });
        if (status !== 200) throw new Error(`HTTP ${status}: ${JSON.stringify(result)}`);
        return result;
    }

    /** 取 wx.login code：YYB-Go /wxapp/getCode（一个账号一次请求，失败即抛错） */
    async getLoginCode() {
        return yyb.getCode(this.account);
    }

    async loginByWxCode() {
        const checkData = {
            appId: MINI_APP_ID,
            thirdType: "WX_APPLET",
            fingerprint: "",
            authCode: await this.getLoginCode(),
        };
        const check = await this.miniPost(`${BASE_HOST}/mine/${API_VERSION}/publicApi/login/checkLoginType`, checkData);
        const loginData = {
            appId: MINI_APP_ID,
            authCode: await this.getLoginCode(),
            isNew: false,
            thirdType: "WX_APPLET",
            fingerprint: "",
            ticket: check?.ticket || "",
        };
        const login = await this.miniPost(`${BASE_HOST}/mine/${API_VERSION}/publicApi/login/loginByMiniApp`, loginData);
        this.applyToken(login);
        if (!this.token) throw new Error(`登录响应未返回 token: ${JSON.stringify(login)}`);
        this.saveCachedToken();
        $.log(`账号[${this.index}] 登录成功: token=${shortValue(this.token)} lmid=${shortValue(this.lmid)}`);
    }

    findActivityNo(payload) {
        return (JSON.stringify(payload || {}).match(/activity_no=([0-9]+)/) || [])[1] || "";
    }

    async getPageConfig() {
        const data = await this.miniPost(
            `${MEMBER_HOST}/api/bff/pages/${API_VERSION}/publicApi/v1/pageConfig`,
            { pageCode: "C2mine" },
            true
        );
        this.activityNo = this.findActivityNo(data);
        return data;
    }

    async checkToken() {
        try {
            await this.getPageConfig();
            return true;
        } catch (e) {
            return false;
        }
    }

    async getPageInfo() {
        const result = await this.taskPost("/openapi/task/v1/signature/page-info", { activity_no: this.activityNo });
        if (!ok(result?.code)) throw new Error(result?.message || result?.msg || JSON.stringify(result));
        return result.data || {};
    }

    todaySigned(pageInfo) {
        const today = Array.isArray(pageInfo?.seven_days_signs) ? pageInfo.seven_days_signs[0] : {};
        return Number(today?.sign_status) === 20;
    }

    rewardText(rewards = []) {
        if (!Array.isArray(rewards)) return "";
        return rewards
            .map((item) => {
                const num = item?.reward_num || item?.num || item?.amount;
                const name = item?.reward_name || item?.reward_type_name || item?.unit || "";
                return num ? `${name}${num}` : "";
            })
            .filter(Boolean)
            .join(",");
    }

    async signIn() {
        await this.getPageConfig();
        if (!this.activityNo) throw new Error("未在会员页配置中找到签到 activity_no");

        const pageInfo = await this.getPageInfo();
        $.log(`账号[${this.index}] 活动: ${pageInfo.task_name || "签到"} 今日=${this.todaySigned(pageInfo) ? "已签到" : "未签到"}`);
        if (this.todaySigned(pageInfo)) return;

        const dxToken = await getDxToken();
        $.log(`账号[${this.index}] 风控指纹${dxToken ? "获取成功" : "获取失败，直接尝试"}`);

        const result = await this.taskPost("/openapi/task/v1/signature/clock", { activity_no: this.activityNo }, dxToken);
        if (!ok(result?.code)) {
            const err = new Error(result?.message || result?.msg || JSON.stringify(result));
            err.code = result?.code;
            throw err;
        }
        $.log(`账号[${this.index}] 签到成功${this.rewardText(result?.data?.reward_info) ? `: ${this.rewardText(result.data.reward_info)}` : ""}`);
    }

    async run() {
        const cached = this.getCachedToken();
        if (cached) {
            this.applyToken(cached);
            $.log(`账号[${this.index}] 使用缓存token: ${shortValue(this.token)}`);
            if (!(await this.checkToken())) {
                this.removeCachedToken();
                $.log(`账号[${this.index}] 缓存token失效，重新登录`);
            }
        }
        if (!this.token) await this.loginByWxCode();
        if (!this.token) return;

        try {
            await this.signIn();
        } catch (e) {
            $.log(`账号[${this.index}] 签到失败${e.code ? `(${e.code})` : ""}: ${e.message || e}`);
            if (tokenError(e)) this.removeCachedToken();
        }
    }
}

!(async () => {
    let accounts;
    try { accounts = yybAccounts(); } catch (e) { $.log(`❌ ${e.message || e}`); return; }
    $.log(`共找到${accounts.length}个YYB账号`);
    for (const account of accounts) {
        await new Task(account).run();
    }
})()
    .catch((e) => $.log(e.message || e))
    .finally(() => $.done());
