// name: 唯品会签到
/*
------------------------------------------
@Description: 唯品会 - 微信小程序静默登录 + 每日签到（唯品币签到）
cron: 40 7,19 * * *
------------------------------------------

------------------------------------------
契约（appid wxe9714e742209d35f，host mapi.vip.com / weixin-api.vip.com / act-ug.vip.com）：
（迁移自 YYB-GO 系脚本，原脚本已 code 登录，登录只用 wx.login code，不需要 encryptedData）

登录1(拿 VIP_TANK/userId)  POST https://mapi.vip.com/vips-mobile/rest/auth/third_party/trylogin/v1?api_key=API_KEY
   body: baseData + {hash, code, event:2, deviceId:marsCid, context:'{"iv":"","encryptedData":""}',
                     source_app_type:"shop_weixin_mina", login_type:"WEIXIN_SMALL_APP", third_type:"WEIXIN"}
   -> code===1 && data.tokenId(=VIP_TANK)、data.userId
登录2(拿 vip openid)        POST https://weixin-api.vip.com/v4/LiteApp/getUserInfo?api_key=API_KEY
   body: baseData + {code, iv:"", encryptedData:"", hash}
   -> code===0 && data.openid(=vip 侧 openid，服务端由 code 派生，非明文微信 openid)、data.unionid
状态  POST https://act-ug.vip.com/checkInAward/withSign/info?api_key=API_KEY  body baseData+{openid:vipOpenid,actId:ACT_ID,biz_code:"old"}
        -> code===1，data.checkInList[isCheckInDay==1].isCheckIn==1 表示今日已签
签到  POST https://act-ug.vip.com/checkInAward/withSign/checkin?api_key=API_KEY 同上 body -> code===1

请求签名（仅 act-ug 签到接口带）：
  secret = aes-128-cbc-decrypt(base64(SIGN_SECRET_ENC), key="weixin_smallmina", iv="weixin"+10*0x00)
  paramHash = sha1( 参数按 key 升序、剔除 api_key、拼成 k=v&... ，对象值 JSON.stringify )
  api_sign  = sha1( path + paramHash + VIP_TANK + marsCid + secret )
  Authorization: OAuth api_sign=<api_sign>；Cookie: mars_cid/userId/warehouse/VIP_TANK/wap_consumer
  X-Traceid: <cookie>;__need_sign=1

API_KEY / HASH / ACT_ID / SIGN_SECRET_ENC / marsCid算法 均为该小程序固定应用常量（原脚本硬编码，非个人凭证）。
marsCid 为设备号，首次生成后按账号缓存复用（登录与签名都要用同一个）。
------------------------------------------
 YYB-Go 版：取码改走 YYB-Go（POST /wxapp/getCode），不再依赖原取码桥接服务。
 变量：YYB_SERVER 每行 地址@账号标识（例如 http://yyb-go:8000@1）；YYB_API_KEY 可选。
 原桥接版脚本见 wxapp/wph.js，业务接口、流程与缓存格式均未改动。
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
const $ = new Env("唯品会签到");
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

const MINI_APP_ID = "wxe9714e742209d35f";
const PACKAGE_VERSION = "1371";
const MINI_APP_VERSION = "2.19.13.20260731";
const API_KEY = "ce29a51aa5c94a318755b2529dcb8e0b";
const HASH = "ptx26";
const ACT_ID = "H3gRnE1Xi18=";
const SIGN_SECRET_ENC = "Ql4mW09F3urBNdzBLfK6UuRTqj22Bta7eEKTO7n5jFf9uU6FZZmcfe/gurOAOB+o";
const DEFAULT_WAREHOUSE = "VIP_NH";
const DEFAULT_PROVINCE = "104104";
const DEFAULT_AREA = "104104101";
const TOKEN_CACHE_FILE = path.join(__dirname, "tokencache", "wph_token_cache.json");
const UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
    "MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF";

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
function short(v, n = 300) {
    const t = typeof v === "string" ? v : JSON.stringify(v);
    return !t ? "" : t.length > n ? `${t.slice(0, n)}...` : t;
}
function mask(v = "") {
    v = String(v || "");
    if (!v) return "";
    if (v.length <= 12) return `${v.slice(0, 3)}***`;
    return `${v.slice(0, 6)}***${v.slice(-6)}`;
}
function sha1(text) {
    return crypto.createHash("sha1").update(String(text)).digest("hex");
}
// @wxnpm/wx-randcode 同款格式：13位时间戳_32位hex(带校验位)
function createMarsCid() {
    const timestamp = Date.now().toString();
    const randomHex = crypto.randomBytes(16).toString("hex");
    let sum = [...timestamp].reduce((total, value) => total + Number(value), 0);
    const checksumIndex = sum % 32;
    for (let i = 0; i < randomHex.length; i++) {
        if (i !== checksumIndex) sum += parseInt(randomHex[i], 16);
    }
    const checksum = (sum % 16).toString(16);
    return `${timestamp}_${randomHex.slice(0, checksumIndex)}${checksum}${randomHex.slice(checksumIndex + 1)}`;
}
function normalizeMarsCid(value) {
    const candidate = String(value || "").trim();
    return /^\d{13}_[0-9a-f]{32}$/i.test(candidate) ? candidate : createMarsCid();
}
function aesDecryptBase64(text) {
    const key = Buffer.from("weixin_smallmina");
    const iv = Buffer.concat([Buffer.from("weixin"), Buffer.alloc(10)]);
    const decipher = crypto.createDecipheriv("aes-128-cbc", key, iv);
    let out = decipher.update(text, "base64", "utf8");
    out += decipher.final("utf8");
    return out;
}
function form(data = {}) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(data)) {
        if (value === undefined || value === null) continue;
        params.append(key, typeof value === "object" ? JSON.stringify(value) : String(value));
    }
    return params.toString();
}

class Task {
    constructor(raw) {
        this.index = $.userIdx++;
        this.account = parseAccount(raw);
        this.openid = this.account.openid;
        this.token = "";
        this.userId = "";
        this.vipOpenid = "";
        this.unionid = "";
        this.marsCid = "";
    }
    log(text) {
        $.log(`账号[${this.index}]${this.account.remark ? `[${this.account.remark}]` : ""} ${text}`);
    }
    baseData() {
        return {
            app_name: "shop_weixin_mina",
            client: "wechat_mini_program",
            source_app: "shop_weixin_mina",
            api_key: API_KEY,
            app_version: "4.0",
            client_type: "wap",
            format: "json",
            mobile_platform: "2",
            ver: "2.0",
            standby_id: "native",
            union_mark: "",
            sd_tuijian: "",
            mobile_channel: "nature",
            mars_cid: this.marsCid,
            warehouse: DEFAULT_WAREHOUSE,
            fdc_area_id: DEFAULT_AREA,
            province_id: DEFAULT_PROVINCE,
            wap_consumer: "A1",
            t: Math.floor(Date.now() / 1000),
            net: "WIFI",
            width: 375,
            height: 667,
            phone_model: "Windows",
            phone_brand: "microsoft",
            sys_version: "Windows 10",
            is_default_area: "1",
            app_theme_mode: "0",
            app_theme_action: "0",
            req_scene: 0,
        };
    }
    cookie() {
        return [
            `mars_cid=${this.marsCid}`,
            this.userId ? `userId=${this.userId}` : "",
            `warehouse=${DEFAULT_WAREHOUSE}`,
            this.token ? `VIP_TANK=${this.token}` : "",
            "wap_consumer=A1",
        ].filter(Boolean).join(";");
    }
    paramHash(data = {}) {
        const sorted = Object.keys(data).sort().reduce((obj, key) => { obj[key] = data[key]; return obj; }, {});
        const text = Object.keys(sorted)
            .filter((key) => key !== "api_key")
            .map((key) => {
                let value = sorted[key];
                if (typeof value === "object") value = JSON.stringify(value);
                return `${key}=${value}`;
            })
            .join("&");
        return sha1(text);
    }
    signedHeaders(url, data) {
        const pathOnly = url.replace(/^http(s)?:\/\/.*?\//, "/");
        const secret = aesDecryptBase64(SIGN_SECRET_ENC);
        const apiSign = sha1(`${pathOnly}${this.paramHash(data)}${this.token}${this.marsCid}${secret}`);
        const cookie = this.cookie();
        return {
            "Content-Type": "application/x-www-form-urlencoded",
            Cookie: cookie,
            "X-Traceid": `${cookie};__need_sign=1`,
            Authorization: `OAuth api_sign=${apiSign}`,
        };
    }
    async request(url, data, headers) {
        const res = await axios.request({
            method: "POST",
            url,
            data: form(data),
            timeout: 30000,
            validateStatus: () => true,
            headers: {
                Accept: "application/json, text/plain, */*",
                "User-Agent": UA,
                Referer: `https://servicewechat.com/${MINI_APP_ID}/${PACKAGE_VERSION}/page-frame.html`,
                ...(headers || {}),
            },
        });
        return { status: res.status, data: res.data };
    }
    /** 取 wx.login code：YYB-Go /wxapp/getCode（一个账号一次请求，失败即抛错） */
    async getCode() {
        return yyb.getCode(this.openid);
    }
    // 登录1：trylogin -> VIP_TANK + userId
    async autoLogin(code) {
        const data = {
            ...this.baseData(),
            hash: HASH,
            code,
            event: 2,
            deviceId: this.marsCid,
            context: JSON.stringify({ iv: "", encryptedData: "" }),
            source_app_type: "shop_weixin_mina",
            login_type: "WEIXIN_SMALL_APP",
            third_type: "WEIXIN",
        };
        const { status, data: res } = await this.request(
            `https://mapi.vip.com/vips-mobile/rest/auth/third_party/trylogin/v1?api_key=${API_KEY}`,
            data,
            { "Content-Type": "application/x-www-form-urlencoded", Cookie: this.cookie() }
        );
        if (status !== 200 || Number(res?.code) !== 1 || !res?.data?.tokenId) {
            // code 70202 / "没有绑定唯品会账户" = 该微信号未绑定/未注册唯品会账户
            const msg = String(res?.msg || "");
            if (Number(res?.code) === 70202 || /没有绑定|未绑定|绑定唯品会/.test(msg)) {
                this.unregistered = true;
                throw new Error("NO_ACCOUNT:未绑定唯品会账户");
            }
            throw new Error(`自动登录失败 HTTP ${status}: ${short(res)}`);
        }
        this.token = res.data.tokenId;
        this.userId = String(res.data.userId || "");
        this.log(`登录成功 userId=${this.userId || "-"} VIP_TANK=${mask(this.token)}`);
    }
    // 登录2：getUserInfo -> vip openid（服务端由 code 派生，非明文微信 openid）
    async getVipWechatInfo(code) {
        const data = { ...this.baseData(), code, iv: "", encryptedData: "", hash: HASH };
        const { status, data: res } = await this.request(
            `https://weixin-api.vip.com/v4/LiteApp/getUserInfo?api_key=${API_KEY}`,
            data,
            { "Content-Type": "application/x-www-form-urlencoded", Cookie: this.cookie() }
        );
        if (status !== 200 || Number(res?.code) !== 0 || !res?.data?.openid) {
            throw new Error(`获取唯品会openid失败 HTTP ${status}: ${short(res)}`);
        }
        this.vipOpenid = res.data.openid;
        this.unionid = res.data.unionid || this.unionid;
        this.log(`唯品会openid获取成功: ${mask(this.vipOpenid)}`);
    }
    saveCache() {
        const cache = readCache();
        cache[this.openid] = {
            ...(cache[this.openid] || {}),
            token: this.token || (cache[this.openid] || {}).token || "",
            userId: this.userId || (cache[this.openid] || {}).userId || "",
            vipOpenid: this.vipOpenid || (cache[this.openid] || {}).vipOpenid || "",
            unionid: this.unionid || (cache[this.openid] || {}).unionid || "",
            marsCid: this.marsCid,
            updatedAt: new Date().toISOString(),
        };
        writeCache(cache);
    }
    removeLoginCache() {
        const cache = readCache();
        if (cache[this.openid]) {
            delete cache[this.openid].token;
            delete cache[this.openid].userId;
            writeCache(cache);
        }
    }
    async login() {
        // trylogin 与 getUserInfo 各自需要一个未消耗的 wx.login code，分别取
        const code1 = await this.getCode();
        await this.autoLogin(code1);
        this.saveCache();
        const code2 = await this.getCode();
        await this.getVipWechatInfo(code2);
        this.saveCache();
    }
    async ensureLogin() {
        const cached = readCache()[this.openid] || {};
        this.marsCid = normalizeMarsCid(cached.marsCid || this.marsCid);
        this.token = this.token || cached.token || "";
        this.userId = this.userId || cached.userId || "";
        this.vipOpenid = this.vipOpenid || cached.vipOpenid || "";
        this.unionid = this.unionid || cached.unionid || "";
        if (this.token && this.userId && this.vipOpenid) {
            this.log(`使用缓存登录态 userId=${this.userId} VIP_TANK=${mask(this.token)}`);
            this.saveCache();
            return;
        }
        await this.login();
    }
    async signInfo() {
        const url = "https://act-ug.vip.com/checkInAward/withSign/info";
        const data = { ...this.baseData(), openid: this.vipOpenid, actId: ACT_ID, biz_code: "old" };
        const { status, data: res } = await this.request(`${url}?api_key=${API_KEY}`, data, this.signedHeaders(url, data));
        if (status !== 200 || Number(res?.code) !== 1) {
            if (Number(res?.code) === 10013 || Number(res?.code) === -2) { this.removeLoginCache(); throw new Error("SESSION_EXPIRED"); }
            throw new Error(`签到查询失败 HTTP ${status}: ${short(res)}`);
        }
        const info = res.data || {};
        const today = (info.checkInList || []).find((item) => Number(item.isCheckInDay) === 1) || {};
        this.log(
            `签到信息: 今日${Number(today.isCheckIn) === 1 ? "已签" : "未签"}，累计${info.numTotal ?? "-"}天，连续${info.nonStopNum ?? "-"}天，已得唯品币${info.awardVipcoinTotal ?? "-"}`
        );
        return info;
    }
    async doCheckin() {
        const url = "https://act-ug.vip.com/checkInAward/withSign/checkin";
        const data = { ...this.baseData(), openid: this.vipOpenid, actId: ACT_ID, biz_code: "old" };
        const { status, data: res } = await this.request(`${url}?api_key=${API_KEY}`, data, this.signedHeaders(url, data));
        if (status !== 200 || Number(res?.code) !== 1) {
            const msg = String(res?.msg || res?.msgSpecial || "");
            if (/已签|重复|already/i.test(msg)) { this.log(`✅ 今日已签到（${msg}）`); return; }
            if (Number(res?.code) === 10013 || Number(res?.code) === -2) { this.removeLoginCache(); throw new Error("SESSION_EXPIRED"); }
            throw new Error(`签到失败 HTTP ${status}: ${short(res)}`);
        }
        const result = res.data || {};
        this.log(`✅ 签到成功，获得${result.awardAmount ?? result.awardValDesc ?? "唯品币"}，累计${result.numTotal ?? "-"}天，连续${result.nonStopNum ?? "-"}天`);
    }
    async sign() {
        const before = await this.signInfo();
        const today = (before.checkInList || []).find((item) => Number(item.isCheckInDay) === 1) || {};
        if (Number(today.isCheckIn) === 1) { this.log("✅ 今日已签到"); return; }
        await this.doCheckin();
        // 重新查询以输出准确的累计/连续天数
        try { await this.signInfo(); } catch (e) {}
    }
    async run() {
        if (!this.openid) { this.log("跳过：变量值里没有 openid"); return; }
        this.log(`开始执行 ${mask(this.openid)}`);
        try {
            await this.ensureLogin();
            await this.sign();
            this.saveCache();
        } catch (e) {
            if (String(e.message).startsWith("NO_ACCOUNT")) {
                this.log("⚠️ 该微信号还没绑定唯品会账户，先在唯品会小程序里登录/绑定一次再跑");
                return;
            }
            if (String(e.message) === "SESSION_EXPIRED") {
                // 缓存态失效，清缓存后整链重来一次
                this.log("会话失效，重新登录后重试");
                try {
                    this.token = ""; this.userId = ""; this.vipOpenid = ""; this.unionid = "";
                    await this.login();
                    await this.sign();
                    this.saveCache();
                    return;
                } catch (e2) {
                    this.log(`执行失败: ${e2.message || e2}`);
                    return;
                }
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
