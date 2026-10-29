# dsh-companion-phone（手机）

让她能摸你的安卓手机：截图看屏幕、点按、滑动、打字、开 App；还能“看”手机上放的直播、视频（截图 + 录音 + 转文字）。
你在 QQ 里让她“帮我看看手机上微信有没有新消息”，她就自己用 adb 去看。

## 她多了什么

- **手机控制**：插件带了一个命令行工具 `phone/phone.mjs`（截图、读界面文字和坐标、按文字找按钮并点、点坐标、滑动、输入文字、按键、打开 App、亮屏解锁），
  装上后写进模型工作目录的 `AGENTS.md`，她干活时自己会用。
- **手机上的红线**（`phone/guard.mjs`）：发给手机的每条命令先过一遍，打电话、发短信 / 替人发消息的 intent、装卸应用、清数据、改系统设置、删文件、重启，
  参数里夹 `; | & $` 想顺带跑别的命令的，`find --tap` 点“转账”“支付”“拨打”“卸载”这类按钮的，一律不执行，打印“不执行——原因”（退出码 3）。
  `AGENTS.md` 里也告诉她：手机只听主人的、只在主人私聊里弄，要发消息先问主人，只用 `phone.mjs`，碰到红线别绕。
- **手机看门狗**：她这一轮真的动了手机、用着用着手机黑屏或锁屏了，就悄悄解开（有 PIN 会自动输）；解不开才跟你说一声。平时聊天手机锁着不碰。
- **看手机直播**：手机截几张图，同时用电脑麦克风录手机外放的声音，用本地 Whisper 转成文字（`live/phone_live.py`）。
- **看电脑上的直播**：截电脑屏幕 + 录电脑放出来的声音再转文字（`live/live.py`，只支持 Windows）。`watch` 打开直播间时单独开一个 Edge 窗口
  （临时配置，不碰你开着的 Edge），看完只关它自己开的那个；Edge 先找 Program Files，再找 x86、用户目录、注册表。
- 看手机 / 看直播一次最多 90 秒（`--seconds` 写多了截到 90）；转文字只用本地模型，没有就报中文错误，不去网上下。
- 装了“她自己的生活”插件并开着自己找事做时，她无聊了也可能自己“玩会儿手机”。

## 安装

先装本体（dsh-companion-core），再装这个：

```bash
dsh plugin --profile web add github:yzs6615/dsh-companion-plugins#phone
```

用桌面版把 `web` 换成 `desktop`（先完全退出桌面版）。也可以到
[Releases](https://github.com/yzs6615/dsh-companion-plugins/releases) 下载 `dsh-companion-phone-<版本>.tgz`，
`dsh plugin --profile web add <文件路径>`。装好、卸掉后重启 DSH。卸载：`dsh plugin --profile web remove dsh-companion-phone`。

要准备的：

- **adb**（Android platform-tools）：放进 PATH，或者在 `.env` 里用 `ADB` 写路径。手机打开 USB 调试，连上电脑并点“允许调试”。
- 要输中文：手机上装 ADBKeyboard。
- 看直播要 Python，装 `numpy`、`soundcard`、`Pillow`、`faster-whisper`，还要本地的 Whisper 模型（`.env` 的 `WHISPER_MODEL_DIR`，下面要有 `base/model.bin`）。
  不会自己去网上下模型。
- 这些要在真实的桌面会话里跑；DSH 开着沙箱（只读 / 只能写工作目录）时 adb、录音起不来。

## 设置（.env）

写在本体的 `.env` 里（默认 `$DSH_HOME/companion/.env`），改完重启 DSH。

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PHONE_MONITOR` | 开 | 手机看门狗 |
| `ADB` | 空 | adb 的路径；不写就先找插件目录下的 `tools/platform-tools`，再用 PATH 里的 `adb` |
| `ANDROID_SERIAL` | 空 | 连了好几台设备时指定用哪台 |
| `PHONE_PIN` | 空 | 手机锁屏 PIN，解锁时自动输；不填就只亮屏上滑 |
| `PHONE_SHOT_DIR` | `data/shots` | 截图存哪 |
| `WHISPER_MODEL_DIR` | 空 | 看直播时转文字用的本地模型目录（下面放 `<大小>/model.bin`，或者直接就是放 `model.bin` 的目录）；没设先找 `<COMPANION_HOME>/tools/whisper-models`，再找插件目录下的 `tools/whisper-models` |

## 跟别的插件的关系

- 只用本体的东西，不依赖别的插件。
- 她自己的生活（life）：装了这个插件，“自己找事做”才会挑“玩手机”。

## 注意

- **她能操作你的手机。** 只有主人私聊时她才有权限动手（本体的权限分级：别人私聊、群里都只读），提示词里也告诉她手机只听主人的。
  手机上有隐私的话别装这个插件，或者用完拔掉数据线。
- **PIN 是明文写在 `.env` 里的**，别把 `.env` 发给别人。
- 截图、录音、转写都存在本机数据目录（`data/shots/`、`data/live/`），里面可能有你手机上的私人内容。
- 录直播的声音只给她自己“看”用，别拿去传播。
- 不联网（手机、Whisper 都在本机）；她看到的内容会交给模型，按聊天花模型额度。

## 许可证

MIT
