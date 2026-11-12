// name: 小米社区签到
/*
------------------------------------------
@Description: 小米社区 - 微信小程序登录 + 每日签到
cron: 15 8 * * *
------------------------------------------

------------------------------------------
契约（appid wx240a4a764023c444，登录 account.xiaomi.com / 业务 api.vip.miui.com）：
（迁移自 YYB-GO 系脚本，原脚本已 code 登录）

登录（纯 wx code，无需小米账号密码/passToken 外部凭证）：
  0) 取微信 getUserInfo 加密资料：POST YYB-Go/wx/getuserinfo {appid,openid}
       -> data.{cloud_id,encryptedData,iv,signature,data(明文profile)}
  1) POST account.xiaomi.com/pass/sns/wxapp/v2/code
       form {code, appid, sid:"wx_vip", userInfo:"true", _locale:"zh_CN"}
       -> code==0，data.wxSToken（微信登录临时票据）
  2) set-cookie deviceId / wxSToken；并把 userInfo 写进 cookie（url-encoded JSON:
       {cloudID,encryptedData,iv,signature,userInfo,rawData,errMsg}）
       ★ 关键：缺 userInfo cookie 时 tokenLogin 只会 302 到 serviceLogin、无法签发会话
  3) POST account.xiaomi.com/pass/sns/wxapp/v3/tokenLogin
       form {sid:"wx_vip", appid, callback:"", authType:"1", wxSToken, _locale}，不跟随重定向
       -> 返回 JSON 含 passToken/userId/cUserId（存缓存）
          code=20003 用户不存在=该微信未注册小米账号；code=24023 用户密码未设置=账号未激活
  4) set-cookie passToken/userId/cUserId
  5) GET account.xiaomi.com/pass/serviceLogin?sid=wx_vip&_json=true -> code0，location(STS地址)
  6) GET <STS地址> -> {S:"OK"}，set-cookie wx_vip_ph（社区会话票据）
签到（api.vip.miui.com，用 ?wx_vip_ph= 作为会话）：
  查询 GET /mtop/planet/wechat/checkin/mypagedata -> entity.data[].title=="每日签到" 的 button=="已签到" 即已签
  签到 POST /mtop/planet/wechat/member/addCommunityGrowUpPointByActionV2  form {action:"WECHAT_CHECKIN_TASK"}
        -> message=="success" 成功
sid="wx_vip"、action="WECHAT_CHECKIN_TASK" 是这家小程序固定应用常量（原脚本硬编码，非个人凭证）。
passToken/userId/cUserId 为登录后本机生成的会话票据，按 openid 存本地缓存 xmsq_token_cache.json。
------------------------------------------
 YYB-Go 版：取码改走 YYB-Go（POST /wxapp/getCode），不再依赖原取码桥接服务。
 变量：YYB_SERVER 每行 地址@账号标识（例如 http://yyb-go:8000@1）；YYB_API_KEY 可选。
 原桥接版脚本见 wxapp/xmsq.js，业务接口、流程与缓存格式均未改动。
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
const $ = new Env("小米社区签到");
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

const MINI_APP_ID = "wx240a4a764023c444";
const PAGE_VERSION = "73";
const ACCOUNT = "https://account.xiaomi.com";
const BASE = "https://api.vip.miui.com";
const SID = "wx_vip";
const TOKEN_CACHE_FILE = path.join(__dirname, "tokencache", "xmsq_token_cache.json");
const UA =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) " +
    "Mobile/15E148 MicroMessenger/8.0.73(0x18004939) NetType/WIFI Language/zh_CN";
const REFERER = `https://servicewechat.com/${MINI_APP_ID}/${PAGE_VERSION}/page-frame.html`;

const yyb = new YYBClient({ appid: MINI_APP_ID });

const DEBUG = process.env.XMSQ_DEBUG === "1";

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
function short(v, n = 300) {
    const t = typeof v === "string" ? v : JSON.stringify(v);
    return !t ? "" : t.length > n ? `${t.slice(0, n)}...` : t;
}
// 小米部分 JSON 接口以 &&&START&&& 开头
function parseXiaomiJson(text) {
    if (text == null) return {};
    if (typeof text === "object") return text;
    let t = String(text);
    if (t.startsWith("&&&START&&&")) t = t.slice("&&&START&&&".length);
    try { return JSON.parse(t); } catch (e) { return { __raw: t }; }
}

class CookieJar {
    constructor() { this.map = {}; }
    setFromResponse(res) {
        const sc = res && res.headers && res.headers["set-cookie"];
        if (!sc) return;
        for (const line of sc) {
            const seg = String(line).split(";")[0];
            const eq = seg.indexOf("=");
            if (eq < 0) continue;
            const name = seg.slice(0, eq).trim();
            const val = seg.slice(eq + 1).trim();
            if (name) this.map[name] = val;
        }
    }
    set(name, val) { this.map[name] = String(val); }
    get(name) { return this.map[name]; }
    header() { return Object.entries(this.map).map(([k, v]) => `${k}=${v}`).join("; "); }
}

class Task {
    constructor(raw) {
        this.index = $.userIdx++;
        this.account = parseAccount(raw);
        this.jar = new CookieJar();
    }
    log(text) {
        $.log(`账号[${this.index}]${this.account.remark ? `[${this.account.remark}]` : ""} ${text}`);
    }
    /** 取 wx.login code：YYB-Go /wxapp/getCode（一个账号一次请求，失败即抛错） */
    async getCode() {
        return yyb.getCode(this.account.openid);
    }
    // 取微信 getUserInfo 加密资料（小米登录前需把它写进 userInfo cookie，否则 tokenLogin 302 无法签发会话）
    async getUserInfoBlob() {
        try {
            // YYB-Go /wx/getuserinfo 只返回账号资料；encryptedData/iv/signature 属小程序侧能力，缺失即按不可用处理。
            const d = await yyb.getAccountInfo(this.account.openid);
            if (!d || !d.encryptedData) return null;
            let profile = {}; try { profile = JSON.parse(d.data); } catch (e) {}
            // rawData 用微信原样返回串（保持 signature 有效）；cloud_id → cloudID
            return { cloudID: d.cloud_id, encryptedData: d.encryptedData, iv: d.iv, signature: d.signature, userInfo: profile, rawData: d.data, errMsg: "getUserInfo:ok" };
        } catch (e) { return null; }
    }
    async req(method, url, { form, params, allowRedirect = true } = {}) {
        const headers = {
            "User-Agent": UA,
            Referer: REFERER,
            Origin: "https://servicewechat.com",
            Accept: "*/*",
        };
        const cookie = this.jar.header();
        if (cookie) headers.Cookie = cookie;
        let data;
        if (form) {
            headers["Content-Type"] = "application/x-www-form-urlencoded";
            data = new URLSearchParams(form).toString();
        }
        const res = await axios.request({
            method, url, data, params,
            headers,
            timeout: 20000,
            responseType: "text",
            transformResponse: (r) => r,
            maxRedirects: allowRedirect ? 5 : 0,
            validateStatus: () => true,
        });
        this.jar.setFromResponse(res);
        if (DEBUG) this.log(`  «${method} ${url.replace(/^https?:\/\/[^/]+/, "")}» HTTP ${res.status} :: ${short(res.data, 260)}`);
        return res;
    }

    // ── 登录：纯 wx code(+微信userInfo) → wxSToken → passToken → serviceLogin → STS → wx_vip_ph ──
    async login() {
        const code = await this.getCode();
        const userInfoBlob = await this.getUserInfoBlob();
        this.jar.set("deviceId", `wp_${$.uuid()}`);

        // 1) 微信 code 换 wxSToken
        const r1 = await this.req("POST", `${ACCOUNT}/pass/sns/wxapp/v2/code`, {
            form: { code, appid: MINI_APP_ID, sid: SID, userInfo: "true", _locale: "zh_CN" },
        });
        const b1 = parseXiaomiJson(r1.data);
        if (b1.code !== 0) {
            const desc = b1.description || b1.desc || b1.message || short(b1);
            throw new Error(`NO_ACCOUNT:微信换取小米登录票据失败(code=${b1.code}, ${desc})`);
        }
        const wxSToken = b1.data && b1.data.wxSToken;
        if (!wxSToken) throw new Error(`NO_ACCOUNT:小米登录响应缺少 wxSToken: ${short(b1)}`);
        this.jar.set("wxSToken", wxSToken);
        // 关键：把微信 userInfo 写进 cookie，tokenLogin 才会返回 JSON 会话（缺它会 302）
        if (userInfoBlob) this.jar.set("userInfo", encodeURIComponent(JSON.stringify(userInfoBlob)));

        // 2) 建立小米账号会话（返回 passToken；老账号可能 302，退回本地缓存）
        const r2 = await this.req("POST", `${ACCOUNT}/pass/sns/wxapp/v3/tokenLogin`, {
            form: { sid: SID, appid: MINI_APP_ID, callback: "", authType: "1", wxSToken, _locale: "zh_CN" },
            allowRedirect: false,
        });
        let session = {};
        if (r2.status >= 300 && r2.status < 400) {
            const cached = readCache()[this.account.openid] || {};
            if (!cached.passToken || !cached.userId) {
                throw new Error("小米账号已有登录态但本地缺少首登票据，请在真机小程序登录一次以生成缓存后再跑");
            }
            session = cached;
            this.log("已加载本地缓存会话票据");
        } else {
            const b2 = parseXiaomiJson(r2.data);
            if (!b2.passToken) {
                // 常见账号态：用户不存在 / 未设置密码（微信绑定的小米账号未完成注册激活）
                if (b2.code === 20003) throw new Error(`NO_ACCOUNT:小米账号不存在(20003 ${b2.description || "用户不存在"})`);
                if (b2.code === 24023) throw new Error(`NOT_ACTIVATED:小米账号未设置密码(24023 用户密码未设置)`);
                throw new Error(`小米会话建立失败: ${short(b2)}`);
            }
            session = { passToken: b2.passToken, userId: b2.userId, cUserId: b2.cUserId };
            const cache = readCache();
            cache[this.account.openid] = { ...session, updatedAt: new Date().toISOString() };
            writeCache(cache);
        }
        for (const k of ["passToken", "userId", "cUserId"]) {
            if (session[k]) this.jar.set(k, session[k]);
        }

        // 3) serviceLogin 拿 STS 跳转地址
        const r3 = await this.req("GET", `${ACCOUNT}/pass/serviceLogin`, {
            params: { sid: SID, _json: "true", _locale: "zh_CN" },
        });
        const b3 = parseXiaomiJson(r3.data);
        const stsUrl = b3.location;
        if (b3.code !== 0 || !stsUrl) throw new Error(`serviceLogin 失败: ${short(b3)}`);

        // 4) STS 登录，拿 wx_vip_ph 社区会话票据
        const r4 = await this.req("GET", stsUrl);
        const b4 = parseXiaomiJson(r4.data);
        if (b4.S !== "OK") throw new Error(`STS 登录失败: ${short(b4)}`);
        const ph = this.jar.get("wx_vip_ph");
        if (!ph) throw new Error(`STS 未返回 wx_vip_ph: ${short(b4)}`);
        this.ph = ph;
        this.log("登录成功");
    }

    // ── 业务：查询 + 签到 ──
    async apiGet(apiPath) {
        const res = await this.req("GET", `${BASE}${apiPath}`, { params: { wx_vip_ph: this.ph } });
        return parseXiaomiJson(res.data);
    }
    async apiPostForm(apiPath, form) {
        const res = await this.req("POST", `${BASE}${apiPath}`, { params: { wx_vip_ph: this.ph }, form });
        return parseXiaomiJson(res.data);
    }
    async sign() {
        const status = await this.apiGet("/mtop/planet/wechat/checkin/mypagedata");
        if (status.code === 401) throw new Error("SESSION_INVALID:小米登录态无效");
        const buttons = (status.entity && status.entity.data) || [];
        const already = Array.isArray(buttons) && buttons.some(
            (item) => item && item.title === "每日签到" &&
                ((item.buttons && item.buttons[0] && item.buttons[0].button) === "已签到")
        );
        if (already) return this.log("✅ 今日已签到，无需重复执行");

        const res = await this.apiPostForm("/mtop/planet/wechat/member/addCommunityGrowUpPointByActionV2", { action: "WECHAT_CHECKIN_TASK" });
        if (res.message === "success") {
            const entity = res.entity || {};
            return this.log(`✅ 签到成功${entity.title ? `，${entity.title}` : "，获得成长值"}`);
        }
        const msg = res.message || res.description || res.desc || short(res);
        if (/已签|签到过|重复|已完成/.test(String(msg))) return this.log(`✅ 今日已签到（${msg}）`);
        this.log(`❌ 签到失败: ${msg}`);
    }
    async run() {
        if (!this.account.openid) { this.log("跳过：变量值里没有 openid"); return; }
        try {
            await this.login();
            await this.sign();
        } catch (e) {
            const m = String(e.message || e);
            if (m.startsWith("NO_ACCOUNT")) {
                this.log(`⚠️ 该微信号尚未注册小米账号/社区，请先在小程序里用微信登录并完成注册再跑。详情：${m.replace(/^NO_ACCOUNT:/, "")}`);
                return;
            }
            if (m.startsWith("NOT_ACTIVATED")) {
                this.log(`⚠️ 微信绑定的小米账号未激活（未设置密码），请在小米社区/账号中心完成账号设置后再跑。详情：${m.replace(/^NOT_ACTIVATED:/, "")}`);
                return;
            }
            this.log(`执行失败: ${m}`);
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
