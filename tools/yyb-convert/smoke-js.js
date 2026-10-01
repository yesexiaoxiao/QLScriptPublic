#!/usr/bin/env node
/**
 * yyb/ 下 js 脚本的离线冒烟验收
 *
 * 用假 axios 跑每个脚本（不访问真实网络），断言：
 *   ① 正常退出、无运行时错误（is not defined / is not a function / Cannot read … / MODULE_NOT_FOUND）
 *   ② 每个 YYB 账号各取一次 wx.login code
 *
 * 沙箱建在系统临时目录（复制 wxapp/ + yyb/ + tools/ 后可跑），跑完自动清理，不改动仓库。
 *
 * 用法：
 *   node tools/yyb-convert/smoke-js.js                # 严格模式：业务接口一律回"未覆盖"
 *   node tools/yyb-convert/smoke-js.js --loose        # 宽松模式：业务接口回"成功"（验证成功路径）
 *   node tools/yyb-convert/smoke-js.js aiguo.js dw.js # 只跑指定脚本
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

const ROOT = path.resolve(__dirname, "..", "..");
const args = process.argv.slice(2);
const LOOSE = args.includes("--loose");
const picked = args.filter((a) => !a.startsWith("--"));
const WANT_CODES = 2; // YYB_SERVER 里两个账号
const CONCURRENCY = 4;
const RUNTIME_ERROR = /is not defined|is not a function|Cannot read propert|Cannot destructure|Unexpected token|MODULE_NOT_FOUND|ReferenceError/;

const FAKE_AXIOS = `// 冒烟用假 axios：只对 YYB 取码/手机号接口给成功响应，其余业务接口按 STUB_MODE 返回，不访问真实网络。
let codeCount = 0;
const LOOSE = process.env.STUB_MODE === "loose";
function ok(data) { return { status: 200, data, headers: {} }; }
function loosePayload() {
    return {
        code: 0, errcode: 0, status: true, success: true, isSucess: true, is_success: true,
        msg: "", message: "", desc: "",
        result: { id: "STUB", title: "stub", point: 1, grow: 1, token: "STUB-TOKEN", code: "STUB" },
        data: { id: "STUB", list: [], pageResult: { list: [] }, todaySignIn: false, isSign: false, continuousDay: 0, balancePoints: 0, integral: 0, points: 0, checkinId: "1", isShow: true, mobile: "", nickname: "冒烟", access_token: "STUB", accessToken: "STUB", token: "STUB" },
        token: "STUB-TOKEN", access_token: "STUB", accessToken: "STUB", authorization: "STUB",
    };
}
async function request(options) {
    const url = String(options.url || "");
    if (url.includes("/wxapp/getCode")) {
        codeCount += 1;
        console.log(\`[stub-getCode] \${codeCount}\`);
        const body = options.data && typeof options.data === "object" ? options.data : {};
        if (!body.ref) return ok({ code: 400, msg: "ref is required" });
        return ok({ code: 0, msg: "", data: { openid: \`oX-\${body.ref}\`, result: { code: \`SMOKE-\${body.ref}\`, errMsg: "login:ok" } } });
    }
    if (url.includes("/wxapp/getPhoneNumber")) {
        console.log("[stub-phoneNumber]");
        return ok({ code: 0, msg: "", data: { result: { code: "PC-STUB", raw: { encryptedData: "ENC", iv: "IV", code: "PC-STUB" }, encryptedData: "ENC", iv: "IV", code: "PC-STUB" } } });
    }
    if (LOOSE) return ok(loosePayload());
    return ok({ code: 401, msg: "冒烟测试：业务接口未覆盖", data: {}, result: {}, token: null, access_token: null });
}
function axiosInstance(config) { return request(config || {}); }
axiosInstance.request = request;
axiosInstance.get = (u, o = {}) => request({ ...o, url: u, method: "GET" });
axiosInstance.post = (u, d, o = {}) => request({ ...o, url: u, method: "POST", data: d });
axiosInstance.create = () => axiosInstance;
axiosInstance.default = axiosInstance;
module.exports = axiosInstance;
`;

function buildSandbox() {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "yyb-smoke-"));
    const scripts = path.join(sandbox, "yyb");
    fs.mkdirSync(scripts, { recursive: true });
    fs.cpSync(path.join(ROOT, "wxapp"), scripts, { recursive: true }); // 供 require 相对依赖
    fs.cpSync(path.join(ROOT, "yyb"), scripts, { recursive: true }); // YYB 版覆盖同名文件
    fs.cpSync(path.join(ROOT, "tools"), path.join(sandbox, "tools"), { recursive: true });
    const mods = path.join(sandbox, "node_modules");
    fs.mkdirSync(path.join(mods, "axios"), { recursive: true });
    fs.writeFileSync(path.join(mods, "axios", "index.js"), FAKE_AXIOS, "utf8");
    fs.writeFileSync(path.join(mods, "axios", "package.json"), '{"name":"axios","version":"0.0.0-stub","main":"index.js"}', "utf8");
    fs.mkdirSync(path.join(mods, "form-data"), { recursive: true });
    fs.writeFileSync(path.join(mods, "form-data", "index.js"), "class FormData { append() {} getHeaders() { return {}; } }\nmodule.exports = FormData;\n", "utf8");
    fs.writeFileSync(path.join(mods, "form-data", "package.json"), '{"name":"form-data","version":"0.0.0-stub","main":"index.js"}', "utf8");
    return { sandbox, scripts, modules: mods };
}

function run(file, ctx) {
    return new Promise((resolve) => {
        const child = execFile(
            process.execPath,
            [path.join(ctx.scripts, file)],
            {
                cwd: ctx.scripts,
                timeout: 90000,
                maxBuffer: 16 * 1024 * 1024,
                env: {
                    ...process.env,
                    NODE_PATH: ctx.modules,
                    STUB_MODE: LOOSE ? "loose" : "strict",
                    YYB_CODE_DELAY_MS: "0", // 取码前的固定延时会拖垮离线冒烟，这里关掉
                    YYB_SERVER: "http://yyb-go.stub:8000@1\nhttp://yyb-go.stub:8000@2",
                    wx_server_url: "",
                    wx_auth: "",
                },
            },
            (err, stdout, stderr) => {
                const text = stdout + stderr;
                const codes = (text.match(/\[stub-getCode\]/g) || []).length;
                const problems = [];
                if (err && err.killed) problems.push("超时");
                else if (err) problems.push(`退出码 ${err.code}`);
                if (LOOSE ? codes < WANT_CODES : codes !== WANT_CODES) {
                    problems.push(`取码 ${codes} 次（期望 ${LOOSE ? "≥" : ""}${WANT_CODES}）`);
                }
                const bad = text.split("\n").filter((l) => RUNTIME_ERROR.test(l));
                if (bad.length) problems.push(`运行时错误：${bad[0].trim().slice(0, 110)}`);
                resolve({ file, codes, problems });
            }
        );
        child.stdin && child.stdin.end();
    });
}

(async () => {
    const ctx = buildSandbox();
    try {
        let targets = fs
            .readdirSync(ctx.scripts)
            .filter((f) => f.endsWith(".js") && f !== "yyb.js")
            .filter((f) => fs.readFileSync(path.join(ctx.scripts, f), "utf8").includes('require("./yyb.js")'))
            .sort();
        if (picked.length) targets = targets.filter((f) => picked.includes(f));
        console.log(`待验收 ${targets.length} 个脚本${LOOSE ? "（宽松模式）" : ""}\n`);

        const results = [];
        for (let i = 0; i < targets.length; i += CONCURRENCY) {
            results.push(...(await Promise.all(targets.slice(i, i + CONCURRENCY).map((f) => run(f, ctx)))));
        }
        const bad = results.filter((r) => r.problems.length);
        console.log(`通过 ${results.length - bad.length} / ${results.length}`);
        if (bad.length) {
            console.log("\n需人工检查：");
            bad.forEach((r) => console.log(`  ${r.file} :: ${r.problems.join(" | ")}`));
        }
        process.exitCode = bad.length ? 1 : 0;
    } finally {
        fs.rmSync(ctx.sandbox, { recursive: true, force: true });
    }
})();
