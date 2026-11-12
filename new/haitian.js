// name: 海天美味馆小程序
/*
------------------------------------------
@Author: sm
@Date: 2026.06.01
@Description:  海天美味馆小程序
cron: 30 11 * * *
------------------------------------------
#Notice:
变量名 haitian

可选变量：
  haitian_phone_login  是否允许用 /wx/getphonenumber 的手机号授权数据登录，默认 1(开启)。
                       海天只有这一条登录路（等同小程序里点“手机号快捷登录”按钮），
                       置 0 则改为自己抓包按 authorization#uuid 手填变量。

登录链路（反编译包 wx7a890ea13f50d7b6 主包，逐行核对）：
  手机号授权 -> e.detail.encryptedData / e.detail.iv
  再 uni.login() 取一次 code
  -> POST buyer-api/wechat/mini/phoneNew/login?edata=&iv=&code=&uuid=&article_ids=&app_versions=
  -> {access_token, refresh_token, uid, success}
  components/login/login.js:180-212(mpWxPhoneLogin)、common/vendor.js:4394(wxRegisterOrLogin)
  注意 edata/iv 必须是【手机号】授权回调里的加密数据（YYB-Go 走 /wx/getphonenumber
  返回的 data.raw.encryptedData / data.raw.iv）；早先脚本传的是 /wx/getuserinfo 的
  【用户资料】加密数据（里面只有 nickName/avatarUrl），服务端解出来没有 phoneNumber，
  固定回 HTTP 500 {"code":"E131","message":"登录失败"}——这不是服务端故障。
  access_token 过期可用 POST buyer-api/passport/token {refresh_token} 续期（vendor.js:13707）。

⚠️【免责声明】
------------------------------------------
1、此脚本仅用于学习研究，不保证其合法性、准确性、有效性，请根据情况自行判断，本人对此不承担任何保证责任。
2、由于此脚本仅用于学习研究，您必须在下载后 24 小时内将所有内容从您的计算机或手机或任何存储设备中完全删除，若违反规定引起任何事件本人对此均不负责。
3、请勿将此脚本用于任何商业或非法目的，若违反规定请自行对此负责。
4、此脚本涉及应用与本人无关，本人对因此引起的任何隐私泄漏或其他后果不承担任何责任。
5、本人对任何脚本引发的问题概不负责，包括但不限于由脚本错误引起的任何损失和损害。
6、如果任何单位或个人认为此脚本可能涉嫌侵犯其权利，应及时通知并提供身份证明，所有权证明，我们将在收到认证文件确认后删除此脚本。
7、所有直接或间接使用、查看此脚本的人均应该仔细阅读此声明。本人保留随时更改或补充此声明的权利。一旦您使用或复制了此免责声明。
 YYB-Go 版：取码改走 YYB-Go（POST /wxapp/getCode），不再依赖原取码桥接服务。
 变量：YYB_SERVER 每行 地址@账号标识（例如 http://yyb-go:8000@1）；YYB_API_KEY 可选。
 原桥接版脚本见 wxapp/haitian.js，业务接口、流程与缓存格式均未改动。
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

const yyb = new YYBClient({ appid: "wx7a890ea13f50d7b6" });
const $ = new Env("海天美味馆小程序");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

const strSplitor = "#";
const MINI_APP_ID = "wx7a890ea13f50d7b6";
const PAGE_VERSION = "772";
const API_BASE = "https://cmallapi.xkmm.cn/buyer-api";
const BASE_API = "https://cmallapi.xkmm.cn/base-api";
const TOKEN_CACHE_FILE = path.join(__dirname, "tokencache", "haitian_token_cache.json");
// 手机号授权开关：默认开启(1)。海天的登录接口只吃手机号授权的加密数据，
// 不想授权就置 0，然后自行抓包按 authorization#uuid 填变量。
const PHONE_LOGIN = !/^(0|false|no|off)$/i.test(String(process.env.haitian_phone_login ?? "1"));
const defaultUserAgent = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_7_15 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.70(0x1800462d) NetType/WIFI Language/zh_CN";

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
    const value = String(token || "");
    return value ? `${value.slice(0, 6)}***${value.slice(-6)}` : "";
}

function maskPhone(phone = "") {
    return String(phone || "").replace(/^(\d{3})\d{4}(\d{4})$/, "$1****$2");
}

function randomUuid(len = 20) {
    const chars = "abcdef0123456789";
    let value = "";
    for (let i = 0; i < len; i++) value += chars[Math.floor(Math.random() * chars.length)];
    return value;
}

function isTokenError(message) {
    return /401|403|token|登录|授权|失效|过期|no-show-toast/i.test(String(message || ""));
}

// 幂等：重复签到服务端回 HTTP 500 {"code":"1019","message":"今天已经签到过了"}，
// 老正则只有 /已签|重复/，匹配不到「已经签到过了」，会把成功当失败报
function isAlreadySigned(message) {
    return /\b1019\b|已签|已经签|签到过|重复|already/i.test(String(message || ""));
}

// 活动侧状态（结束/未开始），不是脚本故障，不打 ❌
function isActivityClosed(message) {
    return /活动(还没有开始|未开始|已经结束|已结束)|已经结束|已结束|\b002\b|\b1009\b/.test(String(message || ""));
}

class Task {
    constructor(env) {
        this.index = $.userIdx++;
        this.raw = String(env || "").trim();
        this.user = this.raw.split(strSplitor);
        this.accountId = this.user[0].trim();
        this.token = "";
        this.refreshToken = "";
        this.communityToken = "";
        this.uuid = randomUuid();
        this.activity_code = "";
        this.userFlag = false;
        this.userInfo = {};
        // 旧格式 authorization#uuid：第一段是 JWT；openid#备注 这种不算
        this.isLegacyToken = this.user.length >= 2 && /^ey[A-Za-z0-9_-]{10,}\./.test(this.accountId);
        if (this.isLegacyToken) {
            this.token = this.user[0].trim();
            this.uuid = this.user[1].trim() || this.uuid;
            this.accountId = `legacy:${shortToken(this.token)}`;
        }
    }

    async run() {
        if (this.isLegacyToken) {
            $.log(`账号[${this.index}] 检测到旧版 authorization#uuid 格式，先迁移到缓存`);
            this.saveCachedToken();
        } else {
            const cached = this.getCachedToken();
            if (cached?.accessToken) {
                this.applyToken(cached);
                $.log(`账号[${this.index}] 使用缓存token: ${shortToken(this.token)}`);
                if (!(await this.checkToken())) {
                    $.log(`账号[${this.index}] 缓存token失效，尝试用 refresh_token 续期`);
                    if (!(await this.refreshAccessToken())) {
                        this.removeCachedToken();
                        $.log(`账号[${this.index}] 续期失败，重新登录`);
                    }
                }
            }

            if (!this.token) {
                if (!PHONE_LOGIN) {
                    $.log(
                        `账号[${this.index}] 没有可用 token：海天唯一的登录接口 wechat/mini/phoneNew/login 需要微信手机号授权的加密数据(小程序里就是“手机号快捷登录”)，而你把 haitian_phone_login 置成了 0。\n` +
                            `  两种办法二选一：\n` +
                            `  1) 允许手机号授权 -> 去掉 haitian_phone_login 或置 1，脚本自动用 YYB-Go 的 /wx/getphonenumber 登录；\n` +
                            `  2) 继续不授权 -> 自行抓一次小程序请求，把 Authorization 和 uuid 按 authorization${strSplitor}uuid 填进 ${ckName} 变量`
                    );
                    return;
                }
                await this.loginByWxCode();
                if (!this.token) return;
            }
        }

        await this.getUserInfo();
        if (!this.userFlag) return;

        await this.task_1();
        await this.task_2();
        await this.getSignActivity();

        if (this.activity_code) {
            await this.signIn();
            if (await this.getLotteryTaskList()) await this.getLotteryNum();
        }
    }

    cacheKey() {
        return this.isLegacyToken ? this.accountId : this.raw;
    }

    getCachedToken() {
        const cache = readTokenCache();
        return cache[this.cacheKey()] || null;
    }

    saveCachedToken() {
        if (!this.token) return;
        const cache = readTokenCache();
        cache[this.cacheKey()] = {
            accessToken: this.token,
            refreshToken: this.refreshToken,
            communityToken: this.communityToken,
            uuid: this.uuid,
            userInfo: this.userInfo,
            updatedAt: new Date().toISOString(),
        };
        writeTokenCache(cache);
    }

    removeCachedToken() {
        const cache = readTokenCache();
        if (cache[this.cacheKey()]) {
            delete cache[this.cacheKey()];
            writeTokenCache(cache);
        }
        this.token = "";
        this.refreshToken = "";
        this.communityToken = "";
        this.userInfo = {};
    }

    applyToken(data = {}) {
        this.token = data.accessToken || data.token || "";
        this.refreshToken = data.refreshToken || "";
        this.communityToken = data.communityToken || "";
        this.uuid = data.uuid || this.uuid;
        this.userInfo = data.userInfo || {};
    }

    headers(extra = {}, auth = true, isJson = false) {
        const headers = {
            "Connection": "keep-alive",
            "envVersion": "release",
            "Content-Type": isJson ? "application/json" : "application/x-www-form-urlencoded",
            "uuid": this.uuid,
            "Accept-Encoding": "gzip,compress,br,deflate",
            "User-Agent": defaultUserAgent,
            "Referer": `https://servicewechat.com/${MINI_APP_ID}/${PAGE_VERSION}/page-frame.html`,
            ...extra,
        };
        if (auth) {
            headers.Authorization = this.token;
            if (this.communityToken) headers["X-Haday-Token"] = this.communityToken;
        }
        return headers;
    }

    async request(pathname, { method = "GET", params, data, auth = true, isJson = false, base = API_BASE } = {}) {
        const options = {
            method,
            url: `${base}${pathname}`,
            params,
            headers: this.headers({}, auth, isJson),
            timeout: 20000,
            validateStatus: () => true,
        };
        if (data !== undefined) options.data = isJson ? data : new URLSearchParams(data).toString();

        const { data: result, status } = await axios.request(options);
        if (status === 401 || status === 403) throw new Error(`HTTP ${status}: ${result?.message || JSON.stringify(result)}`);
        if (status < 200 || status >= 300) throw new Error(`HTTP ${status}: ${JSON.stringify(result)}`);
        if (result && typeof result === "object" && result.code && !["200", "0"].includes(String(result.code))) {
            throw new Error(`${result.code} ${result.message || result.msg || JSON.stringify(result)}`.trim());
        }
        return result;
    }

    /**
     * 取【手机号】授权的加密数据。
     * YYB-Go 的 /wxapp/getPhoneNumber 返回授权包（raw 里含 encryptedData/iv，等同 getPhoneNumber 回调字段）；
     * 注意不能用 /wx/getuserinfo，那个是用户资料(nickName/avatarUrl)的加密数据，
     * 服务端解不出 phoneNumber，固定回 500 E131 登录失败。
     */
    async getPhoneAuthData() {
        const data = await yyb.getPhoneNumber(this.accountId);
        const result = data?.result || data || {};
        const raw = result.raw || data?.raw || {};
        const edata = raw.encryptedData || result.encryptedData || "";
        const iv = raw.iv || result.iv || "";
        if (!edata || !iv) throw new Error(`YYB-Go /wxapp/getPhoneNumber 未返回手机号加密数据: ${JSON.stringify(Object.keys(raw))}`);
        return { edata, iv };
    }

    /** 手机号授权之后再取一次 wx.login code（顺序和小程序一致） */
    async getLoginCode() {
        // YYB-Go：POST /wxapp/getCode（一次一个 code，失败即抛错）
        return yyb.getCode(this.accountId);
    }

    async getArticleIds() {
        try {
            const result = await this.request("/pages/REGISTRATION_AGREEMENT,PRIVACY_PROTECTION_CLAUSE/articles/list", {
                base: BASE_API,
                auth: false,
            });
            const ids = Array.isArray(result) ? result.map(item => item.article_id).filter(Boolean) : [];
            return ids.join(",");
        } catch (e) {
            $.log(`账号[${this.index}] 获取协议ID失败，继续登录: ${e.message || e}`);
            return "";
        }
    }

    async loginByWxCode() {
        try {
            const { edata, iv } = await this.getPhoneAuthData();
            const code = await this.getLoginCode();
            const articleIds = await this.getArticleIds();
            const params = {
                edata,
                iv,
                code,
                uuid: this.uuid,
                article_ids: articleIds,
                app_versions: "1.0.0",
            };
            const result = await this.request("/wechat/mini/phoneNew/login", {
                method: "POST",
                params,
                auth: false,
            });
            const token = result?.access_token || result?.accessToken || "";
            if (!result?.success || !token) throw new Error(`登录响应未返回token: ${JSON.stringify(result)}`);
            this.token = token;
            this.refreshToken = result.refresh_token || result.refreshToken || "";
            await this.loginCommunityToken().catch(() => {});
            this.saveCachedToken();
            $.log(`账号[${this.index}] 手机号授权登录成功: ${shortToken(this.token)}`);
        } catch (e) {
            $.log(`账号[${this.index}] 登录失败: ${e.message || e}`);
        }
    }

    /** access_token 续期：vendor.js:13707 POST /passport/token {refresh_token} */
    async refreshAccessToken() {
        if (!this.refreshToken) return false;
        try {
            const result = await this.request("/passport/token", {
                method: "POST",
                data: { refresh_token: this.refreshToken },
                auth: false,
            });
            const token = result?.accessToken || result?.access_token || "";
            if (!token) return false;
            this.token = token;
            this.refreshToken = result.refreshToken || result.refresh_token || this.refreshToken;
            await this.loginCommunityToken().catch(() => {});
            this.saveCachedToken();
            $.log(`账号[${this.index}] token续期成功: ${shortToken(this.token)}`);
            return await this.checkToken();
        } catch (e) {
            $.log(`账号[${this.index}] token续期失败: ${e.message || e}`);
            return false;
        }
    }

    async loginCommunityToken() {
        if (!this.token) return;
        const result = await this.request("/wx/auth/loginByToken", {
            method: "POST",
            base: "https://cmallwap.xkmm.cn/haday",
            data: { access_token: this.token },
            auth: false,
            isJson: true,
        });
        this.communityToken = result?.data || result || "";
        this.saveCachedToken();
    }

    async checkToken() {
        try {
            await this.request("/members");
            return true;
        } catch (e) {
            return false;
        }
    }

    async getUserInfo() {
        try {
            const result = await this.request("/members");
            if (result?.member_id) {
                this.userInfo = result;
                this.saveCachedToken();
                $.log(`🌸账号[${this.index}] [${result.member_id}][${maskPhone(result.mobile)}] 当前积分[${result.consum_point}]🎉`);
                this.userFlag = true;
            } else {
                $.log(`🌸账号[${this.index}] 查询-失败:${JSON.stringify(result)}❌`);
            }
        } catch (e) {
            const message = e.message || e;
            $.log(`🌸账号[${this.index}] 查询-失败:${message}❌`);
            if (isTokenError(message)) this.removeCachedToken();
        }
    }

    async getSignActivity() {
        try {
            const result = await this.request("/sign/activity/code", {
                params: { activityCode: "" },
            });
            if (result?.activity_code) {
                $.log(`获取活动信息成功，活动ID：${result.activity_code}`);
                this.activity_code = result.activity_code;
            } else {
                $.log(`获取活动信息失败:${JSON.stringify(result)}❌`);
            }
        } catch (e) {
            $.log(`获取活动信息失败:${e.message || e}❌`);
        }
    }

    async signIn() {
        try {
            const result = await this.request("/sign/activity/sign", {
                method: "POST",
                isJson: true,
                data: { activity_code: this.activity_code, fill_date: "" },
            });
            if (result?.is_sign === true || result?.success === true) {
                $.log("签到成功");
            } else if (isAlreadySigned(JSON.stringify(result))) {
                $.log("今日已签到");
            } else {
                $.log(`签到失败 [${result?.message || JSON.stringify(result)}]`);
            }
        } catch (e) {
            const message = String(e.message || e);
            if (isAlreadySigned(message)) {
                $.log("今日已签到");
                return;
            }
            $.log(`签到失败 [${message}]`);
            if (isTokenError(message)) this.removeCachedToken();
        }
    }

    async task_1() {
        try {
            const result = await this.request("/members/browsePage", {
                method: "POST",
                data: {},
            });
            if (result?.code == 200 || result?.statusCode == 200 || result === "") {
                $.log("浏览界面 操作成功");
            } else {
                $.log(`浏览界面 操作失败[${JSON.stringify(result)}]`);
            }
        } catch (e) {
            $.log(`浏览界面 操作失败[${e.message || e}]`);
        }
    }

    async task_2() {
        try {
            const result = await this.request("/members/commnity/brosing/duration/add", {
                method: "POST",
                params: { seconds: 10 },
                data: {},
            });
            if (result?.statusCode == 200 || result?.code == 200 || result === "") {
                $.log("浏览社区 操作成功");
            } else {
                $.log(`浏览社区 操作失败 貌似是正常的 [${JSON.stringify(result)}]`);
            }
        } catch (e) {
            $.log(`浏览社区 操作失败 貌似是正常的 [${e.message || e}]`);
        }
    }

    async doLottery() {
        try {
            const result = await this.request("/lucky/activity/extract", {
                params: { activityCode: `jfcj${this.activity_code}` },
            });
            if (result?.lucky_record_vo) {
                $.log(`🌸账号[${this.index}]🕊抽奖结果:${result.lucky_record_vo.prize_name}🎉`);
                return true;
            }
            $.log(`🌸账号[${this.index}] 抽奖-失败:${JSON.stringify(result)}❌`);
        } catch (e) {
            const message = String(e.message || e);
            if (isActivityClosed(message)) {
                $.log(`🌸账号[${this.index}] 抽奖活动已结束，跳过`);
                return false;
            }
            $.log(`🌸账号[${this.index}] 抽奖-失败:${message}❌`);
        }
        return false;
    }

    /** 返回 false 表示抽奖活动已关闭，外层不用再查次数 */
    async getLotteryTaskList() {
        try {
            const result = await this.request(`/lucky/task/package/jfcj${this.activity_code}`);
            if (result?.member_id) {
                $.log(`🌸账号[${this.index}]🕊抽奖次数任务🎉`);
                for (const task of result.task_list || []) {
                    if (task.today_available_task_number >= 1 && task.today_obtained_task_number < task.today_available_task_number) {
                        if (task.task_key === "LOGIN") {
                            $.log(`🌸账号[${this.index}]🕊正在完成任务:${task.task_name}🎉`);
                            const res = await this.request(`/lucky/task/getLoginOpporturnity/jfcj${this.activity_code}`, {
                                method: "PUT",
                                data: {},
                            });
                            $.log(JSON.stringify(res));
                        }
                        if (task.task_key === "BROWSE_PAGE_TASK") {
                            $.log(`🌸账号[${this.index}]🕊正在完成任务:${task.task_name}🎉`);
                            await this.lotteryTaskBrowser(task.link);
                        }
                    }
                }
                return true;
            }
            $.log(`🌸账号[${this.index}] 抽奖次数任务-失败:${JSON.stringify(result)}❌`);
        } catch (e) {
            const message = String(e.message || e);
            if (isActivityClosed(message)) {
                $.log(`🌸账号[${this.index}] 积分抽奖活动未开始或已结束，跳过抽奖`);
                return false;
            }
            $.log(`🌸账号[${this.index}] 抽奖次数任务-失败:${message}❌`);
        }
        return true;
    }

    async lotteryTaskBrowser(link) {
        await this.request(`/lucky/task/browse/page/start/jfcj${this.activity_code}`, {
            params: { pageUrl: link },
        }).catch(() => {});
        await $.wait(20 * 1000);
        await this.request(`/lucky/task/browse/page/end/jfcj${this.activity_code}`, {
            params: { pageUrl: link },
        }).catch(() => {});
    }

    async getLotteryNum() {
        try {
            const result = await this.request("/lucky/activity/opporturnity", {
                params: { activityCode: `jfcj${this.activity_code}` },
            });
            if (result?.can_use > 0) {
                $.log(`当前剩余抽奖次数：${result.can_use}`);
                for (let can = 0; can < result.can_use; can++) {
                    // 活动已结束时不再空转
                    if (!(await this.doLottery())) break;
                }
            } else {
                $.log("当前剩余抽奖次数0");
            }
        } catch (e) {
            const message = String(e.message || e);
            if (isActivityClosed(message)) {
                $.log("抽奖活动未开始或已结束，跳过");
                return;
            }
            $.log(`查询抽奖次数失败:${message}`);
        }
    }
}

!(async () => {
    await getNotice();
    let accounts;
    try { accounts = yybAccounts(); } catch (e) { $.log(`❌ ${e.message || e}`); return; }
    $.log(`共找到${accounts.length}个YYB账号`);
    for (const user of accounts) {
        await new Task(user).run();
    }
})()
    .catch((e) => console.log(e))
    .finally(() => $.done());

async function getNotice() {
    try {
        const { data: res } = await axios.request({
            url: "https://ghproxy.net/https://raw.githubusercontent.com/smallfawn/Note/refs/heads/main/Notice.json",
            headers: { "User-Agent": defaultUserAgent },
            timeout: 3000,
        });
        $.log(res);
        return res;
    } catch (e) {}
}
