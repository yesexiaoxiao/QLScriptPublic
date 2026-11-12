// name: 小紫有约签到
/*
------------------------------------------
@Description: 小紫有约 - 微信小程序静默登录 + 每日签到
cron: 35 8 * * *
------------------------------------------

------------------------------------------
契约（appid wx3db193ecdebd3fea，host sxkyziqidonglai.cn）：
（迁移自 YYB-GO 系脚本，原脚本已 code 登录）

登录  GET /api/platform/wechatAuthenticate?code&channelCode&siteId&deviceHash
        -> success && status==200，data.sessionId；session 放 cookie: SESSION=<id>
        （msg「请用手机号登录完善用户信息」= 未做手机号注册，签到会 401 身份校验失败）
用户  POST /api/mobile/eShop/eshopVipUser/getUserInfo (form) {siteId} -> status200，data.phone/balance；401=未登录/未注册
签到  POST /api/mobile/activity-v2/activity/launchByValidater (json) {actCode, siteId}
        -> status==200 成功；status==412 且含「已完成签到」= 已签
actCode：按月生成候选 SG{YY}{上月}{0-9} 逐个探测（原脚本机制，每月缓存）。
------------------------------------------
 YYB-Go 版：取码改走 YYB-Go（POST /wxapp/getCode），不再依赖原取码桥接服务。
 变量：YYB_SERVER 每行 地址@账号标识（例如 http://yyb-go:8000@1）；YYB_API_KEY 可选。
 原桥接版脚本见 wxapp/xzyy.js，业务接口、流程与缓存格式均未改动。
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
const $ = new Env("小紫有约签到");
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

const MINI_APP_ID = "wx3db193ecdebd3fea";
const HOST = "sxkyziqidonglai.cn";
const BASE = `https://${HOST}`;
const CHANNEL_CODE = "WXjxriol8e8293wezu";
const DEVICE_HASH = "lkmtJuKGKQ0_S6Oem6ZIv3YoiHYGgoMf";
const SITE_ID = "SITE_33254242630091515087";
const SESSION_CACHE_FILE = path.join(__dirname, "tokencache", "xzyy_token_cache.json");
const ACTCODE_CACHE_FILE = path.join(__dirname, "tokencache", "xzyy_actcode_cache.json");
const UA = "Mozilla/5.0 (Linux; Android 12; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/146.0.0.0 Mobile Safari/537.36 MicroMessenger/8.0.5 MiniProgramEnv/android";

const API_WX_AUTH = "/api/platform/wechatAuthenticate";
const API_USER_INFO = "/api/mobile/eShop/eshopVipUser/getUserInfo";
const API_SIGN = "/api/mobile/activity-v2/activity/launchByValidater";

const yyb = new YYBClient({ appid: MINI_APP_ID });

function readCache(file) {
    try {
        if (!fs.existsSync(file)) return {};
        return JSON.parse(fs.readFileSync(file, "utf8")) || {};
    } catch (e) {
        return {};
    }
}
function writeCache(file, cache) {
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(cache, null, 2), "utf8");
    } catch (e) {
        $.log(`写入缓存失败: ${e.message || e}`);
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
function commonHeaders(session) {
    const h = {
        "User-Agent": UA,
        accept: "application/json, text/plain, */*",
        "content-type": "application/json",
        origin: BASE,
        referer: `${BASE}/mall/personal?siteId=${SITE_ID}&channelCode=${CHANNEL_CODE}`,
        "x-requested-with": "com.tencent.mm",
    };
    if (session) h.cookie = `SESSION=${session}`;
    return h;
}
/** actCode 候选：SG + 两位年 + 上个月 + 0..9（原脚本机制） */
function generateCandidates() {
    const now = new Date();
    let lm = now.getMonth(); // getMonth 是 0..11，即“当前月-1”正好是上个月的月份数
    let year = now.getFullYear();
    if (lm === 0) { lm = 12; year -= 1; }
    const y2 = String(year % 100).padStart(2, "0");
    return Array.from({ length: 10 }, (_, i) => `SG${y2}${lm}${i}`);
}
function monthKey() {
    const now = new Date();
    return `${now.getFullYear()}-${now.getMonth() + 1}`;
}

class Task {
    constructor(raw) {
        this.index = $.userIdx++;
        this.account = parseAccount(raw);
        this.session = "";
    }
    log(text) {
        $.log(`账号[${this.index}]${this.account.remark ? `[${this.account.remark}]` : ""} ${text}`);
    }
    /** 取 wx.login code：YYB-Go /wxapp/getCode（一个账号一次请求，失败即抛错） */
    async getCode() {
        return yyb.getCode(this.account.openid);
    }
    async login() {
        const code = await this.getCode();
        const res = await axios.request({
            method: "GET", url: `${BASE}${API_WX_AUTH}`,
            params: { code, channelCode: CHANNEL_CODE, siteId: SITE_ID, deviceHash: DEVICE_HASH },
            headers: commonHeaders(), timeout: 20000, validateStatus: () => true,
        });
        const d = res.data || {};
        if (!(d.success && Number(d.status) === 200) || !(d.data || {}).sessionId) {
            throw new Error(`登录失败: ${d.msg || short(d)}`);
        }
        this.session = d.data.sessionId;
        // 「请用手机号登录完善用户信息」= 未做手机号注册
        this.unregistered = /请用手机号登录|完善用户信息/.test(String(d.msg || ""));
        const cache = readCache(SESSION_CACHE_FILE);
        cache[this.account.openid] = { session: this.session, updatedAt: new Date().toISOString() };
        writeCache(SESSION_CACHE_FILE, cache);
        this.log(`登录成功${this.unregistered ? "（该微信号未做手机号注册）" : ""}`);
    }
    async checkUser() {
        const res = await axios.request({
            method: "POST", url: `${BASE}${API_USER_INFO}`,
            data: `siteId=${encodeURIComponent(SITE_ID)}`,
            headers: { ...commonHeaders(this.session), "content-type": "application/x-www-form-urlencoded" },
            timeout: 20000, validateStatus: () => true,
        });
        const rs = res.data || {};
        if (Number(rs.status) === 200) return { ok: true, phone: (rs.data || {}).phone, balance: (rs.data || {}).balance };
        return { ok: false, msg: rs.msg };
    }
    async trySign(actCode) {
        const res = await axios.request({
            method: "POST", url: `${BASE}${API_SIGN}`, data: { actCode, siteId: SITE_ID },
            headers: commonHeaders(this.session), timeout: 20000, validateStatus: () => true,
        });
        const rs = res.data || {};
        const status = Number(rs.status);
        const msg = String(rs.msg || "");
        if (rs.success || status === 200) return { done: true, already: false, msg };
        if (status === 412 && /已完成签到/.test(msg)) return { done: true, already: true, msg };
        return { done: false, status, msg };
    }
    /** 取本月缓存的 actCode，没有则用候选逐个探测 */
    async resolveActCodeAndSign() {
        const cache = readCache(ACTCODE_CACHE_FILE);
        const mk = monthKey();
        if (cache.month === mk && cache.actCode) {
            const r = await this.trySign(cache.actCode);
            if (r.done) return r;
            // 缓存失效则重新探测
        }
        const candidates = generateCandidates();
        this.log(`探测 actCode（${candidates[0]}..${candidates[candidates.length - 1]}）`);
        let lastMsg = "";
        for (const act of candidates) {
            const r = await this.trySign(act);
            lastMsg = r.msg;
            if (r.done) {
                writeCache(ACTCODE_CACHE_FILE, { month: mk, actCode: act });
                return r;
            }
            // 身份校验失败=账号未注册，无需继续探测
            if (Number(r.status) === 401) return { done: false, status: 401, msg: r.msg };
            await $.wait(1200, 2000);
        }
        return { done: false, msg: lastMsg || "未找到有效 actCode" };
    }
    async sign() {
        const u = await this.checkUser();
        if (!u.ok || this.unregistered) {
            return this.log(`⚠️ 该微信号还没在小紫有约做手机号注册（${u.msg || "未登录"}），先在小程序里手机号登录一次再跑`);
        }
        const r = await this.resolveActCodeAndSign();
        if (r.done && r.already) return this.log(`✅ 今日已签到（${r.msg}）`);
        if (r.done) return this.log(`✅ 签到成功`);
        if (Number(r.status) === 401) return this.log(`⚠️ 身份校验失败（${r.msg}），该微信号可能未完成注册`);
        this.log(`❌ 签到失败: ${r.msg}`);
    }
    async ensureLogin() {
        const cached = readCache(SESSION_CACHE_FILE)[this.account.openid] || {};
        if (!this.session && cached.session) {
            this.session = cached.session;
            // 用 getUserInfo 校验缓存 session 是否仍有效
            const u = await this.checkUser();
            if (u.ok) { this.log("使用缓存session"); return; }
            this.session = "";
        }
        if (!this.session) await this.login();
    }
    async run() {
        if (!this.account.openid) { this.log("跳过：变量值里没有 openid"); return; }
        try {
            await this.ensureLogin();
            await this.sign();
        } catch (e) {
            this.log(`执行失败: ${e.message || e}`);
        }
    }
}

!(async () => {
    let accounts;
    try { accounts = yybAccounts(); } catch (e) { $.log(`❌ ${e.message || e}`); return; }
    $.log(`共找到${accounts.length}个YYB账号`);
    for (let i = 0; i < accounts.length; i++) {
        await new Task(accounts[i]).run();
        if (i < accounts.length - 1) await $.wait(1500, 3000);
    }
})().catch((e) => $.log(e.message || e)).finally(() => $.done());
