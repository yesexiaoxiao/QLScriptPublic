/**
 * wxapp/*.js -> yyb/*.js 批量转换器（YYB-Go 取码层替换）
 *
 * 覆盖两种取码形态：
 *   A. wcs 桥接型：require("./wcs.js") + new WeChatServer(...) + wechat.getCode()
 *   B. 直连型：自己 axios POST 桥接服务的 /wx/code 或 /wx/getuserinfo 取 code
 *
 * 规则（业务逻辑一律不动）：
 *   R1 头部：插入 // name:，把桥接变量说明换成 YYB_SERVER 说明
 *   R2 require wcs.js -> require ./yyb.js（B 型改为新增 require）
 *   R3 new WeChatServer({url,appid,auth}) -> new YYBClient({appid})，客户端变量统一为 yyb
 *   R4/R8 取码函数体 -> return yyb.getCode(<原账号标识表达式>)
 *   R5/R11 主循环：$.checkEnv(ckName)/$.userList -> yybAccounts()
 *   R6 删除 ckName、桥接地址/鉴权等死变量
 *   R7 文本：wx_server -> YYB-Go
 * 任一条规则命中失败或命中可疑（多次出现、含其它桥接端点、动态 appid 等）→ 该文件不输出。
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const SRC = path.join(ROOT, "wxapp");
const DST = path.join(ROOT, "yyb");
const args = process.argv.slice(2);
const WRITE = args.includes("--write");
const REGRESS = args.includes("--regress");
// 半成品模式：产出机械部分后在人工补齐（仅用于逐个人工处理的文件）
const ALLOW_RESIDUE = args.includes("--allow-residue");
const ALLOW_NOCODE = args.includes("--allow-nocode");

const HEADER_INFO = [
    " YYB-Go 版：取码改走 YYB-Go（POST /wxapp/getCode），不再依赖原取码桥接服务。",
    " 变量：YYB_SERVER 每行 地址@账号标识（例如 http://yyb-go:8000@1）；YYB_API_KEY 可选。",
    " 原桥接版脚本见 wxapp/:FILE:，业务接口、流程与缓存格式均未改动。",
];
const CODE_DOC = "/** 取 wx.login code：YYB-Go /wxapp/getCode（一个账号一次请求，失败即抛错） */";
const OTHER_ENDPOINT = /\/wx\/(getphonenumber|encryptkey|cloud|downloadurl|qrcodeauth|refresh|getlatestuserkey|auth\/|mini\/|main\/|scx\/|user\/appletLogin|call\/init)/;

const splitLines = (text) => text.split("\n");

/** 缩进法定位代码块结束行（对 ${} 模板与正则字面量免疫）；同时支持 `} else {` 行 */
function blockEnd(lines, startIdx) {
    const indent = lines[startIdx].match(/^\s*/)[0];
    for (let i = startIdx + 1; i < lines.length; i++) {
        const line = lines[i];
        const lineIndent = line.match(/^\s*/)[0];
        if (lineIndent === indent && (line === `${indent}}` || /^\s*\}\s*else\s*\{\s*$/.test(line))) return i;
        if (/^\S/.test(line)) return -1;
    }
    return -1;
}

function envName(text) {
    const m = text.match(/new\s+Env\(\s*["'`]([^"'`]+)["'`]/);
    return m ? m[1] : "";
}

function fixHeader(text, file) {
    let out = text;
    const infoLines = HEADER_INFO.map((l) => l.replace(":FILE:", file));
    // 全局删除注释里的桥接变量说明（按"是否处于注释内"判断，代码行交给 R6）
    const dropRe = /(变量名：|变量值：|依赖变量：|账号变量名|需要配置[^\n]*wx_server|wx_server_url|wx_auth|WeChatCodeServer[^\n]*wx_server)/;
    const all = [];
    let inComment = false;
    for (const l of out.split("\n")) {
        const isComment = inComment || /^\s*(\/\/|\/\*)/.test(l);
        const opensBlock = /^\s*\/\*/.test(l) && !/\*\//.test(l);
        if (isComment && dropRe.test(l)) continue;
        all.push(l);
        if (inComment) {
            if (/\*\//.test(l)) inComment = false;
        } else if (opensBlock) {
            inComment = true;
        }
    }
    // 文件头注释区：从第 0 行起连续的注释/空行
    let end = 0;
    let seenComment = false;
    let inBlock = false;
    for (; end < all.length; end++) {
        const l = all[end];
        if (inBlock) {
            seenComment = true;
            if (/\*\/\s*$/.test(l)) inBlock = false;
            continue;
        }
        if (/^\s*\/\*/.test(l)) {
            seenComment = true;
            if (!/\*\/\s*$/.test(l)) inBlock = true;
            continue;
        }
        if (/^\s*\/\//.test(l)) {
            seenComment = true;
            continue;
        }
        if (/^\s*$/.test(l)) {
            if (seenComment) continue;
            break;
        }
        break;
    }
    if (!seenComment) {
        out = `/*\n${infoLines.join("\n")}\n*/\n${all.join("\n")}`;
    } else {
        // 若是 /* */ 块注释，说明插到 */ 之前；若是 // 行注释，追加在注释区之后
        const kept = all.slice(0, end);
        const rest = all.slice(end);
        let lastBlockEnd = -1;
        kept.forEach((l, i) => {
            if (/^\s*\*\/\s*$/.test(l)) lastBlockEnd = i;
        });
        const head =
            lastBlockEnd >= 0
                ? [...kept.slice(0, lastBlockEnd), ...infoLines, ...kept.slice(lastBlockEnd)].join("\n")
                : [...kept, ...infoLines].join("\n");
        out = [head, ...rest].join("\n");
    }
    const name = envName(out);
    if (name && !/^\/\/\s*name\s*:/m.test(out)) out = `// name: ${name}\n${out}`;
    return out;
}

function convert(name, raw) {
    const notes = [];
    const problems = [];
    let text = raw.replace(/\r\n/g, "\n");
    const original = text;

    // ── R1 头部 ──
    text = fixHeader(text, name);

    // ── R6 删桥接死变量（只认桥接地址/鉴权，避免误删业务 API_KEY）──
    const removedVars = new Set();
    const deadNames = new Set(["ckName"]);
    const BRIDGE_VAR = /^(WX_)?(SERVER_URL|SERVER|AUTH)$|^(wx_server_url|wx_auth|wx_server)$/; // 区分大小写：只认桥接变量本身
    for (const m of text.matchAll(/^[ \t]*(?:const|let|var)\s+(\w+)\s*=\s*[^\n]*$/gm)) {
        if (BRIDGE_VAR.test(m[1])) deadNames.add(m[1]);
    }
    for (const v of deadNames) {
        const re = new RegExp(`^[ \\t]*(?:const|let|var)\\s+${v}\\s*=[^\\n]*\\n`, "gm");
        if ((text.match(re) || []).length) {
            text = text.replace(re, "");
            removedVars.add(v);
        }
    }

    // ── R2 require（wcs 桥接型才替换，直连型稍后新增）──
    const reqRe = /[ \t]*const\s+WeChatServer\s*=\s*require\(\s*["'][^"']*wcs\.js["']\s*\);[ \t]*\n/;
    const isWcs = reqRe.test(text);
    let ctorHits = [];
    if (isWcs) {
        const hits = text.match(new RegExp(reqRe.source, "g")) || [];
        if (hits.length === 1) {
            text = text.replace(reqRe, `const { YYBClient, yybAccounts } = require("./yyb.js");\n`);
        } else {
            problems.push(`require wcs.js 出现 ${hits.length} 次`);
        }
    }

    // ── R3 构造 ──
    const ctorRe = /(const|let|var)\s+(\w+)\s*=\s*new\s+WeChatServer\(\s*\{([\s\S]*?)\}\s*\)\s*;/;
    ctorHits = text.match(new RegExp(ctorRe.source, "g")) || [];
    let clientVar = "";
    let appidExpr = "";
    let madeClient = false;
    if (ctorHits.length === 1) {
        const m = text.match(ctorRe);
        clientVar = m[2];
        const appidM = m[3].match(/appid\s*:\s*([^,}]+)/);
        appidExpr = appidM ? appidM[1].trim() : "";
        if (!appidExpr) problems.push("构造里没有 appid");
        text = text.replace(ctorRe, `$1 yyb = new YYBClient({ appid: ${appidExpr} });`);
        notes.push(`ctor -> const yyb = new YYBClient({ appid: ${appidExpr} })`);
        if (clientVar !== "yyb") {
            const refRe = new RegExp(`\\b${clientVar}\\b\\.`, "g");
            const renamed = (text.match(refRe) || []).length;
            text = text.replace(refRe, "yyb.");
            notes.push(`${clientVar} -> yyb（${renamed} 处引用）`);
        }
        madeClient = true;
        if (appidExpr && /[a-zA-Z_$][\w$]*\.[\w$]+/.test(appidExpr)) {
            problems.push(`appid 为动态表达式 ${appidExpr}，需人工确认`);
        }
    } else if (ctorHits.length > 1) {
        problems.push(`new WeChatServer 出现 ${ctorHits.length} 次，需人工`);
    }

    // ── R3b 类内实例：this.<name> = new WeChatServer({...}) -> this.yyb = new YYBClient({...}) ──
    const ctorPropRe = /(this\.(\w+))\s*=\s*new\s+WeChatServer\(\s*\{([\s\S]*?)\}\s*\)\s*;/;
    if (!madeClient) {
        const propHits = text.match(new RegExp(ctorPropRe.source, "g")) || [];
        if (propHits.length === 1) {
            const m = text.match(ctorPropRe);
            const prop = m[2];
            const appidM = m[3].match(/appid\s*:\s*([^,}]+)/);
            appidExpr = appidM ? appidM[1].trim() : "";
            if (!appidExpr) problems.push("类内构造里没有 appid");
            text = text.replace(ctorPropRe, `this.yyb = new YYBClient({ appid: ${appidExpr} });`);
            if (prop !== "yyb") {
                const re = new RegExp(`this\\.${prop}\\.`, "g");
                const renamed = (text.match(re) || []).length;
                text = text.replace(re, "this.yyb.");
                notes.push(`this.${prop} -> this.yyb（${renamed} 处引用）`);
            }
            madeClient = true;
            notes.push(`类内 ctor -> this.yyb = new YYBClient({ appid: ${appidExpr} })`);
        } else if (propHits.length > 1) {
            problems.push(`类内 new WeChatServer 出现 ${propHits.length} 次，需人工`);
        }
    }

    // ── R4/R8 取码函数体 ──
    const lines = splitLines(text);
    const codeFns = [];
    const codeFnsOther = [];
    lines.forEach((l, i) => {
        const m = l.match(/^([ \t]*)((?:async\s+)?)(?:function\s+)?(\w+)\s*\(([^)]*)\)\s*\{\s*$/);
        if (!m) return;
        const end = blockEnd(lines, i);
        if (end < 0) return;
        const body = lines.slice(i + 1, end).join("\n");
        const isClientCall = /\byyb\.getCode\(/.test(body);
        const channel = /(WX_SERVER_URL|wx_server_url|wxServerUrl|axios\.|\$\{)/.test(body);
        const isDirectCall = channel && /\/(code|getuserinfo)/.test(body) && !OTHER_ENDPOINT.test(body);
        if (!isClientCall && !isDirectCall) return;
        let start = i;
        while (start - 1 >= 0 && /^\s*(\/\/|\/\*|\*)/.test(lines[start - 1])) start -= 1;
        const entry = { i, end, start, name: m[3], indent: m[1], params: m[4], body, isAsync: Boolean(m[2]), isFunctionDecl: /\bfunction\b/.test(l), direct: !isClientCall };
        if (isClientCall) codeFns.push(entry);
        else codeFnsOther.push(entry);
    });
    const allCodeFns = [...codeFns, ...codeFnsOther];
    if (allCodeFns.length === 0) {
        problems.push(madeClient ? "找不到取码函数" : "找不到取码函数（直连型）");
    } else if (allCodeFns.length > 1) {
        problems.push(`找到 ${allCodeFns.length} 个取码函数，需人工`);
    } else {
        const fn = allCodeFns[0];
        const bodyCode = fn.body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
        const bad = [];
        // 注：函数体里的 process.env.wx_* 不需要单独拦——整个函数体会被替换掉
        if (OTHER_ENDPOINT.test(fn.body)) bad.push("函数体用了其它桥接端点");
        if (/\bfor\s*\(|\bwhile\s*\(/.test(bodyCode)) bad.push("函数体含重试/循环");
        if (/callWxServer|getOperateData|getServerCode/.test(fn.body)) bad.push("函数体含其它取码路径");
        let refExpr = "";
        if (fn.direct) {
            const m = fn.body.match(/openid\s*:\s*([^,}\n]+)/);
            const openidParam = fn.params
                .split(",")
                .map((p) => p.trim().split("=")[0].trim())
                .find((p) => /openid/i.test(p));
            const ident = fn.body.match(/\b(this\.(?:[\w$]+\.)?\w*openid\w*|this\.\w*[Aa]ccount\w*|openid)\b/);
            const singleParam = fn.params.split(",").length === 1 ? fn.params.trim().split("=")[0].trim() : "";
            refExpr = m
                ? m[1].trim()
                : openidParam ||
                  (ident ? ident[1] : "") ||
                  (/^[A-Za-z_$][\w$]*$/.test(singleParam) ? singleParam : "");
        } else {
            const m = fn.body.match(/\byyb\.getCode\(\s*([^)\n,]+)/);
            refExpr = m ? m[1].trim() : "";
        }
        if (bad.length) problems.push(`取码函数需人工：${bad.join("；")}`);
        else if (!refExpr) problems.push("取码函数里取不到账号标识表达式");
        else {
            // 类内实例（R3b）时调用应是 this.yyb.getCode(...)
            const clientRef = /this\.yyb\.getCode\(/.test(fn.body) ? "this.yyb" : "yyb";
            const newBody = [
                `${fn.indent}${CODE_DOC}`,
                `${fn.indent}${fn.isAsync ? "async " : ""}${fn.isFunctionDecl ? "function " : ""}${fn.name}(${fn.params}) {`,
                `${fn.indent}    return ${clientRef}.getCode(${refExpr});`,
                `${fn.indent}}`,
            ];
            lines.splice(fn.start, fn.end - fn.start + 1, ...newBody);
            text = lines.join("\n");
            notes.push(`${fn.name}() -> yyb.getCode(${refExpr})${fn.direct ? "（直连型）" : ""}`);
        }
    }

    // ── R10 直连型：补 require 与 yyb 实例 ──
    if (!madeClient && !problems.length) {
        // appid 三种形式：顶层常量、对象属性（const APP = { appid: "wx..." }）、裸字面量
        const appidConst = text.match(/^[ \t]*(?:const|let|var)\s+(\w+)\s*=\s*["']wx[0-9a-f]{16}["']/m);
        const appidProp = text.match(/appid\s*:\s*["'](wx[0-9a-f]{16})["']/);
        let appidExpr = "";
        let anchorLine = "";
        if (appidConst) {
            appidExpr = appidConst[1];
            anchorLine = appidConst[0];
        } else if (appidProp) {
            // appid 是对象属性（const APP = { appid: "wx..." }）：直接写字面量，避免运行期依赖对象
            appidExpr = `"${appidProp[1]}"`;
        }
        if (!appidExpr) problems.push("直连型：找不到 appid");
        else {
            const newRequire = `const { YYBClient, yybAccounts } = require("./yyb.js");`;
            let reuse = "";
            if (!/require\(\s*["']\.\/yyb\.js["']\s*\)/.test(text)) {
                const anchors = [...text.matchAll(/^.*require\(\s*["'][^"']*env[^"']*["']\s*\)[^\n]*\n/gm)];
                const anchor = anchors[anchors.length - 1];
                if (!anchor) problems.push("直连型：找不到插入 require 的位置");
                else {
                    text = text.replace(anchor[0], `${anchor[0]}${newRequire}\n`);
                    reuse = newRequire;
                }
            } else {
                reuse = text.match(/^.*require\(\s*["']\.\/yyb\.js["']\s*\)[^\n]*$/m)[0];
            }
            // 实例必须同时晚于 require 与 appid 常量的声明，否则 const 处于 TDZ
            const lines3 = text.split("\n");
            const reqIdx = lines3.findIndex((l) => l.includes('require("./yyb.js")'));
            const appidIdx = anchorLine ? lines3.findIndex((l) => l.includes(anchorLine.trim())) : -1;
            const insertAt = Math.max(reqIdx, appidIdx) + 1;
            lines3.splice(insertAt, 0, "", `const yyb = new YYBClient({ appid: ${appidExpr} });`);
            text = lines3.join("\n");
            notes.push(`直连型：新增 yyb 实例（appid: ${appidExpr}，插在第 ${insertAt + 1} 行）`);
        }
    }

    // ── R5/R11 主循环 ──
    const lines2 = splitLines(text);
    const checkEnvIdx = lines2.findIndex((l) => /\$\.checkEnv\(/.test(l));
    if (checkEnvIdx < 0) {
        // 直连型常见形态：自己声明 accounts 作为账号源 → 换成 yybAccounts()
        const declIdx = lines2.findIndex((l) => /^[ \t]*(?:const|let|var)\s+accounts\s*=/.test(l));
        if (declIdx >= 0) {
            let endIdx = declIdx;
            while (endIdx < lines2.length && !/;[ \t]*$/.test(lines2[endIdx])) endIdx += 1;
            if (endIdx >= lines2.length) {
                problems.push("accounts 赋值无法定位结束");
            } else {
                const ind = lines2[declIdx].match(/^\s*/)[0];
                lines2.splice(declIdx, endIdx - declIdx + 1, `${ind}const accounts = yybAccounts();`);
                text = lines2.join("\n");
                notes.push("主循环账号源 -> yybAccounts()");
            }
        } else {
            problems.push("没有 $.checkEnv(ckName) 主循环");
        }
    } else if (/\b(?:const|let|var)\s+accounts\b/.test(text)) {
        // 文件自己已有 accounts 命名，注入会冲突 → 交人工
        problems.push("文件里已有 accounts 变量，需人工");
    } else {
        const indent = lines2[checkEnvIdx].match(/^\s*/)[0];
        const inject = [
            `${indent}let accounts;`,
            `${indent}try { accounts = yybAccounts(); } catch (e) { $.log(\`❌ \${e.message || e}\`); return; }`,
            `${indent}$.log(\`共找到\${accounts.length}个YYB账号\`);`,
        ];
        lines2.splice(checkEnvIdx, 1, ...inject);
        let i = checkEnvIdx + inject.length;
        while (i < lines2.length) {
            // 桥接条件外壳：if (process.env['wx_server_url'] && ...) { ... } else { ... }
            if (/^\s*if\s*\(\s*process\.env\[?['"]?wx_server_url/.test(lines2[i])) {
                const end = blockEnd(lines2, i);
                if (end < 0) {
                    problems.push("桥接条件块无法定位结束");
                    break;
                }
                let stop = end;
                if (/^\s*\}\s*else\s*\{\s*$/.test(lines2[end])) {
                    const elseEnd = blockEnd(lines2, end);
                    if (elseEnd < 0) {
                        problems.push("桥接条件 else 块无法定位结束");
                        break;
                    }
                    stop = elseEnd;
                }
                const inner = lines2.slice(i + 1, end).map((l) => l.replace(/^ {4}/, ""));
                lines2.splice(i, stop - i + 1, ...inner);
                continue;
            }
            if (/^\s*if\s*\(!\$\.userCount\)\s*\{\s*$/.test(lines2[i])) {
                const end = blockEnd(lines2, i);
                if (end < 0) {
                    problems.push("$.userCount 判断块无法定位结束");
                    break;
                }
                lines2.splice(i, end - i + 1);
                continue;
            }
            if (/^\s*if\s*\(!\$\.userCount\)\s*(return;|\{[^\n]*\})\s*$/.test(lines2[i])) {
                lines2.splice(i, 1);
                continue;
            }
            if (/wx_server_url|wx_auth/.test(lines2[i])) {
                problems.push("主循环里有桥接条件，需人工");
                break;
            }
            if (/return;|\$\.log\(/.test(lines2[i]) || lines2[i].trim() === "") {
                i += 1;
                continue;
            }
            break;
        }
        text = lines2.join("\n");
        const listHits = text.match(/\$\.userList/g) || [];
        text = text.replace(/\$\.userList/g, "accounts");
        notes.push(`主循环 -> yybAccounts()（$.userList x${listHits.length}）`);
    }

    // ── R7 文本 ──
    text = text.replace(/\bwx_server\b/g, "YYB-Go");

    // ── 残留检查 ──
    const residue = [];
    for (const token of ["wcs.js", "WeChatServer", "wx_server_url", "wx_auth", "wx_server", "$.userList", "$.checkEnv", "$.userCount"]) {
        if (text.includes(token)) residue.push(token);
    }
    if (/\bwechat\s*\./.test(text) || /\b(?:const|let|var)\s+wechat\b/.test(text)) residue.push("wechat 变量残留");
    if (/\byyb\.(serverUrl|auth|cloudInit|cloudCall)\b/.test(text)) residue.push("yyb 桥接属性残留（需适配 YYB 端点）");
    for (const v of removedVars) {
        if (new RegExp(`\\b${v}\\b`).test(text)) residue.push(`残留引用 ${v}`);
    }
    if (residue.length) problems.push(`残留：${residue.join(", ")}`);

    // 半成品模式：把"残留""找不到取码函数"降级为提示，交由人工补齐
    let finalProblems = problems;
    const notes2 = [...notes];
    if (ALLOW_RESIDUE || ALLOW_NOCODE) {
        const kept = [];
        for (const p of problems) {
            if (ALLOW_RESIDUE && (p.startsWith("残留：") || p.includes("出现 2 次"))) notes2.push(`【人工待补】${p}`);
            else if (ALLOW_NOCODE && (p.includes("找不到取码函数") || p.includes("个取码函数") || p.includes("取不到账号标识")))
                notes2.push(`【人工待补】${p}`);
            else kept.push(p);
        }
        finalProblems = kept;
    }

    return { text, notes: notes2, problems: finalProblems, changed: text !== original };
}

const files = fs
    .readdirSync(SRC)
    .filter((f) => f.endsWith(".js") && f !== "wcs.js")
    .sort();
// 已人工适配过的文件：转换器不得覆盖（改这里要同步人工维护）
const PROTECT = new Set([
    "camel.js",
    "fuyouhui.js",
    "hisense_aijia.js",
    "jdbclub.js",
    "xmsq.js",
    "yichengtong.js",
    "yipiaoda.js",
    "dfmfs.js",
    "jx.js",
    "jyxe.js",
    "rytyn.js",
    "wrn.js",
]);
const ok = [];
const manual = [];
const regress = [];
for (const f of files) {
    if (PROTECT.has(f)) {
        manual.push({ f, problems: ["已人工适配，转换器跳过"] });
        continue;
    }
    const raw = fs.readFileSync(path.join(SRC, f), "utf8");
    const { text, notes, problems } = convert(f, raw);
    const todo = notes.filter((n) => n.includes("【人工待补】"));
    if (todo.length) console.log(`REVIEW ${f} :: ${todo.map((t) => t.replace("【人工待补】", "")).join(" | ")}`);
    if (problems.length) manual.push({ f, problems });
    else {
        ok.push({ f, notes, text });
        const dstPath = path.join(DST, f);
        if (WRITE) fs.writeFileSync(dstPath, text, "utf8");
        if (REGRESS && fs.existsSync(dstPath)) {
            const old = fs.readFileSync(dstPath, "utf8");
            if (old !== text) regress.push(f);
        }
    }
}
console.log(`可机械转换：${ok.length} / ${files.length}${WRITE ? "（已写入 yyb/）" : "（dry-run）"}`);
console.log(`OK-LIST ${ok.map((r) => r.f).join(",")}`);
if (REGRESS) console.log(`与既有文件不一致：${regress.length}${regress.length ? " -> " + regress.join(", ") : ""}`);
console.log(`\n需人工：${manual.length}`);
manual.forEach((m) => console.log(`  ${m.f} :: ${m.problems.join(" | ")}`));
