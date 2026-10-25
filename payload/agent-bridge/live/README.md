# 看直播 / 看手机

两个脚本，都是「截图 + 录音 + Whisper 转文字」，输出到 `data/live/`。

## 看手机（B 站 App / 直播）

```bat
python live\phone_live.py shot
python live\phone_live.py watch --seconds 60 --shots 6
python live\phone_live.py rec 30
python live\phone_live.py asr data\live\xxx.wav --model base
```

- 截图走 `adb exec-out screencap`，手机要开 USB 调试并授权
- 声音：电脑**麦克风**录手机外放（手机音量尽量大；环境安静效果最好）
- 转写：本地 faster-whisper `base`，中文，CPU
- 输出：`data/live/phone-<时间戳>/`，含 `shot-1.png...`、`audio.wav`、`transcript.txt`、`meta.json`

## 看电脑上的直播（网页版）

```bat
python live\live.py watch "https://live.bilibili.com/12345" --seconds 60 --shots 3
python live\live.py shot
python live\live.py rec 30
```

- 用 Edge 打开直播间并最大化
- 声音：系统 loopback（`soundcard`），不用麦克风
- 输出同上，目录 `data/live/<时间戳>/`

## 模型

`tools/whisper-models/base/`（约 138MB，已从 ModelScope 下载）。
换 small：`node scripts/fetch-whisper.mjs small`，然后 `--model small`（更准、更慢）。

## 注意

- 这些命令要在**桌面**跑：沙箱里 adb daemon 起不来（`CreatePipe failed`），
  soundcard 也需要真实会话。
- 手机外放录音受音量/环境噪音影响，识别率不如内录；要更清楚可以手机投屏到电脑
  （scrcpy/Windows 手机连接）再用 loopback。
- 空音频/静音会返回空文本，不是坏了。
