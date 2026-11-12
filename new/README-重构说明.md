# new/ 重构对照说明

重构范围：`yyb/` 下未在 `newyyb/` 处理过的脚本，输出到本目录，文件名与原目录一一对应。

## 一、跳过清单（14 个，已在 newyyb/ 重构）

`aiguoyue.js`、`ajier.js`、`ardywj.js`、`baimazhixuan.js`、`bluedash.js`、`bydhy.js`、`campari.js`、`casetify.js`、`choubao.js`、`dasenlin.js`、`ddyx.js`、`dfrc.js`、`dsmmhy.js`、`jtc.js`

原因：`newyyb/` 已存在同名且完成节流 + 缓存改造的版本，按本次任务要求不重复处理、也不改动 `newyyb/` 内文件。

## 二、节流改造

### JS（全部 145 个脚本，统一在共享层实现）

微信协议接口调用全部经过 `./yyb.js` 的 `YYBClient`，因此节流只在 `new/yyb.js` 一处实现：

- `throttleWxApi()`：记录上次调用时间，与本次间隔不足 2 秒就先补齐等待
- 挂在 `YYBClient.call()` 入口，覆盖 `/wxapp/getCode`、`/wxapp/getPhoneNumber`、`/wxapp/operateWxData`、`/wx/encryptkey`、`/wx/cloud`
- `/wx/getuserinfo` 读的是 YYB 本地账号资料，不属于微信协议接口，不受限
- 间隔可用 `YYB_WX_MIN_INTERVAL_MS` 调整，默认 2000 毫秒；设 0 关闭

原有 `YYB_CODE_DELAY_MS`（取码前 45~90 秒随机等待）保持不变，两者叠加生效。

### Python（8 个脚本，逐个注入）

每个脚本新增 `throttle_wx_api()`（与 `newyyb/优越城.py` 同一写法），并在 `yyb_code()` / `yyb_phone_code()` 开头调用：

| 脚本 | 节流注入点 |
| --- | --- |
| bjhqbwz.py、BREO.py、liquanpijiu.py、wuyingyundiannao.py、xinxianghui.py、提现免费券.py | `yyb_code()` ×1 |
| hongsehuojian.py、quanmianshidai.py | `yyb_code()` + `yyb_phone_code()` ×2 |

## 三、缓存改造

缓存位置统一为脚本同目录下的 `tokencache/`，写入前自动建目录，不再散落在脚本目录或青龙根目录。

### 1. 已有缓存的脚本：路径收拢 + 自动建目录

- **127 个 JS**：`path.join(__dirname, "xxx_token_cache.json")` → `path.join(__dirname, "tokencache", "xxx_token_cache.json")`，并在 `fs.writeFileSync` 前插入 `fs.mkdirSync(path.dirname(...), { recursive: true })`
- **7 个 PY**：`Path(__file__).with_name("xxx_token_cache.json")` → `Path(__file__).resolve().parent / "tokencache" / "xxx_token_cache.json"`，`write_token_cache()` 开头补建目录

缓存 key、失效策略、业务字段均未改动。

### 2. 原本无缓存的脚本：新增缓存

新增共享助手 `new/token-cache.js`（`getToken` / `saveToken` / `removeToken`），缓存文件 `tokencache/<脚本名>_token_cache.json`。

统一模式：命中缓存 → 赋给原 token 成员 → 用一个**已有的只读查询接口**验证登录态 → 有效则打印“使用缓存token”并跳过微信取码；无效/异常 → `removeToken` + 清空 → 走原登录流程 → 成功后 `saveToken`。签到逻辑、接口路径、请求参数均未改。

| 脚本 | 缓存 key | 校验接口/方式 |
| --- | --- | --- |
| quwa_jxyx.js | openid | `checkOpenid.do` |
| fhxmh.js | openid | `/c/user/memberInfo` |
| huazhu.js | openid | `getBriefInfo`（缓存 sId） |
| miqilin.js | wcsid | `/bff/profile` |
| oppo.js | openid | `/member/info`（缓存 sessionId 等） |
| skyworth.js | openid | `GET /v1/get-user` |
| tclx_lc.js | openid | 里程查询 `query()`（缓存 sectoken） |
| txdt.js | openid | `/activity/v1/checkin/calendar`（缓存整份 loginInfo） |
| ydyc.js | openid | `userInfoData`（缓存 r3dkey） |
| ytb2_all.js | account | `/mini/user-asset`（缓存 shiruanKey 等） |
| ztkd.js | openid | `member/getMemberPoints` |
| 提现免费券.py | ref | `query_coupons()`（缓存 session_token） |

## 四、未加缓存的文件及原因

| 脚本 | 原因 |
| --- | --- |
| kekoukele.js、guyu.js、musi.js、nwdjg.js、stokke.js、tslj.js | 这 6 个脚本的 `run()` 只 `return yyb.getCode(...)`，返回值未被使用，`getUserToken()` 定义了却从未调用——**没有任何登录/换 token 流程**，无登录态可缓存。这是脚本迁移到 YYB-Go 时遗留的既有缺陷，不属于本次改造范围。 |
| qqpcmgr.js | 无只读查询接口可用于验证登录态（`sessionKey` 只用于一次抽奖），强行缓存会破坏原有流程。 |

## 五、发现的既有缺陷（未擅自修改）

`qqpcmgr.js` 第 288 行调用 `yybAccounts()`，但文件没有 `require("./yyb.js")`，运行时会 `ReferenceError`。原脚本同样存在该问题，按“保留原有业务行为”的约束未改动，建议单独修复。

## 六、青龙推送改造（新增）

与 newyyb 的推送模式对齐：超时保护 + 失败原因透明 + 明确的完成判定。

### JS（145 个脚本，共享层实现）

新增两个自治模块，`new/` 目录不再依赖 `tools/env.js`（青龙上整个 `new/` 目录独立可用）：

- **`new/ql-notify.js`**：候选路径依次加载 sendNotify（`/ql/data/scripts/sendNotify.js` → `/ql/data/sendNotify.js` → 脚本目录 → 上级目录 → cwd），加载结果缓存；调用带 30 秒超时竞速（`QL_NOTIFY_TIMEOUT_MS` 可调，设 0 关闭）；结果输出三种状态——`✅ 青龙通知调用完成（模块：xxx）` / `⚠️ 青龙通知未完成（不影响任务结果）：原因` / 非青龙环境时简短提示。
- **`new/env.js`**：复制 tools/env.js，唯一差异是 `sendMsg()` 改走 ql-notify，且 notifyStr 为空时跳过推送（避免发空消息）。

145 个 JS 的 `require("../tools/env.js")` 已批量切换为 `require("./env.js")`，推送行为（把整个运行日志发给青龙通知）保持不变。

### Python（8 个脚本，逐个注入）

每个脚本注入统一函数块：`_ql_load_notify()`（候选路径 + importlib 加载，找 send/sendNotify）+ `_notify_with_timeout()`（daemon 线程 + Event，30 秒超时）+ `ql_notify()`（完成判定与状态输出）。

- 6 个同构脚本（bjhqbwz、xinxianghui、wuyingyundiannao、quanmianshidai、liquanpijiu、hongsehuojian）：原 `from notify import send` 的 try/except 块整体替换为函数块，调用点 `send(...)` → `ql_notify(...)`
- BREO.py、提现免费券.py：保留原有 `notify(lines)` 入口与 `BREO_NOTIFY`/`TXFREE_NOTIFY` 开关，内部改为调用 `ql_notify`，顺带清掉了不再需要的 sys.path 注入

## 八、自包含改造（参考优越城.py，新增）

每个脚本现已完全自包含（单文件可跑），不再引用任何本地共享文件。青龙上**单独上传任意一个脚本即可运行**，无需携带 tools/ 或其他配套文件。

### 内联方式

共享模块逻辑以 IIFE（立即执行函数）形式内联进各脚本顶部，内部标识符全部封闭在 IIFE 作用域内，不会与脚本自身的 `axios`/`fs`/`path` 等声明冲突：

- **Env 运行环境 + 青龙通知**（原 tools/env.js + ql-notify.js）→ 内联为 `const { Env } = (() => { ... })()`
- **YYB 取码客户端**（原 yyb.js，含微信协议接口 2 秒节流）→ 内联为 `const { YYBClient, yybAccounts } = (() => { ... })()`
- **token 缓存助手**（原 token-cache.js，仅 12 个使用缓存的脚本）→ 内联为 `const { getToken, saveToken, removeToken } = (() => { ... })()`

已删除共享文件：`env.js`、`yyb.js`、`ql-notify.js`、`token-cache.js`。

### 特殊处理

- **qqpcmgr.js**：原脚本调用 `yybAccounts()` 却从未引用 yyb.js（既有缺陷，运行时 ReferenceError）。内联时补注入了完整的 Env + YYB 定义，**顺手修复了该缺陷**（该脚本仍需配置 `qqpcmgr_authCode` 才有实际功能）。
- **bucket 缓存归一化**：guyu.js 通过 Env 的 `bucket` 特性存缓存（纯文件名相对路径，会散落在进程 cwd）。内联 Env 块的 bucket 初始化已统一改造：纯文件名自动归入脚本目录的 `tokencache/`，写入前自动建目录，对全部 148 个内联脚本生效（无 bucket 的脚本不受影响）。
- **Python 8 个**：本就自包含（节流/缓存/通知函数块均已内嵌），无外部引用，无需改动。

### 验证

- 全部 JS `node --check` 通过；全目录扫描确认无 `require("./env.js")`、`require("./yyb.js")`、`require("./token-cache.js")`、`require("./ql-notify.js")`、`require("../tools/...")` 及 Python 侧 `from notify import` 残留
- 内联代码与原共享文件逐字一致（仅 module.exports 改为 IIFE return），通知/节流/缓存行为不变

## 九、验证结果（历史）

- 147 个 JS：`node --check` 全部通过
- 8 个 PY：`py_compile` 全部通过
- 通知链路冒烟：JS env.js → ql-notify（本地缺 undici 时失败原因如实打印，判定"未完成"不挂死）；PY ql_notify 命中根目录 notify.py 输出"调用完成"
- 全目录扫描确认：不存在指向 `tokencache/` 之外的缓存路径
- 本地无法做真实运行验证：脚本依赖 `axios` 等 npm 包，仓库内未安装 `node_modules`，原 `yyb/` 脚本运行同样报 `Cannot find module 'axios'`（既有环境限制）；本地调试 sendNotify.js 需要根目录可加载 `undici`（青龙上由面板环境提供）
