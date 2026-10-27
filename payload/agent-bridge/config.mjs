/**
 * bridge 的配置：读 agent-bridge/.env（已在环境变量里的优先），算出 cfg。
 * bridge.mjs 和 scripts/features.mjs（功能与机制页）共用这一份，默认值只写在这里。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.dirname(fileURLToPath(import.meta.url));

// ── .env loading (no dependencies) ────────────────────────────────────────
function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadEnv(path.join(ROOT, '.env'));

export const env = process.env;
export const cfg = {
  wsUrl: env.ONEBOT_WS || 'ws://127.0.0.1:3001',
  token: env.ONEBOT_TOKEN || '',
  allowedQQ: parseList(env.ALLOWED_QQ),
  allowedGroups: parseList(env.ALLOWED_GROUPS),
  dshCli: env.DSH_CLI || guessDshCli(),
  dshHome: env.DSH_HOME || path.join(ROOT, '.dsh-home'),
  agentCwd: env.AGENT_CWD || path.resolve(ROOT, '..'),
  apiKey: env.DEEPSEEK_API_KEY || '',
  permissionMode: env.DSH_PERMISSION_MODE || '',
  timeoutMs: Number(env.SESSION_TIMEOUT_MS || 300_000),
  maxPrompt: Number(env.MAX_PROMPT_CHARS || 6000),
  ackPrivate: (env.ACK_PRIVATE || 'false') !== 'false',
  maxAgeSec: Number(env.MAX_MESSAGE_AGE_SEC || 120),
  personaFile: env.PERSONA_FILE || path.join(ROOT, 'persona.md'),
  humanSplit: (env.HUMAN_SPLIT || 'true') !== 'false',
  botName: env.BOT_NAME || '小鱼', // 启动器 / 状态窗口 / 功能页上显示的名字
  wakeWords: parseList(env.WAKE_WORDS || env.BOT_NAME || '小鱼'),
  memoryEnabled: (env.MEMORY || 'true') !== 'false',
  proactive: (env.PROACTIVE || 'false') === 'true',
  proactiveQQ: parseList(env.PROACTIVE_QQ || ''),
  proactiveMax: Number(env.PROACTIVE_MAX || 2),
  proactiveIdleHours: Number(env.PROACTIVE_IDLE_HOURS || 8),
  phoneMonitor: (env.PHONE_MONITOR || 'true') !== 'false',
  autonomy: (env.AUTONOMY || 'false') === 'true',
  autonomyMinutes: Number(env.AUTONOMY_MINUTES || 45), // 两次自己玩之间至少隔多久
  autonomyMax: Number(env.AUTONOMY_MAX || 8), // 一天最多自己玩几次
  autonomyRollProb: Number(env.AUTONOMY_ROLL_PROB ?? 0.35), // 每小时掷骰子“想不想玩”的基础概率（再按心情/精神调）
  autonomyIdleMin: Number(env.AUTONOMY_IDLE_MIN ?? 20), // 对方这么多分钟内找过它，这小时就不自己玩（在陪人聊呢）
  proactiveLLM: (env.PROACTIVE_LLM || 'true') !== 'false',
  // ChronoLife旁存时间线；不开启时沿用旧行为。
  chronolife: env.CHRONOLIFE === 'true',
  chronolifeTimezone: env.CHRONOLIFE_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai', // 没填就用电脑的时区
  chronolifeTickMinutes: Number(env.CHRONOLIFE_TICK_MINUTES || 30),
  chronolifeProactive: env.CHRONOLIFE_PROACTIVE === 'true',
  chronolifeCheckMs: Number(env.CHRONOLIFE_CHECK_MS || 0), // 测试用：bridge 多久看一次（不填就按 CHRONOLIFE_TICK_MINUTES）
  // ── 拟人行为 ──
  mergeMs: Number(env.MERGE_MS ?? 5000), // 连发合并：对方停这么久没再发才回（手机打字一句要好几秒），0 关闭
  mergeMaxMs: Number(env.MERGE_MAX_MS ?? 15_000),
  busyNoteMs: Number(env.BUSY_NOTE_MS ?? 45_000), // 上一轮忙了这么久还没回完、对方又来消息，才说一句“手上还有一个 等我下”（一轮最多一次）
  typingMsPerChar: Number(env.TYPING_MS_PER_CHAR ?? 130), // 0 关闭打字延迟
  inputStatus: (env.INPUT_STATUS || 'true') !== 'false', // 让对方看到“正在输入”
  markRead: (env.MARK_READ || 'true') !== 'false',
  sleepStart: Number(env.SLEEP_START ?? 1),
  sleepEnd: Number(env.SLEEP_END ?? 7),
  sleepDelayProb: Number(env.SLEEP_DELAY_PROB ?? 0.5), // 睡觉时段慢回的概率，0 关闭
  typoProb: Number(env.TYPO_PROB ?? 0.04),
  facts: (env.FACTS || 'true') !== 'false',
  factsEvery: Number(env.FACTS_EVERY ?? 6),
  followup: (env.FOLLOWUP || 'true') !== 'false',
  groupQuote: (env.GROUP_QUOTE || 'true') !== 'false',
  groupFollowSec: Number(env.GROUP_FOLLOW_SEC ?? 45), // @ 过之后，同一个人接着说不用再 @
  poke: (env.POKE || 'true') !== 'false',
  react: (env.REACT || 'true') !== 'false', // “嗯嗯/哈哈”点表情回应，不调模型
  reactProb: Number(env.REACT_PROB ?? 0.7),
  followupHours: (env.FOLLOWUP_HOURS || '9-22').split('-').map(Number), // 回访只在这个时段
  followupCheckMs: Number(env.FOLLOWUP_CHECK_MS ?? 120_000),
  followupIdleSec: Number(env.FOLLOWUP_IDLE_SEC ?? 180), // 对方刚说完话这么久之内不回访，免得打断
  greetings: (env.GREETINGS || 'true') !== 'false', // 早安/晚安/久未联系的冒泡
  chimeProb: Number(env.CHIME_PROB ?? 0.03), // 群里没被叫也插嘴的基础概率，0 关闭
  chimeCooldownMin: Number(env.CHIME_COOLDOWN_MIN ?? 20),
  chimeMaxDay: Number(env.CHIME_MAX_DAY ?? 6),
  learnStyle: (env.LEARN_STYLE || 'true') !== 'false', // 学对方的口头禅/说话习惯（跟长期事实一起提炼，不多花调用）
  stealStickers: (env.STEAL_STICKERS || 'true') !== 'false', // 对方发的表情包，觉得好玩就收进自己的表情库
  stealMax: Number(env.STEAL_MAX ?? 40), // 每种情绪最多留几张收来的
  ignoreLimit: Number(env.IGNORE_LIMIT ?? 2), // 主动找了几次都没回，就先不找了（等对方开口）
  sulk: (env.SULK || 'true') !== 'false', // 被冷落后对方再开口，第一句带点小情绪
  sulkAfterMin: Number(env.SULK_AFTER_MIN ?? 120), // 主动消息发出后隔多久才回算“被冷落”
  reflect: (env.REFLECT || 'true') !== 'false', // 生活 → 反思 → 人设成长
  mimic: (env.MIMIC || 'true') !== 'false', // 合并转发聊天记录给它，学某个人的说话风格
  mimicRampDays: Number(env.MIMIC_RAMP_DAYS ?? 14), // 多少天学到位（慢慢带进语气）
  // 语音：阿里云百炼 CosyVoice 复刻音色。填了 VOICE_ID + DASHSCOPE_API_KEY 才会开
  voice: (env.VOICE || 'true') !== 'false' && !!env.VOICE_ID && !!env.DASHSCOPE_API_KEY,
  voiceId: env.VOICE_ID || '',
  voiceModel: env.VOICE_MODEL || 'cosyvoice-v3.5-flash',
  voiceMaxChars: Number(env.VOICE_MAX_CHARS ?? 60), // 超过这么多字就还是打字
  voiceMaxDay: Number(env.VOICE_MAX_DAY ?? 20), // 一天最多发几条语音（自己想发的，/说话 不算）
  voiceCutMs: Number(env.VOICE_CUT_MS ?? 0), // 句尾固定再剪掉多少毫秒（自动去杂音之外）
  voiceRate: Number(env.VOICE_RATE ?? 1), // 语速 0.5–2
  voiceEmotion: (env.VOICE_EMOTION || 'true') !== 'false', // 语音带语气：[语音:害怕] 她自己点，或者跟着有来由的心情（生气、委屈…）；开心没做
  voiceEmotionDb: Number(env.VOICE_EMOTION_DB ?? -20), // 带语气的语音最响到多少（有声部分平均 dBFS；平常的语音大约 -25）
  voiceWs: env.DASHSCOPE_WS || undefined, // 测试时指向假的合成服务
  // 唱歌：data/songs/<歌名>/ 里提前转好的片段（sing/render.py 生成），发 QQ 语音
  sing: (env.SING || 'true') !== 'false',
  singMaxDay: Number(env.SING_MAX_DAY ?? 6), // 一天最多唱几段（/唱歌 命令不算）
  // 深夜电台：点一期，她录两三分钟的语音节目（节目卡 + 推荐一首歌）。没开语音就发文字版
  radio: (env.RADIO || 'true') !== 'false',
  radioMaxDay: Number(env.RADIO_MAX_DAY ?? 6), // 一天最多录几期（重播不算）
  radioVoiceSec: Number(env.RADIO_VOICE_SEC ?? 58), // 拼成的每条语音最长几秒
  radioCollectMs: Number(env.RADIO_COLLECT_MS ?? 6000), // 投稿连发几条：最后一条之后等这么久再开录
  emotion: (env.EMOTION || 'true') !== 'false', // 心情有来由、会延续（模型写 [心情:词|为啥]）
  rhythm: (env.RHYTHM || 'true') !== 'false', // 记得对方几点睡几点起，晚睡早起会注意到
  curious: (env.CURIOUS || 'true') !== 'false', // 对对方还不了解的地方，找机会问一句
  curiousProb: Number(env.CURIOUS_PROB ?? 0.3), // 每轮聊天有多大概率提醒她（一天最多一次）
  pokeSelf: (env.POKE_SELF || 'true') !== 'false', // 偶尔主动戳对方一下
  pokeSelfProb: Number(env.POKE_SELF_PROB ?? 0.04), // 每次检查戳的概率（10 分钟看一次，约一天一次）
  pokeSelfIdleMin: Number(env.POKE_SELF_IDLE_MIN ?? 90), // 对方多久没动静才戳
  pokeSelfCheckMs: Number(env.POKE_SELF_CHECK_MS ?? 600_000),
  autonomyHours: (env.AUTONOMY_HOURS || '10-23').split('-').map(Number), // 自己找事做的时段
  autonomyRollWindowMin: Number(env.AUTONOMY_ROLL_WINDOW_MIN ?? 45), // 每小时在前多少分钟里随机掷骰子
  autonomyCheckMs: Number(env.AUTONOMY_CHECK_MS ?? 300_000),
  chase: (env.CHASE || 'true') !== 'false', // 她问了一句、对方半天没回：偶尔追一句“人呢”
  chaseProb: Number(env.CHASE_PROB ?? 0.4),
  chaseMinMin: Number(env.CHASE_MIN ?? 8), // 等多久（分钟）才追：在 CHASE_MIN ~ CHASE_MAX 之间随机
  chaseMaxMin: Number(env.CHASE_MAX ?? 25),
  chaseCheckMs: Number(env.CHASE_CHECK_MS ?? 30_000),
  recall: (env.RECALL || 'true') !== 'false', // 对方撤回：没回的那条就不回了；熟人偶尔调侃一句
  recallTeaseProb: Number(env.RECALL_TEASE_PROB ?? 0.5),
  onlineStatus: (env.ONLINE_STATUS || 'true') !== 'false', // QQ 在线状态跟着作息和心情变（睡觉中/摸鱼中/元气满满…）
  longnick: (env.LONGNICK || 'true') !== 'false', // 每晚写完日记顺手改一句个性签名
  diyStatus: (env.DIY_STATUS || 'false') === 'true', // 自定义在线状态：名字旁边写她自己的一句话（在干嘛 / 陪你听什么 / 心情），没有具体的事就用预设的
  sleepDrift: (env.SLEEP_DRIFT || 'false') === 'true', // 作息被带偏：电脑的主人最近老熬夜 / 早睡，她的睡觉时段跟着挪
  sleepDriftMax: Number(env.SLEEP_DRIFT_MAX ?? 2), // 最多被带晚几个小时（带早最多 1 小时）
  moodAvatar: (env.MOOD_AVATAR || 'false') === 'true', // 心情头像：心情变了换 QQ 头像（图放 data/avatars/，按心情起名）
  moodAvatarMaxDay: Number(env.MOOD_AVATAR_MAX_DAY ?? 4), // 一天最多换几次（换太勤小号容易被风控）
  moodAvatarGapMin: Number(env.MOOD_AVATAR_GAP_MIN ?? 90), // 两次之间至少隔多少分钟
  // 电脑室友：看得见这台电脑在放什么歌、开着什么游戏、开了多久、人在不在电脑前；只跟电脑的主人提
  pcBuddy: (env.PC_BUDDY || 'false') === 'true',
  pcOwner: env.PC_OWNER || '', // 电脑是谁的 QQ（默认 PROACTIVE_QQ 第一个）
  pcMaxDay: Number(env.PC_MAX_DAY ?? 3), // 一天最多因为电脑上的事主动说几句
  pcSongProb: Number(env.PC_SONG_PROB ?? 0.12), // 新放一首歌时顺口说一句的概率（同一首这周放到第 3 遍必说）
  pcCheckMs: Number(env.PC_CHECK_MS ?? 120_000),
  // 电脑上的她（都靠电脑室友看键盘鼠标多久没动；夜里不出声、不留条）
  quietHours: (env.QUIET_HOURS || '23-9').split('-').map(Number), // 这几个钟头不出声、不留条、不发空间
  awayMin: Number(env.AWAY_MIN ?? 120), // 键盘鼠标这么久没动、又动了，算“回来了”
  speaker: (env.SPEAKER || 'false') === 'true', // 早上第一次开电脑、离开很久又回来时，用她的声音从电脑喇叭说一句（要开语音）
  speakerMaxDay: Number(env.SPEAKER_MAX_DAY ?? 3),
  notes: (env.NOTES || 'false') === 'true', // 离开电脑好几个小时时，她在桌面留张便条，回来时弹个通知
  noteAfterMin: Number(env.NOTE_AFTER_MIN ?? 180),
  drawer: (env.DRAWER || 'false') === 'true', // 桌面上“<名字>的抽屉”：写给主人的信、明信片、现场照、梦、便条、收藏的视频都放一份
  playMusic: (env.PLAY_MUSIC || 'false') === 'true', // 用电脑上的 QQ 音乐放歌：模型写 [放歌:歌名 歌手]，主人在电脑前就直接放，不在就发链接
  playMusicMaxDay: Number(env.PLAY_MUSIC_MAX_DAY ?? 6),
  qqMusicExe: env.QQMUSIC_EXE || 'C:\\Program Files (x86)\\Tencent\\QQMusic\\QQMusic.exe',
  // 做梦：早上醒来有时记得昨晚的梦（最近的事拼的），今天第一次聊天、或者早安时顺口说
  dream: (env.DREAM || 'false') === 'true',
  dreamProb: Number(env.DREAM_PROB ?? 0.5), // 每天每个人做梦的概率
  dreamUntil: Number(env.DREAM_UNTIL ?? 12), // 睡醒（SLEEP_END）到几点之间做梦；过了这个点再三个小时就不提了
  dreamCheckMs: Number(env.DREAM_CHECK_MS ?? 600_000),
  // 现场照：问她在干嘛时，可能发一张“现在的她”（data/scene/bg 房间背景 × data/scene/pose 动作）
  photo: (env.PHOTO || 'false') === 'true',
  photoMaxDay: Number(env.PHOTO_MAX_DAY ?? 5),
  // 每周一封信：每周某天晚上给 PROACTIVE_QQ 写一封信，信纸用百炼通义万相画（要 DASHSCOPE_API_KEY，没有就用素纸）
  letter: (env.LETTER || 'false') === 'true',
  letterWeekday: Number(env.LETTER_WEEKDAY ?? 0), // 0 = 周日
  letterHour: Number(env.LETTER_HOUR ?? 21),
  letterModel: env.LETTER_IMAGE_MODEL || 'wanx2.1-t2i-turbo',
  letterCheckMs: Number(env.LETTER_CHECK_MS ?? 600_000),
  // QQ 空间说说：偶尔把自己最近干的事发一条（只写她自己的事，不写聊天内容和人名）；开着 ChronoLife 时只用它记下的虚拟事件
  qzone: (env.QZONE || 'false') === 'true',
  qzoneProb: Number(env.QZONE_PROB ?? 0.012), // QZONE_HOURS 里每次检查发一条的概率（10 分钟看一次，大概两天一条；一天最多一条）
  qzoneHours: (env.QZONE_HOURS || '12-22').split('-').map(Number),
  qzoneRight: Number(env.QZONE_RIGHT ?? 4), // 谁能看：1 所有人，4 好友，64 仅自己
  qzoneCheckMs: Number(env.QZONE_CHECK_MS ?? 600_000),
  // 旅行明信片：隔几周的周末她在自己的小世界里出去玩一趟（周五定去哪），周日下午给 PROACTIVE_QQ 寄一张明信片（正面百炼画当地风景）
  postcard: (env.POSTCARD || 'false') === 'true',
  postcardEveryWeeks: Number(env.POSTCARD_EVERY_WEEKS ?? 3),
  postcardModel: env.POSTCARD_IMAGE_MODEL || env.LETTER_IMAGE_MODEL || 'wanx2.1-t2i-turbo',
  postcardCheckMs: Number(env.POSTCARD_CHECK_MS ?? 600_000),
  anniversary: (env.ANNIVERSARY || 'true') !== 'false', // 认识 100 天、生日这种日子
  meetDate: env.MEET_DATE || '', // 手动指定认识的日子：qq:2025-05-15，多个用逗号；不填就用第一次聊天那天
  weather: (env.WEATHER || 'true') !== 'false', // 对方那边的天气（Open-Meteo，免费不要 key）
  weatherCity: env.WEATHER_CITY || '', // 默认城市；每个人也可以在 QQ 里发 /城市 杭州
  media: (env.MEDIA || 'true') !== 'false', // 看懂发来的视频（抽帧 + 听）和文件
  mediaMaxMB: Number(env.MEDIA_MAX_MB ?? 60),
  journal: (env.JOURNAL || 'true') !== 'false', // 每天写日记，当长期上下文
  journalHour: Number(env.JOURNAL_HOUR ?? 23), // 几点后写当天的日记（没写成第二天补）
  journalDays: Number(env.JOURNAL_DAYS ?? 7), // 聊天时带最近几天的日记
  journalCheckMs: Number(env.JOURNAL_CHECK_MS ?? 600_000),
  reflectHour: Number(env.REFLECT_HOUR ?? 22), // 每天几点后回想一次
  reflectCheckMs: Number(env.REFLECT_CHECK_MS ?? 600_000),
  selfMax: Number(env.SELF_MAX ?? 30), // “最近的自己”最多几条
  selfForgetDays: Number(env.SELF_FORGET_DAYS ?? 14), // 多久没再印证就忘掉
  recentForgetDays: Number(env.RECENT_FORGET_DAYS ?? 5), // “最近在看”忘得快
};

export function parseList(value) {
  return String(value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// 安装包把 DSH 装进本目录的 node_modules；自己装在别处的话在 .env 里写 DSH_CLI
function guessDshCli() {
  return path.join(ROOT, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
}
