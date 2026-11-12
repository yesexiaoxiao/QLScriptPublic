// name: 美孚臻享俱乐部签到
/*
------------------------------------------
@Description: 美孚臻享俱乐部 - 微信小程序静默登录 + 每日签到
cron: 33 8 * * *
------------------------------------------

------------------------------------------
契约（appid wx46f9572cac706c22，host www.rewards.mobil.com.cn，SHOPWIND/Yii2 框架）：
（迁移自 YYB-GO 系脚本 美孚.js，原脚本已 code 登录，无签名，token 放头）

所有请求走 /web/index.php?_mall_id=1&r=<route>；token 放 X-Access-Token 头，会话 cookie 随任务保持。
登录  POST r=api/passport/login   form{code}   -> code==0，data.access_token(=token)、data.ulp_user_id
会员  GET  r=api/kc/user/user-info               -> code==0，data.ulp_user_id / data.ulp_user_info(会员态)
任务  GET  r=api/kc/user/user-task               -> data.data.need_improve_user_info(1=需完善信息=未注册会员)
状态  GET  r=api/kc/user/user-sign-info          -> code==0，data.now_date_is_sign(今日是否已签)
签到  POST r=api/kc/user/sign-in   form(空)      -> code==0 && data.now_date_is_sign
成功码 code==0。
  -1 或 msg 含 登录失效/未登录 = mall token 失效(重登重试一次)。
  -9  且 msg 含 "ulp:请先登录"  = 会员积分平台(ulp/mefoto) 未登录/未注册 —— 该微信号在商城已登录，但
      尚未在美孚会员体系注册(ulp_user_id=0 / need_improve_user_info=1)，签到需先在小程序内完善会员信息。
      按技能规则优雅报 ⚠️(不代注册、不崩溃)。
  -11 或 msg 含 风险识别/验证码 = 风控图形验证码(按技能规则不绕过，如实报告)。
MALL_ID / APP_VERSION 是应用级常量（原脚本硬编码，非个人凭证）；不发送 X-User-Id。
------------------------------------------
 YYB-Go 版：取码改走 YYB-Go（POST /wxapp/getCode），不再依赖原取码桥接服务。
 变量：YYB_SERVER 每行 地址@账号标识（例如 http://yyb-go:8000@1）；YYB_API_KEY 可选。
 原桥接版脚本见 wxapp/mobil.js，业务接口、流程与缓存格式均未改动。
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
const $ = new Env("美孚臻享俱乐部签到");
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

const MINI_APP_ID = "wx46f9572cac706c22";
const BASE_URL = "https://www.rewards.mobil.com.cn";
const MALL_ID = "1";
const APP_VERSION = "4.8.9";
const PAGE_VERSION = "120";
const TOKEN_CACHE_FILE = path.join(__dirname, "tokencache", "mobil_token_cache.json");
const WX_UA =
    "Mozilla/5.0 (Linux; Android 10; MI 8 Build/QKQ1.190828.002; wv) " +
    "AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.6478.122 " +
    "Mobile Safari/537.36 XWEB/1260059 MMWEBSDK/20240501 MMWEBID/3628 " +
    "MicroMessenger/8.0.50.2701(0x28003252) WeChat/arm64 Weixin NetType/WIFI " +
    "Language/zh_CN ABI/arm64 MiniProgramEnv/android";

const COMMON_HEADERS = {
    Host: "www.rewards.mobil.com.cn",
    Connection: "keep-alive",
    Accept: "application/json, text/plain, */*",
    charset: "utf-8",
    "User-Agent": WX_UA,
    "X-Form-Id-List": "[]",
    "X-App-Platform": "wxapp",
    "X-Requested-With": "XMLHttpRequest",
    "X-channel": "WXapp",
    "X-App-Version": APP_VERSION,
    Referer: `https://servicewechat.com/${MINI_APP_ID}/${PAGE_VERSION}/page-frame.html`,
};

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
function short(v, n = 200) {
    const t = typeof v === "string" ? v : JSON.stringify(v);
    return !t ? "" : t.length > n ? `${t.slice(0, n)}...` : t;
}
function toObj(v) {
    if (v && typeof v === "object") return v;
    if (typeof v === "string") { try { return JSON.parse(v); } catch (e) { return { _raw: v }; } }
    return {};
}
function msgOf(r) {
    if (!r || typeof r !== "object") return "";
    return String(r.msg || r.message || r.error || r.errmsg || r._raw || "");
}
function getByPath(src, keys) {
    let cur = src;
    for (const k of keys) { if (!cur || typeof cur !== "object" || !(k in cur)) return undefined; cur = cur[k]; }
    return cur;
}
function extractToken(res) {
    const paths = [
        ["data", "access_token"], ["data", "accessToken"], ["data", "token"],
        ["data", "user", "access_token"], ["data", "user", "accessToken"], ["data", "user", "token"],
        ["data", "user_info", "access_token"], ["data", "user_info", "accessToken"], ["data", "user_info", "token"],
        ["access_token"], ["accessToken"], ["token"],
    ];
    for (const p of paths) { const v = getByPath(res, p); if (typeof v === "string" && v.trim()) return v.trim(); }
    return "";
}
// -9 ulp:请先登录 = 会员积分平台(ulp/mefoto)未登录/未注册，不是 mall token 失效
function isUlpUnregistered(r) {
    const msg = msgOf(r);
    if (Number(r && r.code) === -9 && /ulp/i.test(msg)) return true;
    return /ulp[:：]\s*请先登录/i.test(msg);
}
// mall 层 token 失效（排除 ulp 会员态误伤）
function isLoginExpired(r) {
    if (!r) return false;
    const msg = msgOf(r);
    if (/ulp/i.test(msg)) return false;
    if (Number(r.code) === -1) return true;
    return /登录失效|未登录|token\s*(失效|过期|无效)|invalid.*token|请重新登录/i.test(msg);
}
function needsCaptcha(r) {
    if (!r) return false;
    if (Number(r.code) === -11) return true;
    return /风险识别|验证码|校验码|滑块/.test(msgOf(r));
}
// user-info(data.ulp_user_id / ulp_user_info) 判定会员是否已建立
function hasUlpMember(userInfo) {
    const d = (userInfo && userInfo.data) || {};
    if (Number(d.ulp_user_id) > 0) return true;
    if (Array.isArray(d.ulp_user_info)) return d.ulp_user_info.length > 0;
    return !!d.ulp_user_info;
}

const UNREG_MSG =
    "⚠️ 该微信号已完成商城登录，但尚未在美孚臻享俱乐部注册会员（ulp_user_id=0 / need_improve_user_info=1，" +
    "服务端返回 -9 ulp:请先登录）。签到需先在小程序内完善会员信息/绑定手机号注册后再跑。";

class Task {
    constructor(raw) {
        this.index = $.userIdx++;
        this.account = parseAccount(raw);
        this.token = "";
        this.cookieJar = {};
        this.justLoggedIn = false;
    }
    log(text) {
        $.log(`账号[${this.index}]${this.account.remark ? `[${this.account.remark}]` : ""} ${text}`);
    }
    cookieString() {
        return Object.entries(this.cookieJar)
            .filter(([, v]) => v !== undefined && v !== null && v !== "" && v !== "deleted")
            .map(([k, v]) => `${k}=${v}`).join("; ");
    }
    updateCookie(setCookie) {
        if (!setCookie) return;
        const arr = Array.isArray(setCookie) ? setCookie : [setCookie];
        for (const item of arr) {
            const pair = String(item).split(";")[0];
            const i = pair.indexOf("=");
            if (i <= 0) continue;
            const k = pair.slice(0, i).trim();
            const v = pair.slice(i + 1).trim();
            if (k) this.cookieJar[k] = v;
        }
    }
    async request(route, { method = "GET", body, contentType = "form", query, useToken = true } = {}) {
        const url = new URL("/web/index.php", BASE_URL);
        url.searchParams.set("_mall_id", MALL_ID);
        url.searchParams.set("r", route);
        for (const [k, v] of Object.entries(query || {})) {
            if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
        }
        const headers = { ...COMMON_HEADERS };
        if (useToken && this.token) headers["X-Access-Token"] = this.token;
        const ck = this.cookieString();
        if (ck) headers.Cookie = ck;

        let data = body;
        if (body !== undefined) {
            if (contentType === "json") {
                headers["Content-Type"] = "application/json";
                data = typeof body === "string" ? body : JSON.stringify(body);
            } else {
                headers["Content-Type"] = "application/x-www-form-urlencoded";
                data = typeof body === "string" ? body : new URLSearchParams(body).toString();
            }
        }
        const res = await axios.request({
            method: method || (body === undefined ? "GET" : "POST"),
            url: url.toString(),
            data,
            headers,
            timeout: 20000,
            maxRedirects: 5,
            validateStatus: () => true,
        });
        this.updateCookie(res.headers && res.headers["set-cookie"]);
        const obj = toObj(res.data);
        if (res.status < 200 || res.status >= 300) {
            // 业务结论有时躺在 4xx/5xx 的 JSON 体里；有 code/msg 就交给业务判定
            if (obj && (("code" in obj) || ("msg" in obj) || ("message" in obj))) return obj;
            throw new Error(`${route} HTTP ${res.status}: ${short(res.data)}`);
        }
        return obj;
    }
    async safeRequest(route, opts) {
        try { return await this.request(route, opts); } catch (e) { return { code: 500, msg: e.message || String(e) }; }
    }
    /** 取 wx.login code：YYB-Go /wxapp/getCode（一个账号一次请求，失败即抛错） */
    async getCode() {
        return yyb.getCode(this.account.openid);
    }
    async login() {
        const code = await this.getCode();
        this.token = "";
        const res = await this.request("api/passport/login", { method: "POST", body: { code }, useToken: false });
        if (Number(res.code) !== 0) throw new Error(`业务登录失败: ${msgOf(res) || short(res)}`);
        const token = extractToken(res);
        if (!token) throw new Error(`登录未返回 token: ${short(res)}`);
        this.token = token;
        this.ulpUserId = Number(getByPath(res, ["data", "ulp_user_id"]) || 0);
        this.justLoggedIn = true;
        const cache = readCache();
        cache[this.account.openid] = { token: this.token, cookieJar: this.cookieJar, updatedAt: new Date().toISOString() };
        writeCache(cache);
        this.log("登录成功");
    }
    async ensureLogin() {
        if (this.token) return;
        const cached = readCache()[this.account.openid] || {};
        if (cached.token) {
            this.token = cached.token;
            if (cached.cookieJar && typeof cached.cookieJar === "object") this.cookieJar = { ...cached.cookieJar };
            this.log("使用缓存token");
            return;
        }
        await this.login();
    }
    // 只读预检：返回 unregistered / signed / unsigned / expired / unknown
    async precheck() {
        const info = await this.safeRequest("api/kc/user/user-info", { method: "GET" });
        if (isLoginExpired(info)) return "expired";
        if (isUlpUnregistered(info)) return "unregistered";
        if (Number(info.code) === 0) {
            const d = info.data || {};
            const member = hasUlpMember(info);
            const name = d.nickname || d.nick_name || d.mobile || "";
            if (member) this.log(`会员校验通过${name ? `（${name}）` : ""}`);
            const task = await this.safeRequest("api/kc/user/user-task", { method: "GET" });
            const needImprove = Number(getByPath(task, ["data", "data", "need_improve_user_info"])) === 1;
            if (!member || needImprove) return "unregistered";
        } else {
            this.log(`会员信息异常：${msgOf(info) || short(info)}`);
        }

        const s = await this.safeRequest("api/kc/user/user-sign-info", { method: "GET" });
        if (isLoginExpired(s)) return "expired";
        if (isUlpUnregistered(s)) return "unregistered";
        if (Number(s.code) === 0) {
            return (s.data || {}).now_date_is_sign ? "signed" : "unsigned";
        }
        return "unknown";
    }
    reportSign(res) {
        if (Number(res.code) === 0) {
            const d = res.data || {};
            const days = d.sign_continue_text || d.sign_continue_day || d.sign_continue || "";
            const points = d.sign_once_point || d.point || "";
            if (d.now_date_is_sign) {
                this.log(`✅ 签到成功${days ? `，已累计签到 ${days} 天` : ""}${points ? `，本次 +${points} 积分` : ""}`);
            } else {
                this.log(`✅ 签到已处理：${short(res)}`);
            }
            return "ok";
        }
        const msg = msgOf(res);
        if (isUlpUnregistered(res)) { this.log(UNREG_MSG); return "unregistered"; }
        if (/已签|已经签|签到过|重复|already/i.test(msg)) { this.log(`✅ 今日已签到（${msg}）`); return "ok"; }
        if (needsCaptcha(res)) { this.log(`⚠️ 触发风控图形验证码（${msg || "风险识别"}）；按规则不自动绕过，请稍后手动在小程序内签到或降低频率`); return "captcha"; }
        this.log(`❌ 签到失败：${msg || short(res)}`);
        return "fail";
    }
    async doSign() {
        return this.request("api/kc/user/sign-in", { method: "POST", body: "" });
    }
    async run() {
        if (!this.account.openid) { this.log("跳过：变量值里没有 openid"); return; }
        try {
            await this.ensureLogin();

            let state = await this.precheck();
            if (state === "expired" && !this.justLoggedIn) {
                this.log("token 失效，重新登录后重试");
                await this.login();
                state = await this.precheck();
            }
            if (state === "unregistered") { this.log(UNREG_MSG); return; }
            if (state === "signed") { this.log("✅ 今日已签到"); return; }

            await $.wait(1500, 3500);
            let res = await this.doSign();

            if (isLoginExpired(res) && !this.justLoggedIn) {
                this.log("签到时 token 失效，重新登录后重试");
                await this.login();
                await $.wait(1500, 3000);
                res = await this.doSign();
            }
            this.reportSign(res);
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
