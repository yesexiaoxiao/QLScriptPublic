// name: 衣城通
/*
衣城通 - 签到/每日任务/查询
cron: 20 8 * * *

  1. YYB-Go 中保存的 openid/账号标识，多账号用 & 或换行分隔
  2. openid#token，可直接写入/刷新本地缓存
  3. 仅 token，也可查询/签到
  4. JSON：{"openid":"...","token":"..."}

可选变量：yichengtong_token（单账号 token 兜底）
 YYB-Go 版：取码改走 YYB-Go（POST /wxapp/getCode），不再依赖原取码桥接服务。
 变量：YYB_SERVER 每行 地址@账号标识（例如 http://yyb-go:8000@1）；YYB_API_KEY 可选。
 原桥接版脚本见 wxapp/yichengtong.js，业务接口、流程与缓存格式均未改动。
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
const $ = new Env("衣城通");
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

const MINI_APP_ID = "wxc4eaf0fd0c97862f";
const PACKAGE_VERSION = "138";
const API_BASE = "https://api.yctjob.com";
const TOKEN_CACHE_FILE = path.join(__dirname, "tokencache", "yichengtong_token_cache.json");
const TASK_FUNC_TYPE = {
  lookpost: 1,
  sharepost: 2,
  improveresume: 3,
  adddesktop: 4,
  addmymini: 5,
  lookmerchant: 6,
  lookclothing: 7,
  invitecolleagues: 8,
};
const AUTO_TASK_TYPES = new Set([
  TASK_FUNC_TYPE.lookpost,
  TASK_FUNC_TYPE.sharepost,
  TASK_FUNC_TYPE.lookmerchant,
  TASK_FUNC_TYPE.lookclothing,
]);

const yyb = new YYBClient({ appid: MINI_APP_ID });

function readCache() {
  try {
    if (!fs.existsSync(TOKEN_CACHE_FILE)) return {};
    return JSON.parse(fs.readFileSync(TOKEN_CACHE_FILE, "utf8")) || {};
  } catch {
    return {};
  }
}

function writeCache(cache) {
  try {
    fs.mkdirSync(path.dirname(TOKEN_CACHE_FILE), { recursive: true }); fs.writeFileSync(TOKEN_CACHE_FILE, JSON.stringify(cache, null, 2), "utf8");
  } catch (e) {
    $.log(`token缓存写入失败: ${e.message || e}`);
  }
}

function md5(text) {
  return crypto.createHash("md5").update(String(text)).digest("hex");
}

function mask(value = "") {
  value = String(value);
  if (!value) return "";
  if (value.length <= 12) return `${value.slice(0, 3)}***`;
  return `${value.slice(0, 6)}***${value.slice(-6)}`;
}

function parseAccount(raw) {
  const text = String(raw || "").trim();
  if (!text) return {};

  if (text.startsWith("{")) {
    try {
      const data = JSON.parse(text);
      return {
        openid: data.openid || data.openId || data.account || "",
        token: data.token || data.Authorization || data.authorization || "",
      };
    } catch {}
  }

  for (const sep of ["#", "|"]) {
    if (text.includes(sep)) {
      const [openid, ...rest] = text.split(sep);
      return { openid: openid.trim(), token: rest.join(sep).trim().replace(/^Bearer\s+/i, "") };
    }
  }

  if (text.startsWith("eyJ") || text.length > 80) return { token: text.replace(/^Bearer\s+/i, "") };
  return { openid: text };
}

function ok(res) {
  return Number(res?.code) === 200;
}

function taskSummary(list = []) {
  return list
    .map((item) => `${item.name || item.title || item.id || "任务"} ${item.completeCount ?? 0}/${item.num ?? 1}`)
    .join("；");
}

function taskName(task = {}) {
  return task.name || task.title || `任务${task.id || task.configId || ""}`;
}

async function request(method, urlPath, { token = "", data = null, params = null, custom = {} } = {}) {
  const res = await axios({
    method,
    url: `${API_BASE}${urlPath}`,
    data,
    params,
    timeout: 30000,
    validateStatus: () => true,
    headers: {
      Accept: "*/*",
      "Content-Type": "application/json",
      "User-Agent": "Mozilla/5.0 MicroMessenger MiniProgramEnv/Windows",
      Referer: `https://servicewechat.com/${MINI_APP_ID}/${PACKAGE_VERSION}/page-frame.html`,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...custom,
  });
  return {
    status: res.status,
    data: res.data,
    text: typeof res.data === "string" ? res.data : JSON.stringify(res.data),
  };
}

class Task {
  constructor(raw) {
    this.index = $.userIdx++;
    const account = parseAccount(raw);
    this.openid = account.openid || "";
    this.token = account.token || process.env.yichengtong_token || "";
    this.wxInfo = {};
    this.userInfo = {};
    this.cacheKey = this.openid || (this.token ? md5(this.token).slice(0, 16) : `account_${this.index}`);
  }

  getCached() {
    return readCache()[this.cacheKey] || {};
  }

  saveCache(extra = {}) {
    const cache = readCache();
    cache[this.cacheKey] = {
      ...(cache[this.cacheKey] || {}),
      ...(this.openid ? { openid: this.openid } : {}),
      ...(this.token ? { token: this.token } : {}),
      ...(this.userInfo?.userId ? { userId: this.userInfo.userId } : {}),
      ...(this.userInfo?.mobile ? { mobile: this.userInfo.mobile } : {}),
      ...extra,
      updatedAt: new Date().toISOString(),
    };
    writeCache(cache);
  }

  removeToken() {
    const cache = readCache();
    if (cache[this.cacheKey]) {
      delete cache[this.cacheKey].token;
      writeCache(cache);
    }
  }

  /** 取 wx.login code：YYB-Go /wxapp/getCode（一个账号一次请求，失败即抛错） */
  async getWxCode() {
      return yyb.getCode(this.openid);
  }

  async getOperateData() {
    if (!this.openid) throw new Error("缺少 openid，无法从 YYB-Go 获取授权数据");
    // YYB-Go 的 /wx/getuserinfo 只返回已保存的账号资料，不产生 operatedata：
    // code/iv/encryptedData 属于小程序侧协议能力，需在小程序内走真实授权后按 payload 转 /wxapp/operateWxData。
    const info = await yyb.getAccountInfo(this.openid);
    if (!info.code || !info.iv || !info.encryptedData) {
      throw new Error(`YYB-Go 不提供 operatedata（code/iv/encryptedData）：${JSON.stringify(info).slice(0, 300)}`);
    }
    return info;
  }

  async loginByCode() {
    const code = await this.getWxCode();
    const session = await request("post", "/client/web/wechatSession", {
      params: { code },
      data: {},
    });
    if (session.status !== 200 || !ok(session.data)) {
      throw new Error(`wechatSession失败[${session.status}]: ${session.text.slice(0, 500)}`);
    }
    const data = session.data.data || {};
    this.wxInfo = data.wxInfo || {};
    this.userInfo = data.userInfo || {};
    if (this.wxInfo.openid && !this.openid) this.openid = this.wxInfo.openid;
    const token = this.userInfo.token || data.token || "";
    if (!token) return false;
    this.token = token;
    this.saveCache({ loginType: "wechatSession" });
    $.log(`账号[${this.index}] code登录成功: ${mask(this.userInfo.userId || this.token)}`);
    return true;
  }

  async loginByOperateData() {
    const op = await this.getOperateData();
    const session = await request("post", "/client/web/wechatSession", {
      params: { code: op.code },
      data: {},
    });
    if (session.status === 200 && ok(session.data)) {
      const data = session.data.data || {};
      this.wxInfo = data.wxInfo || {};
      this.userInfo = data.userInfo || {};
    }
    const wxInfo = this.wxInfo || {};
    const login = await request("post", "/client/web/wechatLogin", {
      data: {
        openId: wxInfo.openid || wxInfo.openId || this.openid,
        unionId: wxInfo.unionid || wxInfo.unionId || "",
        sessionKey: wxInfo.sessionKey || wxInfo.session_key || "",
        encryptedData: op.encryptedData,
        iv: op.iv,
        pcSn: "",
        sourceType: 0,
        shareId: null,
        userUuid: null,
        registerType: 1,
      },
    });
    if (login.status !== 200 || !ok(login.data)) {
      throw new Error(`wechatLogin失败[${login.status}]: ${login.text.slice(0, 800)}`);
    }
    this.userInfo = login.data.data || {};
    this.token = this.userInfo.token || "";
    if (!this.token) throw new Error(`wechatLogin未返回token: ${login.text.slice(0, 500)}`);
    this.saveCache({ loginType: "wechatLogin" });
    $.log(`账号[${this.index}] 授权登录成功: ${mask(this.userInfo.userId || this.token)}`);
  }

  async ensureLogin() {
    const cached = this.getCached();
    this.token = this.token || cached.token || "";
    this.userInfo.userId = cached.userId || "";
    if (this.token) return;
    if (!(await this.loginByCode())) {
      $.log(`账号[${this.index}] code未返回token，尝试手机号授权数据登录`);
      await this.loginByOperateData();
    }
  }

  async api(method, urlPath, options = {}) {
    let res = await request(method, urlPath, { ...options, token: this.token });
    if (res.status === 401 || Number(res.data?.code) === 401) {
      $.log(`账号[${this.index}] token失效，尝试重新登录`);
      this.removeToken();
      this.token = "";
      await this.ensureLogin();
      res = await request(method, urlPath, { ...options, token: this.token });
    }
    return res;
  }

  async querySignHome() {
    const res = await this.api("get", "/client/user/signHome");
    if (res.status !== 200 || !ok(res.data)) {
      throw new Error(`签到信息查询失败[${res.status}]: ${res.text.slice(0, 800)}`);
    }
    const data = res.data.data || {};
    const amount = data.amount ?? 0;
    const integral = data.integral ?? 0;
    const configs = Array.isArray(data.configs) ? data.configs : [];
    const today = configs.find((item) => Number(item.signStatus) === 0) || configs.find((item) => item.today);
    const signed = configs.some((item) => Number(item.signStatus) === 1 && item.today);
    $.log(`账号[${this.index}] 查询: 积分${integral}，红包${amount}`);
    if (configs.length) {
      const statusText = configs
        .map((item) => `第${item.dayNum ?? item.days ?? "?"}天:${["未签", "已签", "可补签"][Number(item.signStatus)] || item.signStatus}`)
        .join("；");
      $.log(`账号[${this.index}] 签到日历: ${statusText}`);
    }
    return { data, today, signed };
  }

  async sign(signInfo) {
    if (!signInfo?.today?.logId) {
      $.log(`账号[${this.index}] 未找到今日可签到记录，可能已签到或活动未开放`);
      return;
    }
    const res = await this.api("post", "/client/user/sign", {
      data: { logId: signInfo.today.logId },
    });
    if (res.status === 200 && ok(res.data)) {
      $.log(`账号[${this.index}] 签到成功: ${res.data.msg || "成功"}`);
      return;
    }
    const msg = res.data?.msg || res.data?.message || res.text.slice(0, 500);
    if (/已签|重复|already/i.test(msg)) $.log(`账号[${this.index}] 今日已签到: ${msg}`);
    else $.log(`账号[${this.index}] 签到失败[${res.status}]: ${msg}`);
  }

  async queryTaskHome() {
    const res = await this.api("get", "/client/user/taskHome");
    if (res.status !== 200 || !ok(res.data)) {
      $.log(`账号[${this.index}] 任务信息查询失败[${res.status}]: ${res.text.slice(0, 500)}`);
      return null;
    }
    const data = res.data.data || {};
    $.log(`账号[${this.index}] 任务中心: 积分${data.integral ?? 0}，红包${data.amount ?? 0}`);
    const todayTask = Array.isArray(data.todayTask) ? data.todayTask : [];
    const experienceTask = Array.isArray(data.experienceTask) ? data.experienceTask : [];
    if (todayTask.length) $.log(`账号[${this.index}] 每日任务: ${taskSummary(todayTask)}`);
    if (experienceTask.length) $.log(`账号[${this.index}] 体验任务: ${taskSummary(experienceTask)}`);
    return data;
  }

  async submitTask(task) {
    const id = task.id || task.configId;
    if (!id) return false;
    const res = await this.api("post", "/client/user/taskSub", {
      data: { configId: id },
    });
    if (res.status === 200 && ok(res.data)) {
      $.log(`账号[${this.index}] 任务提交成功: ${taskName(task)} ${res.data.msg || ""}`);
      return true;
    }
    const msg = res.data?.msg || res.data?.message || res.text.slice(0, 500);
    $.log(`账号[${this.index}] 任务提交失败: ${taskName(task)}，${msg}`);
    return false;
  }

  async doDailyTasks(taskHome = null) {
    const data = taskHome || (await this.queryTaskHome());
    if (!data) return;
    const todayTask = Array.isArray(data.todayTask) ? data.todayTask : [];
    const runnable = todayTask.filter((task) => {
      const total = Number(task.num || 1);
      const done = Number(task.completeCount || 0);
      return done < total && AUTO_TASK_TYPES.has(Number(task.functionType));
    });
    if (!runnable.length) {
      $.log(`账号[${this.index}] 每日任务: 暂无可自动执行任务`);
      return;
    }

    for (const task of runnable) {
      const total = Number(task.num || 1);
      let done = Number(task.completeCount || 0);
      const waitSeconds = Math.max(0, Number(task.second || 0));
      while (done < total) {
        $.log(`账号[${this.index}] 执行每日任务: ${taskName(task)} ${done + 1}/${total}`);
        if (waitSeconds > 0) await $.wait(waitSeconds * 1000 + 500, waitSeconds * 1000 + 1800);
        const success = await this.submitTask(task);
        if (!success) break;
        done += 1;
        await $.wait(800, 1500);
      }
    }
  }

  async run() {
    await this.ensureLogin();
    const signInfo = await this.querySignHome();
    await this.sign(signInfo);
    await this.querySignHome();
    const taskHome = await this.queryTaskHome();
    await this.doDailyTasks(taskHome);
    await this.queryTaskHome();
    this.saveCache();
  }
}

!(async () => {
  let accounts;
  try { accounts = yybAccounts(); } catch (e) { $.log(`❌ ${e.message || e}`); return; }
  $.log(`共找到${accounts.length}个YYB账号`);
  for (const account of accounts) {
    try {
      await new Task(account).run();
    } catch (e) {
      $.log(`账号执行异常: ${e.message || e}`);
    }
    await $.wait(800, 1500);
  }
})()
  .catch((e) => $.log(e.message || e))
  .finally(() => $.done && $.done());
