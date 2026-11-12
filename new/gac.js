// name: 广汽丰田新能源签到
/*
------------------------------------------
@Description: 广汽丰田新能源 - 微信小程序静默登录 + 每日签到
cron: 26 11,17 * * *
------------------------------------------

------------------------------------------
契约（appid wxd8a42d1c0c59c15d）：
（迁移自 YYB-GO 系脚本，原脚本已 code 登录）

两段式登录：
  1) 小程序登录  POST https://xcx.nevapp.gtmc.com.cn/wxapp/nev-prod/bff-nev-wxapp/auth/login?code=<code>
       头 apiVersion:1.4.0 -> header.code==10000000，body.token(xcxToken)、body.openId
  2) 换网关token POST https://gw.nevapp.gtmc.com.cn/ha/iam/api/sec/oauth/token
       体(AES-128-CBC，key/iv 随机，key@DS@iv 经 RSA-PKCS1v1.5 公钥加密)：
         {grant_type:'password', username:<常量占位>, password:xcxToken, auth_type:'newminipg'}
       头 Authorization:Basic bmV2YXBwOnNlY3JldA== / appId / timestamp / nonce /
          sig=md5(ts+'Basic bmV2YXBwOnNlY3JldA=='+nonce+APP_ID+APP_SIG_SECRET)
       响应 AES 加密(encryptData/encryptKey) -> body.accessToken(gwToken, JWT)
签到  POST https://gw.nevapp.gtmc.com.cn/main/api/marketing/lgn/task/sec/signinV2 {gtmcUid:'',fromApplication:'0'}
       头 Authorization:<gwToken> / appId / sig=md5(ts+tokenRaw+nonce+APP_ID+APP_SIG_SECRET)
       -> header.code==10000000
查签到本 GET /main/api/marketing/lgn/sec/usersign/getAttendanceBook?beginTime&endTime -> body.todayHasSigned
APP_ID/APP_SIG_SECRET/RSA公私钥/Basic 串 均为该小程序固定应用常量（原脚本硬编码，非个人凭证）。
------------------------------------------
 YYB-Go 版：取码改走 YYB-Go（POST /wxapp/getCode），不再依赖原取码桥接服务。
 变量：YYB_SERVER 每行 地址@账号标识（例如 http://yyb-go:8000@1）；YYB_API_KEY 可选。
 原桥接版脚本见 wxapp/gac.js，业务接口、流程与缓存格式均未改动。
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
const $ = new Env("广汽丰田新能源签到");
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

const MINI_APP_ID = "wxd8a42d1c0c59c15d";
const API_VERSION = "1.4.0";
const PAGE_VERSION = "138";

const GW_BASE = "https://gw.nevapp.gtmc.com.cn";
const XCX_BASE = "https://xcx.nevapp.gtmc.com.cn/wxapp/nev-prod/bff-nev-wxapp";
const APP_ID = "ecb4fdd3-da09-408a-913b-44d311d03105";
const APP_SIG_SECRET = "611ac848-be11-404e-b7a3-54f735d2eb3e";
const BASIC_AUTH = "Basic bmV2YXBwOnNlY3JldA=="; // base64("nevapp:secret") 应用固定
// oauth password grant 的 username：原脚本写死，password 才是每号 xcxToken。
// 允许用变量覆盖以便验证其是否 load-bearing；默认沿用原脚本占位值。
const OAUTH_USERNAME = process.env.gac_oauth_user || "18825160040";
const DIAG = process.env.gac_diag === "1";

// 小程序内嵌固定 RSA 密钥对（应用级，用于请求/响应 AES 密钥的 RSA 包裹，非个人凭证）
const PUBLIC_KEY = "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA49jxpFBAoEslNYrHb0wT8nCpGBn3hvjgToNkp7lFpsSeRS7WbHoFJEvmf1U83cHrbTzRFRowPft/FGBw6/6dZcmMjMgz1n0FWlqk0d7QjEDL+t9Dj9tH9e/qdGfJ3bzR0ZgpgQMpKpx5I5fcEgzMYnHWGLZBY+v+PlPTN/1mz0nnRtIIxb8YuZZFvadfGTC8jeD7tMERpd5zENml5cLbVujENsag9AIpvLdvR6fSewi3l9QmssWpty50UpcAWsvAs+ExRYyUe/s1lwfSdSciW6Lrj4sp4MMaWifdTQUbKKEeuRugEqJSDrxhxoybEbSbl2CYaTR8kifZ1n+lcAh6cQIDAQAB";
const PRIVATE_KEY = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCUEPwXFgsGTngqifX48k/5CRBNVA2/mLJhl+fP7Z0UHrSQmI31rtXcb9zN6PMG0jvNxk0oLvrUgf1K/lfgDp0noUQpCbHqkCk0CGQogSIVr/ktu5lhev0/P+9pkFfXrrZWKYhBk/z7r/XYvmsm4TVyFhge5WZqfY+HXhFmzJEu9lhq9VACXsfXJ6O778Dj3fF6hHsyNsai+qGNL31bdObxJG8EhWNcwK0ejCa8XzsscasbjZ/AhTwAQf9kxT9diCZv2vWvK5QtDhxMbqyQ6lFE8Ew9jaAHYnp2jxh3CwcAMp9B0+Ne4JOBaY7IjH9ENqMC29cYnhxNhj3ZGcbEu6lpAgMBAAECggEBAISKY66iu8GscmLZ1kY/Whk55M7jw97TaDJ2UTrOn8KH7ehVtxXKqIPH2qaztQBRJtl/fkfPLhcWOU9tN+pICqOT9zipBgtLeqaqMEYVuhYhzPMEMDuTZai9qakcXZWjPnMIgID7YQVHsNGROse15yq13mehv7jpppZtPTSBQCEBZAw+SFNS4KVfBDKNntlesEuLJHGWWXnqxWwK3YA4IdUAJjT5kDEiYQs7uy2FHqdcZnw7hV/Tt3OWDqrOB8zoZVhEg9dLvqpBaUi6yh9ihUYJBtFegmsFSY7MazHQjYnY8bcEcoma22c3AZbGeRwTwrNrlL0/UvF60L1njx4xhSUCgYEA0Xgh4mFSrp5E0UbMvy5TnpayH1hcaJNFjyGgQGdwgnE69gzR1Grqv+ihSjTbPvQHu9IGnuXb6Pdm/tuj2ml4xTJ9OnTe2/x/TzMIserNfRD1v6prxjNgZc+YDEebxHTWDBtCNpdbOEy27yO4fc9UvIoIbgG5eDTcMwCtiIt+98sCgYEAtPUPBqegfiDzyBP7l2hxhGwFgIrsFYIg3lJwwlyYpZEt8p/TMwPAMb2k+nfQPtyS6T2bBGr2PAKUAubD1SrwGE4ndXO4SDB814ll93ZrE7X18iyoGBwbgpjGMONK3nbS2z+2WrFEtQZaUuLiiZp+hnxk5uW7EQ5RnToOaUTPtRsCgYBNUOhA5Odd6LFCBb4BOxpGSR1KEJVbTDC6mhDKdOPEYgL/WtAAdc5cM4OFHmlmnTBVlTo4YGOBZAAyReP+9DtNnks2zniL/nEHTLEC6sYaSa5Lpp3NNJ16NtvKfIv0QaPYKB+Sgt96smY7cpXgaiy+wrxFzoEk623zrWZgJg0hbQKBgFMkEO5O0CeDPl6cB8lt/FIKS5Dew0+yhSWAnTw/zQatKH5EPoY+3+w6pPVLXUu0jm9JldK2zkGOMbEPk8R6QOv55JlLPM02MfXZtBa5usLIpKLLL8Q8Dcu4I79MfxatY33GzSLoNZgyvgc9JTZx3FYwCzAnNwbEHG1vwjVNn10nAoGASPxDtahASVh/IN6sjFR1soU8fuzEzThpnchfNVp3BeROR/8fXyfyBk3hKGmh6PY41XttKrGBwCaztCwA6zoTv7/SmzqNCzknq4uFbr9o455T0+0gtBKS6vFv1zCnvyMXjcmyCvB7gIRnhoq5W/z9l8VtAagNi9JOhZpjCl7Ep70=";

const CACHE_FILE = path.join(__dirname, "tokencache", "gac_token_cache.json");
const UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 " +
    "MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF";
const REFERER = `https://servicewechat.com/${MINI_APP_ID}/${PAGE_VERSION}/page-frame.html`;

const pubPem = `-----BEGIN PUBLIC KEY-----\n${PUBLIC_KEY.match(/.{1,64}/g).join("\n")}\n-----END PUBLIC KEY-----`;
const priPem = `-----BEGIN PRIVATE KEY-----\n${PRIVATE_KEY.match(/.{1,64}/g).join("\n")}\n-----END PRIVATE KEY-----`;
const priJwk = crypto.createPrivateKey(priPem).export({ format: "jwk" });
const b64uToBuf = (s) => Buffer.from(String(s).replace(/-/g, "+").replace(/_/g, "/"), "base64");
const b64uToBigInt = (s) => BigInt(`0x${b64uToBuf(s).toString("hex") || "0"}`);
const priN = b64uToBigInt(priJwk.n);
const priD = b64uToBigInt(priJwk.d);
const priKlen = b64uToBuf(priJwk.n).length;

function modPow(base, exp, mod) {
    let b = base % mod, e = exp, r = 1n;
    while (e > 0n) { if (e & 1n) r = (r * b) % mod; e >>= 1n; b = (b * b) % mod; }
    return r;
}
function rsaEncryptPkcs1V15(plain) {
    return crypto.publicEncrypt({ key: pubPem, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(String(plain))).toString("base64");
}
function rsaDecryptPkcs1V15(encB64) {
    const c = BigInt(`0x${Buffer.from(encB64, "base64").toString("hex") || "0"}`);
    const m = modPow(c, priD, priN);
    let hex = m.toString(16);
    if (hex.length % 2) hex = `0${hex}`;
    let em = Buffer.from(hex, "hex");
    if (em.length < priKlen) em = Buffer.concat([Buffer.alloc(priKlen - em.length, 0), em]);
    if (em.length < 11 || em[0] !== 0x00 || em[1] !== 0x02) throw new Error("RSA解密填充头错误");
    let i = 2;
    while (i < em.length && em[i] !== 0x00) i++;
    if (i < 10 || i >= em.length) throw new Error("RSA解密填充分隔错误");
    return em.slice(i + 1).toString("utf8");
}

const rand = (n = 6) => { let s = ""; while (s.length < n) s += Math.random().toString(36).slice(2); return s.slice(0, n); };
const md5 = (s) => crypto.createHash("md5").update(s).digest("hex");

function aesEncrypt(obj) {
    const key = rand(16), iv = rand(16), keyiv = `${key}@DS@${iv}`;
    const cipher = crypto.createCipheriv("aes-128-cbc", Buffer.from(key), Buffer.from(iv));
    let enc = cipher.update(typeof obj === "string" ? obj : JSON.stringify(obj), "utf8", "base64");
    enc += cipher.final("base64");
    return { encryptKey: rsaEncryptPkcs1V15(keyiv), encryptData: enc };
}
function aesDecrypt(encData, encKey) {
    const keyiv = rsaDecryptPkcs1V15(encKey);
    const [key, iv] = keyiv.split("@DS@");
    const dec = crypto.createDecipheriv("aes-128-cbc", Buffer.from(key), Buffer.from(iv));
    let out = dec.update(encData, "base64", "utf8");
    out += dec.final("utf8");
    return out;
}

function readCache() {
    try { if (!fs.existsSync(CACHE_FILE)) return {}; return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")) || {}; } catch (e) { return {}; }
}
function writeCache(c) {
    try { fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true }); fs.writeFileSync(CACHE_FILE, JSON.stringify(c, null, 2), "utf8"); } catch (e) { $.log(`写入缓存失败: ${e.message || e}`); }
}
function parseAccount(raw = "") {
    const [id, remark] = String(raw).split("#").map((s) => (s || "").trim());
    return { openid: id, remark: remark || "" };
}
function short(v, n = 220) {
    const t = typeof v === "string" ? v : JSON.stringify(v);
    return !t ? "" : t.length > n ? `${t.slice(0, n)}...` : t;
}
function parseJwt(token) {
    try {
        const raw = String(token || "").replace(/^Bearer\s+/i, "").trim();
        const p = raw.split(".")[1];
        return JSON.parse(Buffer.from(p.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    } catch { return {}; }
}

async function jreq(method, url, { headers = {}, data } = {}) {
    const res = await axios.request({
        method, url,
        data: data === undefined ? undefined : (typeof data === "string" ? data : JSON.stringify(data)),
        headers, timeout: 25000, validateStatus: () => true,
    });
    return { status: res.status, data: res.data };
}

class Task {
    constructor(raw) {
        this.index = $.userIdx++;
        this.account = parseAccount(raw);
        this.xcxToken = "";
        this.gwToken = "";
        this.gacOpenId = "";
        this.deviceId = md5(this.account.openid || rand(16)).slice(0, 16);
        this.unregistered = false;
    }
    log(text) {
        $.log(`账号[${this.index}]${this.account.remark ? `[${this.account.remark}]` : ""} ${text}`);
    }
    /** 取 wx.login code：YYB-Go /wxapp/getCode（一个账号一次请求，失败即抛错） */
    async getCode() {
        return yyb.getCode(this.account.openid);
    }
    // 第一段：小程序 code 登录
    async xcxLogin(code) {
        const url = `${XCX_BASE}/auth/login?code=${encodeURIComponent(code)}&clickUrl=${encodeURIComponent("/pages/index/index")}&clickId=`;
        const { data } = await jreq("POST", url, {
            data: { code, clickUrl: "/pages/index/index", clickId: "" },
            headers: { "User-Agent": UA, "content-type": "application/json", apiVersion: API_VERSION, Referer: REFERER },
        });
        if (data?.header?.code !== 10000000) {
            const m = data?.header?.message || short(data);
            // 「请先同意隐私政策」= 需在小程序里一次性授权隐私协议(wx用户交互，无法脚本化)；未注册类同样归 ⚠️
            if (/隐私政策|隐私协议|同意.*协议|未注册|未绑定|未实名|完善|注册会员|绑定手机/.test(String(m))) {
                this.unregistered = true;
                throw new Error(`NO_ACCOUNT:${m}`);
            }
            throw new Error(`小程序登录失败: ${m}`);
        }
        if (!data?.body?.token) throw new Error(`小程序登录返回无token: ${short(data?.body)}`);
        this.xcxToken = data.body.token;
        this.gacOpenId = data.body.openId || "";
        this.log(`小程序登录成功 openId=${this.gacOpenId || "?"} tokenLen=${this.xcxToken.length}`);
        if (DIAG) this.log(`[DIAG] xcxToken jwt=${short(parseJwt(this.xcxToken))}`);
        return data.body;
    }
    // 第二段：换网关 token（返回解密后的 plain，供上层判断成功/未注册）
    async exchangeGwRaw(username, password) {
        const timestamp = Date.now();
        const nonce = rand(6);
        const sig = md5(`${timestamp}${BASIC_AUTH}${nonce}${APP_ID}${APP_SIG_SECRET}`);
        const body = aesEncrypt({ grant_type: "password", username, password, auth_type: "newminipg" });
        const { data } = await jreq("POST", `${GW_BASE}/ha/iam/api/sec/oauth/token`, {
            data: body,
            headers: {
                "User-Agent": UA, "content-type": "application/json", Authorization: BASIC_AUTH,
                appId: APP_ID, timestamp, xweb_xhr: "1", nonce, sig, deviceId: this.deviceId,
                operateSystem: "h5", appVersion: "", Referer: REFERER,
            },
        });
        let plain = data;
        if (data?.encryptData && data?.encryptKey) {
            try { plain = JSON.parse(aesDecrypt(data.encryptData, data.encryptKey)); }
            catch (e) { throw new Error(`网关token响应解密失败: ${e.message} raw=${short(data)}`); }
        }
        return plain;
    }
    async exchangeGw() {
        const plain = await this.exchangeGwRaw(OAUTH_USERNAME, this.xcxToken);
        const code = plain?.header?.code;
        const msg = plain?.header?.message || plain?.header?.msg || "";
        if (code !== 10000000 || !plain?.body?.accessToken) {
            // 登录链已通（拿到 xcxToken），但网关侧无账号 => 未注册/未绑定
            if (/未注册|未绑定|不存在|未实名|no.?account|not.?found|会员|注册/i.test(String(msg)) || code === 10000404 || code === 10001002) {
                this.unregistered = true;
                throw new Error(`NO_ACCOUNT:网关侧无账号(${code} ${msg})`);
            }
            throw new Error(`换取网关token失败: code=${code} msg=${msg} ${short(plain)}`);
        }
        this.gwToken = plain.body.accessToken;
        this.log(`网关token成功 tokenLen=${String(this.gwToken).length}`);
        if (DIAG) this.log(`[DIAG] gwToken jwt=${short(parseJwt(this.gwToken))}`);
        return this.gwToken;
    }
    // 认证后的网关请求
    async gwReq(method, apiPath, query = {}, body = undefined) {
        const qs = Object.keys(query).length ? `?${new URLSearchParams(query).toString()}` : "";
        const ts = Date.now();
        const nonce = rand(6);
        const raw = String(this.gwToken).replace(/^Bearer\s+/i, "").trim();
        const sig = md5(`${ts}${raw}${nonce}${APP_ID}${APP_SIG_SECRET}`);
        const headers = {
            "content-type": "application/json", appId: APP_ID, Authorization: this.gwToken,
            timestamp: String(ts), xweb_xhr: "1", sig, nonce, appVersion: "3.22",
            operateSystem: "h5", deviceId: this.deviceId, "User-Agent": UA, Referer: REFERER,
        };
        const send = method === "GET" ? undefined : (Object.keys(body || {}).length ? aesEncrypt(body) : {});
        const { data } = await jreq(method, `${GW_BASE}${apiPath}${qs}`, { headers, data: send });
        let d = data;
        if (d?.encryptData && d?.encryptKey) d = JSON.parse(aesDecrypt(d.encryptData, d.encryptKey));
        return d;
    }
    async attendance() {
        // 本周一~周日范围（原脚本用 ISO 日期）
        const n = new Date(Date.now() + 8 * 3600 * 1000);
        const day = n.getUTCDay();
        const s = new Date(n); s.setUTCDate(n.getUTCDate() - day);
        const e = new Date(s); e.setUTCDate(s.getUTCDate() + 6);
        const f = (x) => x.toISOString().slice(0, 10);
        const d = await this.gwReq("GET", "/main/api/marketing/lgn/sec/usersign/getAttendanceBook", { beginTime: f(s), endTime: f(e), noLoad: "true" });
        if (d?.header?.code !== 10000000) throw new Error(`查签到本失败: ${d?.header?.code} ${d?.header?.message || short(d)}`);
        return d.body || {};
    }
    async doSignin() {
        const d = await this.gwReq("POST", "/main/api/marketing/lgn/task/sec/signinV2", { noLoad: "true", noTip: "true" }, { gtmcUid: "", fromApplication: "0" });
        return d;
    }
    async sign() {
        let book;
        try { book = await this.attendance(); }
        catch (e) { book = null; this.log(`查签到本异常，直接尝试签到（${e.message}）`); }
        if (book && book.todayHasSigned) return this.log(`✅ 今日已签到${book.continuousDays ? `，已连续 ${book.continuousDays} 天` : ""}`);

        const r = await this.doSignin();
        if (r?.header?.code === 10000000) {
            const pt = r.body?.point ?? r.body?.integral ?? r.body?.score;
            return this.log(`✅ 签到成功${pt !== undefined ? `，+${pt}` : ""}`);
        }
        const msg = r?.header?.message || r?.header?.msg || short(r);
        if (/已签|签到过|重复|已完成|repeat/i.test(String(msg))) return this.log(`✅ 今日已签到（${msg}）`);
        this.log(`❌ 签到失败: ${msg}`);
    }
    async ensureLogin() {
        const cached = readCache()[this.account.openid] || {};
        const exp = parseJwt(cached.gwToken || "").exp || 0;
        if (cached.gwToken && exp > Math.floor(Date.now() / 1000) + 60) {
            this.gwToken = cached.gwToken;
            try { const b = await this.attendance(); this.log("使用缓存token"); return b; }
            catch (e) { this.log(`缓存token失效，重新登录（${e.message}）`); this.gwToken = ""; }
        }
        const code = await this.getCode();
        await this.xcxLogin(code);

        if (DIAG) await this.diagProbe();

        await this.exchangeGw();
        const cache = readCache();
        cache[this.account.openid] = { xcxToken: this.xcxToken, gwToken: this.gwToken, gacOpenId: this.gacOpenId, updatedAt: new Date().toISOString() };
        writeCache(cache);
        this.log("登录成功");
    }
    // 诊断：用同一 xcxToken 换不同 username / 破坏 password，判断 username(手机号) 是否 load-bearing
    async diagProbe() {
        const idOf = (p) => { const j = parseJwt(p?.body?.accessToken || ""); return `code=${p?.header?.code} msg=${p?.header?.message || ""} jwt=${short(j, 260)}`; };
        try { this.log(`[DIAG] A 原username+真token => ${idOf(await this.exchangeGwRaw(OAUTH_USERNAME, this.xcxToken))}`); } catch (e) { this.log(`[DIAG] A err ${e.message}`); }
        try { this.log(`[DIAG] B 假username(13000000000)+真token => ${idOf(await this.exchangeGwRaw("13000000000", this.xcxToken))}`); } catch (e) { this.log(`[DIAG] B err ${e.message}`); }
        try { this.log(`[DIAG] C 空username+真token => ${idOf(await this.exchangeGwRaw("", this.xcxToken))}`); } catch (e) { this.log(`[DIAG] C err ${e.message}`); }
        try { this.log(`[DIAG] D 原username+破坏token => ${idOf(await this.exchangeGwRaw(OAUTH_USERNAME, this.xcxToken + "x"))}`); } catch (e) { this.log(`[DIAG] D err ${e.message}`); }
    }
    async run() {
        if (!this.account.openid) { this.log("跳过：变量值里没有 openid"); return; }
        try {
            await this.ensureLogin();
            await this.sign();
        } catch (e) {
            if (String(e.message).startsWith("NO_ACCOUNT")) {
                const cause = String(e.message).replace(/^NO_ACCOUNT:/, "");
                if (/隐私/.test(cause)) this.log(`⚠️ 该微信号需先在广汽小程序里同意隐私政策/授权一次（${cause}），这是一次性用户操作，之后再跑即可`);
                else this.log(`⚠️ 该微信号还没在广汽注册/绑定会员（${cause}），先在小程序里登录一次再跑`);
                return;
            }
            this.log(`执行失败: ${e.message || e}`);
        }
    }
}

const yyb = new YYBClient({ appid: MINI_APP_ID });

!(async () => {
    let accounts;
    try { accounts = yybAccounts(); } catch (e) { $.log(`❌ ${e.message || e}`); return; }
    $.log(`共找到${accounts.length}个YYB账号`);
    for (let i = 0; i < accounts.length; i++) {
        await new Task(accounts[i]).run();
        if (i < accounts.length - 1) await $.wait(1500, 3000);
    }
})().catch((e) => $.log(e.message || e)).finally(() => $.done());
