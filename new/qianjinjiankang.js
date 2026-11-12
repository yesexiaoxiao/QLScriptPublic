// name: 千金健康生活微信小程序签到
/*
------------------------------------------
@Author: sm
@Date: 2026.06.01
@Description:  千金健康生活微信小程序签到
cron: 30 8 * * *
------------------------------------------
#Notice:
变量名 qianjinjiankang

⚠️【免责声明】
------------------------------------------
1、此脚本仅用于学习研究，不保证其合法性、准确性、有效性，请根据情况自行判断，本人对此不承担任何保证责任。
2、由于此脚本仅用于学习研究，您必须在下载后 24 小时内将所有内容从您的计算机或手机或任何存储设备中完全删除，若违反规定引起任何事件本人对此均不负责。
3、请勿将此脚本用于任何商业或非法目的，若违反规定请自行对此负责。
4、此脚本涉及应用与本人无关，本人对因此引起的任何隐私泄漏或其他后果不承担任何责任。
5、本人对任何脚本引发的问题概不负责，包括但不限于由脚本错误引起的任何损失和损害。
6、如果任何单位或个人认为此脚本可能涉嫌侵犯其权利，应及时通知并提供身份证明，所有权证明，我们将在收到认证文件确认后删除此脚本。
7、所有直接或间接使用、查看此脚本的人均应该仔细阅读此声明。本人保留随时更改或补充本声明的权利。一旦您使用或复制了此脚本，即视为您已接受此免责声明。
 YYB-Go 版：取码改走 YYB-Go（POST /wxapp/getCode），不再依赖原取码桥接服务。
 变量：YYB_SERVER 每行 地址@账号标识（例如 http://yyb-go:8000@1）；YYB_API_KEY 可选。
 原桥接版脚本见 wxapp/qianjinjiankang.js，业务接口、流程与缓存格式均未改动。
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
const $ = new Env("千金健康生活微信小程序签到");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

const strSplitor = "#";
const MINI_APP_ID = "wxf5a93358ebb65e29";

const yyb = new YYBClient({ appid: MINI_APP_ID });
const PAGE_VERSION = "35";
const API_BASE = "https://rs-crm.qjyy.com";
const WX_API_BASE = "https://ops-crm.qjyy.com/api/wechat";
const TASK_PACK_ACTIVITY_ID = 12;
const SIGN_TASK_CODE = "8361ec6193a74fabb3a9f67b73858f7b";
const TOKEN_CACHE_FILE = path.join(__dirname, "tokencache", "qianjinjiankang_token_cache.json");
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090a13)";

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
        fs.mkdirSync(path.dirname(TOKEN_CACHE_FILE), { recursive: true }); fs.writeFileSync(TOKEN_CACHE_FILE, JSON.stringify(cache, null, 2), "utf8");
    } catch (e) {
        $.log(`写入token缓存失败: ${e.message || e}`);
    }
}

function shortToken(token = "") {
    return token ? `${token.slice(0, 8)}***${token.slice(-6)}` : "";
}

function maskPhone(phone = "") {
    const text = String(phone || "");
    return /^1\d{10}$/.test(text) ? `${text.slice(0, 3)}****${text.slice(7)}` : text;
}

function getContent(result) {
    return result?.content || result?.data || result || {};
}

function isTokenError(e) {
    return /401|403|token|登录|授权|ERR_USER_TOKEN_ERROR|用户令牌/i.test(String(e?.message || e || ""));
}

class Task {
    constructor(env) {
        this.index = $.userIdx++;
        this.user = String(env || "").trim().split(strSplitor);
        this.openid = (this.user[0] || "").trim();
        this.token = "";
        this.tenId = "";
        this.wxOpenid = "";
        this.customerInfo = {};
    }

    async run() {
        const cached = this.getCachedToken();
        if (cached?.accessToken) {
            this.applyToken(cached);
            $.log(`账号[${this.index}] 使用缓存token: ${shortToken(this.token)}`);
            if (!(await this.checkToken())) {
                $.log(`账号[${this.index}] 缓存token失效，重新登录`);
                this.removeCachedToken();
            }
        }

        if (!this.token) {
            await this.loginByWxCode();
            if (!this.token) return;
        }

        await this.getCustomerInfo();
        await this.signIn();
    }

    getCachedToken() {
        const cache = readTokenCache();
        return cache[this.openid] || null;
    }

    saveCachedToken() {
        if (!this.token || !this.tenId) return;
        const cache = readTokenCache();
        cache[this.openid] = {
            accessToken: this.token,
            tenId: this.tenId,
            wxOpenid: this.wxOpenid,
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
        this.tenId = "";
        this.wxOpenid = "";
    }

    applyToken(data = {}) {
        this.token = data.accessToken || data.token || "";
        this.tenId = data.tenId || data.tenid || "";
        this.wxOpenid = data.wxOpenid || data.openid || "";
    }

    headers(extra = {}) {
        return {
            "content-type": "application/json; charset=UTF-8",
            Authorization: this.token || "",
            wxAppId: MINI_APP_ID,
            Referer: `https://servicewechat.com/${MINI_APP_ID}/${PAGE_VERSION}/page-frame.html`,
            "User-Agent": USER_AGENT,
            ...extra,
        };
    }

    async request(method, url, data = {}, options = {}) {
        const req = {
            method,
            url,
            headers: this.headers(options.headers || {}),
            timeout: options.timeout || 30000,
            validateStatus: () => true,
        };
        if (method === "GET") req.params = data;
        else req.data = data || {};

        const { data: result, status } = await axios.request(req);
        if (status !== 200) throw new Error(`HTTP ${status}: ${JSON.stringify(result)}`);
        if (!result || ![0, 200].includes(Number(result.code))) {
            throw new Error(`${result?.code ?? ""} ${result?.message || result?.msg || JSON.stringify(result)}`.trim());
        }
        return getContent(result);
    }

    async api(pathname, data = {}, method = "POST") {
        if (!this.tenId) throw new Error("缺少tenId，无法请求业务接口");
        return this.request(method, `${API_BASE}${pathname}?tenid=${this.tenId}`, data);
    }

    /** 取 wx.login code：YYB-Go /wxapp/getCode（一个账号一次请求，失败即抛错） */
    async getOperateData() {
        return yyb.getCode(this.openid);
    }

    async loginByWxCode() {
        try {
            const wxData = await this.getOperateData();
            const data = await this.request("GET", `${WX_API_BASE}/user/auth/mini`, {
                code: wxData.code,
                appId: MINI_APP_ID,
                app: 503,
            }, { headers: { Authorization: "" } });

            this.token = data.accessToken || "";
            this.tenId = data.tenId || "";
            this.wxOpenid = data.openid || "";
            if (!this.token || !this.tenId) throw new Error(`登录响应缺少token/tenId: ${JSON.stringify(data)}`);

            this.saveCachedToken();
            $.log(`账号[${this.index}] CODE登录成功: tenId=${this.tenId} openid=${this.wxOpenid}`);
        } catch (e) {
            $.log(`账号[${this.index}] CODE登录失败: ${e.message || e}`);
        }
    }

    async checkToken() {
        try {
            await this.getCustomerInfo(false);
            return true;
        } catch (e) {
            return false;
        }
    }

    async getCustomerInfo(log = true) {
        const data = await this.api("/api/crm/rest/v2/customer/info", {});
        this.customerInfo = data || {};
        if (log) {
            $.log(`账号[${this.index}] 会员: ${this.customerInfo.cstName || this.customerInfo.cstId || ""} ${maskPhone(this.customerInfo.phone || "")} 积分=${this.customerInfo.pointall ?? this.customerInfo.points ?? "未知"}`);
        }
        return data;
    }

    async getSignTaskStatus() {
        return this.api("/api/crm/iactivity/taskPack/status", {
            activityId: TASK_PACK_ACTIVITY_ID,
            taskCode: SIGN_TASK_CODE,
        });
    }

    async signIn() {
        try {
            const status = await this.getSignTaskStatus();
            $.log(`账号[${this.index}] 签到状态: status=${status.status ?? ""} buttonType=${status.buttonType || ""}`);
            if ([1, 2, 55].includes(Number(status.status)) || /已完成|已签到/i.test(String(status.buttonType || ""))) {
                $.log(`账号[${this.index}] 今日已签到`);
                return;
            }

            const data = await this.api("/api/crm/iactivity/taskPack/participate", {
                activityId: TASK_PACK_ACTIVITY_ID,
                taskCode: SIGN_TASK_CODE,
            });
            const awards = (data.givenRecords || []).map((item) => item.awardName).filter(Boolean).join("+");
            $.log(`账号[${this.index}] 签到成功${awards ? `，获得${awards}` : ""}`);
        } catch (e) {
            const message = e.message || String(e);
            $.log(`账号[${this.index}] 签到失败: ${message}`);
            if (isTokenError(message)) this.removeCachedToken();
        }
    }
}

!(async () => {
    let accounts;
    try { accounts = yybAccounts(); } catch (e) { $.log(`❌ ${e.message || e}`); return; }
    $.log(`共找到${accounts.length}个YYB账号`);
    for (const item of accounts) {
        if (!item) continue;
        const task = new Task(item);
        await task.run();
        await $.wait(1000);
    }
})()
    .catch((e) => $.log(e.message || e))
    .finally(() => $.done());
