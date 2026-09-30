// quanmianshidai.py / hongsehuojian.py 的 YYB 版转换（定制替换）
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


def yyb_phone_code(server, ref):
    # YYB-Go：POST /wxapp/getPhoneNumber {"ref": 账号标识, "app_id": 小程序 APPID}
    headers = {"Content-Type": "application/json"}
    api_key = os.getenv("YYB_API_KEY", "").strip()
    if api_key:
        headers["Authorization"] = "Bearer " + api_key
    response = requests.post(
        f"{server}/wxapp/getPhoneNumber",
        json={"ref": ref, "app_id": MINI_APP_ID},
        headers=headers,
        timeout=60,
    )
    response.raise_for_status()
    body = response.json()
    if int(body.get("code", -1)) != 0:
        raise RuntimeError(f"YYB 取手机号失败：{body.get('msg') or body.get('message') or body}")
    data = body.get("data") or {}
    result = data.get("result") or data
    code = result.get("code") or data.get("code")
    if not code:
        raise RuntimeError("YYB 未返回手机号 code")
    return str(code)


def mask(ref):
    return ref if len(ref) <= 12 else f"{ref[:6]}...{ref[-4:]}"
`;

function funcEnd(lines, start) {
    let end = start + 1;
    while (end < lines.length && !/^(def |class |if __name__)/.test(lines[end])) end += 1;
    while (end - 1 > start && (lines[end - 1].trim() === "" || /^#\s*-{3,}\s*$/.test(lines[end - 1]) || /^#\s*$/.test(lines[end - 1]))) end -= 1;
    return end;
}

function applyPairs(text, pairs, report) {
    for (const [oldText, newText] of pairs) {
        if (!text.includes(oldText)) {
            report.push(`MISS(${oldText.split("\n")[0].trim().slice(0, 45)})`);
            continue;
        }
        text = text.split(oldText).join(newText);
        report.push("ok");
    }
    return text;
}

const QM_HEADER_OLD = [
    "# 说明: 通过 wx_server(smallcat) 用 openid 换取 wx.login code 自动登录(nmp),",
    "#       完成每日签到与种棉花(浇水)任务。",
    "# 账号变量名: qmzmh   (填写 wx_server 中的 openid, 多账号用换行或 & 分割, 可选 #备注)",
    "# 需要配置 wx_server_url、wx_auth, 用于获取 wx.login code",
].join("\n");

const QM_HEADER_NEW = [
    "# name: 全棉时代签到",
    "# cron: 30 8 * * *",
    "#",
    "# 环境变量：",
    "#   YYB_SERVER    每行：地址@账号标识（例如 http://yyb-go:8000@1）",
    "#   YYB_API_KEY   可选；yyb-go 配置 YYB_PROTOCOL_TOKEN 时填同一令牌",
    "#",
    "# 参考模版：Template/hsy.py —— 由 YYB-Go 的 /wxapp/getCode 取 wx.login code，",
    "# 之后全部走小程序自己的业务接口（不再依赖 wx_server_url / wx_auth 桥接服务）。",
    "# 本文件是 wxapp/quanmianshidai.py 的 YYB-Go 版，原桥接版脚本保持不变。",
].join("\n");

// ── quanmianshidai.py ──
{
    const report = [];
    let text = fs.readFileSync(path.join(SRC, "quanmianshidai.py"), "utf8").replace(/\r\n/g, "\n");
    text = applyPairs(text, [[QM_HEADER_OLD, QM_HEADER_NEW]], report);

    const constRe = /^[ \t]*WX_SERVER_URL\s*=[^\n]*\n[ \t]*WX_AUTH\s*=[^\n]*\n/m;
    if (constRe.test(text)) {
        text = text.replace(constRe, YYB_BLOCK + "\n");
        report.push("常量->YYB");
    } else report.push("MISS 常量");

    let lines = text.split("\n");
    const gStart = lines.findIndex((l) => /^def get_wx_code\(/.test(l));
    if (gStart < 0) report.push("MISS get_wx_code");
    else {
        const gEnd = funcEnd(lines, gStart);
        lines.splice(
            gStart,
            gEnd - gStart,
            `# 当前账号的 YYB 服务地址（main 遍历账号时写入；取码需要 服务地址 + 账号标识）`,
            `YYB_SERVER_URL = ""`,
            ``,
            ``,
            `# YYB-Go: 账号标识 -> wx.login code（同账号取码由 YYB 串行处理，不需要再 /wx/refresh）`,
            `def get_wx_code(openid):`,
            `    last_msg = ""`,
            `    for attempt in range(4):`,
            `        if attempt:`,
            `            time.sleep(3)`,
            `        try:`,
            `            return yyb_code(YYB_SERVER_URL, openid)`,
            `        except Exception as exc:`,
            `            last_msg = str(exc)`,
            `    raise RuntimeError(f"YYB-Go 获取 code 失败(已重试): {last_msg}")`,
            ``
        );
        report.push("get_wx_code");
    }
    text = lines.join("\n");

    text = applyPairs(text, [
        [
            `def main():\n    accounts = get_env_variable('qmzmh')\n    if not accounts:\n        return\n    if not WX_AUTH:\n        print("❌ 未配置 wx_auth, 无法获取 code, 退出。")\n        return\n    total = len(accounts)`,
            `def main():\n    try:\n        route_list = routes()\n    except RuntimeError as exc:\n        print(f"❌ {exc}")\n        return\n    accounts = [ref for _server, ref in route_list]\n    total = len(accounts)`,
        ],
        [
            `    for index, entry in enumerate(accounts, start=1):\n        parts = str(entry).split('#', 1)`,
            `    for index, (server, ref) in enumerate(route_list, start=1):\n        global YYB_SERVER_URL\n        YYB_SERVER_URL = server\n        parts = str(ref).split('#', 1)`,
        ],
    ], report);

    fs.writeFileSync(path.join(DST, "quanmianshidai.py"), text, "utf8");
    console.log(`quanmianshidai.py: ${report.join(",")}`);
}

// ── hongsehuojian.py ──
{
    const report = [];
    let text = fs.readFileSync(path.join(SRC, "hongsehuojian.py"), "utf8").replace(/\r\n/g, "\n");
    text = applyPairs(
        text,
        [
            [
                `# 说明: 通过 wx_server(smallcat) 用 openid 自动登录, 完成每日签到\n# 账号变量名:hshj   (填写 wx_server 中的 openid, 多账号用换行或 & 分割, 可选 #备注)\n# 需要配置 wx_server_url、wx_auth`,
                `# name: 红色火箭签到\n# cron: 40 8 * * *\n#\n# 环境变量：\n#   YYB_SERVER         每行：地址@账号标识（例如 http://yyb-go:8000@1）\n#   YYB_API_KEY        可选；yyb-go 配置 YYB_PROTOCOL_TOKEN 时填同一令牌\n#   hshj_phone_login   是否允许用手机号授权自动登录, 默认 1(开启), 置 0 关闭\n#   hshj_encrypt_key   手动提供签名密钥：encrypt_key#key_version（YYB 无法自动取到，见 get_encrypt_key）\n#\n# 参考模版：Template/hsy.py —— 由 YYB-Go 的 /wxapp/getCode 取 wx.login code，\n# 之后全部走小程序自己的业务接口（不再依赖 wx_server_url / wx_auth 桥接服务）。\n# 本文件是 wxapp/hongsehuojian.py 的 YYB-Go 版，原桥接版脚本保持不变。`,
            ],
        ],
        report
    );

    const constRe = /^[ \t]*WX_SERVER_URL\s*=[^\n]*\n[ \t]*WX_AUTH\s*=[^\n]*\n/m;
    if (constRe.test(text)) {
        text = text.replace(constRe, YYB_BLOCK + "\n");
        report.push("常量->YYB");
    } else report.push("MISS 常量");

    // smallcat / get_code / get_encrypt_key 三段整体替换
    const oldBridge = `# ---------------------------------------------------------------------------
def smallcat(endpoint, account_id):
    if not WX_AUTH:
        raise RuntimeError("缺少 wx_auth, 无法调用 wx_server")
    headers = {"Accept": "application/json", "Content-Type": "application/json", "auth": WX_AUTH}
    body = json.dumps({"appid": MINI_APP_ID, "openid": account_id})
    resp = session.post(f"{WX_SERVER_URL}{endpoint}", data=body, headers=headers, timeout=60)
    resp.raise_for_status()
    return resp.json()


def get_code(account_id, endpoint="/wx/code"):
    """smallcat 偶发 "获取失败"(运行时会话抖动), 刷新会话后间隔重试。"""
    last_msg = ""
    for attempt in range(4):
        if attempt:
            try:
                smallcat("/wx/refresh", account_id)
            except Exception:
                pass
            time.sleep(3)
        data = smallcat(endpoint, account_id)
        if isinstance(data, dict) and data.get("status") is False:
            last_msg = data.get("message") or "获取失败"
            continue
        code = data.get("code") or (data.get("data") or {}).get("code")
        if code:
            return code
        last_msg = "wx_server 未返回 code"
    raise RuntimeError(f"wx_server {endpoint} 失败(已重试): {last_msg}")


def get_encrypt_key(account_id):
    data = (smallcat("/wx/encryptkey", account_id).get("data") or {})
    return data.get("encrypt_key"), data.get("version")`;

    const newBridge = `# 当前账号的 YYB 服务地址（main 遍历账号时写入；取码需要 服务地址 + 账号标识）
YYB_SERVER_URL = ""


def get_code(account_id, endpoint="/wx/code"):
    """YYB-Go 取码：/wx/code -> /wxapp/getCode；/wx/getphonenumber -> /wxapp/getPhoneNumber。
    同账号取码由 YYB 串行处理，不需要再 /wx/refresh。"""
    if endpoint not in ("/wx/code", "/wx/getphonenumber"):
        raise RuntimeError(f"YYB-Go 不再支持端点 {endpoint}")
    last_msg = ""
    for attempt in range(4):
        if attempt:
            time.sleep(3)
        try:
            if endpoint == "/wx/code":
                return yyb_code(YYB_SERVER_URL, account_id)
            return yyb_phone_code(YYB_SERVER_URL, account_id)
        except Exception as exc:
            last_msg = str(exc)
    raise RuntimeError(f"YYB-Go {endpoint} 失败(已重试): {last_msg}")


def get_encrypt_key(account_id):
    """签名用的 encrypt_key。YYB-Go 的 /wx/getlatestuserkey（getUserEncryptKey 转发）需要小程序真实的
    operateWxData payload，不能凭空构造，因此这里不做猜测性转发：
    用 hshj_encrypt_key=encrypt_key#key_version 提供，否则明确报错。"""
    raw = os.getenv("hshj_encrypt_key", "").strip()
    if raw:
        parts = raw.split("#", 1)
        return parts[0], (parts[1] if len(parts) > 1 else "")
    raise RuntimeError(
        "YYB-Go 无法自动获取 encrypt_key（需真实 getLatestUserKey payload）；"
        "请在 YYB 控制台确认该小程序能力后用 hshj_encrypt_key=encrypt_key#key_version 提供"
    )`;

    text = applyPairs(text, [[oldBridge, newBridge]], report);

    text = applyPairs(
        text,
        [
            [
                `def run_account(account_id, index):`,
                `def run_account(account_id, index, server):\n    global YYB_SERVER_URL\n    YYB_SERVER_URL = server`,
            ],
            [
                `def main():\n    raw = os.getenv("hshj", "")\n    accounts = [x.strip() for x in raw.replace("&", "\\n").splitlines() if x.strip()]\n\n    if not accounts:\n        print("❌ 未检测到账号信息(环境变量 hshj), 退出。")\n        return\n    if not WX_AUTH:\n        print("❌ 未配置 wx_auth, 无法获取 code, 退出。")\n        return`,
                `def main():\n    try:\n        route_list = routes()\n    except RuntimeError as exc:\n        print(f"❌ {exc}")\n        return`,
            ],
            [
                `    for i, entry in enumerate(accounts, 1):\n        parts = entry.split("#", 1)\n        account = parts[0].strip()`,
                `    for i, (server, ref) in enumerate(route_list, 1):\n        parts = str(ref).split("#", 1)\n        account = parts[0].strip()`,
            ],
            [`            summary, ok = run_account(account, i)`, `            summary, ok = run_account(account, i, server)`],
        ],
        report
    );

    fs.writeFileSync(path.join(DST, "hongsehuojian.py"), text, "utf8");
    console.log(`hongsehuojian.py: ${report.join(",")}`);
}
