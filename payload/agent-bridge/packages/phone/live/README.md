# 看直播 / 看手机

两个脚本，都是「截图 + 录音 + Whisper 转文字」。机器人跑它们时数据放在数据目录（`BRIDGE_DATA`，默认 `COMPANION_HOME/data`）下的 `live/`；
自己手动跑没设 `BRIDGE_DATA` 时放在插件目录的 `data/live/`。下面的命令在这个插件的目录里跑。

## 看手机（B 站 App / 直播）

```bat
python live\phone_live.py shot
python live\phone_live.py watch --seconds 60 --shots 6
python live\phone_live.py rec 30
python live\phone_live.py asr 某段录音.wav --model base
```

- 截图走 `adb exec-out screencap`，手机要开 USB 调试并授权
- 声音：电脑**麦克风**录手机外放（手机音量尽量大；环境安静效果最好）
- 转写：本地 faster-whisper，中文，CPU
- 输出：`live/phone-<时间戳>/`，含 `shot-1.png...`、`audio.wav`、`transcript.txt`、`meta.json`

## 看电脑上的直播（网页版）

```bat
python live\live.py watch "https://live.bilibili.com/房间号" --seconds 60 --shots 3
python live\live.py shot
python live\live.py rec 30
```

- 单独开一个 Edge 窗口（临时配置，不碰你自己开着的 Edge）打开直播间并最大化，看完把这个窗口关掉
- Edge 先找 Program Files，再找 x86、用户目录、注册表
- 声音：系统 loopback（`soundcard`），不用麦克风
- 输出同上，目录 `live/<时间戳>/`

## 模型

只用本地的 faster-whisper 模型，绝不自己去网上下。自己下好 CTranslate2 格式的模型（比如 `base` 约 138MB），
放成 `<目录>/base/model.bin` 这样，再在 `.env` 里写 `WHISPER_MODEL_DIR=<目录>`；没设时先找 `<COMPANION_HOME>/tools/whisper-models/`（本体的 `kernel/scripts/fetch-whisper.mjs` 没设 WHISPER_MODEL_DIR 时下到这），再找插件目录下的 `tools/whisper-models/`。
换别的大小（`small` 更准、更慢）就多放一个 `<目录>/small/`，命令里加 `--model small`。
只用本地模型（`local_files_only`），找不到 `<大小>/model.bin` 就报中文错误，不会去网上下；`WHISPER_MODEL_DIR` 也可以直接指到放 `model.bin` 的那个目录。

## 注意

- 一次最多看/录 90 秒，`--seconds` 写多了会截到 90。
- 要在真实的桌面会话里跑：沙箱里 adb daemon 起不来（`CreatePipe failed`），soundcard 也要真实会话。
- 手机外放录音受音量、环境噪音影响，识别率不如内录；要更清楚可以手机投屏到电脑（scrcpy / Windows 手机连接）再用 loopback。
- 空音频、静音会返回空文本，不是坏了。
