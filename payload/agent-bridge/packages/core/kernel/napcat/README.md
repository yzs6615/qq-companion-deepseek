# NapCat 部署备忘

本体通过 NapCat（OneBot 11 的正向 WebSocket）连 QQ。NapCat 按它自己的说明装（Windows 上用 NapCat.Shell），
这个目录只放一个帮忙写 NapCat 配置的脚本。

## 启动

1. 托盘退出正在运行的 QQ。
2. 按 NapCat 的说明启动它（Windows 上一般是 NapCat 目录里的 `launcher.bat`：从注册表找 QQ，要管理员权限）。
   DSH 的沙箱里启动会 `spawn EPERM`，要在桌面上双击。
3. UAC 点“是”，等 QQ 窗口出现，用手机扫码。
4. 登录后 NapCat 控制台会打印 WebUI 地址（默认 `http://127.0.0.1:6099`）和 token。

## 配置

`node napcat/setup-onebot.mjs [QQ号]`（在本体的 `kernel` 目录里跑）会写 `config/onebot11.json`（模板）和
`config/onebot11_<QQ号>.json`，内容是一个监听 `127.0.0.1:3001` 的正向 WebSocket 服务，
token 同步写进 `<COMPANION_HOME>/.env` 的 `ONEBOT_TOKEN` 那一行（装进 DSH 后 COMPANION_HOME 是 `$DSH_HOME/companion`，
见根目录 README 的“设置”；跑脚本前把这个环境变量设上，没设就写内核目录里的 `.env`）。改完重启 DSH。

脚本默认找本体目录下的 `tools/napcat/app/napcat/config`；NapCat 装在别处（比如用 OneKey 装的），
用 `NAPCAT_CONFIG_DIR` 指到它的 `config` 目录再运行。端口用 `ONEBOT_PORT` 改，token 用 `ONEBOT_TOKEN` 指定（不写就随机生成）。

## 风控提示

NapCat 属于第三方协议端，不是腾讯官方机器人。用主号有被封/冻结的风险，
建议用**不常用的小号**，不要群发、不要高频自动回复。
