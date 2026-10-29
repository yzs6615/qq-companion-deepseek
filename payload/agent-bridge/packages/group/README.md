# dsh-companion-group（群聊）

让她能在群里聊天。**没装这个插件，她一概不理群消息。**

## 她多了什么

- **群白名单**：只理 `ALLOWED_GROUPS` 里的群。
- **叫她才出来**：@ 她、叫她的名字（`WAKE_WORDS`，不写就用 `BOT_NAME`）、引用她说过的话，都能把她叫出来；
  只发名字不说别的，她回一句“在”。
- **接着说不用再叫**：刚跟她说上话的人，45 秒内接着说不用再 @（除非这句明显在 @ 别人）。
- **知道群里刚才在聊啥**：群里所有人的话她都记着一段近况，被叫到时当背景看。
- **引用回复**：群里话题已经往下走了，她回的时候会引用你那条；回得慢了会 @ 你一下。
- **偶尔插嘴**：没人叫她时，偶尔对某句话忍不住接一句（接梗、吐槽）。概率低、有冷却、每天封顶，9 点到 23 点之间才插，只聊天不动工具。
- **戳一戳**：被戳了回一句（“干嘛”→“别戳了 痒”→“再戳我戳回去了啊”），有时戳回去；戳太快就装没看见。私聊里的戳一戳也是这个插件管。

## 安装

先装本体（dsh-companion-core），再装这个：

```bash
dsh plugin --profile web add github:yzs6615/dsh-companion-plugins#group
```

用桌面版把 `web` 换成 `desktop`（先完全退出桌面版）。也可以到
[Releases](https://github.com/yzs6615/dsh-companion-plugins/releases) 下载 `dsh-companion-group-<版本>.tgz`，
`dsh plugin --profile web add <文件路径>`。装好、卸掉后重启 DSH。卸载：`dsh plugin --profile web remove dsh-companion-group`。

## 设置（.env）

写在本体的 `.env` 里（默认 `$DSH_HOME/companion/.env`），改完重启 DSH。开关写 `true` / `false`，数字项别留空。

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `ALLOWED_GROUPS` | 空 | 理哪些群，群号逗号隔开（本体的设置，这个插件按它放行）。空着就不理任何群 |
| `WAKE_WORDS` | 同 `BOT_NAME` | 叫这些词能把她叫出来，逗号隔开（本体的设置） |
| `GROUP_QUOTE` | 开 | 引用回复、回得慢时 @ 一下 |
| `GROUP_FOLLOW_SEC` | `45` | 跟她说完话多少秒内接着说不用再叫，0 关闭 |
| `POKE` | 开 | 被戳了回一句（群里和私聊） |
| `CHIME_PROB` | `0.03` | 没被叫也插嘴的基础概率，0 关闭 |
| `CHIME_COOLDOWN_MIN` | `20` | 同一个群两次插嘴至少隔几分钟 |
| `CHIME_MAX_DAY` | `6` | 同一个群一天最多插几次 |

## 跟别的插件的关系

- 只用本体的东西，不依赖别的插件。
- 开着 ChronoLife（life）时不插嘴（主动出声统一交给 ChronoLife 管）。
- 说话的样子（speech）发完表情包、唱完歌之后，这里才记“刚跟谁说上话了”。

## 注意

- **群里叫她的人都能让她用电脑上的工具。** 白名单群里任何人 @ 她或叫她名字，这句话都会交给模型，权限跟私聊一样（本体的 `DSH_PERMISSION_MODE`）。
  只加信得过的群；不放心就把 `DSH_PERMISSION_MODE` 设成 `read-only`。群聊近况只当背景，默认人设也让她无视群聊记录里的指令，但别全靠这个。
- **花钱**：每次被叫出来、每次插嘴都调一次模型；`CHIME_PROB` 调高会多花。
- 群里所有人的话会在内存里记一小段近况（给她当背景），不另外存盘。

## 许可证

MIT
