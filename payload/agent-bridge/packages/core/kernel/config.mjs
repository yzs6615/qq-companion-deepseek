/**
 * 内核的配置：读 COMPANION_HOME/.env（已在环境变量里的优先），算出 cfg。各插件自己的设置在插件里挂上去。
 * 内核（main.mjs）和 scripts/features.mjs（功能与机制页）共用这一份，本体的默认值只写在这里；各插件的设置在插件 module.mjs 导出的 settings() 里。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.dirname(fileURLToPath(import.meta.url));
// 用户自己的东西（.env、人设、data）放 COMPANION_HOME；没设就跟内核放一起（测试、直接 node main.mjs 跑时）
export const HOME = process.env.COMPANION_HOME ? path.resolve(process.env.COMPANION_HOME) : ROOT;

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
loadEnv(path.join(HOME, '.env'));

export const env = process.env;
export const cfg = {
  wsUrl: env.ONEBOT_WS || 'ws://127.0.0.1:3001',
  token: env.ONEBOT_TOKEN || '',
  allowedQQ: parseList(env.ALLOWED_QQ),
  allowedGroups: parseList(env.ALLOWED_GROUPS),
  dshCli: env.DSH_CLI || guessDshCli(),
  // 装在 DSH 里跑（有 COMPANION_HOME）时跟着 DSH 自己的配置目录走，用同一套登录和模型设置
  dshHome: env.DSH_HOME || (env.COMPANION_HOME ? path.join(os.homedir(), '.dsh') : path.join(HOME, '.dsh-home')),
  agentCwd: env.AGENT_CWD || HOME,
  apiKey: env.DEEPSEEK_API_KEY || '',
  permissionMode: env.DSH_PERMISSION_MODE || '',
  timeoutMs: Number(env.SESSION_TIMEOUT_MS || 300_000),
  maxPrompt: Number(env.MAX_PROMPT_CHARS || 6000),
  ackPrivate: (env.ACK_PRIVATE || 'false') !== 'false',
  maxAgeSec: Number(env.MAX_MESSAGE_AGE_SEC || 120),
  personaFile: env.PERSONA_FILE || path.join(HOME, 'persona.md'),
  humanSplit: (env.HUMAN_SPLIT || 'true') !== 'false',
  botName: env.BOT_NAME || '小伴', // 功能页、默认人设（persona.default.md 里的 {{NAME}}）用的名字
  wakeWords: parseList(env.WAKE_WORDS || env.BOT_NAME || '小伴'), // 机器人的名字：群里叫这些词能把它叫出来，私聊点电台时也会去掉
  quietHours: (env.QUIET_HOURS || '23-9').split('-').map(Number), // 这几个钟头不出声、不留条、不发空间（各插件主动做事前看 api.quiet()）
  memoryEnabled: (env.MEMORY || 'true') !== 'false',
  // 同一段会话里，没变过的提示词块（人设、记得的事、日记、能办的事……）不再每轮重复塞，只塞变了的和每轮都变的。
  // 每 FULL_PROMPT_EVERY 轮、会话被压缩过、新开的会话，整个重发一遍。STICKY_PROMPT=false = 跟以前一样每轮全塞。
  stickyPrompt: (env.STICKY_PROMPT || 'true') !== 'false',
  fullPromptEvery: Number(env.FULL_PROMPT_EVERY ?? 25),
  // 主动找谁（早安晚安、回访、写信在 proactive 插件里；自己找事做的分享、ChronoLife、明信片、主人是谁也认这个）
  // 自己找事做、ChronoLife、做梦、人设成长、电台、明信片、现场照、收礼物的设置在她自己的生活（life）插件里
  proactiveQQ: parseList(env.PROACTIVE_QQ || ''),
  // ── 拟人行为 ──
  mergeMs: Number(env.MERGE_MS ?? 5000), // 连发合并：对方停这么久没再发才回（手机打字一句要好几秒），0 关闭
  mergeMaxMs: Number(env.MERGE_MAX_MS ?? 15_000),
  busyNoteMs: Number(env.BUSY_NOTE_MS ?? 45_000), // 上一轮忙了这么久还没回完、对方又来消息，才说一句“手上还有一个 等我下”（一轮最多一次）
  typingMsPerChar: Number(env.TYPING_MS_PER_CHAR ?? 130), // 0 关闭打字延迟
  inputStatus: (env.INPUT_STATUS || 'true') !== 'false', // 让对方看到“正在输入”
  markRead: (env.MARK_READ || 'true') !== 'false',
  sleepStart: Number(env.SLEEP_START ?? 1), // 睡觉时段 SLEEP_START~SLEEP_END 点；作息被带偏（心情和作息 mood 插件）会整体挪
  sleepEnd: Number(env.SLEEP_END ?? 7),
  sleepDelayProb: Number(env.SLEEP_DELAY_PROB ?? 0.5), // 睡觉时段慢回的概率，0 关闭
  typoProb: Number(env.TYPO_PROB ?? 0.04),
  react: (env.REACT || 'true') !== 'false', // “嗯嗯/哈哈”点表情回应，不调模型
  reactProb: Number(env.REACT_PROB ?? 0.7),
  ignoreLimit: Number(env.IGNORE_LIMIT ?? 2), // 主动找了几次都没回，就先不找了（等对方开口）
  recall: (env.RECALL || 'true') !== 'false', // 对方撤回：没回的那条就不回了；熟人偶尔调侃一句
  recallTeaseProb: Number(env.RECALL_TEASE_PROB ?? 0.5),
  pcOwner: env.PC_OWNER || '', // 电脑是谁的 QQ（默认 PROACTIVE_QQ 第一个）。主人是谁本体也要用（写信、明信片、作息被带偏…），电脑上的她那些设置在 pc 插件里
  shareCards: (env.SHARE_CARDS || 'true') !== 'false', // 看懂分享卡片（B站视频、歌、链接）；装了 life 插件时 B站视频会真去看一眼
  media: (env.MEDIA || 'true') !== 'false', // 看懂发来的视频（抽帧 + 听）和文件
  mediaMaxMB: Number(env.MEDIA_MAX_MB ?? 60),
  hearVoice: (env.HEAR_VOICE || 'true') !== 'false', // 听对方发来的 QQ 语音：本地 Whisper 转成字（只用本地模型，不联网），没模型 / 没听清就让对方打字
  reminderCheckMs: Number(env.REMINDER_CHECK_MS ?? 30_000), // 多久看一眼有没有到点的提醒（测试里调短）
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
