// name: 骁龙骁友会
/*
------------------------------------------
@Author: sm
@Date: 2026.08.16
@Description:  骁龙骁友会 小程序 签到 + 每日任务(抽奖/点赞/阅读5分钟/VLOG1分钟)
cron: 20 9 * * *
------------------------------------------
#Notice:
YYB-Go 版：取码改走 YYB-Go（POST /wxapp/getCode），不再依赖原取码桥接服务。
变量：YYB_SERVER 每行 地址@账号标识（例如 http://yyb-go:8000@1）；YYB_API_KEY 可选。
原桥接版脚本见 wxapp/wx_xlxyh.js，业务接口、流程与缓存格式均未改动。

可选变量：
  wx_xlxyh_read_task  是否做两个「停留时长」任务，默认 1(开启)。
                      阅读文章要真等 5 分钟、VLOG 要真等 1 分钟——服务端是用
                      enterReadDaily / exitReadDaily 两次调用的时间差算时长的，
                      没有任何时长参数可以传，所以只能真等。整个脚本因此约跑 6.5 分钟。
                      不想让任务跑这么久就置 0，只做签到/抽奖/点赞。

登录链路（反编译主包 wx026c06df6adc5d06 逐行核对，A21B5B03…js）：
  wx.login code -> POST /api/user/getOpenId {code}
                -> {openId, sessionKey, userInfo}；userInfo.id 就是 userId
  之后每个请求把 userId / sessionKey / openId 放在【请求头】上（22E9D2A0…js）
  userInfo.id === 0 表示这个微信号还没在骁友会注册过，脚本会直接提示而不是瞎跑。

请求签名（22E9D2A0…js + B1596B97…js:165/284 + 563700E2…js）：
  sign = md5( joinJson(参数) + requestId + timestamp )      —— 小写、无盐
  joinJson: k1=encodeURIComponent(v1)&k2=...   （对象自身的枚举顺序）
  requestId: 源码 uuid() 无参调用，第 8/13/18/23 位被置成 undefined 再 join，
             实际得到的是 32 位十六进制而不是标准 UUID，必须照抄这个 quirk。
  注意：必须带微信小程序 User-Agent，否则 getOpenId 直接回 {"code":1,"message":"非法请求"}。
  另注：sign 服务端不校验（故意写错签名，signList / checkActivity 照样回 200），
        真正的准入是那个 User-Agent；照抄签名只是为了跟真机一致。
        （sign 的算法本身是核对过的：563700E2…js 的 hex_md5 就是标准小写 md5，
          h() 按 charCodeAt&255 取字节，l() 输出小写 hex，没有任何私货。）

签到 / 抽奖的【前置条件】：先打一次点击埋点（2026-08-18 实测定性）
  这个后端要求先收到一条"你点了这个按钮"的埋点事件，之后那个动作才放行：
    POST /api/buryPointApp/save
      userId, openId, activitySource=Xcx_MeiRiRenWu,
      urlPath=pages/task-center/index, urlName=任务中心,
      elementName=每日签到, elementType=页面, eventNameEn=MPClick
    → 等 0.4~1.1 秒 → GET /api/user/signIn?userId=…
  对照实验（同一把会话、同一分钟）：
    不打埋点 → signIn 恒回 40001「登录过期，请重新登录」
    打了埋点 → signIn 回 200 {state:3, coreCoin:10}，签到成功、连续天数 +1
  抽奖同理，换成转盘页的埋点（urlPath=pages/wheel/index、elementName=立即抽奖）：
    不打埋点 → getLuck 回 code=1「非法请求」，连只读的 luckDraw/list 都回 code=1
    打了埋点 → getLuck 回 200 并中奖
  真机每次点按钮都会先发埋点，所以线上永远撞不到；脚本不发就一直被拒。
  ⚠️ 这也是为什么之前两天 15 轮变量法（换会话/时间戳/requestId/UA/Referer/GET-POST/
     签名大小写/换别人 userId）全都无效 —— 门槛根本不在 signIn 这个请求里面。

点赞 / 阅读 5 分钟 / VLOG 1 分钟 三个任务不需要埋点前置，直接就能过。

⚠️【免责声明】
------------------------------------------
1、此脚本仅用于学习研究，不保证其合法性、准确性、有效性，请根据情况自行判断，本人对此不承担任何保证责任。
2、由于此脚本仅用于学习研究，您必须在下载后 24 小时内将所有内容从您的计算机或手机或任何存储设备中完全删除，若违反规定引起任何事件本人对此均不负责。
3、请勿将此脚本用于任何商业或非法目的，若违反规定请自行对此负责。
4、此脚本涉及应用与本人无关，本人对因此引起的任何隐私泄漏或其他后果不承担任何责任。
5、本人对任何脚本引发的问题概不负责，包括但不限于由脚本错误引起的任何损失和损害。
6、如果任何单位或个人认为此脚本可能涉嫌侵犯其权利，应及时通知并提供身份证明，所有权证明，我们将在收到认证文件确认后删除此脚本。
7、所有直接或间接使用、查看此脚本的人均应该仔细阅读此声明。本人保留随时更改或补充此声明的权利。一旦您使用或复制了此脚本，即视为您已接受此免责声明。
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
const $ = new Env("骁龙骁友会");
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

const strSplitor = "#";
const MINI_APP_ID = "wx026c06df6adc5d06";
const PAGE_VERSION = "644";
// BC195B25ACE3C9CFDA7F33222D124737.js: API_ROOT(release)
const API_BASE = "https://qualcomm.boysup.cn/qualcomm-app";
const TOKEN_CACHE_FILE = path.join(__dirname, "tokencache", "wx_xlxyh_token_cache.json");
// 两个停留时长任务开关：服务端按 enter/exit 两次调用的时间差算时长，只能真等
const READ_TASK = !/^(0|false|no|off)$/i.test(String(process.env.wx_xlxyh_read_task ?? "1"));

const defaultUserAgent =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090a13) UnifiedPCWindowsWechat(0xf254162e) XWEB/18151";

// 端点（B3F98543ACE3C9CFD59FED444E024737.js / 671C83A1…js，方法与参数逐条核对）
const EP_GET_OPENID = "/api/user/getOpenId"; // POST {code}                    postNoSession
const EP_USER_INFO = "/api/user/info"; // GET  {userId}
const EP_SIGN_LIST = "/api/user/signList"; // GET  {userId}
const EP_SIGN_IN = "/api/user/signIn"; // GET  {userId}   ← 是 GET，不是 POST
const EP_TASK_DAILY = "/api/home/taskDaily"; // GET  {userId}
const EP_DRAW_LIST = "/api/luckDraw/list"; // GET  {page,userId,activityId}
const EP_GET_LUCK = "/api/luckDraw/getLuck"; // POST {userId,activityId}
const EP_BURY_POINT = "/api/buryPointApp/save"; // POST 点击埋点，签到/抽奖的前置
const EP_ARTICLES = "/api/home/articles"; // GET  {page,size,userId,type,searchDate,articleShowPlace}
const EP_ARTICLE_LIKE = "/api/article/like"; // GET  {articleId,userId}
const EP_ENTER_READ = "/api/article/enterReadDaily"; // POST {articleId,userId}
const EP_EXIT_READ = "/api/article/exitReadDaily"; // POST {articleId,userId}
const EP_VLOG_LIST = "/api/article/vlogList"; // GET  {page,size,userId,sortBy}
const EP_VLOG_PLAY = "/api/article/vlogPlay"; // GET  {articleId}
const EP_SYS_CONFIG = "/api/sysConfig/detail"; // POST {propertyKey}
const EP_QUIZ_DETAIL = "/api/interactQuestion/detail"; // POST {userId}

// pages/wheel/index.js:34 —— 客户端自己也是硬编码 7，不存在活动 id 轮换
const LUCK_ACTIVITY_ID = 7;
// pages/article-details/index.js:299 —— 5 == minute 才算完成；userExitRead 在 lookTimes>=300 时直接 return
const READ_SECONDS = 300;
// pages/vlog/detail.js:197 —— 1 == minute 才算完成；进入条件是 lookTimes < 60
const VLOG_SECONDS = 60;
const VLOG_SWITCH_KEY = "task_switch_DAILY_PLAY_VIDEO_1_MINUTES";

// 22E9D2A0…js: f = String(code)，放行 "200" 与 "40003"；40001 = 会话失效需重登
const SUCCESS_CODES = new Set(["200", "40003"]);
const CODE_SESSION_EXPIRED = "40001";

const yyb = new YYBClient({
    appid: MINI_APP_ID,
});

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

function md5(str) {
    return crypto.createHash("md5").update(str).digest("hex");
}

// B1596B97ACE3C9CFD73F039088324737.js:165 exports.joinJson
function joinJson(data) {
    let out = "";
    let i = 0;
    for (const key in data || {}) {
        if (i > 0) out += "&";
        out += `${key}=${encodeURIComponent(data[key])}`;
        i++;
    }
    return out;
}

// B1596B97ACE3C9CFD73F039088324737.js:284 exports.uuid
// 源码调用处是无参 uuid()，于是 t[8]/t[13]/t[18]/t[23] 被赋成 undefined，
// join("") 会把 undefined 丢掉 —— 实际发出去的是 32 位十六进制。照抄。
function requestId() {
    const t = [];
    for (let i = 0; i < 36; i++) t[i] = "0123456789abcdef".substr(Math.floor(16 * Math.random()), 1);
    t[14] = "4";
    t[19] = "0123456789abcdef".substr((3 & parseInt(t[19], 16)) | 8, 1);
    t[8] = t[13] = t[18] = t[23] = undefined;
    return t.join("");
}

function bizCode(result) {
    return String(result?.code ?? "");
}

function isSuccess(result) {
    return SUCCESS_CODES.has(bizCode(result));
}

// 幂等：重复签到/重复完成时服务端文案不止一种
function isAlreadyDone(message) {
    return /已签|已经签|签到过|重复|已完成|已领|already/i.test(String(message || ""));
}

function maskPhone(phone = "") {
    return String(phone).replace(/^(\d{3})\d{4}(\d{4})$/, "$1****$2");
}

function shortId(value = "") {
    const s = String(value || "");
    return s ? `${s.slice(0, 4)}***${s.slice(-4)}` : "";
}

function stripHtml(text = "") {
    return String(text || "")
        .replace(/<[^>]*>/g, "")
        .trim();
}

function cut(text = "", n = 26) {
    const s = String(text || "").replace(/\s+/g, " ").trim();
    return s.length > n ? `${s.slice(0, n)}…` : s;
}

class Task {
    constructor(env) {
        this.index = $.userIdx++;
        this.raw = String(env || "").trim();
        this.user = this.raw.split(strSplitor);
        this.accountId = (this.user[0] || "").trim();
        this.remark = (this.user[1] || "").trim();
        this.userId = 0;
        this.sessionKey = "";
        this.openId = "";
        this.userInfo = {};
        this.cache = readTokenCache();
        // 旧格式 sessionKey#userId：第一段是 base64 会话而不是 openid，第二段是纯数字
        this.legacySession = /^\d+$/.test(this.remark) && /[=+/]/.test(this.accountId);
        if (this.legacySession) {
            this.sessionKey = this.accountId;
            this.userId = Number(this.remark);
            this.accountId = "";
        }
    }

    get tag() {
        const who = this.userInfo.nick || this.remark || shortId(this.accountId) || `userId ${this.userId}`;
        return `账号[${this.index}] ${who}`;
    }

    log(msg) {
        $.log(`${this.tag}: ${msg}`);
    }

    /**
     * 22E9D2A0…js:u()/i() —— 参数一律走 joinJson，GET 拼 query、POST 放 body，
     * 会话三件套(userId/sessionKey/openId)和签名都在请求头上。
     * withSession=false 对应 postNoSession（userId "0"、sessionKey/openId 空串）。
     */
    async request(endpoint, { method = "GET", data = null, withSession = true, retry = true } = {}) {
        const body = joinJson(data);
        const ts = Date.now();
        const rid = requestId();
        const headers = {
            "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
            userId: withSession ? String(this.userId || 0) : "0",
            sessionKey: withSession ? this.sessionKey || "" : "",
            openId: withSession ? this.openId || "" : "",
            timestamp: String(ts),
            requestId: rid,
            sign: md5(body + rid + ts),
            "User-Agent": defaultUserAgent,
            Referer: `https://servicewechat.com/${MINI_APP_ID}/${PAGE_VERSION}/page-frame.html`,
            Accept: "*/*",
            xweb_xhr: "1",
        };
        const config = {
            url: API_BASE + endpoint,
            method,
            headers,
            timeout: 30000,
            validateStatus: () => true,
        };
        if (method === "GET") {
            if (body) config.url += `?${body}`;
        } else {
            config.data = body;
        }

        let result;
        try {
            const res = await axios(config);
            result = typeof res.data === "string" ? JSON.parse(res.data) : res.data;
        } catch (e) {
            return { code: "-1", message: e.message || "网络错误" };
        }

        // 22E9D2A0…js: 40001 -> clearUserInfo + refreshUserInfo + 重放一次
        if (bizCode(result) === CODE_SESSION_EXPIRED && retry && !this.legacySession) {
            this.log("会话失效，重新登录后重试");
            if (await this.login(true)) {
                return this.request(endpoint, { method, data, withSession, retry: false });
            }
        }
        return result || {};
    }

    /** 取一次性 wx.login code：YYB-Go /wxapp/getCode（一个账号一次请求，失败即抛错） */
    async getServerCode() {
        return yyb.getCode(this.accountId);
    }

    /** A21B5B03…js: wx.login code -> getOpenId -> {openId, sessionKey, userInfo} */
    async loginByWxCode() {
        const code = await this.getServerCode();
        const result = await this.request(EP_GET_OPENID, {
            method: "POST",
            data: { code },
            withSession: false,
            retry: false,
        });
        if (!isSuccess(result)) throw new Error(`getOpenId 失败: ${result.message || bizCode(result)}`);
        const data = result.data || {};
        const id = Number(data.userInfo?.id || 0);
        if (!id) {
            throw new Error("该微信号还没在骁友会注册（userInfo.id=0），先在小程序里完成注册/授权手机号");
        }
        this.userId = id;
        this.sessionKey = data.sessionKey || "";
        this.openId = data.openId || "";
        return true;
    }

    /** 只读校验会话：/api/user/info 通了就说明 userId+sessionKey 还有效 */
    async loadUserInfo() {
        const result = await this.request(EP_USER_INFO, { data: { userId: this.userId }, retry: false });
        if (!isSuccess(result) || !result.data?.id) return false;
        this.userInfo = result.data;
        return true;
    }

    async login(force = false) {
        if (this.legacySession) {
            if (!this.userId || !this.sessionKey) {
                $.log(`账号[${this.index}]: 旧格式变量应为 sessionKey#userId`);
                return false;
            }
            if (await this.loadUserInfo()) return true;
            $.log(`账号[${this.index}]: 手填的 sessionKey 已失效，建议改用 wx_server 的 openid 自动登录`);
            return false;
        }

        if (!this.accountId) {
            $.log(`账号[${this.index}]: 变量值为空`);
            return false;
        }

        const cached = this.cache[this.accountId];
        if (!force && cached?.userId && cached?.sessionKey) {
            this.userId = Number(cached.userId);
            this.sessionKey = cached.sessionKey;
            this.openId = cached.openId || "";
            if (await this.loadUserInfo()) {
                this.log("会话缓存有效");
                return true;
            }
            this.log("会话缓存已失效，重新登录");
        }

        try {
            await this.loginByWxCode();
        } catch (e) {
            $.log(`账号[${this.index}]: 登录失败 ${e.message || e}`);
            return false;
        }
        if (!(await this.loadUserInfo())) {
            $.log(`账号[${this.index}]: 登录后读取用户信息失败`);
            return false;
        }
        this.cache = readTokenCache();
        this.cache[this.accountId] = {
            userId: this.userId,
            sessionKey: this.sessionKey,
            openId: this.openId,
            nick: this.userInfo.nick || "",
            updatedAt: new Date().toISOString(),
        };
        writeTokenCache(this.cache);
        this.log("登录成功");
        return true;
    }

    /**
     * 点击埋点 —— 签到和抽奖的【前置条件】，不是可选的统计上报。
     * 服务端要求先收到一条"你点了这个按钮"的埋点事件，之后那个动作才放行：
     *   不打埋点 -> signIn 恒回 40001「登录过期」、getLuck 恒回 code=1「非法请求」
     *   打了埋点 -> 两个都 200
     * 真机每次点按钮都会先发它，所以线上永远不会撞到；脚本不发就一直被拒。
     */
    async buryPoint(page) {
        const P = {
            sign: { urlPath: "pages/task-center/index", urlName: "任务中心", elementName: "每日签到" },
            wheel: { urlPath: "pages/wheel/index", urlName: "幸运大转盘", elementName: "立即抽奖" },
        }[page];
        const result = await this.request(EP_BURY_POINT, {
            method: "POST",
            data: {
                userId: this.userId,
                openId: this.openId || "",
                activitySource: "Xcx_MeiRiRenWu",
                urlPath: P.urlPath,
                urlName: P.urlName,
                elementName: P.elementName,
                elementType: "页面",
                eventNameEn: "MPClick",
            },
            retry: false,
        });
        // 真机点完按钮到发请求有个自然间隔，太快容易被判成非人工
        await $.wait(400 + Math.floor(Math.random() * 700));
        return isSuccess(result);
    }

    /** pages/task-center/index.js:200-235  signList -> isSignToday==0 才 signIn */
    async signTask() {
        const list = await this.request(EP_SIGN_LIST, { data: { userId: this.userId } });
        if (!isSuccess(list)) {
            this.log(`❌ 读取签到状态失败: ${list.message || bizCode(list)}`);
            return;
        }
        const info = list.data || {};
        if (Number(info.isSignToday) === 1) {
            this.log(`✅ 今日已签到（本月连续 ${info.signContinuityMonth || 0} 天）`);
            return;
        }
        if (!(await this.buryPoint("sign"))) {
            this.log("⚠️ 签到前置埋点没成功，继续试签到（大概率会被拒）");
        }
        // retry:false —— 这里的 40001 不是会话过期，是前置埋点没到位，重登没用
        const result = await this.request(EP_SIGN_IN, { data: { userId: this.userId }, retry: false });
        if (isSuccess(result) && result.data) {
            // state 1/2/3 在源码里对应三种「签到成功」弹窗
            this.log(`✅ 签到成功 芯动值+${result.data.coreCoin ?? 0}`);
        } else if (isAlreadyDone(result.message)) {
            this.log(`✅ 今日已签到（${result.message}）`);
        } else if (bizCode(result) === CODE_SESSION_EXPIRED) {
            this.log("❌ 签到回 40001：前置埋点没被服务端认下，稍后重试或在小程序里手点一次");
        } else {
            this.log(`❌ 签到失败: ${result.message || bizCode(result)}`);
        }
    }

    /**
     * pages/wheel —— 只抽每日免费的那次。
     * 已玩次数 = luckDrawSumCount - luckDrawCount，超过 freeCountDay 后每抽要扣
     * luckCoreCoin 芯动值，脚本不替用户花积分。
     */
    async drawTask() {
        // 转盘页的读接口也吃这个前置：不打埋点连 luckDraw/list 都回 code=1
        if (!(await this.buryPoint("wheel"))) {
            this.log("⚠️ 抽奖前置埋点没成功，继续试（大概率会被拒）");
        }
        const list = await this.request(EP_DRAW_LIST, {
            data: { page: 1, userId: this.userId, activityId: LUCK_ACTIVITY_ID },
        });
        if (!isSuccess(list)) {
            this.log(`❌ 读取抽奖信息失败: ${list.message || bizCode(list)}`);
            return;
        }
        const d = list.data || {};
        const used = Number(d.luckDrawSumCount || 0) - Number(d.luckDrawCount || 0);
        const free = Number(d.freeCountDay || 0);
        if (Number(d.luckDrawCount || 0) <= 0) {
            this.log("🎡 抽奖次数已用完，跳过");
            return;
        }
        if (used >= free) {
            this.log(`🎡 免费次数已用完（今日已抽 ${used}/${free}），再抽要扣 ${d.luckCoreCoin} 芯动值，跳过`);
            return;
        }
        const result = await this.request(EP_GET_LUCK, {
            method: "POST",
            data: { userId: this.userId, activityId: LUCK_ACTIVITY_ID },
        });
        if (isSuccess(result) && result.data) {
            this.log(`🎉 抽奖成功: ${result.data.name || "已中奖"}`);
        } else if (isAlreadyDone(result.message)) {
            this.log(`🎡 今日抽奖已完成（${result.message}）`);
        } else if (/非法请求/.test(String(result.message || ""))) {
            // 实测就是前置埋点没到位（打了埋点同一请求立刻 200 并中奖）
            this.log("🎡 抽奖回「非法请求」：前置埋点没被认下，稍后重试");
        } else {
            this.log(`❌ 抽奖失败: ${result.message || bizCode(result)}`);
        }
    }

    /** 取资讯列表（只读），阅读任务和点赞任务共用 */
    async fetchArticles() {
        const result = await this.request(EP_ARTICLES, {
            data: {
                page: 1,
                size: 20,
                userId: this.userId,
                type: 0,
                searchDate: "",
                articleShowPlace: "骁友资讯列表页",
            },
        });
        if (!isSuccess(result)) {
            this.log(`❌ 读取资讯列表失败: ${result.message || bizCode(result)}`);
            return [];
        }
        return result.data?.articleList || [];
    }

    /** 每日点赞文章 —— pages/article-details/index.js like(): articleLike(String(id), userId) */
    async likeTask(articles) {
        const target = articles.find((a) => Number(a.isLike) === 0);
        if (!target) {
            this.log("👍 列表里的文章都点过赞了，跳过");
            return;
        }
        const result = await this.request(EP_ARTICLE_LIKE, {
            data: { articleId: String(target.id), userId: this.userId },
        });
        if (isSuccess(result)) {
            this.log(`👍 点赞成功: ${cut(target.title)}`);
        } else if (isAlreadyDone(result.message)) {
            this.log(`👍 已点赞（${result.message}）`);
        } else {
            this.log(`❌ 点赞失败: ${result.message || bizCode(result)}`);
        }
    }

    /**
     * 每日阅读文章 5 分钟。
     * enterReadDaily / exitReadDaily 都只收 {articleId,userId}，没有时长参数——
     * 时长是服务端按两次调用的时间差算的，所以必须真等 READ_SECONDS 秒。
     */
    async readTask(articles) {
        const target = articles.find((a) => Number(a.lookTimes || 0) < READ_SECONDS);
        if (!target) {
            this.log("📖 列表里的文章阅读时长都够了，跳过");
            return;
        }
        this.log(`📖 开始阅读: ${cut(target.title)}（已读 ${target.lookTimes || 0}s）`);
        const enter = await this.request(EP_ENTER_READ, {
            method: "POST",
            data: { articleId: target.id, userId: this.userId },
        });
        if (!isSuccess(enter)) {
            this.log(`❌ 进入阅读失败: ${enter.message || bizCode(enter)}`);
            return;
        }
        const wait = READ_SECONDS + 5;
        this.log(`⏳ 停留 ${wait}s（源码要求满 5 分钟）`);
        await $.wait(wait * 1000);
        const exit = await this.request(EP_EXIT_READ, {
            method: "POST",
            data: { articleId: target.id, userId: this.userId },
        });
        if (isSuccess(exit)) {
            this.log("✅ 阅读任务已提交");
        } else {
            this.log(`❌ 退出阅读失败: ${exit.message || bizCode(exit)}`);
        }
    }

    /** 每日观看骁友 VLOG 1 分钟 —— pages/vlog/detail.js，进入前先看任务开关 */
    async vlogTask() {
        const cfg = await this.request(EP_SYS_CONFIG, { method: "POST", data: { propertyKey: VLOG_SWITCH_KEY } });
        if (isSuccess(cfg) && String(cfg.data?.propertyValue) === "0") {
            this.log("🎬 VLOG 任务开关关闭，跳过");
            return;
        }
        const list = await this.request(EP_VLOG_LIST, {
            data: { page: 1, size: 20, userId: this.userId, sortBy: 1 },
        });
        if (!isSuccess(list)) {
            this.log(`❌ 读取 VLOG 列表失败: ${list.message || bizCode(list)}`);
            return;
        }
        const records = list.data?.records || [];
        const target = records.find((v) => Number(v.lookTimes || 0) < VLOG_SECONDS);
        if (!target) {
            this.log("🎬 列表里的 VLOG 观看时长都够了，跳过");
            return;
        }
        this.log(`🎬 开始观看: ${cut(target.title)}（已看 ${target.lookTimes || 0}s）`);
        const enter = await this.request(EP_ENTER_READ, {
            method: "POST",
            data: { articleId: target.id, userId: this.userId },
        });
        if (!isSuccess(enter)) {
            this.log(`❌ 进入 VLOG 失败: ${enter.message || bizCode(enter)}`);
            return;
        }
        await this.request(EP_VLOG_PLAY, { data: { articleId: target.id } });
        const wait = VLOG_SECONDS + 5;
        this.log(`⏳ 停留 ${wait}s（源码要求满 1 分钟）`);
        await $.wait(wait * 1000);
        const exit = await this.request(EP_EXIT_READ, {
            method: "POST",
            data: { articleId: target.id, userId: this.userId },
        });
        if (isSuccess(exit)) {
            this.log("✅ VLOG 任务已提交");
        } else {
            this.log(`❌ 退出 VLOG 失败: ${exit.message || bizCode(exit)}`);
        }
    }

    /**
     * 互动答题（+20）：只读提示，不自动作答。
     * /api/interactQuestion/detail 只回题干和选项，不带正确答案；每天只有一次机会，
     * 随机蒙一个会白白浪费掉，所以这里把题目打出来让人自己在小程序里答。
     */
    async quizNotice() {
        const result = await this.request(EP_QUIZ_DETAIL, { method: "POST", data: { userId: this.userId } });
        if (!isSuccess(result)) return;
        const data = result.data || {};
        if (Number(data.state) > 0) {
            const correct = Number(data.questionAnswerRecord?.isCorrect) === 1;
            this.log(`📝 互动答题: 今日已作答（${correct ? "答对" : "答错"}）`);
            return;
        }
        const q = data.question;
        if (!q) return;
        const options = (q.answers || []).map((a) => `${a.answerNo}.${a.answer}`).join("  ");
        this.log(`📝 互动答题未作答(+20)，接口不返回正确答案，需自己在小程序里答：`);
        this.log(`   ${cut(q.question, 80)}`);
        if (options) this.log(`   ${options}`);
    }

    /** 收尾对账：taskDaily 的 status 1 = 已完成 */
    async summary() {
        const result = await this.request(EP_TASK_DAILY, { data: { userId: this.userId } });
        if (!isSuccess(result)) return;
        const rows = (result.data || []).map((t) => `${Number(t.status) === 1 ? "✔" : "✘"}${stripHtml(t.name)}`);
        if (rows.length) this.log(`每日任务: ${rows.join(" ")}`);
        const info = await this.request(EP_USER_INFO, { data: { userId: this.userId } });
        if (isSuccess(info) && info.data) {
            this.log(`💰 芯动值 ${info.data.coreCoin} | 等级 ${info.data.levelName || info.data.level}`);
        }
    }

    async run() {
        if (!(await this.login())) return;
        this.log(`【${this.userInfo.nick || "-"}】${maskPhone(this.userInfo.phone)} 芯动值 ${this.userInfo.coreCoin}`);

        await this.signTask();
        await this.drawTask();

        const articles = await this.fetchArticles();
        if (articles.length) await this.likeTask(articles);
        await this.quizNotice();

        if (READ_TASK) {
            if (articles.length) await this.readTask(articles);
            await this.vlogTask();
        } else {
            this.log("⏭ wx_xlxyh_read_task=0，跳过阅读 5 分钟 / VLOG 1 分钟");
        }

        await this.summary();
    }
}

!(async () => {
    let accounts;
    try { accounts = yybAccounts(); } catch (e) { $.log(`❌ ${e.message || e}`); return; }
    $.log(`共找到${accounts.length}个YYB账号`);
    for (const user of accounts) {
        try {
            await new Task(user).run();
        } catch (e) {
            $.log(`账号处理异常: ${e.message || e}`);
        }
    }
})()
    .catch((e) => $.log(`脚本异常: ${e.message || e}`))
    .finally(() => $.done());
