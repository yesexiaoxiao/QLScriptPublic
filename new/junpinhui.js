// name: 君品荟
/*
君品荟 - 登录、签到、查询、酒谷之旅农场
cron: 45 8 * * *

      也支持 openid#token 或仅 token

------------------------------------------
关键点：酒谷之旅(garden) 这套后端注册在【习酒】小程序 wx489f950decfeb93e 名下，
不是君品荟自己。2026-08-18 实测定性，三件事都必须换成习酒的身份，缺一个就 5001：

  ① 登录（两段，各耗一个 code，都用习酒 appid 取码）
       GET  xcx.exijiu.com/anti-channeling/public/index.php/api/v2/auth/session?code=
            -> data.login_code          （之后当请求头 login_code 带上）
       GET  apimallwm.exijiu.com/garden/wechat/login?code=
            -> data.authorized_token    （之后当请求头 Authorization 带上）
     authorized_token 是个 JWT，解出来 memberInfo.id 和君品荟侧的 member_id 一致，
     所以是同一个会员，换 appid 不换账号。
  ② 请求头：AppID / Referer 都用习酒 appid，Authorization 放 authorized_token。
     服务端是按 AppID 头去找"该 appid 的用户密钥"来解 encryptData 的。
  ③ encryptData 的密钥：smallcat /wx/encryptkey 要用【习酒】appid 取，
     encrypt_key(24 字符) 和 iv(16 字符) 都按 utf-8 字节直接用 -> AES-192-CBC/PKCS7，
     输出 hex；version 用该次返回的值。明文是 {…业务参数, ts}。

对照实验：
  君品荟 appid 的 encryptkey + 君品荟的头 -> 5001「用户信息异常」（这是修之前的行为）
  习酒   appid 的 encryptkey + 君品荟的头 -> 5001（头也得换）
  习酒   appid 的 encryptkey + 习酒的头   -> err=0，签到成功
                                             {isTodayFirstSign:true, water:"1", tips:"系统赠送您：浇水*1次"}

另外：/garden/wechat/auth（拿站点自己签发的 key）在 smallcat 体系下走不通 ——
它要用服务端自己 code2Session 得到的 session_key 去解 encryptedData，
而 smallcat 每次调用都会另换一把 session_key，两边永远对不上；上面这条
/wx/encryptkey 的路子是同一份第三方实现里的另一条分支，实测可用。
滑块验证(5008) 按规则不绕。
------------------------------------------
 YYB-Go 版：取码改走 YYB-Go（POST /wxapp/getCode），不再依赖原取码桥接服务。
 变量：YYB_SERVER 每行 地址@账号标识（例如 http://yyb-go:8000@1）；YYB_API_KEY 可选。
 原桥接版脚本见 wxapp/junpinhui.js，业务接口、流程与缓存格式均未改动。
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
const $ = new Env("君品荟");
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

const MINI_APP_ID = "wx8d41cdc44c8aeaab";
// 酒谷之旅(garden) 这套后端注册在【习酒】小程序名下，不是君品荟自己。
// 所以 garden 的登录、请求头、以及 encryptData 用的加密密钥都必须用这个 appid，
// 用君品荟的 appid 去取密钥服务端一律回 5001「用户信息异常」。会员是同一个
// （garden 登录返回的 authorized_token 里 memberInfo.id 和君品荟侧一致）。
const GARDEN_APP_ID = "wx489f950decfeb93e";
const APP_VERSION = "1.0.12";
const FM_BASE = "https://fm.exijiu.com";
const GARDEN_BASE = "https://apimallwm.exijiu.com";
const MAIN_BASE = "https://xcx.exijiu.com/anti-channeling/public/index.php/api/v2";
const TOKEN_CACHE_FILE = path.join(__dirname, "tokencache", "junpinhui_token_cache.json");

const yyb = new YYBClient({ appid: MINI_APP_ID });
// garden 侧要用习酒 appid 取 code / 取加密密钥
const gardenYyb = new YYBClient({ appid: GARDEN_APP_ID });

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
  if (!text) return { openid: "", token: "" };

  if (text.startsWith("{")) {
    try {
      const data = JSON.parse(text);
      return {
        openid: data.openid || data.openId || data.account || "",
        token: data.token || data.accessToken || "",
      };
    } catch {}
  }

  for (const sep of ["#", "|"]) {
    if (text.includes(sep)) {
      const [openid, ...rest] = text.split(sep);
      return { openid: openid.trim(), token: rest.join(sep).trim() };
    }
  }

  if (text.length > 40 && !text.startsWith("o")) return { openid: "", token: text };
  return { openid: text, token: "" };
}

function headers(token = "") {
  return {
    "Content-Type": "application/json",
    "User-Agent": "Mozilla/5.0 MicroMessenger MiniProgramEnv/Windows",
    Referer: `https://servicewechat.com/${MINI_APP_ID}/215/page-frame.html`,
    AppID: MINI_APP_ID,
    "App-Version": APP_VERSION,
    Authorization: `Basic ${Buffer.from("wechat:wechat_secret").toString("base64")}`,
    ...(token ? { "X-Access-Token": token } : {}),
  };
}

/**
 * garden 侧的请求头 —— 必须整套换成【习酒】的身份，服务端是按 AppID 头 +
 * Authorization 里的 authorized_token 来决定用哪个 appid 的密钥解 encryptData 的。
 * 混用（君品荟的头 + 习酒的密钥，或反之）一律 5001。
 */
function gardenHeaders(session = {}) {
  return {
    "Content-Type": "application/json",
    "User-Agent": "Mozilla/5.0 MicroMessenger MiniProgramEnv/Windows",
    Referer: `https://servicewechat.com/${GARDEN_APP_ID}/215/page-frame.html`,
    AppID: GARDEN_APP_ID,
    "App-Version": APP_VERSION,
    ...(session.authorizedToken ? { Authorization: session.authorizedToken } : {}),
    ...(session.loginCode ? { login_code: session.loginCode } : {}),
  };
}

function shortJson(value, limit = 180) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return "";
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function okCode(res) {
  return String(res?.code) === "10000" || res?.success === true || Number(res?.err) === 0;
}

function assertOk(res, action) {
  if (!res || !okCode(res)) {
    throw new Error(`${action}失败: ${res?.message || res?.msg || res?.errMsg || shortJson(res, 500)}`);
  }
  return res.data;
}

async function request(method, base, urlPath, { token = "", data = null, params = null, hdrs = null } = {}) {
  const res = await axios({
    method,
    url: `${base}${urlPath}`,
    data,
    params,
    timeout: 20000,
    validateStatus: () => true,
    headers: hdrs || headers(token),
  });
  return res.data;
}

function aesCbcPkcs7Hex(text, key, iv) {
  const keyBuf = Buffer.from(String(key), "utf8");
  const ivBuf = Buffer.from(String(iv), "utf8");
  const algo = { 16: "aes-128-cbc", 24: "aes-192-cbc", 32: "aes-256-cbc" }[keyBuf.length];
  if (!algo) throw new Error(`encrypt_key长度异常: ${keyBuf.length}`);
  if (ivBuf.length !== 16) throw new Error(`iv长度异常: ${ivBuf.length}`);
  const cipher = crypto.createCipheriv(algo, keyBuf, ivBuf);
  return cipher.update(text, "utf8", "hex") + cipher.final("hex");
}

function listify(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  for (const key of ["list", "data", "records", "items", "rows"]) {
    if (Array.isArray(value[key])) return value[key];
  }
  return [];
}

function pickId(item = {}) {
  for (const key of ["id", "sorghum_id", "sorghumId", "member_sorghum_id", "memberSorghumId", "land_id", "landId"]) {
    if (item[key] !== undefined && item[key] !== null && item[key] !== "") return item[key];
  }
  return "";
}

function landNo(item = {}) {
  return item.serial_number ?? item.serialNumber ?? pickId(item) ?? "?";
}

function landStatus(item = {}) {
  const value = Number(item.status ?? -1);
  return Number.isFinite(value) ? value : -1;
}

function isPlantable(item = {}) {
  return pickId(item) && landStatus(item) === 0;
}

function isGrowing(item = {}) {
  const status = landStatus(item);
  return pickId(item) && status > 0 && ![10, 11].includes(status);
}

function isHarvestable(item = {}) {
  return pickId(item) && [10, 11].includes(landStatus(item));
}

function isCompleted(task = {}) {
  return Number(task.is_complete ?? task.isComplete ?? task.complete ?? task.status_complete ?? 0) === 1;
}

class Task {
  constructor(raw) {
    this.index = $.userIdx++;
    const account = parseAccount(raw);
    this.openid = account.openid;
    this.token = account.token || "";
    this.member = {};
    this.cacheKey = this.openid || (this.token ? md5(this.token).slice(0, 16) : `account_${this.index}`);
  }

  getCached() {
    return readCache()[this.cacheKey] || {};
  }

  saveCache(extra = {}) {
    const cache = readCache();
    cache[this.cacheKey] = {
      ...(cache[this.cacheKey] || {}),
      openid: this.openid || this.getCached().openid || "",
      ...(this.token ? { token: this.token } : {}),
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

  async getWxCode() {
    if (!this.openid) throw new Error("缺少 openid，无法自动登录");
    // YYB-Go：POST /wxapp/getCode（一个账号一次请求，失败即抛错）
    return yyb.getCode(this.openid);
  }

  async login() {
    const code = await this.getWxCode();
    const data = assertOk(
      await request("post", FM_BASE, "/api/v2/login/wxMiniSilentLogin", {
        data: { code },
      }),
      "静默登录"
    );
    if (!data?.token) throw new Error(`静默登录未返回 token: ${JSON.stringify(data)}`);
    this.token = data.token;
    this.saveCache({
      unionId: data.unionId || "",
      phone: data.phone || "",
      mainOpenId: data.openId || "",
    });
    $.log(`账号[${this.index}] 登录成功: ${mask(data.phone || data.openId || this.token)}`);
  }

  async ensureLogin() {
    if (!this.token) this.token = this.getCached().token || "";
    if (this.token) return;
    await this.login();
  }

  async withRelogin(fn) {
    let res = await fn();
    const msg = `${res?.message || ""}${res?.msg || ""}`;
    // 5001 既可能是会话过期也可能是加密不对，两种都靠重登 garden 会话解决
    if (!okCode(res) && this.openid && /登录|授权|token|Token|未认证|失效|重新进入|用户信息异常/.test(msg)) {
      $.log(`账号[${this.index}] garden 会话疑似失效，重新登录`);
      this.garden = null;
      await this.gardenLogin();
      res = await fn();
    }
    return res;
  }

  /**
   * garden 会话：走【习酒】appid 的两段式登录（每次跑消耗 2 个 code）。
   *   ① code -> GET {MAIN_BASE}/auth/session?code=  -> data.login_code   （请求头 login_code）
   *   ② code -> GET {GARDEN_BASE}/garden/wechat/login?code=  -> data.authorized_token（请求头 Authorization）
   * 会员和君品荟侧是同一个（authorized_token 的 JWT 里 memberInfo.id 一致）。
   */
  async gardenLogin() {
    if (!this.openid) throw new Error("缺少 openid，无法登录 garden");

    // YYB-Go：两次都向 garden 小程序要新的 wx.login code（code 一次性）
    const sess = await request("get", MAIN_BASE, "/auth/session", {
      params: { code: await gardenYyb.getCode(this.openid) },
      hdrs: gardenHeaders(),
    });
    const loginCode = (sess?.data || {}).login_code || "";

    const auth = await request("get", GARDEN_BASE, "/garden/wechat/login", {
      params: { code: await gardenYyb.getCode(this.openid) },
      hdrs: gardenHeaders({ loginCode }),
    });
    const authorizedToken = assertOk(auth, "garden 登录")?.authorized_token;
    if (!authorizedToken) throw new Error(`garden 登录未返回 authorized_token: ${shortJson(auth)}`);

    this.garden = { loginCode, authorizedToken };
    $.log(`账号[${this.index}] garden 登录成功`);
  }

  async ensureGarden() {
    if (!this.garden?.authorizedToken) await this.gardenLogin();
    return this.garden;
  }

  async gardenGet(urlPath, params = {}) {
    const res = await this.withRelogin(async () =>
      request("get", GARDEN_BASE, urlPath, { hdrs: gardenHeaders(await this.ensureGarden()), params })
    );
    return assertOk(res, urlPath);
  }

  async gardenPost(urlPath, data = {}) {
    const res = await this.withRelogin(async () =>
      request("post", GARDEN_BASE, urlPath, { hdrs: gardenHeaders(await this.ensureGarden()), data })
    );
    return assertOk(res, urlPath);
  }

  /**
   * encryptData 用的密钥必须取【习酒】appid 的（GARDEN_APP_ID）。
   * 用君品荟自己的 appid 取，服务端一律回 5001「用户信息异常」——
   * 因为它是按请求头里的 AppID 去找对应 appid 的用户密钥来解密的。
   */
  async getEncryptKey() {
    if (!this.openid) throw new Error("缺少 openid，无法生成 encryptData");
    const { data } = await axios.post(
      `${gardenWechat.serverUrl}/wx/encryptkey`,
      { appid: GARDEN_APP_ID, openid: this.openid },
      {
        headers: { auth: gardenWechat.auth },
        timeout: 30000,
        validateStatus: () => true,
      }
    );
    if (!data?.status) throw new Error(data?.message || "YYB-Go 获取 encryptkey 失败");
    const info = data.data || {};
    const encryptKey = info.encryptKey || info.encrypt_key;
    const iv = info.iv;
    const version = info.version;
    if (!encryptKey || !iv || version === undefined) {
      throw new Error(`YYB-Go encryptkey 缺少必要字段: ${JSON.stringify(data)}`);
    }
    return { encryptKey, iv, version };
  }

  async encryptData(data = {}) {
    const payload = data && typeof data === "object" ? { ...data } : {};
    const key = await this.getEncryptKey();
    payload.ts = Date.now();
    payload.encryptData = aesCbcPkcs7Hex(JSON.stringify(payload), key.encryptKey, key.iv);
    payload.version = key.version;
    return payload;
  }

  async encryptedPost(urlPath, data = {}) {
    return this.withEncryptHint(urlPath, async () => this.gardenPost(urlPath, await this.encryptData(data)));
  }

  async encryptedGet(urlPath, data = {}) {
    return this.withEncryptHint(urlPath, async () => this.gardenGet(urlPath, await this.encryptData(data)));
  }

  /**
   * 加密写接口被拒时补一句根因指向。5001 现在只剩两种可能：
   * garden 会话过期（withRelogin 已经自动重登重放过一次），或者密钥拿错了 appid。
   */
  async withEncryptHint(urlPath, fn) {
    try {
      return await fn();
    } catch (e) {
      const msg = String(e.message || e);
      if (/用户信息异常|请从小程序重新进入|请删除小程序/.test(msg)) {
        throw new Error(`${msg} ← encryptData 校验失败：密钥必须取 ${GARDEN_APP_ID}(习酒) 的，见文件头说明`);
      }
      if (/滑块|5008/.test(msg)) {
        throw new Error(`${msg} ← 触发滑块验证，按规则不绕，请在小程序里手动过一次`);
      }
      throw e;
    }
  }

  async queryMember() {
    const info = await this.gardenGet("/garden/Gardenmemberinfo/getMemberInfo");
    this.member = info || {};
    this.saveCache({
      memberId: info?.member_id || "",
      nickName: info?.nick_name || "",
      integration: info?.integration || "",
    });
    $.log(
      `账号[${this.index}] 会员: ${info?.nick_name || mask(info?.member_id || "")}，积分${info?.integration ?? "未知"}，水滴${info?.water ?? 0}，有机肥${info?.manure ?? 0}，种子${info?.sorghum ?? 0}`
    );
    return info || {};
  }

  async dailySign() {
    try {
      const data = await this.encryptedPost("/garden/sign/dailySign");
      $.log(`账号[${this.index}] 签到成功: ${shortJson(data || "ok")}`);
    } catch (e) {
      $.log(`账号[${this.index}] 签到失败: ${e.message || e}`);
    }
  }

  async queryFarm() {
    const data = await this.gardenGet("/garden/sorghum/index");
    const lands = listify(data);
    const summary = lands
      .map((v) => `#${v.serial_number ?? v.id ?? "?"}:${v.status ?? "?"}`)
      .join(" ");
    $.log(`账号[${this.index}] 地块: ${lands.length || 0}块 ${summary}`.trim());
    return lands;
  }

  landPayload(land) {
    const id = pickId(land);
    return {
      id,
      sorghum_id: id,
      member_sorghum_id: id,
      land_id: id,
    };
  }

  async harvestFarm(lands) {
    const candidates = lands.filter(isHarvestable);
    if (!candidates.length) return false;

    let acted = false;
    try {
      const data = await this.encryptedGet("/garden/Sorghum/harvestAll");
      $.log(`账号[${this.index}] 一键收获成功: ${shortJson(data || "ok")}`);
      return true;
    } catch (e) {
      $.log(`账号[${this.index}] 一键收获失败，尝试单块收获: ${e.message || e}`);
    }

    for (const land of candidates) {
      try {
        const data = await this.encryptedPost("/garden/sorghum/harvest", this.landPayload(land));
        $.log(`账号[${this.index}] 收获成功: 地块${landNo(land)} ${shortJson(data || "ok")}`);
        acted = true;
      } catch (e) {
        $.log(`账号[${this.index}] 收获失败[${landNo(land)}]: ${e.message || e}`);
      }
      await $.wait(500, 1200);
    }
    return acted;
  }

  async seedFarm(lands) {
    const seedCount = Number(this.member.sorghum || 0);
    if (seedCount <= 0) {
      $.log(`账号[${this.index}] 无可用种子，跳过种植`);
      return false;
    }
    const candidates = lands.filter(isPlantable);
    if (!candidates.length) {
      $.log(`账号[${this.index}] 未识别到可种植地块`);
      return false;
    }
    let acted = false;
    const limit = Math.min(seedCount, candidates.length);
    for (let i = 0; i < limit; i++) {
      const land = candidates[i];
      try {
        const data = await this.encryptedPost("/garden/sorghum/seed", this.landPayload(land));
        $.log(`账号[${this.index}] 种植成功: 地块${landNo(land)} ${shortJson(data || "ok")}`);
        acted = true;
      } catch (e) {
        $.log(`账号[${this.index}] 种植失败[${landNo(land)}]: ${e.message || e}`);
      }
      await $.wait(500, 1200);
    }
    return acted;
  }

  async waterFarm(lands) {
    const waterCount = Number(this.member.water || 0);
    if (waterCount <= 0) {
      $.log(`账号[${this.index}] 无可用水滴，跳过浇水`);
      return false;
    }
    const candidates = lands.filter(isGrowing);
    if (!candidates.length) {
      $.log(`账号[${this.index}] 未识别到可浇水地块`);
      return false;
    }
    let acted = false;
    const limit = Math.min(waterCount, candidates.length);
    for (let i = 0; i < limit; i++) {
      const land = candidates[i];
      try {
        const data = await this.encryptedPost("/garden/sorghum/watering", this.landPayload(land));
        $.log(`账号[${this.index}] 浇水成功: 地块${landNo(land)} ${shortJson(data || "ok")}`);
        acted = true;
      } catch (e) {
        $.log(`账号[${this.index}] 浇水失败[${landNo(land)}]: ${e.message || e}`);
      }
      await $.wait(500, 1200);
    }
    return acted;
  }

  async manureFarm(lands) {
    const manureCount = Number(this.member.manure || 0);
    if (manureCount <= 0) {
      $.log(`账号[${this.index}] 无可用有机肥，跳过施肥/养护`);
      return false;
    }
    const candidates = lands.filter(isGrowing);
    if (!candidates.length) {
      $.log(`账号[${this.index}] 未识别到可施肥/养护地块`);
      return false;
    }
    let acted = false;
    const limit = Math.min(manureCount, candidates.length);
    for (let i = 0; i < limit; i++) {
      const land = candidates[i];
      try {
        const data = await this.encryptedPost("/garden/sorghum/manuring", this.landPayload(land));
        $.log(`账号[${this.index}] 施肥/养护成功: 地块${landNo(land)} ${shortJson(data || "ok")}`);
        acted = true;
      } catch (e) {
        $.log(`账号[${this.index}] 施肥/养护失败[${landNo(land)}]: ${e.message || e}`);
      }
      await $.wait(500, 1200);
    }
    return acted;
  }

  async runFarmAutomation() {
    const maxRounds = Number(process.env.junpinhui_farm_rounds || 5);
    let anyAction = false;
    for (let round = 1; round <= maxRounds; round++) {
      $.log(`账号[${this.index}] 农场自动化第${round}轮`);
      await this.queryMember();
      let lands = await this.queryFarm();

      const harvested = await this.harvestFarm(lands);
      if (harvested) {
        anyAction = true;
        await this.queryMember();
        lands = await this.queryFarm();
      }

      const seeded = await this.seedFarm(lands);
      if (seeded) {
        anyAction = true;
        await this.queryMember();
        lands = await this.queryFarm();
      }

      const watered = await this.waterFarm(lands);
      if (watered) {
        anyAction = true;
        await this.queryMember();
        lands = await this.queryFarm();
      }

      const manured = await this.manureFarm(lands);
      if (manured) {
        anyAction = true;
        await this.queryMember();
        await this.queryFarm();
      }

      if (!harvested && !seeded && !watered && !manured) break;
      await $.wait(800, 1600);
    }
    if (!anyAction) $.log(`账号[${this.index}] 农场暂无可执行动作`);
    return anyAction;
  }

  async queryTasks() {
    const data = await this.gardenGet("/garden/tasks/index");
    const tasks = listify(data);
    if (!tasks.length) {
      $.log(`账号[${this.index}] 未查询到任务列表`);
      return [];
    }
    $.log(
      `账号[${this.index}] 任务: ${tasks
        .map((t) => `${t.name || t.code || t.id}:${isCompleted(t) ? "已完成" : "未完成"}`)
        .join("，")}`
    );
    return tasks;
  }

  async doShareTask() {
    try {
      const data = await this.encryptedPost("/garden/gardenmemberinfo/dailyShare");
      $.log(`账号[${this.index}] 分享任务完成: ${shortJson(data || "ok")}`);
    } catch (e) {
      $.log(`账号[${this.index}] 分享任务失败: ${e.message || e}`);
    }
  }

  async doQuestionTask() {
    try {
      const questions = listify(await this.gardenGet("/garden/Gardenquestiontask/index"));
      if (!questions.length) {
        $.log(`账号[${this.index}] 每日一答无题目`);
        return;
      }
      for (const q of questions) {
        const id = q.id;
        const answer = q.answer;
        if (!id || !answer) continue;
        const data = await this.encryptedGet("/garden/Gardenquestiontask/answerResultsJph", {
          question_id: id,
          answer,
        });
        $.log(`账号[${this.index}] 每日一答完成: ${q.title ? shortJson(q.title, 45) : id} => ${shortJson(data || "ok")}`);
        await $.wait(500, 1200);
      }
    } catch (e) {
      $.log(`账号[${this.index}] 每日一答失败: ${e.message || e}`);
    }
  }

  async doRealityTask() {
    try {
      const data = await this.gardenGet("/garden/realscene/reward");
      $.log(`账号[${this.index}] 实景相册任务: ${shortJson(data || "ok")}`);
    } catch (e) {
      $.log(`账号[${this.index}] 实景相册任务失败: ${e.message || e}`);
    }
  }

  async doCompleteInfoTask() {
    try {
      const data = await this.gardenGet("/garden/tasks/checkCompleteMemberInfo");
      $.log(`账号[${this.index}] 完善信息任务: ${shortJson(data || "ok")}`);
    } catch (e) {
      $.log(`账号[${this.index}] 完善信息任务失败: ${e.message || e}`);
    }
  }

  async doSubscribePrize() {
    try {
      const data = await this.gardenGet("/garden/tasks/getSubscribePrize");
      $.log(`账号[${this.index}] 订阅奖励: ${shortJson(data || "ok")}`);
    } catch (e) {
      $.log(`账号[${this.index}] 订阅奖励失败: ${e.message || e}`);
    }
  }

  async doTasks(tasks) {
    const pending = tasks.filter((task) => !isCompleted(task));
    if (!pending.length) {
      $.log(`账号[${this.index}] 暂无未完成任务`);
      return;
    }
    for (const task of pending) {
      const code = task.code || "";
      if (code === "answer_survey") await this.doQuestionTask();
      else if (code === "garden_share") await this.doShareTask();
      else if (code === "view_organic_sorghum") await this.doRealityTask();
      else if (code === "complete_member_info") await this.doCompleteInfoTask();
      else if (/subscribe/i.test(code)) await this.doSubscribePrize();
      else $.log(`账号[${this.index}] 未适配任务: ${task.name || code || task.id}`);
      await $.wait(500, 1200);
    }
  }

  async run() {
    $.log(`\n账号[${this.index}] ${mask(this.openid || this.cacheKey)}`);
    // 所有业务都在 garden 上，直接用 garden 会话；原来的 fm 静默登录只是拿一个
    // 对 garden 无效的 X-Access-Token，白耗一个 code，已不再调用。
    await this.ensureGarden();
    await this.queryMember();
    await this.dailySign();

    const tasks = await this.queryTasks();
    await this.doTasks(tasks);

    await this.runFarmAutomation();

    await this.queryMember();
    await this.queryFarm();
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
      $.log(`账号执行失败: ${e.message || e}`);
    }
  }
})()
  .catch((e) => $.log(`脚本异常: ${e.message || e}`))
  .finally(() => $.done && $.done());
