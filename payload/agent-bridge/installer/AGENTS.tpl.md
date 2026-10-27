# 本机 Agent 速查

这个工作区是一个 QQ 机器人（{{NAME}}）：`agent-bridge/bridge.mjs` 把 QQ 消息转给 `dsh --profile headless`，
每条聊天用 `--session-id` 续接。下面是你能用的工具。

## 看图

QQ 发来的图片会被下载到 `agent-bridge/data/images/`，绝对路径会附在消息里。
用 `read_image` 工具直接看（PNG/JPEG/WebP/GIF），别用 pwsh/OCR 去硬解。

<!-- if:bili -->
## 刷 B站

想刷 B站、看某个视频讲了啥，用这个（读得比截图准）：

```bat
node agent-bridge/bili/bili.mjs hot 10                 :: 热门
node agent-bridge/bili/bili.mjs rank 10                :: 全站排行
node agent-bridge/bili/bili.mjs search 关键词 --n 8     :: 搜索（--order click 按播放 / pubdate 按最新）
node agent-bridge/bili/bili.mjs watch BV号或链接        :: 简介、标签、弹幕刷得最多的、热评
node agent-bridge/bili/bili.mjs watch BV号 --listen 3   :: 再用本地 Whisper 听前 3 分钟讲了啥（要装“听声音”）
node agent-bridge/bili/bili.mjs watch BV号 --frames     :: 再看画面：挑弹幕最密的时刻和换镜头的地方截图，用 read_image 一张张看
node agent-bridge/bili/bili.mjs seen                   :: 最近看过的
```

- 列表里标了“（看过）”的就别再看了，换一个。
- 看画面时对照“时间轴”：标了“弹幕高峰”的格子是观众反应最大的地方，配着那里刷的弹幕一起看。
- 说“B站说刷太快了（风控）”就别再刷，干点别的。
- 不会发评论、点赞、投币，也不登录别人的账号。
<!-- end -->

<!-- if:sing -->
## 学新歌

被叫去学一首歌：先 `bili.mjs search 歌名` 找个音质好的完整版，然后：

```bat
node agent-bridge/sing/learn.mjs start --title 歌名 --artist 歌手 --bv BV号 --seg 104-134   :: 在后台学，马上返回
node agent-bridge/sing/learn.mjs status 歌名                                                :: 学到哪一步了
```

- 一段 30 秒要 5 分钟左右，比一轮聊天长得多。**只能用 learn.mjs**，别直接跑 `sing/render.py`，也别用后台 job 或者等 job：
  这一轮一结束，它们就会被一起杀掉。
- `--seg 起-止`（秒）挑副歌，30 秒左右，可以写好几个 `--seg`。有歌词就加 `--lyrics 歌词.json`（`{"lines":[{"start","end","text"}]}`）。
- start 完就跟对方说一句“在学了，过几分钟”，然后结束这一轮，别干等。对方再问就看 `status`。
- 学好的歌会出现在“你学会唱的歌”里，到时候写 `[唱歌:歌名]`。同一时间只能学一首。
<!-- end -->

<!-- if:autonomy -->
## 刷别的（知乎、微博、听歌、看番）

除了 B站，自己找事做时也可以刷这些（都不用登录）：

```bat
node agent-bridge/life/life.mjs zhihu 15              :: 知乎热榜：问题、热度、摘要（回答要登录看不了）
node agent-bridge/life/life.mjs weibo 20              :: 微博热搜
node agent-bridge/life/life.mjs music 飙升             :: 网易云榜单：飙升 / 热歌 / 新歌 / 原创
node agent-bridge/life/life.mjs song 晴天              :: 一首歌的歌词 + 网易云热评（歌名或 id）
node agent-bridge/life/life.mjs anime                 :: 今天更新的新番（anime 这周 看这周的）
node agent-bridge/life/life.mjs anime-rank            :: 番剧排行
node agent-bridge/life/life.mjs anime-watch season_id :: 追一部番：简介、评分、最新一集、弹幕、热评
node agent-bridge/life/life.mjs seen                  :: 最近看过的
```

- 标了“（看过）”的就换一个。番剧画面大多要会员，看弹幕和评论就行。
- 刷到有意思的可以记进日记，想分享就跟对方说一两句。

<!-- end -->

<!-- if:phone -->
## 手机控制

用 `agent-bridge/phone/phone.mjs`（依赖 `tools/platform-tools/adb.exe`，手机要开 USB 调试）：

```bat
node agent-bridge/phone/phone.mjs devices
node agent-bridge/phone/phone.mjs shot          :: 截图到 agent-bridge/data/shots/
node agent-bridge/phone/phone.mjs dump          :: 界面文字 + 坐标
node agent-bridge/phone/phone.mjs find 微信 --tap
node agent-bridge/phone/phone.mjs tap 540 1600
node agent-bridge/phone/phone.mjs text "你好"
```

看手机的最快流程：`shot` 截图 → 用读图能力看 `agent-bridge/data/shots/shot-*.png`
→ 决定坐标 → `tap` / `swipe`。中文输入需要手机上装 ADBKeyboard。

截图全黑、点哪都没反应时，先 `node agent-bridge/phone/phone.mjs status`。
返回 `locked:true` 或 `screen:off` 就 `node agent-bridge/phone/phone.mjs unlock`；
`.env` 里有 `PHONE_PIN` 会自动输 PIN。解不开就直接问对方，不要对着黑屏反复点。
<!-- end -->

<!-- if:listen -->
## 看直播 / 听声音

电脑网页直播（Edge + 系统声音 loopback）：

```bat
python agent-bridge/live/live.py capture --seconds 60 --shots 3
python agent-bridge/live/live.py watch "https://live.bilibili.com/房间号" --seconds 60
```

`capture` 不打开浏览器，直接截当前屏幕 + 录系统声音，适合“看我现在看的直播”。

<!-- if:phone -->
手机截图 + 麦克风录音 + Whisper 转文字：

```bat
python agent-bridge/live/phone_live.py watch --seconds 60 --shots 6
python agent-bridge/live/phone_live.py asr agent-bridge/data/live/xxx.wav --model base
```
<!-- end -->

本地语音识别模型在 `tools/whisper-models/base`。
<!-- end -->
