// name: stokke小程序
/*
------------------------------------------
@Author: sm
@Date: 2024.06.07 19:15
@Description:  
cron: 30 9 * * 1
------------------------------------------
#Notice:   
stokke 微信小程序 每周签到得积分 
变量名称：stokke
⚠️【免责声明】
------------------------------------------
1、此脚本仅用于学习研究，不保证其合法性、准确性、有效性，请根据情况自行判断，本人对此不承担任何保证责任。
2、由于此脚本仅用于学习研究，您必须在下载后 24 小时内将所有内容从您的计算机或手机或任何存储设备中完全删除，若违反规定引起任何事件本人对此均不负责。
3、请勿将此脚本用于任何商业或非法目的，若违反规定请自行对此负责。
4、此脚本涉及应用与本人无关，本人对因此引起的任何隐私泄漏或其他后果不承担任何责任。
5、本人对任何脚本引发的问题概不负责，包括但不限于由脚本错误引起的任何损失和损害。
6、如果任何单位或个人认为此脚本可能涉嫌侵犯其权利，应及时通知并提供身份证明，所有权证明，我们将在收到认证文件确认后删除此脚本。
7、所有直接或间接使用、查看此脚本的人均应该仔细阅读此声明。本人保留随时更改或补充此声明的权利。一旦您使用或复制了此脚本，即视为您已接受此免责声明。
 YYB-Go 版：取码改走 YYB-Go（POST /wxapp/getCode），不再依赖原取码桥接服务。
 变量：YYB_SERVER 每行 地址@账号标识（例如 http://yyb-go:8000@1）；YYB_API_KEY 可选。
 原桥接版脚本见 wxapp/stokke.js，业务接口、流程与缓存格式均未改动。
*/

const {
    Env
} = require("../tools/env")
const $ = new Env("stokke小程序");
const { YYBClient, yybAccounts } = require("./yyb.js");
const strSplitor = "#";
const axios = require("axios");
const defaultUserAgent = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.31(0x18001e31) NetType/WIFI Language/zh_CN miniProgram"
let yyb = new YYBClient({ appid: 'wxe232c36aaca3dc1a' });

class Task {
    constructor(env) {
        this.index = $.userIdx++
        this.user = env.split(strSplitor);
        this.token = null
        this.wcsid = this.user[0]
        this.isSign = false
    }

    /** 取 wx.login code：YYB-Go /wxapp/getCode（一个账号一次请求，失败即抛错） */
    async run() {
        return yyb.getCode(this.wcsid);
    }
    async getUserToken(code) {
        let data = ({
            "code": code,
            "spread_spid": 0,
            "type": "routine",
            "inviteCode": "",
            "inviteTime": ""
        });

        let options = {
            method: 'POST',
            url: 'https://www.stokkeshop.cn/api/front/wechat/authorize/program/login?code=' + code,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781 NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF XWEB/50249',
                'Content-Type': 'application/json',
                'xweb_xhr': '1',
                'Authori-zation': '',
                'Sec-Fetch-Site': 'cross-site',
                'Sec-Fetch-Mode': 'cors',
                'Sec-Fetch-Dest': 'empty',
                'Referer': 'https://servicewechat.com/wxe232c36aaca3dc1a/54/page-frame.html',
                'Accept-Language': 'zh-CN,zh;q=0.9'
            },
            data: data
        };

        let {
            data: result
        } = await axios.request(options);

        if (result?.code == '200') {
            this.token = result.data.token
            $.log(`🌸账号[${this.index}] 获取用户Token成功:${this.token}`)
        } else {
            $.log(`🌸账号[${this.index}] 获取用户Token-失败:${result.message}❌`)
        }
    }
    async getUserInfo() {
        let options = {
            method: 'GET',
            url: `https://www.stokkeshop.cn/api/front/user`,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781 NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF XWEB/50249',
                'Content-Type': 'application/json',
                'xweb_xhr': '1',
                'Authori-zation': '' + this.token + '',
                'Sec-Fetch-Site': 'cross-site',
                'Sec-Fetch-Mode': 'cors',
                'Sec-Fetch-Dest': 'empty',
                'Referer': 'https://servicewechat.com/wxe232c36aaca3dc1a/54/page-frame.html',
                'Accept-Language': 'zh-CN,zh;q=0.9'
            }
        }
        let {
            data: result
        } = await axios.request(options);
        if (result?.code == '200') {
            //打印签到结果
            $.log(`🌸账号[${this.index}]` + `[${result.data.nickname}] 积分[${result.data.integral}]🎉`);

        } else {
            $.log(`🌸账号[${this.index}] 获取用户信息-失败:${result.message}❌`)
        }
    }

    async doSign() {
        let options = {
            method: 'POST',
            url: `https://www.stokkeshop.cn/api/front/integral-task/finishWeekSign`,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781 NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF XWEB/50249',
                'Content-Type': 'application/json',
                'xweb_xhr': '1',
                'Authori-zation': '' + this.token + '',
                'Sec-Fetch-Site': 'cross-site',
                'Sec-Fetch-Mode': 'cors',
                'Sec-Fetch-Dest': 'empty',
                'Referer': 'https://servicewechat.com/wxe232c36aaca3dc1a/54/page-frame.html',
                'Accept-Language': 'zh-CN,zh;q=0.9'
            },
            data: {}
        };
        let {
            data: result
        } = await axios.request(options);

        if (result?.code == '200') {
            //打印签到结果

            $.log(`签到成功 🎉`);
        } else {
            $.log(`🌸账号[${this.index}] 签到-失败:${result.message}❌`)
        }




    }








}

!(async () => {
    await getNotice()
    let accounts;
    try { accounts = yybAccounts(); } catch (e) { $.log(`❌ ${e.message || e}`); return; }
    $.log(`共找到${accounts.length}个YYB账号`);
    for (let user of accounts) {
        await new Task(user).run();
    }

})()
    .catch((e) => console.log(e))
    .finally(() => $.done());

async function getNotice() {
    try {
        let options = {
            url: `https://ghproxy.net/https://raw.githubusercontent.com/smallfawn/Note/refs/heads/main/Notice.json`,
            headers: {
                "User-Agent": defaultUserAgent,
            },
            timeout: 3000
        }
        let {
            data: res
        } = await axios.request(options);
        $.log(res)
        return res
    } catch (e) { }

}
