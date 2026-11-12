// name: 得物种树签到
/*
------------------------------------------
@Description: 得物(Dewu/Poizon) 种树 - 微信小程序静默登录 + 每日签到
cron: 30 8 * * *
------------------------------------------

------------------------------------------
契约（appid wx3c12cdd0ae8b1a7b，host app.dewu.com）：
（迁移自 YYB-GO 得物种树脚本，原脚本已 code 登录）

两套签名/两处放置（关键差异）：
  登录签名 loginSign：对 body 排序键拼接 key+fmt(v)（bool→true/false，null 跳过），
                      末尾追加 SW_APP_SIGN_SECRET 后 MD5；sign 放在【body】里。
  业务签名 bizSign  ：对参数排序键拼接 key+str(v)（null→""），末尾追加 SIGN_SECRET
                      后 MD5；sign 放在【query ?sign=】里。POST 签 body，GET 签 query。
                      空 body/空 query 时 sign = MD5(SIGN_SECRET)。

登录  POST /api/v1/h5/user_core/mapi/users/wechat/login
        body={type:"wxapp",code,deviceId,newFlow:true,hitGray:true,bizType:""}+sign(loginSign)
        头带 SK/ltk/AppId:wxapp/xsn 等固定应用常量，不带 token
        -> resp.header['x-auth-token']（去 "Bearer "）= 后续 x-auth-token 头
           && body.code==200，body.data.loginInfo.loginToken = duToken/cookieToken
状态  GET  /hacking-tree/v1/sign/list      -> data.list 里 day==currentDay && IsSignIn ⇒ 今日已签
签到  POST /hacking-tree/v1/sign/sign_in {}
        -> HTTP200 && body.code==200 ⇒ 成功(data.Num=获得水滴)；body.code==711110001 ⇒ 今日已签
鉴权失效：body.code==11001 / msg含"校验失败" / code==700 / msg含"未登录/请先登录" ⇒ 重登重试
风控：body.code==485 且 data.sessionId / msg含"请校验验证码" ⇒ 命中滑块(当前 IP 被得物风控，
      非脚本 bug，需 App 内手动签到或换网络重跑)。403/404/485「网络拥堵/前方拥挤」为瞬时限流，退避重试。
SIGN_SECRET / SW_APP_SIGN_SECRET / SW_APP_SK / SW_APP_LTK / AUTH_SK / device_model 均为该
小程序固定应用常量（原脚本硬编码，非个人凭证）。
------------------------------------------
 YYB-Go 版：取码改走 YYB-Go（POST /wxapp/getCode），不再依赖原取码桥接服务。
 变量：YYB_SERVER 每行 地址@账号标识（例如 http://yyb-go:8000@1）；YYB_API_KEY 可选。
 原桥接版脚本见 wxapp/dw.js，业务接口、流程与缓存格式均未改动。
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
const $ = new Env("得物种树签到");
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

const MINI_APP_ID = "wx3c12cdd0ae8b1a7b";
const BASE = "https://app.dewu.com";

// 业务签名密钥（种树 hacking-tree 接口）
const SIGN_SECRET = "048a9c4943398714b356a696503d2d36";
// 小程序登录签名密钥
const SW_APP_SIGN_SECRET = "19bc545a393a25177083d4a748807cc0";
const LOGIN_PATH = "/api/v1/h5/user_core/mapi/users/wechat/login";
// 登录专用固定头（应用常量）
const SW_APP_SK = "9U7MQhgnG8oZXxFz88rUDzxlHf8BQe4pNv5y7wMGKqoChmYNNPA4D56K2C4i066BtQ6yv8CKBW8vbXCdLdDH8MnN271p";
const SW_APP_LTK = "eMKkwoHDnMOrCMKcw6PDsMKRP8KUworCgsOue8OmwpbCkcKnNTjCk3fDk8OrLcOKa1TCnHrDjVDCh8Ogw7s9cMOLcCjCoMOyw5I=";
const SW_APP_XSN = "eef229c26f5fa8169ed16f4f66c360d3";
// 业务头固定应用常量
const AUTH_SK = "9U0cRrTwOLG5X6xThcbMQQUWKTkAjqOvr3CEVpaSot2bnNdNBTRzNio1SDIt5Dr5Pt3Ogq91fX6rrGJuhEW12WnBJ51u";
const DEVICE_MODEL = "2512BPNDAC";

const EP_SIGN_LIST = "/hacking-tree/v1/sign/list";
const EP_SIGN_IN = "/hacking-tree/v1/sign/sign_in";

const TOKEN_CACHE_FILE = path.join(__dirname, "tokencache", "dw_token_cache.json");
const LOGIN_UA =
    "Mozilla/5.0 (Linux; Android 16; 2308CPXD0C Build/BP2A.250605.031.A3; wv) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Version/4.0 Chrome/146.0.7680.178 Mobile Safari/537.36 XWEB/1460249 " +
    "MMWEBSDK/20260202 MMWEBID/6435 MicroMessenger/8.0.70.3060(0x28004652) WeChat/arm64 Weixin " +
    "NetType/WIFI Language/zh_CN ABI/arm64 MiniProgramEnv/android";
const BIZ_UA =
    "Mozilla/5.0 (Linux; U; Android 14; zh-CN; " + DEVICE_MODEL + " Build/UKQ1.230917.001) " +
    "AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/100.0.4896.58 UWS/5.18.11.0 " +
    "Mobile Safari/537.36/duapp/5.91.5(android;14)";

const yyb = new YYBClient({ appid: MINI_APP_ID });

function readCache() {
    try { if (!fs.existsSync(TOKEN_CACHE_FILE)) return {}; return JSON.parse(fs.readFileSync(TOKEN_CACHE_FILE, "utf8")) || {}; } catch (e) { return {}; }
}
function writeCache(c) {
    try { fs.mkdirSync(path.dirname(TOKEN_CACHE_FILE), { recursive: true }); fs.writeFileSync(TOKEN_CACHE_FILE, JSON.stringify(c, null, 2), "utf8"); } catch (e) { $.log(`写入缓存失败: ${e.message || e}`); }
}
function parseAccount(raw = "") {
    const [id, remark] = String(raw).split("#").map((s) => (s || "").trim());
    return { openid: id, remark: remark || "" };
}
function short(v, n = 220) {
    const t = typeof v === "string" ? v : JSON.stringify(v);
    return !t ? "" : t.length > n ? `${t.slice(0, n)}...` : t;
}
function md5(str) {
    return crypto.createHash("md5").update(String(str), "utf8").digest("hex");
}
function uuid4() {
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
    });
}

// 登录签名：排序键拼接 key+fmt(v)（bool→true/false，null/undefined 跳过），末尾追加密钥后 MD5。
function loginSign(params, secret) {
    const fmt = (v) => {
        if (v === null || v === undefined) return "";
        if (typeof v === "boolean") return v ? "true" : "false";
        if (typeof v === "object") return JSON.stringify(v);
        return String(v);
    };
    let text = "";
    for (const k of Object.keys(params).sort()) {
        if (params[k] === null || params[k] === undefined) continue;
        text += k + fmt(params[k]);
    }
    return md5(text + secret);
}

// 业务签名：排序键拼接 key+str(v)（null→""），末尾追加密钥后 MD5。空对象 => MD5(SIGN_SECRET)。
function bizSign(params) {
    const p = params || {};
    let raw = "";
    for (const k of Object.keys(p).sort()) {
        const v = p[k];
        raw += k + (v === null || v === undefined ? "" : String(v));
    }
    return md5(raw + SIGN_SECRET);
}

function isAuthErr(data) {
    if (!data || typeof data !== "object") return false;
    const code = Number(data.code);
    const msg = String(data.msg || data.message || "");
    if (code === 11001 || code === 700) return true;
    return /校验失败|未登录|请先登录|token失效|会话/i.test(msg);
}
// 真正的滑块人机验证（需 App 内手动过），命中即视为当前 IP 被风控。
function isHardCaptcha(data) {
    if (!data || typeof data !== "object") return false;
    if (Number(data.code) === 485 && data.data && data.data.sessionId) return true;
    return /请校验验证码/.test(String(data.msg || ""));
}
const TRANSIENT_CODES = new Set([403, 404, 485]);

class Task {
    constructor(raw) {
        this.index = $.userIdx++;
        this.account = parseAccount(raw);
        this.xAuthToken = "";
        this.loginToken = "";
        this.captcha = false;
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
        const body = { type: "wxapp", code, deviceId: uuid4(), newFlow: true, hitGray: true, bizType: "" };
        body.sign = loginSign(body, SW_APP_SIGN_SECRET);
        const headers = {
            Host: "app.dewu.com",
            Connection: "keep-alive",
            appVersion: "4.4.0",
            "content-type": "application/json",
            SK: SW_APP_SK,
            ltk: SW_APP_LTK,
            skt: "xdr1",
            miniappversion: "5.96.1",
            "Wxapp-Login-Token": "",
            AppId: "wxapp",
            "wxapp-route-id": "undefined",
            platform: "h5",
            xsn: SW_APP_XSN,
            charset: "utf-8",
            Referer: `https://servicewechat.com/${MINI_APP_ID}/586/page-frame.html`,
            "User-Agent": LOGIN_UA,
        };
        const res = await axios.request({
            method: "POST", url: BASE + LOGIN_PATH, data: body, headers,
            timeout: 20000, validateStatus: () => true,
        });
        let xAuth = String(res.headers["x-auth-token"] || res.headers["X-Auth-Token"] || "").replace("Bearer ", "").trim();
        const data = res.data || {};
        let loginToken = "";
        if (Number(data.code) === 200) {
            loginToken = ((data.data || {}).loginInfo || {}).loginToken || "";
        }
        if (!xAuth || !loginToken) {
            const msg = data.msg || data.message || short(data);
            // 未绑定手机号/未注册的优雅提示：实测该微信号未绑手机 -> code=745 "请先绑定手机号"，
            // 此时登录不返回 token（并非脚本错误，需先在得物 App/小程序里绑定手机号登录一次）。
            if (Number(data.code) === 745 || /注册|未激活|绑定|授权|手机号/.test(String(msg))) {
                this.unregistered = true;
                throw new Error(`NO_ACCOUNT:${msg}`);
            }
            throw new Error(`登录失败(code=${data.code} 无token): ${msg}`);
        }
        this.xAuthToken = xAuth;
        this.loginToken = String(loginToken);
        const cache = readCache();
        cache[this.account.openid] = { xAuthToken: this.xAuthToken, loginToken: this.loginToken, updatedAt: new Date().toISOString() };
        writeCache(cache);
        this.log("登录成功");
    }
    bizHeaders() {
        return {
            "x-auth-token": this.xAuthToken,
            duToken: this.loginToken,
            cookieToken: this.loginToken,
            device_model: DEVICE_MODEL,
            deviceTrait: DEVICE_MODEL,
            SK: AUTH_SK,
            ua: "duapp/5.91.5(android;14)",
            appid: "h5",
            networktype: "wifi",
            channel: "du",
            appVersion: "5.91.5",
            emu: "0",
            countryCode: "CN",
            isRoot: "0",
            imei: "",
            platform: "h5",
            isProxy: "0",
            Origin: "https://cdn-m.dewu.com",
            "X-Requested-With": "com.shizhuang.duapp",
            Referer: "https://cdn-m.dewu.com/",
            "Accept-Language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
            Accept: "*/*",
            "Sec-Fetch-Site": "same-site",
            "Sec-Fetch-Mode": "cors",
            "Sec-Fetch-Dest": "empty",
            Cookie: `duToken=${this.loginToken}`,
            "User-Agent": BIZ_UA,
        };
    }
    // GET：sign 源=query 参数（此处均为空），sign 放到 query。
    async bizGet(apiPath, params = {}) {
        const query = { ...params, sign: bizSign(params) };
        const res = await axios.request({
            method: "GET", url: BASE + apiPath, params: query, headers: this.bizHeaders(),
            timeout: 20000, validateStatus: () => true,
        });
        return { status: res.status, data: res.data || {} };
    }
    // POST：sign 源=body，sign 放到 query。带瞬时反爬(403/404/485)退避重试。
    async bizPost(apiPath, body = {}, extraHeaders = {}) {
        const query = { sign: bizSign(body) };
        const headers = { ...this.bizHeaders(), ...extraHeaders };
        let last = { status: 0, data: {} };
        const retries = 3;
        for (let attempt = 0; attempt <= retries; attempt++) {
            if (attempt > 0) {
                const wait = Math.round((Math.pow(2, attempt - 1) * 6 + Math.random() * 3) * 1000);
                this.log(`  [重试 ${attempt}/${retries}] ${(wait / 1000).toFixed(1)}s 后重发 ${apiPath}`);
                await new Promise((r) => setTimeout(r, wait));
            }
            const res = await axios.request({
                method: "POST", url: BASE + apiPath, params: query, data: body, headers,
                timeout: 20000, validateStatus: () => true,
            });
            last = { status: res.status, data: res.data || {} };
            if (isHardCaptcha(last.data)) return last; // 滑块不重试
            if (TRANSIENT_CODES.has(res.status)) continue;
            const biz = Number(last.data && last.data.code);
            if (TRANSIENT_CODES.has(biz)) continue;
            return last;
        }
        return last;
    }
    async checkSignedToday() {
        const { data } = await this.bizGet(EP_SIGN_LIST);
        if (isAuthErr(data)) return { auth: true };
        try {
            const d = data.data || {};
            for (const item of d.list || []) {
                if (item.day === d.currentDay && item.IsSignIn) return { signed: true };
            }
        } catch (e) {}
        return { signed: false, ok: Number(data.code) === 200 };
    }
    async sign(retry = true) {
        // 1) 先查签到列表，若今日已签直接返回
        const chk = await this.checkSignedToday();
        if (chk.auth) {
            if (retry) { this.log("会话失效，重新登录后重试"); this.xAuthToken = ""; this.loginToken = ""; await this.login(); return this.sign(false); }
            return this.log("❌ 鉴权失效，重登后仍失败");
        }
        if (chk.signed) return this.log("✅ 今日已签到");
        // 2) 执行签到
        const { status, data } = await this.bizPost(EP_SIGN_IN, {});
        if (isHardCaptcha(data)) {
            this.captcha = true;
            return this.log(`🚫 触发滑块验证码，当前 IP 被得物风控，请在 App 内手动签到或换网络重跑（非脚本错误）: ${short(data.msg)}`);
        }
        if (Number(data.code) === 711110001) return this.log("✅ 今日已签到（服务端确认）");
        if (status === 200 && Number(data.code) === 200) {
            const num = (data.data || {}).Num;
            return this.log(`✅ 签到成功${num !== undefined ? `，获得水滴 ${num}` : ""}`);
        }
        const msg = data.msg || data.message || short(data);
        if (/已签|签到过|重复|已完成/.test(String(msg))) return this.log(`✅ 今日已签到（${msg}）`);
        if (retry && isAuthErr(data)) {
            this.log("会话失效，重新登录后重试");
            this.xAuthToken = ""; this.loginToken = "";
            await this.login();
            return this.sign(false);
        }
        this.log(`❌ 签到失败: ${msg} (code=${data.code})`);
    }
    async ensureLogin() {
        const cached = readCache()[this.account.openid] || {};
        if (!this.xAuthToken && cached.xAuthToken && cached.loginToken) {
            this.xAuthToken = cached.xAuthToken;
            this.loginToken = cached.loginToken;
            this.log("使用缓存token");
            return;
        }
        if (!this.xAuthToken) await this.login();
    }
    async run() {
        if (!this.account.openid) { this.log("跳过：变量值里没有 openid"); return; }
        try {
            await this.ensureLogin();
            await this.sign();
        } catch (e) {
            if (String(e.message).startsWith("NO_ACCOUNT")) {
                this.log(`⚠️ 该微信号未在得物绑定手机号/注册（${String(e.message).replace(/^NO_ACCOUNT:/, "")}），先在得物小程序里登录并绑定手机号一次再跑`);
                return;
            }
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
