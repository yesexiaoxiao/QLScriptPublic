// name: 海信爱家
/*
海信爱家 - 签到/查询
cron: 30 8 * * *

  1. YYB-Go 中保存的 openid，多账号用 & 或换行分隔
  2. customerId#accessToken
  3. openid#customerId#accessToken
  4. JSON：{"openid":"...","customerId":"...","accessToken":"...","refreshToken":"...","loginKey":"..."}

可选变量：hisense_aijia_customerId、hisense_aijia_token、hisense_aijia_refreshToken、hisense_aijia_loginKey、hisense_aijia_sign_task_id
说明：openid 首次自动登录会通过 YYB-Go 的 /wx/getphonenumber 获取手机号授权 code。
 YYB-Go 版：取码改走 YYB-Go（POST /wxapp/getCode），不再依赖原取码桥接服务。
 变量：YYB_SERVER 每行 地址@账号标识（例如 http://yyb-go:8000@1）；YYB_API_KEY 可选。
 原桥接版脚本见 wxapp/hisense_aijia.js，业务接口、流程与缓存格式均未改动。
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
const $ = new Env("海信爱家");
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

const MINI_APP_ID = "wxf488d623a17cd7b5";
const PACKAGE_VERSION = "115";
const MINI_ID = "105";
const APP_PACKAGE = "com.hisense.miniapp-aiot";
const FEATURE_CODE = "86100300000100100000fffe";
const APP_VERSION = "m_p.16.000";
const DEFAULT_VALUE = "-1";
const DEFAULT_LICENSE = "-1";
const SOURCE_TYPE = 21;
const SIGN_APP_KEY = "commonweb";
const SIGN_APP_SECRET = "MORZRbkuiWxjp+SM4vR_GxY4pZxLZ6rn";
const POINT_BASE = "https://mobile-aiot.hismarttv.com";
const WXTV_BASE = "https://public-wxtv.hismarttv.com";
const MINI_MOBI_BASE = "https://mini-mobi.hismarttv.com";
const ACCOUNT_BASE = "https://portal-account.hismarttv.com";
const TOKEN_CACHE_FILE = path.join(__dirname, "tokencache", "hisense_aijia_token_cache.json");

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
  value = String(value || "");
  if (!value) return "";
  if (value.length <= 12) return `${value.slice(0, 3)}***`;
  return `${value.slice(0, 6)}***${value.slice(-6)}`;
}

function short(value, limit = 500) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text && text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function randHex(len = 4) {
  return Math.floor(Math.random() * Math.pow(16, len)).toString(16);
}

function getSignSecret(appKey = SIGN_APP_KEY) {
  if (appKey !== SIGN_APP_KEY) throw new Error(`appSecret not found: ${appKey}`);
  return SIGN_APP_SECRET;
}

function signString(data, postAndJSON = false, appKey = SIGN_APP_KEY) {
  const secret = getSignSecret(appKey);
  let text = "";
  if (postAndJSON) {
    text = typeof data === "string" ? data : JSON.stringify(data || {});
  } else if (typeof data === "string") {
    text = data;
  } else {
    text = Object.keys(data || {})
      .map((key) => {
        let value = data[key];
        if (value === "" || value === null || value === undefined) return "";
        if (typeof value === "object") value = JSON.stringify(value);
        return `${key}=${value}`;
      })
      .filter(Boolean)
      .sort()
      .join("&");
  }
  return crypto.createHash("md5").update(`${text}${secret}`).digest("base64");
}

function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function generateDeviceId() {
  const identifier = (`0${MINI_ID}0${Date.now().toString(16)}${randHex(8)}${randHex(8)}`).slice(0, 32);
  return `${FEATURE_CODE}${identifier}`;
}

function pureGuid() {
  return uuid().replace(/-/g, "");
}

function buildSign(data, postAndJSON) {
  return signString(data || {}, postAndJSON, SIGN_APP_KEY);
}

function encryptByAppKey(value) {
  if (!value) return "";
  const secret = getSignSecret(SIGN_APP_KEY);
  const cipher = crypto.createCipheriv("aes-256-cbc", Buffer.from(secret, "utf8"), Buffer.from(secret.slice(0, 16), "utf8"));
  return Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]).toString("base64");
}

function decryptByAppKey(value) {
  if (!value) return "";
  try {
    const secret = getSignSecret(SIGN_APP_KEY);
    const decipher = crypto.createDecipheriv("aes-256-cbc", Buffer.from(secret, "utf8"), Buffer.from(secret.slice(0, 16), "utf8"));
    return Buffer.concat([decipher.update(String(value), "base64"), decipher.final()]).toString("utf8");
  } catch {
    return value;
  }
}

function cleanPayload(data = {}) {
  return Object.entries(data).reduce((obj, [key, val]) => {
    if (val === undefined || val === null || Number.isNaN(val)) return obj;
    obj[key] = val;
    return obj;
  }, {});
}

function parseAccount(raw) {
  const text = String(raw || "").trim();
  if (!text) return {};

  if (text.startsWith("{")) {
    try {
      const data = JSON.parse(text);
      return {
        openid: data.openid || data.openId || data.account || "",
        customerId: data.customerId || data.userId || "",
        accessToken: data.accessToken || data.token || "",
        refreshToken: data.refreshToken || "",
        loginKey: data.loginKey || "",
        phone: data.phone || data.mobilePhone || "",
        phoneCode: data.phoneCode || "",
        encryptedData: data.encryptedData || "",
        iv: data.iv || "",
        loginCode: data.loginCode || data.code || "",
      };
    } catch {}
  }

  if (text.includes("#") || text.includes("|")) {
    const sep = text.includes("#") ? "#" : "|";
    const parts = text.split(sep).map((v) => v.trim()).filter(Boolean);
    if (parts.length >= 3) return { openid: parts[0], customerId: parts[1], accessToken: parts.slice(2).join(sep) };
    if (parts.length === 2) {
      if (parts[0].startsWith("o")) return { openid: parts[0], accessToken: parts[1] };
      return { customerId: parts[0], accessToken: parts[1] };
    }
  }

  if (text.startsWith("o")) return { openid: text };
  return { accessToken: text };
}

function isTokenError(data) {
  const text = short(data, 1000) || "";
  const code = data?.resultCode ?? data?.code;
  return /token|登录|未登录|失效|access/i.test(text) || ["A00001", "B0101", "B0102", "401", 401].includes(code);
}

function requestHeaders(contentType = "application/json") {
  return {
    Accept: "*/*",
    "content-type": contentType,
    "User-Agent": "Mozilla/5.0 MicroMessenger MiniProgramEnv/Windows",
    Referer: `https://servicewechat.com/${MINI_APP_ID}/${PACKAGE_VERSION}/page-frame.html`,
  };
}

function addSearch(url, params = {}) {
  const u = new URL(url);
  Object.entries(params).forEach(([key, val]) => {
    if (val !== undefined && val !== null && val !== "") u.searchParams.set(key, String(val));
  });
  return u.toString();
}

async function request(method, base, urlPath, data = {}, options = {}) {
  const url = urlPath.startsWith("http") ? urlPath : `${base}${urlPath}`;
  const postAndJSON = method.toUpperCase() === "POST" && (options.contentType || "application/json").includes("json");
  const payload = cleanPayload({ _t: Date.now(), ...(data || {}) });
  const headers = requestHeaders(options.contentType || "application/json");

  if (options.signType === "WEB_CN_GW") {
    headers["X-Sign-For"] = buildSign(payload, postAndJSON);
    headers.appKey = SIGN_APP_KEY;
  } else if (options.signType === "WEB_CN") {
    payload.sign = buildSign(payload, postAndJSON);
    payload.appKey = SIGN_APP_KEY;
  }

  const config = {
    method,
    url,
    timeout: options.timeout || 30000,
    validateStatus: () => true,
    headers,
  };
  if (method.toUpperCase() === "GET") config.params = payload;
  else config.data = payload;

  const res = await axios(config);
  return { status: res.status, data: res.data, text: typeof res.data === "string" ? res.data : JSON.stringify(res.data) };
}

function extractSceneParam(res, sceneCode) {
  const pageParams = res?.pageParams || res?.data?.pageParams || [];
  if (Array.isArray(pageParams)) {
    const item = pageParams.find((v) => v.sceneCode === sceneCode) || pageParams[0] || {};
    return normalizeMaybeJson(item);
  }
  return normalizeMaybeJson(res?.[sceneCode] || res?.data || res || {});
}

function normalizeMaybeJson(value) {
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  if (!value || typeof value !== "object") return value;
  const out = Array.isArray(value) ? [] : {};
  for (const [key, val] of Object.entries(value)) out[key] = normalizeMaybeJson(val);
  return out;
}

function findTaskId(value) {
  if (!value || typeof value !== "object") return "";
  if (value.mpSignInfo?.taskId) return value.mpSignInfo.taskId;
  if (value.taskId && /sign|签到/i.test(JSON.stringify(value).slice(0, 300))) return value.taskId;
  for (const val of Object.values(value)) {
    const found = findTaskId(val);
    if (found) return found;
  }
  return "";
}

function formatSignStatus(status = {}) {
  const today = status.signedToday ? "已签" : "未签";
  const days = status.keepSigningDays ?? 0;
  const rewards = Array.isArray(status.rewardSignTaskList) ? status.rewardSignTaskList : [];
  const next = rewards[Math.max(0, Number(days) || 0)] || rewards[0] || {};
  const point = Number(next.rewardType) === 130 ? next.rewardNum : "";
  return `今日${today}，连续${days}天${point !== "" ? `，下次奖励${point}积分` : ""}`;
}

class Task {
  constructor(raw) {
    this.index = $.userIdx++;
    const account = parseAccount(raw);
    this.openid = account.openid || "";
    this.customerId = account.customerId || process.env.hisense_aijia_customerId || "";
    this.accessToken = account.accessToken || process.env.hisense_aijia_token || "";
    this.refreshToken = account.refreshToken || process.env.hisense_aijia_refreshToken || "";
    this.loginKey = account.loginKey || process.env.hisense_aijia_loginKey || "";
    this.phone = account.phone || "";
    this.phoneCode = account.phoneCode || "";
    this.encryptedData = account.encryptedData || "";
    this.iv = account.iv || "";
    this.loginCode = account.loginCode || "";
    this.deviceId = generateDeviceId();
    this.cacheKey = this.openid || this.customerId || (this.accessToken ? md5(this.accessToken).slice(0, 16) : `account_${this.index}`);
  }

  getCached() {
    return readCache()[this.cacheKey] || {};
  }

  saveCache(extra = {}) {
    const cache = readCache();
    cache[this.cacheKey] = {
      ...(cache[this.cacheKey] || {}),
      ...(this.openid ? { openid: this.openid } : {}),
      ...(this.customerId ? { customerId: this.customerId } : {}),
      ...(this.accessToken ? { accessToken: this.accessToken } : {}),
      ...(this.refreshToken ? { refreshToken: this.refreshToken } : {}),
      ...(this.loginKey ? { loginKey: this.loginKey } : {}),
      ...(this.phone ? { phone: this.phone } : {}),
      ...extra,
      updatedAt: new Date().toISOString(),
    };
    writeCache(cache);
  }

  removeToken() {
    const cache = readCache();
    if (cache[this.cacheKey]) {
      delete cache[this.cacheKey].accessToken;
      writeCache(cache);
    }
  }

  loadCache() {
    const cached = this.getCached();
    this.openid = this.openid || cached.openid || "";
    this.customerId = this.customerId || cached.customerId || "";
    this.accessToken = this.accessToken || cached.accessToken || "";
    this.refreshToken = this.refreshToken || cached.refreshToken || "";
    this.loginKey = this.loginKey || cached.loginKey || "";
    this.phone = this.phone || cached.phone || "";
  }

  /** 取 wx.login code：YYB-Go /wxapp/getCode（一个账号一次请求，失败即抛错） */
  async getWxCode() {
      return yyb.getCode(this.openid);
  }

  async getPhoneNumberData() {
    if (!this.openid) throw new Error("缺少 openid，无法从 YYB-Go 获取手机号授权 code");
    // YYB-Go：POST /wxapp/getPhoneNumber {ref, app_id}；能否返回真实授权包取决于账号与目标小程序。
    const data = await yyb.getPhoneNumber(this.openid);
    const d = data?.result || data || {};
    const phoneCode = d.code || data?.code || "";
    if (!phoneCode) throw new Error(`YYB-Go 未返回手机号 code: ${short(data, 500)}`);
    const raw = d.raw || data?.raw || {};
    const rawData = normalizeMaybeJson(raw.data || {});
    if (rawData?.mobile) this.phone = this.phone || rawData.mobile;
    return { phoneCode, raw };
  }

  async refreshAccessToken() {
    if (!this.accessToken || !this.refreshToken) return false;
    const res = await request("POST", MINI_MOBI_BASE, "/MobileMiniAppAPI/1.2/adapter/refreshToken", {
      token: this.accessToken,
      refreshToken: this.refreshToken,
    });
    const data = res.data?.data || {};
    if (res.status === 200 && Number(res.data?.resultCode) === 0 && Number(data.resultCode) === 0 && data.token) {
      this.accessToken = data.token;
      this.refreshToken = data.refreshToken || this.refreshToken;
      this.customerId = data.customerId || this.customerId;
      this.saveCache({ loginType: "refreshToken" });
      $.log(`账号[${this.index}] refreshToken 刷新成功: ${mask(this.customerId || this.accessToken)}`);
      return true;
    }
    $.log(`账号[${this.index}] refreshToken 刷新失败: ${short(res.data, 300)}`);
    return false;
  }

  async loginByLoginKey() {
    if (!this.loginKey) return false;
    const res = await request("POST", ACCOUNT_BASE, "/mobile/s/quickLogin", {
      serverCode: 9006,
      requestSource: 2,
      qrCodeFlag: 0,
      accCategory: "newminihxaj",
      termType: "1",
      loginKey: this.loginKey,
      sid: `sid-${Date.now()}-${randHex()}`,
    }, { signType: "WEB_CN_GW" });
    const data = res.data?.data || {};
    const tokenInfo = data.tokenInfo || {};
    if (res.status === 200 && Number(data.resultCode) === 0 && tokenInfo.token) {
      this.customerId = tokenInfo.customerId || this.customerId;
      this.accessToken = tokenInfo.token;
      this.refreshToken = tokenInfo.refreshToken || this.refreshToken;
      this.saveCache({ loginType: "loginKey" });
      $.log(`账号[${this.index}] loginKey 登录成功: ${mask(this.customerId || this.accessToken)}`);
      return true;
    }
    $.log(`账号[${this.index}] loginKey 登录失败: ${short(res.data, 300)}`);
    return false;
  }

  async fetchLoginKey() {
    if (!this.accessToken || this.loginKey) return;
    const res = await request("GET", ACCOUNT_BASE, "/mobile/st/getLoginKey", {
      accessToken: this.accessToken,
      keyType: 1,
    }, { signType: "WEB_CN_GW" });
    const data = res.data?.data || {};
    if (res.status === 200 && Number(data.resultCode) === 0 && data.loginKey) {
      this.loginKey = data.loginKey;
      this.saveCache({ loginKey: this.loginKey });
      $.log(`账号[${this.index}] loginKey 已缓存`);
    } else {
      $.log(`账号[${this.index}] loginKey 获取失败: ${short(res.data, 300)}`);
    }
  }

  async loginByPhoneAuth() {
    let op = {};
    if (this.phoneCode || (this.encryptedData && this.iv)) {
      op = {
        phoneCode: this.phoneCode,
        encryptedData: this.encryptedData,
        iv: this.iv,
        code: this.loginCode,
      };
    } else if (this.openid) {
      op = await this.getPhoneNumberData();
    } else {
      return false;
    }
    const phoneCode = op.phoneCode || this.phoneCode || "";
    const loginCode = this.loginCode || (phoneCode ? "" : op.code || (this.openid ? await this.getWxCode() : ""));
    const loginPayload = {
      deviceId: this.deviceId,
      ...(phoneCode
        ? { phoneCode }
        : {
            iv: op.iv,
            loginCode,
            encryptedData: op.encryptedData,
          }),
      miniId: MINI_ID,
      sid: uuid(),
    };
    const res = await request("POST", WXTV_BASE, "/weixintv/oauth/login4MiniAPPByPhone", loginPayload, { signType: "WEB_CN" });
    const data = res.data || {};
    if (res.status === 200 && Number(data.resultCode) === 0 && data.token) {
      this.customerId = data.customerId || this.customerId;
      this.accessToken = data.token;
      this.refreshToken = data.refreshToken || this.refreshToken;
      this.saveCache({ loginType: "phoneAuth" });
      $.log(`账号[${this.index}] 手机授权登录成功: ${mask(this.customerId || this.accessToken)}`);
      return true;
    }
    const msg = data?.data?.errorDesc || data?.errorDesc || data?.message || short(data, 300);
    $.log(`账号[${this.index}] 手机授权登录失败: ${msg}`);
    return false;
  }

  async ensureLogin() {
    this.loadCache();
    if (this.accessToken && this.customerId) {
      this.saveCache({ loginType: "direct" });
      return;
    }
    if (this.accessToken && !this.customerId) {
      $.log(`账号[${this.index}] 已有 token 但缺少 customerId，请使用 账号标识#customerId#accessToken 或 JSON 配置`);
    }
    if (await this.refreshAccessToken()) return;
    if (await this.loginByLoginKey()) return;
    if (await this.loginByPhoneAuth()) return;
    throw new Error("未获取到海信业务 customerId/accessToken；首次账号需要手机号授权，请配置 账号标识#customerId#accessToken 或 JSON");
  }

  commonPointParams() {
    const mobile = this.phone ? encryptByAppKey(this.phone) : "";
    return {
      customerId: String(this.customerId),
      mobile,
      accessToken: this.accessToken,
      appType: MINI_ID,
    };
  }

  commonSignParams() {
    const mobile = this.phone ? encryptByAppKey(this.phone) : "";
    return {
      deviceId: this.deviceId,
      appPackageName: APP_PACKAGE,
      appVersionName: DEFAULT_VALUE,
      appVersionCode: DEFAULT_VALUE,
      license: DEFAULT_LICENSE,
      appVersion: APP_VERSION,
      deviceExt: "Windows",
      userType: "1",
      customerId: String(this.customerId),
      mobile,
      accessToken: this.accessToken,
      userId: String(this.customerId),
    };
  }

  async pointScore(pathname, data = {}) {
    const res = await request("POST", POINT_BASE, pathname, { ...this.commonPointParams(), ...data }, { signType: "WEB_CN_GW" });
    if (res.status !== 200 || isTokenError(res.data)) throw new Error(`${pathname}失败: ${short(res.data, 500)}`);
    return res.data;
  }

  async pointSign(pathname, data = {}, query = {}) {
    const url = Object.keys(query).length ? addSearch(`${POINT_BASE}${pathname}`, query) : `${POINT_BASE}${pathname}`;
    const res = await request("POST", "", url, { ...this.commonSignParams(), ...data }, { signType: "WEB_CN_GW" });
    if (res.status !== 200 || isTokenError(res.data)) throw new Error(`${pathname}失败: ${short(res.data, 500)}`);
    return res.data;
  }

  async queryProfile() {
    const res = await request("GET", "", `${POINT_BASE}/MobileMiniAppAPI/s/6.3/account/getCustomerProfile`, {
      accessToken: this.accessToken,
      timeStamp: Math.floor(Date.now() / 1000),
      customerId: this.customerId,
      randStr: pureGuid(),
    }, { signType: "WEB_CN_GW" });
    if (res.status === 200 && Number(res.data?.resultCode) === 0) {
      const data = res.data.data || {};
      this.phone = decryptByAppKey(data.mobilePhone || "") || this.phone;
      this.saveCache({ phone: this.phone });
      $.log(`账号[${this.index}] 用户: ${mask(data.mobilePhone || this.customerId)}${data.nickName ? `，${data.nickName}` : ""}`);
    } else {
      $.log(`账号[${this.index}] 用户信息查询失败: ${short(res.data, 300)}`);
    }
  }

  async queryPoints() {
    const res = await this.pointScore("/AIoTPointsMall/gw/svc/HiScore/1.0/userPoints", {});
    if (Number(res.resultCode) !== 0) throw new Error(`积分查询失败: ${short(res, 500)}`);
    const data = res.data || {};
    $.log(`账号[${this.index}] 总积分: ${data.totalScore ?? 0}`);
    return data;
  }

  async queryTodayRecords() {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const end = new Date();
    end.setHours(23, 59, 59, 999);
    const res = await this.pointScore("/AIoTPointsMall/gw/svc/HiScore/1.0/userPointRecords", {
      pageNo: "1",
      pageSize: "100",
      startTime: start.getTime(),
      endTime: end.getTime(),
    });
    if (Number(res.resultCode) !== 0 && res.data?.resultCode !== "B0306") throw new Error(`今日积分记录查询失败: ${short(res, 500)}`);
    const list = Array.isArray(res.data?.entities) ? res.data.entities : [];
    const income = list.filter((item) => Number(item.type) === 1).reduce((sum, item) => sum + Number(item.score || 0), 0);
    $.log(`账号[${this.index}] 今日获得积分: ${income}`);
    if (list.length) $.log(`账号[${this.index}] 今日记录: ${list.slice(0, 5).map((v) => `${v.scoreName || v.name || "积分"}+${v.score || 0}`).join("；")}`);
    return list;
  }

  async getSceneParam(sceneCode) {
    const res = await request("GET", WXTV_BASE, "/vodapptv/5.10/sceneParams/data/get", {
      accessToken: this.accessToken,
      type: 2,
      sceneCode,
    }, { signType: "NONE" });
    if (res.status !== 200 || Number(res.data?.resultCode) !== 0) throw new Error(`编排查询失败: ${short(res.data, 500)}`);
    return extractSceneParam(res.data, sceneCode);
  }

  async getSignTaskId() {
    if (process.env.hisense_aijia_sign_task_id) return process.env.hisense_aijia_sign_task_id;
    const scene = await this.getSceneParam("STATIC_AILIFE_SIGN_INFO");
    const taskId = findTaskId(scene);
    if (!taskId) throw new Error(`未解析到签到 taskId: ${short(scene, 500)}`);
    $.log(`账号[${this.index}] 签到任务ID: ${taskId}`);
    return taskId;
  }

  async querySignStatus(taskId) {
    const res = await this.pointSign("/AIoTPointsMall/gw/svc/HiVip/1.0/getCheckInStatus", {
      taskId,
      sourceType: SOURCE_TYPE,
    });
    if (String(res.code ?? "1") !== "0") throw new Error(`签到状态查询失败: ${short(res, 500)}`);
    const status = res.checkInStatus || {};
    $.log(`账号[${this.index}] 签到状态: ${formatSignStatus(status)}`);
    return status;
  }

  async signIn(taskId, status = {}) {
    if (status.signedToday) {
      $.log(`账号[${this.index}] 今日已签到`);
      return;
    }
    const rewards = Array.isArray(status.rewardSignTaskList) ? status.rewardSignTaskList : [];
    const days = Number(status.keepSigningDays || 0);
    const reward = rewards[Math.max(0, days)] || rewards[0] || {};
    if (reward.rewardType !== undefined && Number(reward.rewardType) !== 130) {
      $.log(`账号[${this.index}] 当前奖励类型异常，跳过签到`);
      return;
    }
    const now = Date.now();
    const res = await this.pointSign(
      "/AIoTPointsMall/gw/svc/HiVip/1.0/checkIn",
      {
        returnCheckInStatus: false,
        requestId: `ailife_sign-${now}-${randHex()}`,
        taskId,
        reportToGroup: 1,
        requestTime: String(now),
      },
      { customerId: this.customerId }
    );
    if (String(res.code ?? "1") === "0") {
      $.log(`账号[${this.index}] 签到成功${reward.rewardNum ? `，预计获得${reward.rewardNum}积分` : ""}`);
    } else {
      const msg = res.message || res.msg || short(res, 300);
      if (/已签|重复|today/i.test(msg)) $.log(`账号[${this.index}] 今日已签到: ${msg}`);
      else $.log(`账号[${this.index}] 签到失败: ${msg}`);
    }
  }

  async run() {
    try {
      await this.ensureLogin();
      $.log(`账号[${this.index}] 登录态: customerId=${mask(this.customerId)} token=${mask(this.accessToken)}`);
      await this.queryProfile();
      await this.queryPoints();
      await this.queryTodayRecords();
      const taskId = await this.getSignTaskId();
      const status = await this.querySignStatus(taskId);
      await this.signIn(taskId, status);
      await this.queryPoints();
    } catch (e) {
      $.log(`账号[${this.index}] 运行失败: ${e.message || e}`);
    }
  }
}

!(async () => {
  let accounts;
  try { accounts = yybAccounts(); } catch (e) { $.log(`❌ ${e.message || e}`); return; }
  $.log(`共找到${accounts.length}个YYB账号`);
  for (const raw of accounts) {
    const task = new Task(raw);
    await task.run();
  }
  await $.done();
})();
