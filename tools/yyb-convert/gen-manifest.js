#!/usr/bin/env node
/**
 * 生成 yyb/README.md 的脚本清单（名称 / cron / 语言）
 *
 * 用法：node tools/yyb-convert/gen-manifest.js
 * 说明：只读取 yyb/ 下脚本头部的 name 与 cron 元数据，不修改任何脚本。
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const DIR = path.join(ROOT, "yyb");
const OUT = path.join(DIR, "README.md");

const isScript = (f) => /\.(js|py)$/.test(f) && f !== "yyb.js";

function metaOf(file) {
    const text = fs.readFileSync(path.join(DIR, file), "utf8");
    const name = (text.match(/^\s*(?:\/\/|#)\s*name[:：]\s*(.+?)\s*$/m) || [])[1] || file;
    const cron = (text.match(/^\s*(?:\/\/|#)?\s*cron[:：]?\s*([0-9*,/\- ]{9,})\s*$/m) || [])[1] || "";
    const env = [];
    for (const m of text.matchAll(/os\.getenv\("([A-Za-z_][\w]*)"|process\.env\.([A-Za-z_][\w]*)|process\.env\[["']([A-Za-z_][\w]*)["']\]/g)) {
        const key = m[1] || m[2] || m[3];
        if (key && !["YYB_SERVER", "YYB_API_KEY", "YYB_TIMEOUT"].includes(key) && !env.includes(key)) env.push(key);
    }
    const manual = /qqpcmgr_authCode|hshj_encrypt_key|YYB-Go 不提供|YYB-Go 无法自动获取/.test(text);
    return { name, cron, lang: file.endsWith(".py") ? "py" : "js", env: env.slice(0, 4), manual };
}

const files = fs.readdirSync(DIR).filter(isScript).sort();
const rows = files.map((f) => ({ file: f, ...metaOf(f) }));

const head = `# yyb —— YYB-Go 版脚本

本目录是 [wxapp/](../wxapp) 下脚本的 **YYB-Go 版**：取码统一走 YYB-Go 的
\`POST /wxapp/getCode\`（\`{\\"ref\\": 账号标识, \\"app_id\\": 小程序AppID}\`），
不再依赖原 wx_server/smallcat 桥接服务。原脚本保留在 \`wxapp/\` 未做改动，两边可对照。

## 环境变量

| 变量 | 说明 |
| --- | --- |
| \`YYB_SERVER\` | 每行一个账号：\`地址@账号标识\`，例如 \`http://yyb-go:8000@1\`（账号标识支持 YYB 的账号 ID 或 OpenID） |
| \`YYB_API_KEY\` | 可选；yyb-go 配置了 \`YYB_PROTOCOL_TOKEN\` 时填同一令牌（会以 \`Authorization: Bearer\` 发送） |

部分脚本需要业务参数，账号写成一行的形式：\`地址@账号标识#appid#storeId#...\`（保留在小程序里抓到的参数，取码仍只用前面那一段账号标识）。

## 共享模块

- \`yyb.js\`（js 脚本共用）：解析 \`YYB_SERVER\`、取码 \`getCode(ref[, appid])\`、手机号 \`getPhoneNumber\`、
  账号资料 \`getAccountInfo\`、\`operateWxData\` / \`encryptKey\` / \`cloud\` 转发，以及给主循环用的 \`yybAccounts()\`。
- py 脚本不依赖共享模块：\`routes()\` / \`yyb_code()\` / \`yyb_phone_code()\` 直接内联在每个文件里（与 \`Template/hsy.py\` 一致）。

## 需要在 YYB 下手工提供变量的脚本

YYB-Go 没有等价能力的路径一律**明确报错**，不伪造结果：

| 脚本 | 需要手工提供 | 原因 |
| --- | --- | --- |
| \`qqpcmgr.js\` | \`qqpcmgr_authCode\` | 原走二维码授权（\`/wx/qrcodeauth\`），YYB 无等价入口 |
| \`hongsehuojian.py\` | \`hshj_encrypt_key=encrypt_key#key_version\` | 签名密钥需小程序真实 \`getLatestUserKey\` payload |
| \`fuyouhui.js\`、\`yichengtong.js\`、\`xmsq.js\` | 无（会明确报错/降级） | 需要 operatedata（code/iv/encryptedData），属小程序侧能力 |

另外：\`ykb_all.js\`、\`jingjianx_all.js\` 会为每个小程序/门店各取一次 code，单次运行消耗的一次性 code 较多（属原脚本语义）。

## 脚本清单（${rows.length} 个）

| 脚本 | 名称 | cron | 备注 |
| --- | --- | :---: | --- |
`;

const body = rows
    .map((r) => {
        const notes = [];
        if (r.manual) notes.push("需手工变量");
        if (!r.cron) notes.push("未声明 cron");
        return `| \`${r.file}\` | ${r.name} | ${r.cron ? `\`${r.cron}\`` : "—"} | ${notes.join("；")} |`;
    })
    .join("\n");

const tail = `

> 本清单由 \`node tools/yyb-convert/gen-manifest.js\` 依据脚本头部的 \`name\`/\`cron\` 元数据生成。
> 新建青龙任务时用 YYB-Go 的 \`yyb-scriptctl.sh install 脚本名\`（脚本头部已有 \`cron\` 时可省略 \`--cron\`）。
`;

fs.writeFileSync(OUT, head + body + tail, "utf8");
console.log(`已生成 ${path.relative(ROOT, OUT)}：${rows.length} 个脚本（js ${rows.filter((r) => r.lang === "js").length} / py ${rows.filter((r) => r.lang === "py").length}）`);
