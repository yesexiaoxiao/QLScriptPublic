# yyb —— YYB-Go 版脚本

本目录是 [wxapp/](../wxapp) 下脚本的 **YYB-Go 版**：取码统一走 YYB-Go 的
`POST /wxapp/getCode`（`{\"ref\": 账号标识, \"app_id\": 小程序AppID}`），
不再依赖原 wx_server/smallcat 桥接服务。原脚本保留在 `wxapp/` 未做改动，两边可对照。

## 环境变量

| 变量 | 说明 |
| --- | --- |
| `YYB_SERVER` | 每行一个账号：`地址@账号标识`，例如 `http://yyb-go:8000@1`（账号标识支持 YYB 的账号 ID 或 OpenID） |
| `YYB_API_KEY` | 可选；yyb-go 配置了 `YYB_PROTOCOL_TOKEN` 时填同一令牌（会以 `Authorization: Bearer` 发送） |
| `YYB_CODE_DELAY_MS` | 可选；每次取码（调 `wx.login`）前的延时基准毫秒数，实际等待该基准的 0.75~1.5 倍随机（默认 `60000` → 等 45~90 秒），设 `0` 关闭 |

所有脚本（js 与 py）调用 YYB-Go 取码（`POST /wxapp/getCode`，即 `wx.login`）前都会先等
`YYB_CODE_DELAY_MS` 的 0.75~1.5 倍随机（默认 45~90 秒）。这里带随机抖动是必要的：多个脚本常由同一
cron 波次拉起，固定时长会让它们在同一秒对同一账号取码；重试/重新登录会再取一次码，也就再等一次。
因此 `ykb_all.js`、`jingjianx_all.js` 这类一次遍历多门店的脚本运行时长会明显变长。

部分脚本需要业务参数，账号写成一行的形式：`地址@账号标识#appid#storeId#...`（保留在小程序里抓到的参数，取码仍只用前面那一段账号标识）。

## 共享模块

- `yyb.js`（js 脚本共用）：解析 `YYB_SERVER`、取码 `getCode(ref[, appid])`、手机号 `getPhoneNumber`、
  账号资料 `getAccountInfo`、`operateWxData` / `encryptKey` / `cloud` 转发，以及给主循环用的 `yybAccounts()`。
- py 脚本不依赖共享模块：`routes()` / `yyb_code()` / `yyb_phone_code()` 直接内联在每个文件里（与 `Template/hsy.py` 一致）。

## 需要在 YYB 下手工提供变量的脚本

YYB-Go 没有等价能力的路径一律**明确报错**，不伪造结果：

| 脚本 | 需要手工提供 | 原因 |
| --- | --- | --- |
| `qqpcmgr.js` | `qqpcmgr_authCode` | 原走二维码授权（`/wx/qrcodeauth`），YYB 无等价入口 |
| `hongsehuojian.py` | `hshj_encrypt_key=encrypt_key#key_version` | 签名密钥需小程序真实 `getLatestUserKey` payload |
| `fuyouhui.js`、`yichengtong.js`、`xmsq.js` | 无（会明确报错/降级） | 需要 operatedata（code/iv/encryptedData），属小程序侧能力 |

另外：`ykb_all.js`、`jingjianx_all.js` 会为每个小程序/门店各取一次 code，单次运行消耗的一次性 code 较多（属原脚本语义）。

## 脚本清单（167 个）

| 脚本 | 名称 | cron | 备注 |
| --- | --- | :---: | --- |
| `BREO.py` | BREO | `8 9,10,11 * * *` |  |
| `aiguo.js` | 爱裹旧衣回收 | `46 8 * * *` |  |
| `aiguoyue.js` | 爱果乐之家微信小程序签到 | `30 8 * * *` |  |
| `aima.js` | 爱玛会员俱乐部 | — | 未声明 cron |
| `ajier.js` | 安吉尔会员 | `25 8 * * *` |  |
| `ardywj.js` | 爱康会员签到 | `53 8 * * *` |  |
| `babycare.js` | Babycare官方旗舰店 | `41 8 * * *` |  |
| `baimazhixuan.js` | 白马智选 | `42 8 * * *` |  |
| `bjhqbwz.py` | 北京环球签到 | `15 9 * * *` |  |
| `bluedash.js` | BLUE DASH 布鲁大师签到 | `30 8 * * *` |  |
| `bmsb.js` | 宝妈上班 | `17 8 * * *` |  |
| `bqs.js` | 倍轻松签到 | `12 9 * * *` |  |
| `bydhy.js` | 比亚迪海洋签到 | `51 8 * * *` |  |
| `camel.js` | 骆驼CAMEL签到 | `18 8 * * *` |  |
| `campari.js` | 金巴厘杯中空间签到 | `31 8 * * *` |  |
| `casetify.js` | CASETiFY 签到 | `46 8 * * *` |  |
| `choubao.js` | 臭宝乐园 | `30 9 * * *` |  |
| `colorful.js` | colorful七彩虹 | `30 10 * * *` |  |
| `dasenlin.js` | 大参林小程序签到 | `35 8 * * *` |  |
| `ddyx.js` | 铛铛一下签到 | `32 8 * * *` |  |
| `dfmfs.js` | 巅峰美缝师签到 | `12 9 * * *` |  |
| `dfrc.js` | 东风日产签到 | `42 9 * * *` |  |
| `dsmmhy.js` | 袋鼠妈妈会员商城签到 | `12 8 * * *` |  |
| `dstx.js` | 都市甜心签到 | `47 8 * * *` |  |
| `dtsh.js` | DT生活签到 | `33 8 * * *` |  |
| `dw.js` | 得物种树签到 | `30 8 * * *` |  |
| `fafa.js` | 发发藏宝洞小程序签到 | `38 8 * * *` |  |
| `feihe.js` | 飞鹤微信小程序签到 | `30 8 * * *` |  |
| `fej.js` | 敷尔佳小程序签到 | `20 8 * * *` |  |
| `fhxmh.js` | 飞鹤星妈会 | `20 8 * * *` |  |
| `fmy.js` | 飞蚂蚁旧衣回收 | `37 8 * * *` |  |
| `fsdlb.js` | 逢三得利吧小程序 | `30 9 * * *` |  |
| `fuyouhui.js` | 复游会 | `25 8 * * *` | 需手工变量 |
| `fxh.js` | 一汽丰田丰享汇 | `28 8 * * *` |  |
| `fyzq.js` | 风云再起北京 | `20 8 * * *` |  |
| `gac.js` | 广汽丰田新能源签到 | `26 11,17 * * *` |  |
| `gujiajiaju.js` | 顾家小程序签到 | `41 8 * * *` |  |
| `guyu.js` | 谷雨小程序 | `30 9 * * 1` |  |
| `gyjj.js` | 国乐酱酒 | `30 9 * * *` |  |
| `haier.js` | 海尔智家签到 | `55 8 * * *` |  |
| `haitian.js` | 海天美味馆小程序 | `30 11 * * *` |  |
| `hisense_aijia.js` | 海信爱家 | `30 8 * * *` |  |
| `hlyili.js` | 活力伊利 | `48 8 * * *` |  |
| `hlzj.js` | 海澜之家签到 | `20 8 * * *` |  |
| `hongsehuojian.py` | 红色火箭签到 | `40 8 * * *` | 需手工变量 |
| `hougongfang.js` | 厚工坊 | `40 8 * * *` |  |
| `hrj.js` | 好人家签到 | `36 8 * * *` |  |
| `huazhu.js` | 华住会 | `35 8 * * *` |  |
| `hxek.js` | demogic会员 | `41 8 * * *` |  |
| `iqoo.js` | iqoo社区 | `30 8 * * *` |  |
| `iyouke.js` | iyouke平台签到 | `39 8 * * *` |  |
| `jdbclub.js` | 加多宝Club签到 | `5 10 * * *` |  |
| `jdcode.js` | 京东Code采集 | `0 0,6,12,18 * * *` |  |
| `jdyj.js` | 金典有机生活签到 | `30 11 * * *` |  |
| `jingjianx_all.js` | jingjianx统一签到 | `30 8 * * *` |  |
| `jingyoujia.js` | 劲友家小程序签到 | `30 8 * * *` |  |
| `jlc.js` | 嘉立创签到 | `57 8 * * *` |  |
| `jsb.js` | 杰士邦会员中心 | `49 8 * * *` |  |
| `jtc.js` | 捷停车签到 | `57 8 * * *` |  |
| `junpinhui.js` | 君品荟 | `45 8 * * *` |  |
| `juziyingtao.js` | 橘子樱桃微信小程序签到 | `30 8 * * *` |  |
| `jx.js` | 酒仙签到 | `40 8 * * *` |  |
| `jyk.js` | 旧衣客签到 | `22 9 * * *` |  |
| `jyxe.js` | 旧衣小二 | `38 8 * * *` |  |
| `kangshifu.js` | 康师傅畅饮社 | `30 10 * * *` |  |
| `kekoukele.js` | 可口可乐小程序 | `30 9 * * 1` |  |
| `kuaijihe.js` | 快集合 | `52 8 * * *` |  |
| `laobanfw.js` | 老板服务微商城 | `46 8 * * *` |  |
| `ldxq.js` | 绿动新球签到 | `15 8 * * *` |  |
| `lieer.js` | 烈儿宝贝小程序签到 | `38 8 * * *` |  |
| `liquanpijiu.py` | 漓泉啤酒签到 | `30 9 * * *` |  |
| `lmf.js` | 绿蜜蜂签到 | `22 8 * * *` |  |
| `longfor.js` | 龙湖天街签到 | `35 8 * * *` |  |
| `lthwy.js` | 骆驼户外运动城签到 | `21 8 * * *` |  |
| `lvbizi.js` | 绿鼻子微信小程序签到 | `30 8 * * *` |  |
| `maopu.js` | 毛铺草本荟 | `43 8 * * *` |  |
| `mcyp.js` | 名创优品签到 | `30 8 * * *` |  |
| `mdhy.js` | 美的会员签到 | `32 8 * * *` |  |
| `mdxtn.js` | 美的小天鹅 | `12 11 * * *` |  |
| `mengxiangjia.js` | 梦想家TSE微信小程序签到 | `30 8 * * *` |  |
| `mfd.js` | 麦富迪会员签到 | `35 8 * * *` |  |
| `mifengjingxishe.js` | 蜜蜂惊喜社微信小程序签到 | `30 8 * * *` |  |
| `mimengshenghuo.js` | 米萌生活 | `30 8 * * *` |  |
| `miqilin.js` | 米其林会员小程序 | `30 9 * * *` |  |
| `mobil.js` | 美孚臻享俱乐部签到 | `33 8 * * *` |  |
| `mscxh.js` | 玛氏宠享会签到 | `28 9 * * *` |  |
| `mtyl.js` | 每天有乐 | `50 8 * * *` |  |
| `musi.js` | 慕斯小程序签到 | `30 9 * * *` |  |
| `mxbc.js` | 蜜雪冰城 | `30 8 * * *` |  |
| `nestle.js` | 雀巢会员俱乐部 | `20 8 * * *` |  |
| `nice.js` | 纳爱斯品质生活签到 | `31 8 * * *` |  |
| `nissin.js` | 日清食品签到 | `28 8 * * *` |  |
| `niuyougu.js` | 牛油谷 | `24 8 * * *` |  |
| `nndj.js` | 牛牛短剧签到 | `16 10,22 * * *` |  |
| `nwdjg.js` | 浓五的酒馆 | `30 9 * * *` |  |
| `nxdc.js` | 奈雪签到 | `45 8 * * *` |  |
| `olecs.js` | Ole超市签到 | `16 6,18 * * *` |  |
| `oppo.js` | OPPO | `21 8 * * *` |  |
| `parkson.js` | 呼啦圈小程序签到 | `35 8 * * *` |  |
| `pddgy-公众号版.js` | 拼多多果园公众号版 | `28 9,13 * * *` |  |
| `pddgy.js` | 拼多多果园签到 | `26 9,13 * * *` |  |
| `qianjinjiankang.js` | 千金健康生活微信小程序签到 | `30 8 * * *` |  |
| `qmai.js` | 企迈qmai平台签到 | `51 8 * * *` |  |
| `qmsd.js` | 全棉时代签到 | `51 11 * * *` |  |
| `qqhyjlb.js` | 洽洽会员俱乐部 | `39 8 * * *` |  |
| `qqpcmgr.js` | 腾讯电脑管家登录 | `10 9 * * *` | 需手工变量 |
| `quanmianshidai.py` | 全棉时代签到 | `30 8 * * *` |  |
| `quncrm.js` | 群脉平台签到 | `49 8 * * *` |  |
| `qutaoka.js` | 趣淘卡 | `26 8 * * *` |  |
| `quwa_jxyx.js` | 趣蛙/匠心优选 | `23 8 * * *` |  |
| `qyqd.js` | 期云积签兑 | `36 8 * * *` |  |
| `rio.js` | RIO微醺俱乐部 | `33 8 * * *` |  |
| `roki.js` | 老板电器ROKI签到 | `30 8 * * *` |  |
| `rrk.js` | 红人库签到 | `34 10 * * *` |  |
| `rytyn.js` | 认养一头牛签到 | `17 9 * * *` |  |
| `sanf.js` | 三福会员签到 | `43 8 * * *` |  |
| `sf.js` | 顺丰速运签到 | `20 8 * * *` |  |
| `shanyi.js` | 善羿科技 | `38 8 * * *` |  |
| `shefuyishou.js` | 社服益寿活动 | `22 8 * * *` |  |
| `shengongshe.js` | 申工社 | `34 8 * * *` |  |
| `sinsin.js` | sinsin微信小程序签到 | `30 8 * * *` |  |
| `skyworth.js` | 创维会员中心 | `38 8 * * *` |  |
| `smgc.js` | 上美广场签到 | `20 9,21 * * *` |  |
| `stokke.js` | stokke小程序 | `30 9 * * 1` |  |
| `szgc.js` | 深圳春茧未来荟签到 | `40 8 * * *` |  |
| `tclx_lc.js` | 同程旅行里程签到 | `21 8 * * *` |  |
| `thyc.js` | 途虎养车签到 | `24 8 * * *` |  |
| `tjg.js` | 天机观签到 | `9 9,14 * * *` |  |
| `tmj.js` | 谭木匠会员俱乐部签到 | `36 8 * * *` |  |
| `tnjy.js` | 天牛旧衣服回收签到 | `34 8 * * *` |  |
| `trsj.js` | 甜润世界签到 | `5 9,12,20 * * *` |  |
| `tslj.js` | 谢瑞麟小程序签到 | `30 9 * * *` |  |
| `txdt.js` | 腾讯地图 | `18 8 * * *` |  |
| `txq.js` | 汤星球 | `47 8 * * *` |  |
| `wanjiale.js` | 万家乐会员俱乐部 | `36 8 * * *` |  |
| `wanyazhenxuan.js` | 丸丫甄选签到 | `18 8 * * *` |  |
| `wb.js` | 花生帮粉丝俱乐部签到任务 | `41 8 * * *` |  |
| `wph.js` | 唯品会签到 | `40 7,19 * * *` |  |
| `wps.js` | WPS | `40 8 * * *` |  |
| `wrn.js` | 薇诺娜签到 | `41 8 * * *` |  |
| `wugenvboshi.js` | 五个女博士微信小程序签到 | `30 8 * * *` |  |
| `wuyingyundiannao.py` | 无影云电脑签到 | `40 9 * * *` |  |
| `wx_xlxyh.js` | 骁龙骁友会 | `20 9 * * *` |  |
| `wxzf.js` | 提现笔笔省领券 | `12 11 * * *` |  |
| `wzy.js` | 喂自由签到 | `16 10 * * *` |  |
| `xchy.js` | 携程会员签到 | `24 7,19 * * *` |  |
| `xiaodangjia.js` | 小铛家 | `32 8 * * *` |  |
| `xinxianghui.py` | 芯享会签到 | `20 9 * * *` |  |
| `xmsq.js` | 小米社区签到 | `15 8 * * *` |  |
| `xzyy.js` | 小紫有约签到 | `35 8 * * *` |  |
| `ydyc.js` | 优点云创 | `24 8 * * *` |  |
| `yichengtong.js` | 衣城通 | `20 8 * * *` | 需手工变量 |
| `yingshujufeng.js` | 影视飓风小程序签到 | `28 8 * * *` |  |
| `yipiaoda.js` | 华润壹票达 | `44 8 * * *` |  |
| `yjlxh.js` | 伊家乐享会 | `42 8 * * *` |  |
| `ykb_all.js` | ykb_huiyuan统一签到 | `45 8 * * *` |  |
| `youzan.js` | 有赞通用签到 | `15 8 * * *` |  |
| `ytb2_all.js` | 视软ytb2统一签到 | `50 8 * * *` |  |
| `yuexihui.js` | 中粮悦喜荟 | `30 8 * * *` |  |
| `yunduodingding.js` | 云朵叮叮微信小程序签到 | `30 8 * * *` |  |
| `yz19.js` | tuoluzhe拓路者小程序签到 | `27 8 * * *` |  |
| `yz9d.js` | 戴可思小程序签到 | `25 8 * * *` |  |
| `yzyj.js` | 微盟会员签到 | `45 8 * * *` |  |
| `zbs.js` | 植白说小程序 | `30 8 * * *` |  |
| `zippo.js` | zippo会员 | `44 8 * * *` |  |
| `ztkd.js` | 中通快递 | `20 8 * * *` |  |
| `提现免费券.py` | 提现免费券 | `12 9 * * *` |  |

> 本清单由 `node tools/yyb-convert/gen-manifest.js` 依据脚本头部的 `name`/`cron` 元数据生成。
> 新建青龙任务时用 YYB-Go 的 `yyb-scriptctl.sh install 脚本名`（脚本头部已有 `cron` 时可省略 `--cron`）。
