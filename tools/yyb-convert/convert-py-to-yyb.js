/**
 * wxapp/*.py -> yyb/*.py（YYB-Go 版，参考 Template/hsy.py）
 * 做法与 js 一致：业务逻辑一律不动，只把"取码层 + 账号来源"换成 YYB-Go。
 */
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..", "..");
const SRC = path.join(ROOT, "wxapp");
const DST = path.join(ROOT, "yyb");

const YYB_BLOCK = `# ---------------------------------------------------------------------------
# YYB-Go：账号与取码（参考 Template/hsy.py）
# ---------------------------------------------------------------------------
def routes():
    # YYB_SERVER 每行：地址@账号标识
    values = []
    for lineno, raw in enumerate(os.getenv("YYB_SERVER", "").splitlines(), 1):
        raw = raw.strip()
        if not raw:
            continue
        if "@" not in raw:
            raise RuntimeError(f"YYB_SERVER 第 {lineno} 行格式错误，应为 地址@账号标识")
        server, ref = raw.rsplit("@", 1)
        server, ref = server.strip().rstrip("/"), ref.strip()
        if not server or not ref:
            raise RuntimeError(f"YYB_SERVER 第 {lineno} 行格式错误，应为 地址@账号标识")
        if not server.startswith(("http://", "https://")):
            server = "http://" + server
        values.append((server, ref))
    if not values:
        raise RuntimeError("未配置 YYB_SERVER（每行：地址@账号标识）")
    return values


def yyb_code(server, ref):
    # YYB-Go：POST /wxapp/getCode {"ref": 账号标识, "app_id": 小程序 APPID}。
    # wx.login code 短期且一次性，失败即抛错，不重放后面的业务请求。
    headers = {"Content-Type": "application/json"}
    api_key = os.getenv("YYB_API_KEY", "").strip()
    if api_key:
        headers["Authorization"] = "Bearer " + api_key
    response = requests.post(
        f"{server}/wxapp/getCode",
        json={"ref": ref, "app_id": MINI_APP_ID},
        headers=headers,
        timeout=30,
    )
    response.raise_for_status()
    try:
        body = response.json()
    except ValueError as exc:
        raise RuntimeError(f"YYB 取 code 返回非 JSON：HTTP {response.status_code}") from exc
    if int(body.get("code", -1)) != 0:
        raise RuntimeError(f"YYB 取 code 失败：{body.get('msg') or body.get('message') or body}")
    result = (body.get("data") or {}).get("result")
    code = result if isinstance(result, str) else (result or {}).get("code")
    if not code:
        raise RuntimeError("YYB 未返回 data.result.code")
    return str(code)


def mask(ref):
    return ref if len(ref) <= 12 else f"{ref[:6]}...{ref[-4:]}"
`;

/** 找到 def 函数体的结束行（下一个顶层 def/class/if __name__，回退尾部空行与分隔注释） */
function funcEnd(lines, start) {
    let end = start + 1;
    while (end < lines.length && !/^(def |class |if __name__)/.test(lines[end])) end += 1;
    while (end - 1 > start && (lines[end - 1].trim() === "" || /^#\s*-{3,}\s*$/.test(lines[end - 1]) || /^#\s*$/.test(lines[end - 1]))) end -= 1;
    return end;
}

function convert(cfg) {
    const report = [];
    let text = fs.readFileSync(path.join(SRC, cfg.file), "utf8").replace(/\r\n/g, "\n");
    const lines = text.split("\n");

    // 1) get_wx_code 函数体
    const gStart = lines.findIndex((l) => /^def get_wx_code\(/.test(l));
    if (gStart < 0) report.push("MISS get_wx_code");
    else {
        const gEnd = funcEnd(lines, gStart);
        const body = [
            `# 当前账号的 YYB 服务地址（main 遍历账号时通过 run_account 写入；取码需要 服务地址 + 账号标识）`,
            `YYB_SERVER_URL = ""`,
            ``,
            ``,
            `# YYB-Go: 账号标识 -> wx.login code（同账号取码由 YYB 串行处理，不需要再 /wx/refresh）`,
            `def get_wx_code(${cfg.param}):`,
            `    last_msg = ""`,
            `    for attempt in range(4):`,
            `        if attempt:`,
            `            time.sleep(3)`,
            `        try:`,
            `            return yyb_code(YYB_SERVER_URL, ${cfg.param})`,
            `        except Exception as exc:`,
            `            last_msg = str(exc)`,
            `    raise RuntimeError(f"YYB-Go 获取 code 失败(已重试): {last_msg}")`,
            ``,
        ];
        lines.splice(gStart, gEnd - gStart, ...body);
        report.push("get_wx_code");
    }
    text = lines.join("\n");

    // 2) run_account 接收 server 并写入模块级地址（中间层 login/obtain_session 不用改）
    const beforeRun = text;
    text = text.replace(
        new RegExp(`^def run_account\\((${cfg.param}), (\\w+)\\):`, "m"),
        `def run_account($1, $2, server):\n    global YYB_SERVER_URL\n    YYB_SERVER_URL = server`
    );
    if (text !== beforeRun) report.push("run_account 签名");
    else report.push("MISS run_account 签名");

    // 3) 删桥接常量并插入 YYB 片段
    const constRe = /^[ \t]*WX_SERVER_URL\s*=[^\n]*\n[ \t]*WX_AUTH\s*=[^\n]*\n/m;
    if (constRe.test(text)) {
        text = text.replace(constRe, YYB_BLOCK + "\n");
        report.push("常量->YYB 片段");
    } else report.push("MISS 桥接常量");

    // 4) 头部
    const headerOld = cfg.headerOld;
    if (text.includes(headerOld)) {
        text = text.replace(headerOld, cfg.headerNew);
        report.push("头部");
    } else report.push("MISS 头部");

    // 5) main
    const mainStart = text.indexOf("def main():");
    if (mainStart < 0) report.push("MISS main");
    else {
        const mlines = text.split("\n");
        const idx = mlines.findIndex((l) => l === "def main():");
        const end = funcEnd(mlines, idx);
        mlines.splice(idx, end - idx, ...cfg.mainNew.split("\n"));
        text = mlines.join("\n");
        report.push("main");
    }

    fs.writeFileSync(path.join(DST, cfg.file), text, "utf8");
    console.log(`${cfg.file}: ${report.join(",")}`);
}

const titles = {
    "bjhqbwz.py": { param: "account_id", env: "bjhqbwz", title: "北京环球" },
    "liquanpijiu.py": { param: "openid", env: "lqpj", title: "漓泉啤酒" },
    "xinxianghui.py": { param: "account_id", env: "xxh", title: "芯享会" },
    "wuyingyundiannao.py": { param: "openid", env: "wuying", title: "无影云电脑" },
};

for (const [file, info] of Object.entries(titles)) {
    const src = fs.readFileSync(path.join(SRC, file), "utf8").replace(/\r\n/g, "\n");
    const envLine = (src.match(/^#new Env\("([^"]+)"\)/m) || [])[1] || info.title;
    const cronLine = (src.match(/^#cron\s+(.+)$/m) || [])[1] || "";
    const headerNew = [
        `# name: ${envLine}`,
        `# cron: ${cronLine}`,
        `#`,
        `# 环境变量：`,
        `#   YYB_SERVER    每行：地址@账号标识（例如 http://yyb-go:8000@1）`,
        `#   YYB_API_KEY   可选；yyb-go 配置 YYB_PROTOCOL_TOKEN 时填同一令牌`,
        `#`,
        `# 参考模版：Template/hsy.py —— 由 YYB-Go 的 /wxapp/getCode 取 wx.login code，`,
        `# 之后全部走小程序自己的业务接口（不再依赖 wx_server_url / wx_auth 桥接服务）。`,
        `# 本文件是 wxapp/${file} 的 YYB-Go 版，原桥接版脚本保持不变。`,
    ].join("\n");

    // 头部：原说明里与账号/桥接相关的行整段替换
    const oldHeaderLines = src.split("\n").filter((l) => /(# ?说明:|账号变量名|需要配置 wx_server|#new Env|#cron )/.test(l));
    let headerOld = "";
    if (oldHeaderLines.length) {
        const firstIdx = src.split("\n").findIndex((l) => /(# ?说明:|账号变量名)/.test(l));
        const lastIdx = src.split("\n").findIndex((l) => /^#cron /.test(l));
        headerOld = src.split("\n").slice(firstIdx, lastIdx + 1).join("\n");
    }

    convert({
        file,
        param: info.param,
        headerOld,
        headerNew,
        mainNew: `def main():
    try:
        route_list = routes()
    except RuntimeError as exc:
        print(f"❌ {exc}")
        return

    print("=============== ${info.title} 签到开始 ===============")
    summaries = []
    ok_count = 0
    for i, (server, ref) in enumerate(route_list, 1):
        print(f"\\n-------------- 账号 {i}({mask(ref)}) --------------")
        try:
            summary, ok = run_account(ref, i, server)
            summaries.append(summary)
            ok_count += 1 if ok else 0
        except Exception as e:
            print(f"❌ 账号 {i} 执行异常: {e}")
            summaries.append(f"【账号 {i}】\\n❌ 执行异常: {e}")
        time.sleep(1)

    print("\\n=============== ${info.title} 签到结束 ===============")
    title = f"${info.title}签到 {ok_count}/{len(route_list)} 成功"
    try:
        send(title, "\\n\\n".join(summaries))
    except Exception as e:
        print(f"⚠️ 通知发送失败: {e}")`,
    });
}

