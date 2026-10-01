#!/usr/bin/env node
/**
 * yyb/ 下 py 脚本的离线冒烟验收
 *
 * 用 pyodide 解释执行脚本，并注入假 requests（不访问真实网络），断言：
 *   ① 语法可编译
 *   ② 每个 YYB 账号各取一次 wx.login code，且 main() 不抛异常
 *
 * 依赖 pyodide（Node 版）：
 *   npm i pyodide            # 在仓库根或本目录安装即可
 *
 * 用法：
 *   node tools/yyb-convert/smoke-py.js                 # 验收 yyb/ 下全部 .py
 *   node tools/yyb-convert/smoke-py.js BREO.py xxh...  # 只跑指定脚本
 *
 * 说明：个别脚本在 YYB 下需要手工变量才能走到取码（例如 hongsehuojian.py 的签名密钥），
 *       这类脚本用 PY_ENV 追加环境变量后复查，例如：
 *       PY_ENV='hshj_encrypt_key=STUB#1' node tools/yyb-convert/smoke-py.js hongsehuojian.py
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

let loadPyodide;
try {
    ({ loadPyodide } = require("pyodide"));
} catch (e) {
    console.error("未找到 pyodide（Node 版）。请先执行：npm i pyodide");
    process.exit(2);
}

const ROOT = path.resolve(__dirname, "..", "..");
const DIR = path.join(ROOT, "yyb");
const WANT_CODES = 2;

const STUB = `
import types, json, sys, os

class FakeResponse:
    def __init__(self, payload, status=200):
        self._payload = payload
        self.status_code = status
    def raise_for_status(self):
        if self.status_code >= 400:
            raise requests.RequestException(f"HTTP {self.status_code}")
    def json(self):
        return self._payload
    @property
    def text(self):
        return json.dumps(self._payload, ensure_ascii=False)

class RequestsStub(types.ModuleType):
    """按 URL 分发的假 requests；/wxapp/getCode 计数用于断言每账号取码一次"""
    def __init__(self):
        super().__init__("requests")
        self.RequestException = type("RequestException", (Exception,), {})
        self.calls = []
        self.code_calls = []

    def _dispatch(self, method, url, **kwargs):
        body = kwargs.get("json")
        if body is None:
            raw = kwargs.get("data")
            if isinstance(raw, str):
                try: body = json.loads(raw)
                except ValueError: body = raw
            else:
                body = raw
        self.calls.append((method, url, body))
        if "/wxapp/getCode" in url:
            self.code_calls.append(body)
            if not (body or {}).get("ref"):
                return FakeResponse({"code": 400, "msg": "ref is required"})
            return FakeResponse({"code": 0, "msg": "", "data": {"openid": "oX", "result": {"code": "PYCODE-" + str(body["ref"]), "errMsg": "login:ok"}}})
        if "/wxapp/getPhoneNumber" in url:
            return FakeResponse({"code": 0, "msg": "", "data": {"result": {"code": "PC-STUB", "raw": {"encryptedData": "ENC", "iv": "IV", "code": "PC-STUB"}}}})
        return FakeResponse({"code": 401, "msg": "冒烟测试：业务接口未覆盖", "data": {}, "errcode": 401})

    def post(self, url, **kwargs): return self._dispatch("POST", url, **kwargs)
    def get(self, url, **kwargs): return self._dispatch("GET", url, **kwargs)
    def Session(self): return types.SimpleNamespace(headers={}, get=self.get, post=self.post)

requests = RequestsStub()
sys.modules["requests"] = requests

# 部分脚本会 import urllib3 关警告，这里给个空实现
urllib3 = types.ModuleType("urllib3")
urllib3.disable_warnings = lambda *a, **k: None
sys.modules["urllib3"] = urllib3

os.environ["YYB_SERVER"] = "http://yyb-go.stub:8000@1\\nhttp://yyb-go.stub:8000@2"
os.environ.pop("YYB_API_KEY", None)
os.environ["YYB_CODE_DELAY_MS"] = "0"  # 取码前的固定延时会拖垮离线冒烟，这里关掉
for pair in (EXTRA_ENV or "").split(","):
    if "=" in pair:
        k, v = pair.split("=", 1)
        os.environ[k.strip()] = v
`;

(async () => {
    const py = await loadPyodide({ indexURL: path.dirname(require.resolve("pyodide")) });
    py.globals.set("EXTRA_ENV", process.env.PY_ENV || "");
    py.runPython(STUB);

    const picked = process.argv.slice(2);
    const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".py")).filter((f) => !picked.length || picked.includes(f)).sort();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "yyb-smoke-py-"));
    console.log(`待验收 ${files.length} 个 py 脚本`);

    let failed = 0;
    for (const file of files) {
        py.globals.set("SRC", fs.readFileSync(path.join(DIR, file), "utf8"));
        py.globals.set("SCRIPT_FILE", path.join(tmp, file)); // 让脚本写的 token 缓存落到临时目录
        try {
            const out = py.runPython(`
import io, contextlib
requests.calls.clear()
requests.code_calls.clear()
ns = {"__file__": SCRIPT_FILE, "__name__": "smoke_" + "pyfile".replace("", "")}
buf = io.StringIO()
try:
    with contextlib.redirect_stdout(buf):
        exec(compile(SRC, "pyfile", "exec"), ns)
        if "main" in ns:
            ns["main"]()
    err = ""
except Exception as exc:
    err = f"{type(exc).__name__}: {exc}"
_LOG = buf.getvalue()
f"CODES={len(requests.code_calls)}|ERR={err}"
`);
            const codes = Number((out.match(/CODES=(\d+)/) || [])[1] || -1);
            const err = (out.match(/\|ERR=([^|]*)$/) || [])[1] || "";
            const ok = codes === WANT_CODES && !err;
            if (!ok) failed += 1;
            console.log(`${ok ? "[ok]  " : "[warn]"} ${file} 取码=${codes} err=${err || "无"}`);
            if (!ok) {
                const log = py.runPython(`_LOG[:240]`).replace(/\n/g, " / ");
                console.log(`        ${log}`);
            }
        } catch (e) {
            failed += 1;
            console.log(`[fail] ${file}: ${String(e.message).split("\n").slice(-1)[0]}`);
        }
    }
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(failed ? `\n有 ${failed} 个需人工检查` : "\nALL PASS");
    process.exitCode = failed ? 1 : 0;
})().catch((e) => {
    console.error("运行失败：", e && e.message);
    process.exit(2);
});
