# yyb-convert —— wxapp → yyb（YYB-Go 版）转换与验收工具

把 `wxapp/` 下的桥接版脚本转成 `yyb/` 下的 YYB-Go 版：取码统一走
`POST /wxapp/getCode`，业务逻辑不动。`wxapp/` 原文件始终保持不变，两边可对照。

配套说明见 [`yyb/README.md`](../../yyb/README.md)（脚本清单、环境变量、需要手工变量的脚本）。

## 脚本

| 文件 | 用途 |
| --- | --- |
| `convert-wxapp-to-yyb.js` | js 批量转换：`require("./wcs.js")`/`new WeChatServer(...)`/取码函数体/主循环 一次性替换 |
| `convert-py-to-yyb.js` | py 批量转换（4 个"get_wx_code + 签到"型脚本） |
| `convert-py-extra.js` | py 定制转换（`quanmianshidai.py`、`hongsehuojian.py`，结构特殊） |
| `smoke-js.js` | js 离线冒烟验收（假 axios，断言每个 YYB 账号各取一次 code） |
| `smoke-py.js` | py 离线冒烟验收（pyodide + 假 requests） |
| `gen-manifest.js` | 依据脚本头部 `name`/`cron` 元数据重新生成 `yyb/README.md` 的清单 |

```bash
# 转换（默认 dry-run，只报告不写文件；加 --write 才落盘）
node tools/yyb-convert/convert-wxapp-to-yyb.js            # 看看哪些能自动转、哪些要人工
node tools/yyb-convert/convert-wxapp-to-yyb.js --write    # 落盘（会跳过 PROTECT 清单里的文件）

# 验收
node tools/yyb-convert/smoke-js.js                        # 严格模式：业务接口一律回"未覆盖"
node tools/yyb-convert/smoke-js.js --loose                # 宽松模式：业务接口回"成功"（验证成功路径）
node tools/yyb-convert/smoke-js.js aiguo.js dw.js         # 只跑指定脚本

npm i pyodide                                             # smoke-py 依赖（装一次即可）
node tools/yyb-convert/smoke-py.js
PY_ENV='hshj_encrypt_key=STUB#1' node tools/yyb-convert/smoke-py.js hongsehuojian.py

node tools/yyb-convert/gen-manifest.js                    # 更新 yyb/README.md 清单
```

两个 smoke 都在系统临时目录里自建沙箱，跑完自动清理，不会改动仓库、不访问真实网络。

## 转换规则（js）

每个文件只动取码层这 4 处，其余一律不动：

1. `const WeChatServer = require("./wcs.js")` → `const { YYBClient, yybAccounts } = require("./yyb.js")`
2. `new WeChatServer({url,appid,auth})` → `new YYBClient({ appid })`（客户端变量统一为 `yyb`；类内的
   `this.wechat = new WeChatServer(...)` → `this.yyb = ...`，取码写成 `this.yyb.getCode(...)`）
3. 取码函数体 → `return yyb.getCode(<原账号标识表达式>)`
4. 主循环 `$.checkEnv(ckName)` + `$.userList`（含 `if (process.env['wx_server_url'] …)` 外壳、自建
   `const accounts = …`）→ `yybAccounts()`
5. 顺手删掉 `ckName` / `WX_SERVER_URL` / `WX_AUTH` 等桥接死变量，头部加 `// name:` 与 YYB 说明

容易踩的两个坑（转换器已处理）：

- `new YYBClient(...)` 必须插在 **require 和 appid 常量声明之后**，否则 `const` 处于 TDZ，
  运行时报 `Cannot access 'YYBClient'/'MINI_APP_ID' before initialization`；
- 旧脚本期望 `{data:{...}}` 返回，YYB 的 `getCode()` 直接返回 code 字符串，取码函数体必须重写。

## 转换规则（py）

py 没有共享模块，按 `Template/hsy.py` 的风格内联 `routes()` / `yyb_code()` / `yyb_phone_code()` / `mask()`：

1. 头部注释/docstring 换成 YYB 说明 + `# name:` / `# cron:`
2. 删 `WX_SERVER_URL` / `WX_AUTH`，插入上面几个函数
3. `get_wx_code(X)` 用**模块级** `YYB_SERVER_URL`（由 `run_account(ref, index, server)` 写入）——
   py 的调用链常是 `run_account → login/obtain_session → get_wx_code` 两层以上，这样不用改中间层
4. `main()` 改为遍历 `routes()` 的 `(server, ref)`

## PROTECT 清单

`convert-wxapp-to-yyb.js` 不会覆盖下列**人工适配过**的文件（改这里要同步人工维护）：

```
camel.js  dfmfs.js  fuyouhui.js  hisense_aijia.js  jdbclub.js  jx.js  jyxe.js
rytyn.js  wrn.js  xmsq.js  yichengtong.js  yipiaoda.js
```

## 能力边界

YYB-Go 没有等价能力的路径一律**明确报错**，不伪造结果（细节见 `yyb/README.md`）：

- operatedata（code/iv/encryptedData）、`/wx/refresh`、`/wx/downloadurl`、`/wx/qrcodeauth`、
  `/wx/encryptkey`（需真实 payload）→ 报错或改用 `operateWxData` 转发真实 payload
- 手机号 → `/wxapp/getPhoneNumber`
- 多小程序/多店铺脚本（`ykb_all.js`、`jingjianx_all.js`）每个 app/门店各取一次 code，属原脚本语义
