#!/usr/bin/env node
/**
 * QQ (OneBot 11) <-> DeepSeek Harness bridge.
 *
 * NapCat (or any OneBot 11 implementation with a forward WebSocket server)
 * pushes events to us; each allowed message becomes one `dsh --profile headless
 * --json` run. The headless session id is remembered per chat, so follow-up
 * messages continue the same conversation.
 */
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as human from './human.mjs';
import {
  extractStickers,
  extractVoice,
  extractSing,
  typingDelayMs,
  mergeWaitMs,
  dayKey,
  nowDesc,
  selfState,
  familiarity,
  makeTypo,
  ackKind,
  looksLikeQuestion,
  extractMoodTag,
} from './human.mjs';
import { cfg, env, parseList, HOME } from './config.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

// ── 插件：每个插件给内核一个 setup(api)，在这里登记钩子、服务和定时任务 ─────────────────
// 钩子名、参数和调用的地方见 docs/插件接口.md。内核只在固定的地方 collect / emit / first / pipe，
// 没装的插件就什么都不发生；一个插件的钩子出错只记一笔日志，不影响别的。
const hooks = new Map(); // 钩子名 -> [{ fn, order, from }]
const services = new Map(); // 服务名 -> 实现（跨插件用，没装就是 undefined）
const timers = []; // { ms, fn, first, from }
const plugins = []; // 已加载的插件 { id, file }
let loadingPlugin = 'core';
function on(name, fn, order = 100) {
  const list = hooks.get(name) || [];
  list.push({ fn, order, from: loadingPlugin });
  list.sort((a, b) => a.order - b.order);
  hooks.set(name, list);
}
const hookList = (name) => hooks.get(name) || [];
const hookFail = (name, h, err) => log(`插件 ${h.from} 的 ${name} 出错：${err?.stack || err?.message || err}`);
/** 每个钩子返回一段字符串，按 order 接起来。 */
function collect(name, ...args) {
  let out = '';
  for (const h of hookList(name)) {
    try {
      out += h.fn(...args) || '';
    } catch (err) {
      hookFail(name, h, err);
    }
  }
  return out;
}
/** 按顺序都跑一遍（等异步的跑完）。 */
async function emit(name, ...args) {
  for (const h of hookList(name)) {
    try {
      await h.fn(...args);
    } catch (err) {
      hookFail(name, h, err);
    }
  }
}
/** 依次问，有一个返回真值就停下并返回它（命令、消息拦截用）。 */
async function first(name, ...args) {
  for (const h of hookList(name)) {
    try {
      const r = await h.fn(...args);
      if (r) return r;
    } catch (err) {
      hookFail(name, h, err);
    }
  }
  return null;
}
/** 值依次过每个钩子（返回 undefined 表示不改）。 */
function pipe(name, value, ...args) {
  for (const h of hookList(name)) {
    try {
      const r = h.fn(value, ...args);
      if (r !== undefined) value = r;
    } catch (err) {
      hookFail(name, h, err);
    }
  }
  return value;
}
const provide = (name, impl) => services.set(name, impl);
const use = (name) => services.get(name);
const every = (ms, fn, firstMs) => timers.push({ ms, fn, first: firstMs, from: loadingPlugin });


// BRIDGE_DATA 让测试能用临时目录，不碰真实数据。
const DATA_DIR = env.BRIDGE_DATA ? path.resolve(env.BRIDGE_DATA) : path.join(HOME, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
// 内核起的工具（模型调用的 phone.mjs、bili.mjs、python 脚本）都认这个数据目录；
// 也别让任何一个 python 脚本偷偷去 HuggingFace 下模型（几百 MB），模型都得是本地已经有的
process.env.BRIDGE_DATA ||= DATA_DIR;
process.env.HF_HUB_OFFLINE ||= '1';
// Linux / Mac 上一般只有 python3；插件里跑 python 脚本都用 env.PYTHON
process.env.PYTHON ||= process.platform === 'win32' ? 'python' : 'python3';
const IMAGE_DIR = path.join(DATA_DIR, 'images');
const MEMORY_DIR = path.join(DATA_DIR, 'memory');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const sessions = readJson(SESSIONS_FILE, {});
// 主人是谁：PC_OWNER（电脑是谁的），没设就是 PROACTIVE_QQ 第一个；都没填就没有主人，谁都按“别人”算。
// 写信、明信片、作息被带偏、ChronoLife、电脑上的她、发说说、喇叭、放歌、发图、画画都认这一个
function ownerQQ() {
  return String(cfg.pcOwner || cfg.proactiveQQ[0] || '');
}
/**
 * 是不是主人私聊：只有这时才用 DSH_PERMISSION_MODE 的全权限（能动手机、电脑、文件），才放歌、发图、画画；
 * 别人私聊、群里（主人在群里也一样）都只读、只陪聊。
 */
const isOwnerChat = (ev) => ev?.message_type !== 'group' && !!ownerQQ() && String(ev?.user_id) === ownerQQ();
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const REMINDERS_FILE = path.join(DATA_DIR, 'reminders.json');
const state = readJson(STATE_FILE, {});
const reminders = readJson(REMINDERS_FILE, []);
function saveState() {
  writeAtomic(STATE_FILE, JSON.stringify(state, null, 2));
}
function saveReminders() {
  writeAtomic(REMINDERS_FILE, JSON.stringify(reminders, null, 2));
}
function userState(qq) {
  const key = String(qq);
  if (!state[key]) state[key] = { affection: 0, lastUserAt: 0, lastProactiveAt: 0, day: '', count: 0 };
  const st = state[key];
  st.turns ??= 0; // 聊过多少轮
  st.days ??= 0; // 聊过多少天
  st.lastDay ??= '';
  return st;
}
/** 熟悉度分数：喂鱼/摸摸 + 聊过的天数 + 聊过的轮数。 */
function closeness(st) {
  return st.affection + st.days * 2 + st.turns * 0.1 + (st.bonus || 0);
}
/**
 * 手动把某个人的综合分调到指定值：.env 里写 CLOSENESS_SET=qq:分数（多个用逗号）。
 * 做法是记一个固定的 bonus，让“此刻”的总分等于目标；之后每聊一轮照常往上涨。
 * 同一个目标只调一次（st.bonusTarget 记着）；改成别的数字会按当时的分数重新调。只调白名单里的人。
 */
function applyClosenessSet() {
  for (const item of parseList(env.CLOSENESS_SET)) {
    const [qq, value] = item.split(':').map((s) => s.trim());
    const target = Number(value);
    if (!qq || !Number.isFinite(target)) {
      log(`CLOSENESS_SET 里的 "${item}" 格式不对，应为 QQ号:分数`);
      continue;
    }
    if (!cfg.allowedQQ.includes(qq)) {
      log(`CLOSENESS_SET: ${qq} 不在 ALLOWED_QQ 里，跳过`);
      continue;
    }
    const st = userState(qq);
    if (st.bonusTarget === target) continue;
    const natural = st.affection + st.days * 2 + st.turns * 0.1;
    st.bonus = Math.round((target - natural) * 10) / 10;
    st.bonusTarget = target;
    saveState();
    log(`综合分已调到 ${target}：${qq}（自然分 ${natural.toFixed(1)}，调整 ${st.bonus >= 0 ? '+' : ''}${st.bonus}）`);
  }
}
/**
 * “聊过几天、几轮”是后来才加的计数，升级前聊的都没记，熟人会被当成刚认识。
 * 第一次启动时按 bridge.log 里的收发记录补一次（只数条数和日期，不看内容）。
 * 只补白名单里的人；补过就在 state.json 里留个标记，之后不再动。
 */
function backfillCloseness() {
  if (state._closenessSeeded) return;
  try {
    const per = new Map(); // qq -> { days: Set, turns }
    for (const line of fs.readFileSync(path.join(DATA_DIR, 'bridge.log'), 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\[([^\]]+)\] ([→←]) .*?\((\d+)\):/);
      if (!m || !cfg.allowedQQ.includes(m[3])) continue;
      const p = per.get(m[3]) || { days: new Set(), turns: 0 };
      p.days.add(dayKey(new Date(m[1])));
      if (m[2] === '←') p.turns++; // 回过一句才算一轮，和实时计数一致
      per.set(m[3], p);
    }
    const done = [];
    for (const [qq, p] of per) {
      const st = userState(qq);
      const days = p.days.size;
      if (days > st.days) {
        st.affection += days - st.days; // 实时规则：每多聊一天，亲密度 +1
        st.days = days;
      }
      if (p.turns > st.turns) st.turns = p.turns;
      const latest = [...p.days].sort().at(-1);
      if (!st.lastDay || latest > st.lastDay) st.lastDay = latest; // 免得今天又被算成新的一天
      done.push(`${qq}: ${st.days} 天 ${st.turns} 轮`);
    }
    state._closenessSeeded = Date.now();
    saveState();
    log(`熟悉度已按历史记录补齐（${done.join('；') || '没有可补的记录'}）`);
  } catch (err) {
    log(`熟悉度补齐失败: ${err.message}`); // 没标记，下次启动再试
  }
}

function readJson(file, fallback, keepBroken = true) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return fallback; // 还没有这个文件
  }
  try {
    return JSON.parse(text);
  } catch {
    // 读得到但不是完整的 JSON（多半是写到一半断了电）：原样另存一份再用默认值，别下次一保存就把它盖没了。
    // 别的程序正在写的文件（学歌写的 song.json）不留，读到半截很正常。
    try {
      if (keepBroken && text.trim()) {
        const keep = `${file}.broken-${Date.now()}`;
        fs.copyFileSync(file, keep);
        log(`${path.basename(file)} 坏了（读不成 JSON），原样留了一份 ${path.basename(keep)}，先用空的`);
      }
    } catch {
      /* 留不了就算了 */
    }
    return fallback;
  }
}
/** 先写临时文件再换名：写到一半断电，原来的文件还在，不会读出半截。换名失败（被别的程序占着）就直接写。 */
function writeAtomic(file, text) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text);
  try {
    fs.renameSync(tmp, file);
  } catch {
    fs.writeFileSync(file, text);
    fs.rmSync(tmp, { force: true });
  }
}
function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}`;
  console.log(line);
  try {
    fs.appendFileSync(path.join(DATA_DIR, 'bridge.log'), line + '\n');
  } catch {
    /* ignore */
  }
}
function saveSessions() {
  const tmp = SESSIONS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(sessions, null, 2));
  fs.renameSync(tmp, SESSIONS_FILE);
}

// ── persona ───────────────────────────────────────────────────────────────
// Read on every message (cached by mtime) so editing persona.md takes effect
// without restarting the bridge.
// 人设里的条件段 <!-- if:名字 --> … <!-- end -->（见 human.mjs 的 expandPersona）：名字就是 cfg 上的设置名，
// 功能开着才留下那段；设置在插件里，插件没装时 cfg 上是 undefined，当关。
// 跟原来安装器的勾选项对不上名字的在这里对一下：stickers = 收表情包（STEAL_STICKERS）。
const PERSONA_FLAGS = { stickers: 'stealStickers' };
const personaOn = (name) => !!cfg[PERSONA_FLAGS[name] || name];
let personaCache = { mtime: 0, text: '' };
function persona() {
  // 自己的人设没写就先用自带的默认人设
  const file = fs.existsSync(cfg.personaFile) ? cfg.personaFile : path.join(ROOT, 'persona.default.md');
  try {
    const { mtimeMs } = fs.statSync(file);
    if (mtimeMs !== personaCache.mtime) {
      personaCache = { mtime: mtimeMs, text: human.expandPersona(fs.readFileSync(file, 'utf8'), personaOn).trim().replace(/\{\{NAME\}\}/g, cfg.botName) }; // 默认人设里的名字是 {{NAME}}，换成 BOT_NAME
      log(`人设已加载: ${file} (${personaCache.text.length} 字)`);
    }
    return personaCache.text;
  } catch {
    return personaCache.text;
  }
}
// ── memory ────────────────────────────────────────────────────────────────
// 跨会话的“还记得”能力：每轮把双方的话留一行，下一轮拼进 prompt。
// 只保留最近 30 行，够用又不会把 token 撑爆。
function memoryFile(chatKey) {
  // 冒号也换掉：群聊是 g群号:u号，Windows 会把带冒号的文件名当成隐藏的数据流，记忆存不进去
  const safe = String(chatKey).replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(MEMORY_DIR, `${safe}.md`);
}
function readMemory(chatKey) {
  if (use('life')?.memoryOff()) return ''; // 开着 ChronoLife 但它没起来（她自己的生活，life 插件）：当没有
  if (!cfg.memoryEnabled) return '';
  try {
    const lines = fs.readFileSync(memoryFile(chatKey), 'utf8').trim().split('\n').filter(Boolean);
    const text = lines.slice(-12).join('\n');
    return pipe('context:filter', text, chatKey); // 删掉的记忆在这里拦（life 插件的 ChronoLife）
  } catch {
    return '';
  }
}
function appendMemory(chatKey, userText, answer) {
  if (!cfg.memoryEnabled) return;
  const clip = (s) => String(s || '').replace(/\s+/g, ' ').slice(0, 160);
  try {
    fs.mkdirSync(MEMORY_DIR, { recursive: true });
    const file = memoryFile(chatKey);
    let lines = [];
    try {
      lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
    } catch {}
    lines.push(`- 对方：${clip(userText)}`);
    lines.push(`- 你：${clip(answer)}`);
    writeAtomic(file, lines.slice(-30).join('\n') + '\n');
  } catch (err) {
    log(`记忆写入失败: ${err.message}`);
  }
}

// ── 自我状态 ──────────────────────────────────────────────────────────────
/** 自主活动留下的“今天干过啥”，被问在干嘛时能对上号。 */
function diaryToday() {
  const day = dayKey();
  const entries = (state._self?.log || []).filter((e) => e.day === day);
  return entries.slice(-5).map((e) => `${e.time} ${e.text}`);
}
function addDiary(text, shared = '') {
  if (!text) return;
  const self = state._self || (state._self = {});
  const now = new Date();
  (self.log ||= []).push({
    day: dayKey(now),
    time: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
    at: now.getTime(),
    text,
    ...(shared ? { shared: shared.slice(0, 120) } : {}),
  });
  self.log = self.log.slice(-40);
  saveState();
}

// 睡觉时段：心情和作息（mood 插件）管，作息被带偏（SLEEP_DRIFT）时会整体挪；
// 没装就按 SLEEP_START~SLEEP_END 固定（跟原来没开 SLEEP_DRIFT 时一样）
const sleepSpan = () => {
  const m = use('mood');
  return m ? [m.sleepHour(), m.wakeHour()] : [(cfg.sleepStart + 24) % 24, (cfg.sleepEnd + 24) % 24];
};
function asleep(h = new Date().getHours()) {
  const [a, b] = sleepSpan();
  return a <= b ? h >= a && h < b : h >= a || h < b;
}
/** 现在该不该安静：睡觉时段、QUIET_HOURS（默认 23~9 点），或者 ChronoLife 在休息 / 停用。插件主动出声、发东西前都看这个。 */
function quietNow() {
  const h = new Date().getHours();
  const [a, b] = cfg.quietHours;
  if (asleep(h) || (a !== b && (a < b ? h >= a && h < b : h >= a || h < b))) return true;
  const life = use('life')?.state() || null; // ChronoLife（她自己的生活，life 插件）：没装、没开是 null
  return !!life && (life.mode === 'rest' || life.mode === 'disabled');
}

/** 每条提示词都带上：现在几点、你什么心情、跟对方多熟。 */
function lifeBlock(qq) {
  const s = myState(qq ? `u${qq}` : '');
  const fam = qq ? familiarity(closeness(userState(qq))) : null;
  const diary = diaryToday();
  return (
    `\n\n---\n【此刻】${nowDesc()}\n你的状态：心情${s.mood}${s.reason ? `（因为${s.reason}）` : ''}，精力：${s.energyDesc}。` +
    (diary.length ? `\n你今天干过：${diary.join('；')}` : '') +
    (fam ? `\n你和对方：${fam.tier}（${fam.hint}）` : '') +
    collect('prompt:state', qq, qq ? `u${qq}` : '') +
    `\n（这是你自己心里的感觉，带着它说话就行；别念出来，也别提“状态”“熟悉度”这类词。）`
  );
}
// 作息被带偏那句（10）在心情和作息（mood）插件里，ChronoLife 小屋近况（30）在她自己的生活（life）插件里

// ── 群聊近况（只存内存）──────────────────────────────────────────────────
// 本体好多发送的地方都会记一笔（打字、语音、唱歌……），所以缓冲留在本体；群聊插件读它。
const groupBuf = new Map(); // group_id -> [{ id, uid, name, text, at, self }]
function recordGroup(groupId, entry) {
  const buf = groupBuf.get(String(groupId)) || [];
  buf.push({ at: Date.now(), ...entry });
  while (buf.length > 20) buf.shift();
  groupBuf.set(String(groupId), buf);
}
function groupContext(groupId, excludeIds = [], limit = 10) {
  const cutoff = Date.now() - 30 * 60_000;
  const skip = new Set(excludeIds.map(String));
  return (groupBuf.get(String(groupId)) || [])
    .filter((e) => e.at >= cutoff && !skip.has(String(e.id)))
    .slice(-limit)
    .map((e) => `${e.self ? '你' : e.name}：${e.text.slice(0, 80)}`)
    .join('\n');
}

/** 跟 collect 一样问一遍，但每个钩子给的那段分开返回：[{ key, text, every }]（key = 钩子名#插件#第几个，同一套插件里不会变）。 */
function collectEach(name, ...args) {
  return hookList(name).map((h, i) => {
    let text = '';
    try {
      text = h.fn(...args) || '';
    } catch (err) {
      hookFail(name, h, err);
    }
    return { key: `${name}#${h.from}#${i}`, text, every: !!h.fn.every };
  });
}
/**
 * 每轮的提示词按块拼。同一段会话里已经塞过、内容也没变的块（人设、记得的事、日记、能办的事……，每个插件给的那段各算一块）
 * 不再重复塞，只塞变了的、每轮都会变的和对方这句话：省下的上下文留给真聊天，会话压缩也晚得多。
 * 【此刻】、规矩（钩子函数上标了 every = true 的）每轮都塞；记着的那几句只在整个重发时塞（会话里本来就有这些对话）。
 * prev 是这段会话上次记下的 { blocks: 块名 → 内容指纹, turns: 离上次整个重发过了几轮 }；
 * 没有 prev（新会话、会话刚被压缩过）或者过了 FULL_PROMPT_EVERY 轮，就整个重发一遍。
 * 返回 { text, sent }：sent 等这轮跑成了再记进 sessions.json，跑失败就不记，下一轮照旧补上。
 */
function buildPrompt(ev, text, isGroup, chatKey, excludeIds = [], prev = null) {
  const head = persona();
  if (!head) return { text, sent: null };
  const full = !cfg.stickyPrompt || !prev || (prev.turns || 0) >= cfg.fullPromptEvery;
  const blocks = full ? {} : { ...(prev.blocks || {}) };
  const put = (name, body, how = '') => {
    if (!body) {
      delete blocks[name]; // 这轮没有这块：下次再出现（哪怕字一样，比如又被冷落了、又好久没发表情包）照样塞
      return '';
    }
    if (how === 'every') return body;
    if (how === 'fullOnly') return full ? body : '';
    const h = createHash('sha1').update(body).digest('hex').slice(0, 12);
    if (!full && blocks[name] === h) return '';
    blocks[name] = h;
    return body;
  };
  const who = senderName(ev) || String(ev.user_id);
  const scene = isGroup ? `群聊（群 ${ev.group_id}）里有人 @ 你` : '私聊';
  const mem = readMemory(chatKey);
  const memBlock = mem ? `\n\n---\n你之前和这个人聊过（记着的几句）：\n${mem}` : '';
  const turn = { ev, text, isGroup, chatKey, qq: ev.user_id, who, excludeIds };
  // 背景块按 order 拼（见 docs/插件接口.md），每块都过一遍 context:filter（删掉的记忆在那里拦）
  const filt = (s) => (s ? pipe('context:filter', s, chatKey) : '');
  const each = (name) => collectEach(name, turn).map((b) => put(b.key, filt(b.text), b.every ? 'every' : '')).join('');
  const remembered = each('prompt:context') + put('recent', filt(memBlock), 'fullOnly') + each('prompt:context-late');
  const continuous = collectEach('prompt:after', turn).map((b) => put(b.key, b.text, b.every ? 'every' : '')).join('');
  const hints = collectEach('prompt:hint', turn).map((b) => put(b.key, b.text, b.every ? 'every' : '')).join('');
  return {
    text: `${put('persona', head)}${put('now', lifeBlock(ev.user_id), 'every')}${remembered}${continuous}\n\n---\n对方：${who}\n场景：${scene}\n对方刚说：\n${text}\n\n（不管做完没做完，最后都用 1-2 句话回对方，别只调工具就沉默。）${hints}`,
    sent: cfg.stickyPrompt ? { blocks, turns: full ? 1 : (prev.turns || 0) + 1 } : null,
  };
}

// ── OneBot helpers ────────────────────────────────────────────────────────
function decodeCQ(s) {
  return s
    .replace(/&#91;/g, '[')
    .replace(/&#93;/g, ']')
    .replace(/&#44;/g, ',')
    .replace(/&amp;/g, '&');
}
/** Normalise OneBot `message` (array or CQ string) into segments. */
function segments(message) {
  if (Array.isArray(message)) return message;
  if (typeof message !== 'string') return [];
  const out = [];
  let rest = message;
  const re = /\[CQ:([a-zA-Z0-9_.-]+)((?:,[^\]]*)?)\]/g;
  let last = 0;
  let m;
  while ((m = re.exec(message))) {
    if (m.index > last) out.push({ type: 'text', data: { text: decodeCQ(message.slice(last, m.index)) } });
    const data = {};
    for (const pair of m[2].replace(/^,/, '').split(',')) {
      const eq = pair.indexOf('=');
      if (eq > 0) data[pair.slice(0, eq)] = decodeCQ(pair.slice(eq + 1));
    }
    out.push({ type: m[1], data });
    last = re.lastIndex;
  }
  if (last < message.length) out.push({ type: 'text', data: { text: decodeCQ(message.slice(last)) } });
  return out;
}
// QQ 自带的小黄脸表情：NapCat 发来的是 face 段（只有编号，raw.faceText 里通常带名字），
// 不转成文字的话，模型完全看不到对方发了表情；只发一个表情的消息还会被当成空消息丢掉。
const FACE_NAMES = {
  4: '得意', 5: '流泪', 12: '调皮', 13: '呲牙', 14: '微笑', 21: '可爱', 63: '玫瑰', 66: '爱心',
  76: '赞', 178: '斜眼笑', 179: 'doge', 182: '笑哭', 264: '捂脸',
};
function faceName(d) {
  const t = String(d?.raw?.faceText || '').replace(/^\//, '').replace(/^\[|\]$/g, '').trim();
  return t || FACE_NAMES[String(d?.id)] || `编号${d?.id ?? '?'}`;
}
function textOf(segs) {
  return segs
    .map((s) => {
      if (s.type === 'text') return s.data?.text || '';
      if (s.type === 'face') return `[QQ表情:${faceName(s.data)}]`;
      if (s.type === 'dice') return `[掷骰子:${s.data?.result ?? '?'}点]`;
      if (s.type === 'rps') return '[猜拳]';
      if (CARD_TYPES.has(s.type) && cfg.shareCards) {
        const c = parseCard(s);
        return c ? cardLine(c) : '';
      }
      return '';
    })
    .join('')
    .trim();
}
/** 只有打的字（不含卡片、表情），群里认“叫没叫她”用：别让分享来的视频标题把她喊出来。 */
function typedOf(segs) {
  return segs.map((s) => (s.type === 'text' ? s.data?.text || '' : '')).join('').trim();
}

// ── 分享卡片（QQ 里“分享”过来的 B站视频、歌、网页）─────────────────────────────
// NapCat 发来的是 json 段（data.data 是一段 JSON 字符串），老一点的是 xml 段；OneBot 标准里还有 share / music 段。
// 不认的话整条消息是空的，会被当成空消息丢掉。认出来写成一行“[分享了…]”；
// B站视频再交给 message:share 钩子（life 插件用刷 B站那套真去看一眼）。
const CARD_TYPES = new Set(['json', 'xml', 'share', 'music']);
const cardClean = (s, n = 120) => String(s || '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim().slice(0, n);
/** 一个卡片段 → { kind: 'music' | 'link' | 'other', source, title, desc, url }；认不出、或者是合并转发，返回 null。 */
function parseCard(seg) {
  const d = seg?.data || {};
  if (seg?.type === 'share') return { kind: 'link', source: '', title: cardClean(d.title), desc: cardClean(d.content, 200), url: String(d.url || '') };
  if (seg?.type === 'music') {
    const source = { qq: 'QQ音乐', 163: '网易云音乐', kugou: '酷狗', kuwo: '酷我' }[d.type] || '';
    return { kind: 'music', source, title: cardClean(d.title), desc: cardClean(d.content), url: String(d.url || '') };
  }
  if (seg?.type === 'xml') {
    const x = String(d.data || '');
    const pick = (re) => cardClean(x.match(re)?.[1] || '');
    const title = pick(/<title>([^<]*)<\/title>/) || pick(/brief="([^"]*)"/);
    return title ? { kind: 'link', source: pick(/<source[^>]*name="([^"]*)"/), title, desc: pick(/<summary>([^<]*)<\/summary>/), url: pick(/url="([^"]*)"/) } : null;
  }
  if (seg?.type !== 'json') return null;
  let j;
  try {
    j = typeof d.data === 'string' ? JSON.parse(d.data) : d.data;
  } catch {
    return null;
  }
  if (!j || typeof j !== 'object' || /multimsg/.test(String(j.app || ''))) return null; // 合并转发走 forward 那边
  const meta = j.meta && typeof j.meta === 'object' ? j.meta : {};
  const prompt = cardClean(j.prompt);
  if (meta.music) {
    const m = meta.music;
    return { kind: 'music', source: cardClean(m.tag, 20), title: cardClean(m.title), desc: cardClean(m.desc), url: String(m.jumpUrl || m.musicUrl || '') };
  }
  if (meta.news) {
    const m = meta.news;
    return { kind: 'link', source: cardClean(m.tag, 20), title: cardClean(m.title) || prompt, desc: cardClean(m.desc, 200), url: String(m.jumpUrl || '') };
  }
  if (meta.detail_1) {
    // 小程序：title 是哪个 App（“哔哩哔哩”），desc 才是分享的东西
    const m = meta.detail_1;
    return { kind: 'link', source: cardClean(m.title, 20), title: cardClean(m.desc) || prompt, desc: '', url: String(m.qqdocurl || m.url || '') };
  }
  return prompt ? { kind: 'other', source: '', title: prompt.replace(/^\[[^\]]*\]\s*/, '') || prompt, desc: '', url: '' } : null;
}
const isBiliCard = (c) => /哔哩哔哩|bilibili/i.test(c.source) || /b23\.tv|bili2233\.cn|bilibili\.com\/video/i.test(c.url);
/** 卡片写成给她看的一行。链接只留 http(s) 的，太长截掉。 */
function cardLine(c) {
  const url = /^https?:\/\//i.test(c.url) ? ` ${c.url.slice(0, 200)}` : '';
  if (c.kind === 'music') return c.title ? `[分享了一首歌：《${c.title}》${c.desc ? ` ${c.desc}` : ''}${c.source ? `（${c.source}）` : ''}]` : '[分享了一首歌]';
  if (isBiliCard(c)) return `[分享了一个B站视频：${c.title}${url}]`;
  if (c.kind === 'link') return `[分享了一个链接：${c.title}${c.source ? `（${c.source}）` : ''}${c.desc && c.desc !== c.title ? ` —— ${c.desc}` : ''}${url}]`;
  return `[分享：${c.title}]`;
}
/** 这条消息里认得出的卡片。 */
const cardsOf = (segs) => segs.filter((s) => CARD_TYPES.has(s.type)).map(parseCard).filter(Boolean);
function mentions(segs, qq) {
  return segs.some((s) => s.type === 'at' && String(s.data?.qq) === String(qq));
}
function senderName(ev) {
  return ev.sender?.card || ev.sender?.nickname || String(ev.user_id);
}

// ── 引用（QQ 里“回复”某条消息）────────────────────────────────────────────
// 消息里会带一个 reply 段（只有被引用那条的 id）。用 get_msg 取原文；取不到就从最近的消息里找。
// 原文会放在对方这句话前面告诉模型；被引用的消息里有图，也一起下载给它看。
const recentMsgs = new Map(); // message_id -> { uid, name, text, self }
function rememberMsg(id, info) {
  if (id === undefined || id === null || id === '') return;
  recentMsgs.set(String(id), { at: Date.now(), ...info });
  if (recentMsgs.size > 800) recentMsgs.delete(recentMsgs.keys().next().value);
}
function replyId(segs) {
  const r = segs.find((s) => s.type === 'reply');
  return r?.data?.id !== undefined && r?.data?.id !== null ? String(r.data.id) : '';
}
async function fetchMsg(id) {
  try {
    return await sendRaw({ action: 'get_msg', params: { message_id: /^\d+$/.test(id) ? Number(id) : id } });
  } catch (err) {
    log(`取引用消息失败: ${err.message}`);
    return null;
  }
}
/** 被引用的那条是不是机器人自己发的（群里引用它的话 = 在跟它说话）。 */
async function quotesMe(segs) {
  const id = replyId(segs);
  if (!id || !selfId) return false;
  const cached = recentMsgs.get(id);
  if (cached) return !!cached.self;
  const m = await fetchMsg(id);
  return String(m?.sender?.user_id ?? m?.user_id ?? '') === String(selfId);
}
/** 返回 { desc, images } 或 null（没引用）。desc 形如：对方引用了你自己之前说的：「……」 */
async function resolveQuote(segs, ev) {
  const id = replyId(segs);
  if (!id) return null;
  const m = await fetchMsg(id);
  const cached = recentMsgs.get(id);
  const qsegs = m ? segments(m.message ?? m.raw_message).filter((s) => s.type !== 'reply') : null;
  let text = qsegs ? textOf(qsegs) : '';
  let uid = String(m?.sender?.user_id ?? m?.user_id ?? '');
  let name = m?.sender?.card || m?.sender?.nickname || '';
  if (!text && cached) text = cached.text;
  if (!uid && cached) uid = cached.uid;
  if (!name && cached) name = cached.name;
  const self = (selfId && uid === String(selfId)) || !!cached?.self;
  const images = qsegs && qsegs.some((s) => s.type === 'image' || s.type === 'mface') ? await saveImages(qsegs, { message_id: `quote-${id}` }) : [];
  if (!text && !images.length) {
    const kind = qsegs?.some((s) => s.type === 'record') ? '一条语音' : qsegs?.some((s) => s.type === 'video') ? '一段视频' : qsegs?.some((s) => s.type === 'file') ? '一个文件' : '一条消息';
    return { images, desc: m || cached ? `对方引用了${self ? '你自己之前发的' : `${name || '某人'}发的`}${kind}` : '对方引用了一条消息（原文已经找不到了）' };
  }
  const who = self ? '你自己之前说的' : uid === String(ev.user_id) ? '自己之前说的' : `${name || '某人'}说的`;
  const what = text ? `「${text.replace(/\s+/g, ' ').slice(0, 300)}」${images.length ? '（还带图，图也一起给你了）' : ''}` : '一张图（图一起给你了）';
  return { images, desc: `对方引用了${who}：${what}` };
}

// ── 撤回：像真人一样“看见了” ───────────────────────────────────────────────
// 对方撤回一条消息：还在攒着没回的那批里就拿掉（不回已经撤回的话）；
// 私聊里、熟一点的人、刚发不久的，偶尔调侃一句“撤回了啥 我都看到了”（RECALL_TEASE_PROB）。群里不调侃。
function dropFromBatch(chatKey, messageId) {
  const b = batches.get(chatKey);
  if (!b) return false;
  const i = b.parts.findIndex((p) => String(p.ev?.message_id) === String(messageId));
  if (i < 0) return false;
  b.parts.splice(i, 1);
  if (!b.parts.length) {
    clearTimeout(b.timer);
    batches.delete(chatKey);
  }
  return true;
}
async function handleRecall(n) {
  if (!cfg.recall) return;
  const uid = String(n.user_id ?? '');
  const isGroup = n.notice_type === 'group_recall';
  if (!uid || (selfId && uid === String(selfId))) return; // 它自己撤回的（手滑补正）
  if (isGroup && n.operator_id && String(n.operator_id) !== uid) return; // 管理员撤回别人的：不关它事
  if (isGroup ? !cfg.allowedGroups.includes(String(n.group_id)) : !cfg.allowedQQ.includes(uid)) return;
  const chatKey = isGroup ? `g${n.group_id}:u${uid}` : `u${uid}`;
  const cached = recentMsgs.get(String(n.message_id));
  const dropped = dropFromBatch(chatKey, n.message_id);
  log(`撤回：${isGroup ? `群 ${n.group_id} ` : ''}${uid} 撤回了一条${dropped ? '还没回的，这条不回了' : ''}`);
  if (isGroup || !cached || cached.self) return;
  if (Date.now() - (cached.at || 0) > 10 * 60_000) return; // 很久以前的撤回：没注意到
  if (familiarity(closeness(userState(uid))).tier === '刚认识') return; // 不熟就别调侃
  if (Math.random() >= cfg.recallTeaseProb) return;
  try {
    const prompt =
      `${persona()}${lifeBlock(uid)}\n\n---\n对方刚把一条消息撤回了，不过你撤回前已经看到了，内容是：「${String(cached.text).slice(0, 200)}」\n` +
      `像熟人那样接一句：可以调侃“撤回了啥 我都看到了”，可以装没看见问“刚发的啥”，内容好笑的可以拿来逗一下；尴尬的、私密的别复述原文。` +
      `就 1 句，别客服腔。只输出要发的话。`;
    const r = await runAgent(prompt, null, { permissionMode: 'read-only' });
    const line = humanize(r.text).trim();
    if (!line) return;
    await sleep((1500 + Math.random() * 3000) * pace());
    await say({ message_type: 'private', user_id: Number(uid) }, line, { casual: true });
    appendMemory(chatKey, '（撤回了一条消息）', line);
    log('撤回：调侃了一句');
  } catch (err) {
    log(`撤回调侃失败: ${err.message}`);
  }
}

// ── 看懂发来的视频和文件 ──────────────────────────────────────────────────
// 视频：get_file 让 NapCat 下到本机（不行就按 url 下）→ media/frames.py 挑几帧拼成图（换镜头的地方优先；跟 life 插件刷 B站用的 bili/frames.py 一样，本体带一份）
//       → 有本地 Whisper 就听一下说了啥 → 图跟图片一起给它看，听到的话写进这句话前面。
// 文件：文本/代码/字幕直接读；PDF/Word/Excel/PPT 用 media/doc_text.py 读成字；图片当图片；视频走上面；
//       别的只告诉它文件名和存在哪。都存 data/media/。超过 MEDIA_MAX_MB 的不下。
const MEDIA_DIR = path.join(DATA_DIR, 'media');
const EXT = {
  text: new Set(['txt', 'md', 'csv', 'json', 'log', 'py', 'js', 'mjs', 'ts', 'html', 'htm', 'xml', 'yml', 'yaml', 'ini', 'srt', 'lrc', 'c', 'cpp', 'h', 'java', 'go', 'rs', 'sh', 'bat', 'ps1', 'sql', 'toml', 'cfg', 'conf']),
  doc: new Set(['pdf', 'docx', 'xlsx', 'pptx']),
  image: new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp']),
  video: new Set(['mp4', 'mov', 'mkv', 'avi', 'webm', 'flv', 'm4v', '3gp']),
};
const fmtSize = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`);
const fmtDur = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
/** 跑一个 python 脚本（异步，不卡别的聊天），返回最后一行的 JSON（没有就 null）。 */
function runPyJson(args, timeoutMs) {
  return runJson(env.PYTHON || 'python', args, timeoutMs);
}
/**
 * 本地 Whisper 听一段音频（media/asr.py，base 模型），返回 { text } 或 null。看视频、听 QQ 语音都走这个。
 * ASR_SCRIPT 可以换成别的脚本（测试用假的；.mjs/.js 用 node 跑，别的用 python 跑），参数一样：<文件> --model base。
 */
function runAsr(file, timeoutMs) {
  const script = env.ASR_SCRIPT || path.join(ROOT, 'media', 'asr.py');
  const args = [script, file, '--model', 'base'];
  return /\.m?js$/i.test(script) ? runJson(process.execPath, args, timeoutMs) : runPyJson(args, timeoutMs);
}
/** 本地 Whisper 模型在不在（WHISPER_MODEL_DIR 下的 base/model.bin，跟 media/asr.py 认的一样）。听 QQ 语音前先看一眼，没有就不听、绝不联网去下。 */
function localWhisper() {
  if (env.ASR_SCRIPT) return true;
  return !!env.WHISPER_MODEL_DIR && fs.existsSync(path.join(path.resolve(env.WHISPER_MODEL_DIR), 'base', 'model.bin'));
}
function runJson(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    let out = '';
    const timer = setTimeout(() => p.kill(), timeoutMs);
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', () => {});
    p.on('error', () => resolve(null));
    p.on('close', () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(out.trim().split(/\r?\n/).pop() || ''));
      } catch {
        resolve(null);
      }
    });
  });
}
async function downloadTo(url, dest, maxBytes) {
  const r = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const len = Number(r.headers.get('content-length') || 0);
  if (len && len > maxBytes) throw new Error(`太大（${fmtSize(len)}）`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > maxBytes) throw new Error(`太大（${fmtSize(buf.length)}）`);
  fs.writeFileSync(dest, buf);
  return dest;
}
/** 把视频/文件段弄到本机，返回存好的路径（失败返回 ''）。 */
async function fetchMedia(seg, ev, name) {
  const d = seg.data || {};
  const maxBytes = cfg.mediaMaxMB * 1048576;
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  const dest = path.join(MEDIA_DIR, `${ev.message_id || Date.now()}-${String(name).replace(/[\\/:*?"<>|\s]+/g, '_').slice(-80)}`);
  const tries = [];
  if (seg.type === 'video' && d.file) tries.push(() => sendRaw({ action: 'get_file', params: { file: String(d.file) } }));
  if (seg.type === 'file' && d.file_id) tries.push(() => sendRaw({ action: 'get_file', params: { file_id: String(d.file_id) } }));
  for (const t of tries) {
    try {
      const r = await t();
      if (r?.file && fs.existsSync(r.file)) {
        if (fs.statSync(r.file).size > maxBytes) throw new Error(`太大（${fmtSize(fs.statSync(r.file).size)}）`);
        fs.copyFileSync(r.file, dest);
        return dest;
      }
      if (r?.url && /^https?:/i.test(r.url)) return await downloadTo(r.url, dest, maxBytes);
      if (r?.base64) {
        fs.writeFileSync(dest, Buffer.from(r.base64, 'base64'));
        return dest;
      }
    } catch (err) {
      if (/太大/.test(err.message)) throw err;
      log(`取文件失败（get_file）: ${err.message}`);
    }
  }
  if (d.url && /^https?:/i.test(d.url)) return downloadTo(d.url, dest, maxBytes);
  if (d.url && fs.existsSync(d.url)) {
    fs.copyFileSync(d.url, dest);
    return dest;
  }
  return '';
}
/** 看一段视频：挑帧拼图 + 听。返回 { note, images }。 */
async function watchVideo(file, label = '一段视频') {
  const plan = path.join(MEDIA_DIR, `${path.basename(file)}.plan.json`);
  fs.writeFileSync(plan, JSON.stringify({ segments: [{ file, start: 0, end: 0, kind: 'whole' }], max: 6, duration: 0, out: file.replace(/\.[^.\\/]+$/, '') + '-frames' }));
  const fr = await runPyJson([path.join(ROOT, 'media', 'frames.py'), plan], 120_000);
  fs.rmSync(plan, { force: true });
  const dur = fr?.duration || 0;
  let heard = '';
  if (dur > 0 && dur <= 600) {
    const asr = await runAsr(file, 240_000);
    heard = String(asr?.text || '').trim();
  }
  const sheets = fr?.sheets || [];
  const bits = [`对方发来${label}${dur ? `（${fmtDur(dur)}）` : ''}`];
  bits.push(heard ? `里面说的：「${heard.slice(0, 800)}」` : dur > 600 ? '太长了没听' : '没听出有人说话');
  bits.push(sheets.length ? `画面挑了几帧拼成 ${sheets.length} 张图，跟图片一起给你了，左上角是时间` : '画面没打开');
  return { note: `（${bits.join('，')}）`, images: sheets };
}
/** 这条消息里的视频和文件：返回 { note, images } 或 null。 */
async function readMedia(segs, ev) {
  if (!cfg.media) return null;
  const items = segs.filter((s) => s.type === 'video' || s.type === 'file').slice(0, 2);
  if (!items.length) return null;
  if (ev.message_type !== 'group') showTyping(ev);
  const notes = [];
  const images = [];
  for (const seg of items) {
    const d = seg.data || {};
    const name = seg.type === 'video' ? 'video.mp4' : String(d.file || d.name || 'file');
    const ext = (name.match(/\.([a-z0-9]+)$/i)?.[1] || (seg.type === 'video' ? 'mp4' : '')).toLowerCase();
    const size = Number(d.file_size || 0);
    if (size > cfg.mediaMaxMB * 1048576) {
      notes.push(`（对方发来${seg.type === 'video' ? '一段视频' : `一个文件「${name}」`}，${fmtSize(size)}，太大了没打开）`);
      continue;
    }
    let file = '';
    try {
      file = await fetchMedia(seg, ev, seg.type === 'video' ? `video.${ext || 'mp4'}` : name);
    } catch (err) {
      notes.push(`（对方发来${seg.type === 'video' ? '一段视频' : `一个文件「${name}」`}，${/太大/.test(err.message) ? err.message + '，没打开' : '没下下来'}）`);
      continue;
    }
    if (!file) {
      notes.push(`（对方发来${seg.type === 'video' ? '一段视频' : `一个文件「${name}」`}，没下下来）`);
      continue;
    }
    const realSize = fs.statSync(file).size;
    if (seg.type === 'video' || EXT.video.has(ext)) {
      const v = await watchVideo(file, seg.type === 'video' ? '一段视频' : `一个视频文件「${name}」`);
      notes.push(v.note);
      images.push(...v.images);
    } else if (EXT.image.has(ext)) {
      images.push(file);
      notes.push(`（对方发来一张图片文件「${name}」，跟图片一起给你了）`);
    } else if (EXT.text.has(ext) || EXT.doc.has(ext)) {
      const r = await runPyJson([path.join(ROOT, 'media', 'doc_text.py'), file, '4000'], 60_000);
      if (r?.text) notes.push(`（对方发来一个文件「${name}」（${fmtSize(realSize)}），内容：\n${r.text}${r.truncated ? '\n…（后面还有，太长没放进来；要看全文可以用工具打开 ' + file + '）' : ''}\n）`);
      else notes.push(`（对方发来一个文件「${name}」（${fmtSize(realSize)}），存在 ${file}，没直接读出字来，可以用工具打开看看）`);
    } else {
      notes.push(`（对方发来一个文件「${name}」（${fmtSize(realSize)}），存在 ${file}）`);
    }
  }
  log(`收到${items.map((s) => (s.type === 'video' ? '视频' : '文件')).join('、')}：${notes.length} 个看过了`);
  return { note: notes.join('\n'), images };
}

// ── 听 QQ 语音：对方发来的 record 段（HEAR_VOICE，默认开）─────────────────────────────
// get_record 让 NapCat 转成 wav（不行就 get_file 拿原文件，再不行用段里的 path / url）→ 本地 Whisper 听（跟看视频同一个 runAsr）
// → “（发来语音：……）”拼进这轮的话。只用本地模型、不联网；没模型、没取到、没听出字，就回一句“没听清 打字吧”。群里一样，只是得先叫到她。
const VOICE_IN_DIR = path.join(DATA_DIR, 'voice-in');
const DEAF_LINES = ['没听清 打字吧', '这条语音我没听清 你打字说？', '语音没听出来 打字吧'];
/** 这条消息里的语音：返回 { note }（听出来了）/ { failed: true }（没听成）/ null（没有语音或者 HEAR_VOICE 关了）。 */
async function readVoice(segs, ev) {
  const rec = segs.find((s) => s.type === 'record');
  if (!rec || !cfg.hearVoice) return null;
  const d = rec.data || {};
  if (ev.message_type !== 'group') showTyping(ev);
  if (!localWhisper()) {
    log('听语音：本地没有 Whisper 模型，没听（不去网上下）');
    return { failed: true };
  }
  fs.mkdirSync(VOICE_IN_DIR, { recursive: true });
  const base = path.join(VOICE_IN_DIR, String(ev.message_id || Date.now()).replace(/[^\w-]/g, '_'));
  let file = '';
  const ref = d.file ? { file: String(d.file) } : d.file_id ? { file_id: String(d.file_id) } : null;
  for (const params of ref ? [{ ...ref, out_format: 'wav' }, ref] : []) {
    const action = params.out_format ? 'get_record' : 'get_file';
    try {
      const r = await sendRaw({ action, params });
      const ext = params.out_format ? '.wav' : path.extname(String(r?.file || '')) || '.amr';
      if (r?.file && fs.existsSync(r.file)) {
        fs.copyFileSync(r.file, base + ext);
        file = base + ext;
      } else if (r?.base64) {
        fs.writeFileSync(base + ext, Buffer.from(r.base64, 'base64'));
        file = base + ext;
      }
      if (file) break;
    } catch (err) {
      log(`取语音失败（${action}）: ${err.message}`);
    }
  }
  try {
    if (!file && d.path && fs.existsSync(d.path)) {
      file = base + (path.extname(d.path) || '.amr');
      fs.copyFileSync(d.path, file);
    } else if (!file && d.url && /^https?:/i.test(d.url)) {
      file = await downloadTo(d.url, base + '.amr', 20 * 1048576);
    }
  } catch (err) {
    log(`取语音失败（按地址下）: ${err.message}`);
    file = '';
  }
  const olds = fs.readdirSync(VOICE_IN_DIR).map((f) => path.join(VOICE_IN_DIR, f)).filter((f) => f !== file);
  for (const old of olds.sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs).slice(0, -30)) fs.rmSync(old, { force: true }); // 只留最近 30 个
  if (!file || !fs.existsSync(file)) {
    log('听语音：没取到语音文件');
    return { failed: true };
  }
  const r = await runAsr(file, 120_000);
  const heard = String(r?.text || '').replace(/\s+/g, ' ').trim();
  if (!heard) {
    log('听语音：没听出字');
    return { failed: true };
  }
  log(`听语音：听出 ${heard.length} 字`);
  return { note: `（发来语音：${heard.slice(0, 500)}）` };
}

/** Download QQ image segments so the agent can inspect them with read_image. */
async function saveImages(segs, ev) {
  const imgs = segs.filter((s) => s.type === 'image' || s.type === 'mface').slice(0, 4);
  const saved = [];
  for (let i = 0; i < imgs.length; i++) {
    const d = imgs[i].data || {};
    // 只认 QQ 自己标成表情的图（商城表情 / 收藏的表情 sub_type=1 / “[动画表情]”），普通照片绝不收进表情库
    const isSticker = imgs[i].type === 'mface' || !!(d.emoji_id || d.emoji_package_id) || String(d.sub_type ?? d.subType ?? '') === '1' || /表情/.test(String(d.summary || ''));
    let buf = null;
    let ext = 'jpg';
    try {
      if (d.url && /^https?:/i.test(d.url)) {
        const res = await fetch(d.url, { signal: AbortSignal.timeout(15_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const ct = (res.headers.get('content-type') || '').toLowerCase();
        if (ct.includes('png')) ext = 'png';
        else if (ct.includes('webp')) ext = 'webp';
        else if (ct.includes('gif')) ext = 'gif';
        const ab = await res.arrayBuffer();
        if (ab.byteLength > 12 * 1024 * 1024) throw new Error('图片太大');
        buf = Buffer.from(ab);
      } else if (d.file && path.isAbsolute(d.file) && fs.existsSync(d.file)) {
        buf = fs.readFileSync(d.file);
      }
    } catch (err) {
      log(`图片 ${i + 1} 下载失败: ${err.message}`);
      continue;
    }
    if (!buf || buf.length < 16) continue;
    if (buf[0] === 0x89 && buf[1] === 0x50) ext = 'png';
    else if (buf[0] === 0xff && buf[1] === 0xd8) ext = 'jpg';
    else if (buf[0] === 0x47 && buf[1] === 0x49) ext = 'gif';
    else if (buf.slice(8, 12).toString() === 'WEBP') ext = 'webp';
    fs.mkdirSync(IMAGE_DIR, { recursive: true });
    const dest = path.join(IMAGE_DIR, `${ev.message_id || Date.now()}-${i}.${ext}`);
    fs.writeFileSync(dest, buf);
    let shown = dest;
    if (ext === 'gif') {
      // 模型读 GIF 只能看到一帧，拆成多帧拼图给它看。
      const sheet = dest.replace(/\.gif$/i, '.sheet.png');
      try {
        execFileSync(env.PYTHON, [path.join(ROOT, 'images', 'gif_sheet.py'), dest, sheet], {
          timeout: 20_000,
          windowsHide: true,
        });
        shown = sheet;
      } catch (err) {
        log(`GIF 拆帧失败: ${err.message}`);
      }
    }
    saved.push(shown);
    if (isSticker) (ev._stickers ||= []).push({ file: dest, shown });
  }
  return saved;
}

// ── OneBot WS client with reconnect + API calls ───────────────────────────
let ws = null;
let selfId = null;
let stopped = false;
let reconnectDelay = 1000;
let echoSeq = 0;
const pending = new Map(); // echo -> {resolve, reject, timer}
let activeRuns = 0;

function connect() {
  if (stopped) return;
  const url = new URL(cfg.wsUrl);
  if (cfg.token) url.searchParams.set('access_token', cfg.token);
  log(`连接 OneBot: ${url.origin}${url.pathname}`);
  ws = new WebSocket(url);

  ws.addEventListener('open', () => {
    reconnectDelay = 1000;
    log('OneBot 已连接');
  });
  ws.addEventListener('message', (event) => {
    let data;
    try {
      data = JSON.parse(typeof event.data === 'string' ? event.data : event.data.toString());
    } catch {
      return;
    }
    if (data.echo != null && pending.has(data.echo)) {
      const p = pending.get(data.echo);
      pending.delete(data.echo);
      clearTimeout(p.timer);
      if (data.retcode === 0 || data.status === 'ok') p.resolve(data.data);
      else p.reject(new Error(`${data.status || 'error'} ${data.retcode ?? ''} ${data.wording || ''}`.trim()));
      return;
    }
    if (data.post_type === 'meta_event') {
      if (data.meta_event_type === 'lifecycle' && data.self_id) {
        selfId = data.self_id;
        log(`机器人 QQ: ${selfId}`);
      }
      return;
    }
    if (data.post_type === 'message') {
      handleEvent(data).catch((err) => log('处理消息失败:', err.stack || err.message));
    } else if (data.post_type === 'notice' && (data.notice_type === 'friend_recall' || data.notice_type === 'group_recall')) {
      handleRecall(data).catch((err) => log('处理撤回失败:', err.message));
    } else if (data.post_type === 'notice') {
      first('notice', data).catch((err) => log('处理通知失败:', err.message)); // 戳一戳等交给插件
    }
  });
  ws.addEventListener('close', () => {
    log(`OneBot 断开，${Math.round(reconnectDelay / 1000)}s 后重连`);
    for (const [, p] of pending) {
      clearTimeout(p.timer);
      p.reject(new Error('连接断开'));
    }
    pending.clear();
    if (!stopped) {
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
    }
  });
  ws.addEventListener('error', (e) => log('OneBot WS 错误:', e.message || ''));
}

function sendRaw(obj) {
  if (!ws || ws.readyState !== 1) return Promise.reject(new Error('OneBot 未连接'));
  obj.echo = `echo-${++echoSeq}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(obj.echo);
      reject(new Error('OneBot API 超时'));
    }, 20_000);
    pending.set(obj.echo, { resolve, reject, timer });
    ws.send(JSON.stringify(obj));
  });
}

/** 往 target（带 message_type / user_id / group_id 的对象）所在的聊天发消息，返回 message_id。 */
async function sendMsg(target, message) {
  const res =
    target.message_type === 'group'
      ? await sendRaw({ action: 'send_group_msg', params: { group_id: target.group_id, message } })
      : await sendRaw({ action: 'send_private_msg', params: { user_id: target.user_id, message } });
  return res?.message_id;
}

const pace = () => (cfg.typingMsPerChar ? 1 : 0); // 关掉打字延迟时，所有“装人”的停顿也一起关
let inputStatusFails = 0;
/** 私聊里让对方看到“对方正在输入…”；接口不支持就连续失败 3 次后不再试。 */
function showTyping(target) {
  if (!cfg.inputStatus || target.message_type === 'group' || inputStatusFails >= 3) return;
  sendRaw({ action: 'set_input_status', params: { user_id: String(target.user_id), event_type: 1 } })
    .then(() => {
      inputStatusFails = 0;
    })
    .catch(() => {
      inputStatusFails++;
    });
}

/** 发一个文字气泡；群里可带引用（回复那条消息）或 @。 */
async function sendBubble(ev, chunk, { quote = false, at = false } = {}) {
  const message = [];
  if (quote && ev.message_id) message.push({ type: 'reply', data: { id: String(ev.message_id) } });
  if (at && ev.user_id) message.push({ type: 'at', data: { qq: String(ev.user_id) } });
  message.push({ type: 'text', data: { text: at ? ` ${chunk}` : chunk } });
  const id = await sendMsg(ev, message);
  rememberMsg(id, { uid: String(selfId ?? ''), name: '你', text: chunk, self: true });
  if (ev.message_type === 'group') recordGroup(ev.group_id, { id, name: '你', text: chunk, self: true });
  return id;
}

let lastTypoAt = 0;
/** 偶尔手滑：选一个气泡换个同音字，之后补一句 “*对的字” 或者撤回重发。 */
function planSlip(bubbles) {
  if (!cfg.typoProb || Math.random() >= cfg.typoProb || Date.now() - lastTypoAt < 10 * 60_000) return null;
  const order = bubbles.map((_, i) => i).sort(() => Math.random() - 0.5);
  for (const index of order) {
    const slip = makeTypo(bubbles[index]);
    if (slip) return { index, ...slip };
  }
  return null;
}

/**
 * 回复一段话。像人一样：拆成气泡，按字数“打字”，群里忙的时候引用原消息，偶尔手滑。
 * opts.credit：模型已经想了多久，这段时间算进第一个气泡的打字时间里。
 * opts.casual：是闲聊回复（才允许手滑），报错/命令回显不要。
 */
async function reply(ev, text, opts = {}) {
  if (!text) return;
  const bubbles = opts.whole ? [String(text).trim()] : humanBubbles(text); // whole：清单类消息别拆成一行一个气泡
  const slip = opts.casual ? planSlip(bubbles) : null;
  let credit = opts.credit || 0;
  for (let i = 0; i < bubbles.length; i++) {
    const wait = Math.max(0, typingDelayMs(bubbles[i], cfg.typingMsPerChar) - credit);
    credit = 0;
    if (wait > 0) {
      showTyping(ev);
      await sleep(wait);
    }
    const chunks = splitText(bubbles[i], 1200);
    for (let c = 0; c < chunks.length; c++) {
      const first = i === 0 && c === 0;
      const how = { quote: first && opts.quote, at: first && opts.at };
      try {
        if (slip && slip.index === i && c === 0) {
          lastTypoAt = Date.now();
          const id = await sendBubble(ev, slip.typo, how);
          await sleep((1200 + Math.random() * 1400) * pace());
          if (id && Math.random() < 0.5) {
            try {
              await sendRaw({ action: 'delete_msg', params: { message_id: id } });
              await sleep((600 + Math.random() * 600) * pace());
              await sendBubble(ev, chunks[c], how);
              continue;
            } catch (err) {
              log('撤回失败，改成补正:', err.message);
            }
          }
          await sendBubble(ev, slip.fix);
        } else {
          await sendBubble(ev, chunks[c], how);
        }
      } catch (err) {
        log('发送回复失败:', err.message);
        return;
      }
      await sleep(150 * pace());
    }
  }
}

/**
 * 把模型的原始输出发出去：先发文字，再补表情（表情标签一个不留，多写了也只发一张）。
 * opts.autoMood：模型没点表情时，按梗补一张的概率（发表情包在 speech 插件里，没装就不发）。
 */
async function say(target, raw, opts = {}) {
  // 模型输出里的标记（[语音] [唱歌] [表情:xx] [心情:xx] 电台……）由各插件在 say:extract 里抠掉、记进 tags；
  // 正文谁接手发（语音插件）在 say:send 里定，没人接就打字；发完 say:after 里补唱歌、表情包。
  const { text, tags } = pipe('say:extract', { text: String(raw ?? ''), tags: {} });
  if (!(await first('say:send', target, text, tags, opts)) && text) await reply(target, text, opts);
  await emit('say:after', target, text, tags, opts);
  return text;
}
// [电台:…]（10）在她自己的生活（life）插件里抠
on('say:extract', ({ text, tags }) => ({ text: extractMoodTag(text).text, tags }), 20);
// [唱歌] [语音] [表情:xx] 是人设里教它写的标记，本体照样抠掉、记进 tags（没装 speech 插件也不会原样发出去，
// 心情那边没话说时补的 [表情:开心] 也是）；真正去唱、发语音、发表情包在 speech 插件的 say:send / say:after 里。
on('say:extract', ({ text, tags }) => {
  const sg = extractSing(text);
  return { text: sg.text, tags: { ...tags, sing: sg.sing } };
}, 30);
on('say:extract', ({ text, tags }) => {
  const v = extractVoice(text);
  return { text: v.text, tags: { ...tags, voice: v.voice, tone: v.tone } };
}, 40);
on('say:extract', ({ text, tags }) => {
  const s = extractStickers(text);
  return { text: s.text, tags: { ...tags, moods: s.moods } };
}, 50);

/** 点个表情回应对方那条消息（“嗯嗯/哈哈”这种不值得再回一句）。 */
const REACT_IDS = { laugh: ['178', '4', '12'], ok: ['76', '14', '66'] };
async function reactTo(ev, kind) {
  if (!ev.message_id) return false;
  try {
    await sendRaw({
      action: 'set_msg_emoji_like',
      params: { message_id: ev.message_id, emoji_id: pick(REACT_IDS[kind] || REACT_IDS.ok) },
    });
    return true;
  } catch (err) {
    log(`表情回应失败: ${err.message}`);
    return false;
  }
}
function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}
async function sendPrivate(qq, text) {
  return sendRaw({
    action: 'send_private_msg',
    params: { user_id: Number(qq), message: [{ type: 'text', data: { text } }] },
  });
}

// ── 心情 ─────────────────────────────────────────────────────────────────
// 聊天、自己找事做时，模型觉得心情变了就在最后写 [心情:词|为啥]（本体抠掉，不发出去）。
// 先过 mood:changed：开着 ChronoLife（她自己的生活，life 插件）让它记一笔，“没回”“冷落”这种它自己管、返回 true 就到此为止；
// 心情有来由、会延续几个小时在心情和作息（mood 插件）里。两个都没装就只是抠掉。
function moodChanged(mood, reason, chatKey = '') {
  if (pipe('mood:changed', false, mood, reason, chatKey)) return;
  use('mood')?.setEmotion(mood, reason, chatKey);
}
/**
 * 现在的她：按时段的日常心情（开着 ChronoLife 就跟着它）；被事情影响了的心情、熬夜后犯困由心情和作息（mood 插件）在 state:mood 里换上
 * （chatKey 是那件事的聊天才告诉为啥）。没装 mood 就只有按时段的。
 */
function myState(chatKey = '') {
  const s = selfState();
  const life = use('life')?.state() || null; // ChronoLife（她自己的生活，life 插件）
  if (life?.settings.enabled) {
    s.mood = life.mode === 'rest' ? '困' : life.valence < .4 ? '有点丧' : life.arousal > .7 ? '兴奋' : life.valence > .7 ? '开心' : '平静';
    s.energy = life.arousal;
    s.energyDesc = life.arousal < .3 ? '安静，慢慢聊' : '精神平稳';
    if (life.emotionReason && (life.emotionScope === 'global' || life.emotionScope === chatKey)) s.reason = life.emotionReason;
    return s;
  }
  return pipe('state:mood', s, chatKey);
}

async function checkReminders() {
  if (!ws || ws.readyState !== 1) return;
  const due = reminders.filter((r) => r.at <= Date.now());
  if (!due.length) return;
  for (const r of due) {
    try {
      await sendPrivate(r.qq, `该${r.text}了`);
    } catch (err) {
      log(`提醒发送失败 ${r.qq}: ${err.message}`);
    }
  }
  for (let i = reminders.length - 1; i >= 0; i--) {
    if (reminders[i].at <= Date.now()) reminders.splice(i, 1);
  }
  saveReminders();
}

/**
 * 把模型输出收拾成正常人打字的样子：
 * 去掉"收到，"这类开头、markdown 装饰和不必要的句号。
 */
function humanize(text) {
  let t = String(text || '').trim();
  if (!t) return t;
  t = t.replace(/^(收到|好的|没问题|明白了?|行吧)[，,。.!！~～\s]+/u, '');
  // 代码块原样保留，圈外只做轻量去装饰
  t = t
    .split(/(```[\s\S]*?```)/)
    .map((part, i) => {
      if (i % 2 === 1) return part;
      return part
        .replace(/^#{1,6}\s+/gm, '')
        .replace(/\*\*(.+?)\*\*/g, '$1')
        .replace(/^\s*[-*+]\s+/gm, '')
        .replace(/^\s*\d+[.、)]\s+/gm, '')
        .replace(/`([^`\n]+)`/g, '$1');
    })
    .join('');
  t = t.replace(/[。.]+$/u, '');
  return t.trim();
}
/** 一行一句就拆成几个气泡，最多 4 条；代码块不拆。 */
function humanBubbles(text) {
  const t = String(text || '').trim();
  if (!cfg.humanSplit || t.length > 260 || t.includes('```')) return [t];
  const pieces = t
    .split(/\n+/)
    .flatMap((p) => p.split(/(?<=[。！？!?…])\s*/u))
    .map((s) => s.trim())
    .filter(Boolean);
  if (pieces.length <= 1) return [t];
  // 最多 4 个气泡；超出的并进最后一个，别把内容吞了。
  return pieces.length > 4 ? [...pieces.slice(0, 3), pieces.slice(3).join(' ')] : pieces;
}
function splitText(text, limit) {
  const out = [];
  let rest = text.trim();
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit);
    if (cut < limit * 0.5) cut = limit;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  if (rest) out.push(rest);
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Agent invocation ──────────────────────────────────────────────────────
/**
 * 杀掉一个子进程连同它开出来的子进程。Windows 上 child.kill() 只杀 dsh 自己，它敲的命令（node、python、powershell）会留下来
 * 接着跑、还攥着会话的写锁，所以用 taskkill /T /F 杀整棵树；别的系统照旧 kill。已经退出的不碰（PID 可能被别人用了）。
 */
function killTree(child) {
  return new Promise((resolve) => {
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return resolve();
    if (process.platform !== 'win32') {
      try {
        child.kill();
      } catch {}
      return resolve();
    }
    try {
      const k = spawn('taskkill', ['/T', '/F', '/PID', String(child.pid)], { windowsHide: true, stdio: 'ignore' });
      k.on('error', () => {
        try {
          child.kill();
        } catch {}
        resolve();
      });
      k.on('close', resolve);
    } catch {
      try {
        child.kill();
      } catch {}
      resolve();
    }
  });
}
/** 会话本身没了 / 坏了（dsh 的报错：session "…" not found、stored session … failed validation 这些）才值得丢掉重开；超时、起不来这种不是会话的错。 */
const SESSION_GONE = /session[^\n]{0,160}?(not found|was not found|failed validation|identity mismatch|unknown to this harness|unsupported legacy|shrank below)|SessionFormatUnsupported|raw log:/i;
/** opts.permissionMode：这一次调用单独降权（比如群里插嘴只让它聊天，不让碰工具）。 */
function runAgent(prompt, sessionId, opts = {}) {
  return new Promise((resolve, reject) => {
    const args = ['--profile', 'headless'];
    if (opts.patch) args.push('--patch', opts.patch);
    args.push('--json');
    if (sessionId) args.push('--session-id', sessionId);
    args.push(prompt);

    const childEnv = { ...process.env, DSH_HOME: cfg.dshHome };
    // 她在命令行里敲的 node（刷 B站、听歌那些脚本）要跟 bridge 用同一个：离线安装包自带的 Node 不在系统 PATH 里
    const pathKey = Object.keys(childEnv).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
    childEnv[pathKey] = `${path.dirname(process.execPath)}${path.delimiter}${childEnv[pathKey] || ''}`;
    const mode = opts.permissionMode || cfg.permissionMode;
    if (mode) childEnv.DSH_PERMISSION_MODE = mode;
    if (cfg.apiKey) childEnv.DEEPSEEK_API_KEY = cfg.apiKey;
    else delete childEnv.DEEPSEEK_API_KEY;

    // The Windows file sandbox forbids anonymous pipes between processes, so
    // child stdout/stderr go to files in data/ instead of 'pipe'.
    const stamp = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const outPath = path.join(DATA_DIR, `run-${stamp}.out`);
    const errPath = path.join(DATA_DIR, `run-${stamp}.err`);
    const outFd = fs.openSync(outPath, 'w');
    const errFd = fs.openSync(errPath, 'w');

    const child = spawn(process.execPath, [cfg.dshCli, ...args], {
      cwd: cfg.agentCwd,
      env: childEnv,
      windowsHide: true,
      stdio: ['ignore', outFd, errFd],
    });

    let settled = false;
    let timer;
    const unlinkOut = () => {
      for (const file of [outPath, errPath]) {
        try {
          fs.unlinkSync(file);
        } catch {}
      }
    };
    const cleanup = () => {
      clearTimeout(timer);
      for (const fd of [outFd, errFd]) {
        try {
          fs.closeSync(fd);
        } catch {}
      }
    };
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      // 超时 / 出错时它还在跑：整棵进程树一起杀掉（它敲的命令、刷 B站 的脚本这些子进程也别留着占会话的锁），杀完再删输出文件
      killTree(child).then(unlinkOut, unlinkOut);
      fn(value);
    };
    timer = setTimeout(() => settle(reject, new Error(`处理超时（${cfg.timeoutMs / 1000}s）`)), cfg.timeoutMs);

    child.on('error', (err) => settle(reject, err));
    child.on('close', (code) => {
      if (settled) return;
      let stdout = '';
      let stderr = '';
      try {
        stdout = fs.readFileSync(outPath, 'utf8');
      } catch {}
      try {
        stderr = fs.readFileSync(errPath, 'utf8').slice(-4000);
      } catch {}
      let finalText = null;
      let session = sessionId || null;
      let errorText = null;
      let ctx = 0; // 最后一步带了多大的上下文（新算的 + 缓存命中的，token）：看会话有没有被压缩
      for (const line of stdout.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line);
          if (ev.type === 'session' && ev.sessionId) session = ev.sessionId;
          if (ev.type === 'final') finalText = ev.text ?? '';
          if (ev.type === 'error' && ev.message) errorText = ev.message;
          if (ev.type === 'status' && ev.phase === 'step_end' && ev.usage) {
            const u = ev.usage;
            ctx = (u.inputTokens || 0) + (u.cacheReadTokens || 0) + (u.cacheWriteTokens || 0) || ctx;
          }
        } catch {
          /* non-JSON line: ignore */
        }
      }
      if (code === 0 && finalText !== null) {
        settle(resolve, { text: finalText, session, ctx });
      } else {
        const detail = (errorText || stderr.trim().split('\n').slice(-3).join(' | ') || `退出码 ${code}`).slice(0, 500);
        settle(reject, new Error(detail));
      }
    });
  });
}

const chains = new Map();
const activeChats = new Set();
function runQueued(key, task) {
  const prev = chains.get(key) || Promise.resolve();
  const next = prev.then(task, task);
  chains.set(key, next.then(
    () => undefined,
    () => undefined,
  ));
  return next;
}

async function handleEvent(ev) {
  if (ev.self_id) selfId = ev.self_id;
  if (selfId && ev.user_id === selfId) return;
  if (cfg.maxAgeSec > 0 && ev.time && Date.now() / 1000 - ev.time > cfg.maxAgeSec) return;

  ev._seenAt = Date.now();
  const segs = segments(ev.message);
  rememberMsg(ev.message_id, { uid: String(ev.user_id), name: senderName(ev), text: textOf(segs) || '（图）', self: false });
  await emit('message:seen', ev, segs);
  const isGroup = ev.message_type === 'group';
  let wokeWord = '';
  if (isGroup) {
    // 群聊插件决定这条群消息理不理（白名单、@、叫名字、接着说、插嘴）；没装群聊插件就一概不理
    const g = await first('message:group', ev, segs);
    if (!g) return;
    wokeWord = g.wokeWord || '';
  } else if (!cfg.allowedQQ.includes(String(ev.user_id))) {
    log(`忽略未授权私聊: ${ev.user_id}`);
    return;
  }
  if (await first('message:raw', ev, segs)) return; // 插件整条接手（比如合并转发）
  // Remove the @bot segment so the prompt is clean.
  const clean = segs.filter((s) => !(s.type === 'at' && String(s.data?.qq) === String(selfId)));
  const images = await saveImages(clean, ev);
  let text = textOf(clean);
  if (wokeWord) text = text.replace(wokeWord, '').replace(/^[，,。.!！~～\s]+/, '').trim();
  const quote = await resolveQuote(segs, ev);
  if (quote) {
    images.push(...quote.images);
    text = `（${quote.desc}）\n${text || '（只引用了，没说别的）'}`;
  }
  const media = await readMedia(clean, ev);
  if (media) {
    images.push(...media.images);
    text = text ? `${media.note}\n${text}` : media.note;
  }
  // 分享来的东西（卡片、打的链接）：装了的插件可以去真看一眼（life 插件看 B站视频），看到的写在这句后面
  const shared = cfg.shareCards ? await first('message:share', ev, { cards: cardsOf(clean), text, isBili: isBiliCard }) : null;
  if (shared) text = `${text}\n${shared}`;
  const voice = await readVoice(clean, ev);
  if (voice?.failed && !text && !images.length) {
    await reply(ev, pick(DEAF_LINES)); // 只发了条语音、又没听成：直接让对方打字，不用过模型
    return;
  }
  if (voice) text = voice.note ? (text ? `${voice.note}\n${text}` : voice.note) : `${text}\n（还发了条语音，没听清）`.trim();
  if (!text && images.length === 0) {
    if (wokeWord) {
      await reply(ev, '在');
      return;
    }
    return;
  }
  if (!text) text = '（发来图片）';
  if (text.length > cfg.maxPrompt) text = text.slice(0, cfg.maxPrompt) + '\n…（已截断）';

  const chatKey = isGroup ? `g${ev.group_id}:u${ev.user_id}` : `u${ev.user_id}`;
  const who = `${senderName(ev)}(${ev.user_id})`;
  const msg = { segs, isGroup, chatKey, who, images, wokeWord };
  if (await first('message:command', ev, text, msg)) return; // 插件的命令（/日记 /唱歌 ……），不调模型
  if (text === '/help' || text === '/帮助') {
    await reply(ev, helpText(ev), { whole: true });
    return;
  }
  if (text === '/new' || text === '/reset') {
    if (sessions[chatKey]) {
      delete sessions[chatKey];
      saveSessions();
    }
    await reply(ev, '行，重新开始');
    return;
  }
  if (text === '/status') {
    // 给主人排错用的“后台”命令，所以这里可以露数字；/心情 就只说人话。
    const st = userState(ev.user_id);
    await reply(
      ev,
      `在线 · 活跃任务 ${activeRuns} · 会话 ${Object.keys(sessions).length} · 模型 deepseek-flash\n` +
        `熟悉度 ${familiarity(closeness(st)).tier} · 综合分 ${Math.round(closeness(st))}（${st.days} 天 ${st.turns} 轮）`,
    );
    return;
  }

  // ── 小互动命令（不调模型，省钱）─────────────────────────────────────
  const st = userState(ev.user_id);
  st.lastUserAt = Date.now();
  await emit('message:user', ev, st, msg); // 对方开口了（被冷落的小情绪……），saveState 在下面
  st.ignored = 0; // “主动找了几次没回”清零。放在 message:user 后面：被冷落（mood 插件）要看清零前的数
  const today = dayKey();
  if (st.lastDay !== today) {
    st.lastDay = today; // 每天头一次说话算一天，混得越久越熟
    st.days += 1;
    st.affection += 1;
  }
  saveState();
  if (await first('message:turn', ev, text, msg)) return; // 插件接手这一轮（点电台……），不进普通聊天
  if (/^\/(喂鱼|摸摸|rua|摸鱼)$/i.test(text)) {
    st.affection += 1;
    saveState();
    await reply(ev, pick(['行吧，摸一下', '喏，喂你一口', '别摸了，掉鳞', '哼，勉强让你摸', '再摸要收费了']));
    return;
  }
  if (text === '/心情' || text === '/亲密度') {
    const me = myState(chatKey);
    const fam = familiarity(closeness(st));
    // 像人被问“心情咋样”那样回，不报数字（数字在 /status）
    const moodLine = {
      平静: '还行 没啥事',
      开心: '挺好 心情不错',
      懒: '懒 不想动',
      无聊: '无聊 闲得慌',
      嘴贫: '想找人贫两句',
      烦: '有点烦 别惹我',
      兴奋: '有点上头',
      有点丧: '有点丧',
      困: '困死了',
      委屈: '有点委屈',
      生气: '有点生气 别惹我',
    }[me.mood] || '还行';
    const tired = me.energy < 0.3 ? '\n眼皮在打架' : me.energy < 0.55 ? '\n没啥精神' : '';
    const us = { 刚认识: '你嘛 还在观察', 一般熟: '跟你还行', 熟: '跟你挺熟了', 很熟: '跟你还用说' }[fam.tier] || '';
    await reply(ev, `${moodLine}${me.reason ? ` ${me.reason}` : ''}${tired}${us ? `\n${us}` : ''}`);
    return;
  }
  if (text === '/提醒' || text === '/提醒列表') {
    const mine = reminders.filter((r) => r.qq === String(ev.user_id) && r.at > Date.now());
    await reply(
      ev,
      mine.length
        ? mine
            .map((r) => `${new Date(r.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} ${r.text}`)
            .join('\n')
        : '没提醒',
    );
    return;
  }
  const rm = text.match(/^\/提醒\s+(\d+)\s*(m|分钟|h|小时|min|hour)?\s+(.+)$/i);
  if (rm) {
    const n = Number(rm[1]);
    const unit = (rm[2] || 'm').toLowerCase();
    const isHours = unit.startsWith('h') || unit === '小时';
    addReminder(ev.user_id, Date.now() + n * (isHours ? 3600_000 : 60_000), rm[3].trim());
    await reply(ev, `行，${n}${isHours ? '小时' : '分钟'}后叫你`);
    return;
  }

  // 只是“嗯嗯/哈哈”的附和，点个表情回应就行，不用再调模型回一句（上一句是问句时除外）。
  if (cfg.react && !images.length && !batches.has(chatKey) && !activeChats.has(chatKey)) {
    const kind = ackKind(text);
    const last = lastAnswer.get(chatKey);
    if (kind && last && Date.now() - last.at < 10 * 60_000 && !looksLikeQuestion(last.text) && Math.random() < cfg.reactProb) {
      if (await reactTo(ev, kind)) {
        log(`← ${who}: （表情回应「${text}」）`);
        appendMemory(chatKey, text, '（点了个表情回应）');
        return;
      }
    }
  }

  log(`→ ${who}: ${text.slice(0, 80).replace(/\n/g, ' ')}${text.length > 80 ? '…' : ''}${images.length ? ` [图${images.length}]` : ''}`);
  enqueueTurn(chatKey, { ev, text, images, isGroup, who });
}

// ── 连发合并 + 睡觉时段慢回 ───────────────────────────────────────────────
// 真人看到你连发三条，是等你说完再回一次，而不是回三遍。每个聊天攒一个批次，
// 安静 MERGE_MS 之后一起交给模型；睡觉时段（SLEEP_START~SLEEP_END）有一定概率晚几分钟再回。
const batches = new Map(); // chatKey -> { parts, firstAt, extra, timer }
const lastAnswer = new Map(); // chatKey -> { text, at }，判断“好的”是不是在回答问题
const busyRuns = new Map(); // chatKey -> { since, nudges, lastNudge, noted }：正在回的这一轮
const BUSY_LINES = ['等下 上一个还没弄完', '手上还有一个 等我下', '别急 一个一个来'];

/** 这一轮真忙了挺久（看视频、弄手机这种）对方又来消息，才吭一声，一轮最多一次；平常回得慢点不用解释。 */
function noteBusy(chatKey, ev) {
  const run = busyRuns.get(chatKey);
  if (!run || run.noted || Date.now() - run.since < cfg.busyNoteMs) return;
  run.noted = true;
  run.nudges++; // 跟看门狗的“还在弄”算在一起，别接连冒两句
  run.lastNudge = Date.now();
  reply(ev, pick(BUSY_LINES)).catch(() => {});
}
const IMG_ONLY = '（发来图片）';

function sleepDelayMs() {
  if (!asleep() || !cfg.sleepDelayProb || Math.random() >= cfg.sleepDelayProb) return 0;
  return Math.round(60_000 + Math.random() * 240_000);
}
let markReadFails = 0;
function markRead(ev) {
  if (!cfg.markRead || ev.message_type === 'group' || markReadFails >= 3) return;
  sendRaw({ action: 'mark_private_msg_as_read', params: { user_id: ev.user_id } })
    .then(() => {
      markReadFails = 0;
    })
    .catch(() => {
      markReadFails++;
    });
}

function enqueueTurn(chatKey, item) {
  const now = Date.now();
  let b = batches.get(chatKey);
  if (!b) {
    b = { parts: [], firstAt: now, extra: item.isGroup ? 0 : sleepDelayMs(), timer: null };
    batches.set(chatKey, b);
    markRead(item.ev);
    if (b.extra) log(`${item.who} 睡觉时段，晚 ${Math.round(b.extra / 1000)}s 再回`);
  }
  b.parts.push(item);
  clearTimeout(b.timer);
  const wait = mergeWaitMs(item.text, item.images.length > 0, cfg.mergeMs);
  const at = Math.min(Math.max(now + wait, b.firstAt + b.extra), b.firstAt + b.extra + cfg.mergeMaxMs);
  b.timer = setTimeout(() => flushTurn(chatKey), Math.max(0, at - now));
}

function flushTurn(chatKey) {
  const b = batches.get(chatKey);
  if (!b) return;
  // 上一轮还没回完（模型还在想，或者正一段段“打字”发出去）：新消息先攒着，回完一起看、一起回，
  // 跟真人一样，不用每来一条就喊一声“等下”。
  if (activeChats.has(chatKey)) {
    noteBusy(chatKey, b.parts[b.parts.length - 1].ev);
    b.timer = setTimeout(() => flushTurn(chatKey), 1000);
    return;
  }
  batches.delete(chatKey);
  const last = b.parts[b.parts.length - 1];
  const real = b.parts.filter((p) => p.text !== IMG_ONLY);
  let text = (real.length ? real : b.parts).map((p) => p.text).join('\n');
  if (text.length > cfg.maxPrompt) text = text.slice(0, cfg.maxPrompt) + '\n…（已截断）';
  if (b.parts.length > 1) log(`${last.who} 连发 ${b.parts.length} 条，合成一轮`);
  processTurn({
    ev: last.ev,
    text,
    images: b.parts.flatMap((p) => p.images).slice(0, 6),
    isGroup: last.isGroup,
    chatKey,
    who: last.who,
    ids: b.parts.map((p) => p.ev.message_id),
    stickers: b.parts.flatMap((p) => p.ev._stickers || []),
  }).catch((err) => log('处理失败:', err.stack || err.message));
}

const FAIL_TIMEOUT = ['想太久了，脑子转不动，你再说一遍', '这个我一时半会弄不完，卡住了', '超时了，换个简单点的说法再来一遍'];
const FAIL_OTHER = ['我这边掉线了一下，等会儿你再说一遍', '脑子短路了，再发一次', '刚才断了一下，再来一遍'];
const failLine = (err) => pick(/超时/.test(err.message) ? FAIL_TIMEOUT : FAIL_OTHER);

/** 群里别人又说了好几句，它的回复就引用原消息；等太久也会 @ 一下。 */
function groupMovedOn(ev) {
  const newer = (groupBuf.get(String(ev.group_id)) || []).filter((e) => !e.self && e.at > (ev._seenAt || 0)).length;
  return newer >= 2 || Math.random() < 0.1;
}

async function processTurn({ ev, text, images, isGroup, chatKey, who, ids, stickers = [] }) {
  await runQueued(chatKey, async () => {
    activeChats.add(chatKey);
    const run = { since: Date.now(), nudges: 0, lastNudge: 0, noted: false };
    busyRuns.set(chatKey, run);
    // 长任务/锁屏卡住时，每 60 秒冒个泡，最多两次（刚说过“手上还有一个”就跳过这次），别让对面干等。
    const watchdog = setInterval(() => {
      if (run.nudges >= 2 || Date.now() - run.lastNudge < 40_000) return;
      run.nudges++;
      run.lastNudge = Date.now();
      reply(ev, pick(['还在弄', '等下，有点慢', '别急，卡了一下'])).catch(() => {});
    }, 60_000);
    const phoneWatch = { on: true };
    const turn = { ev, text, images, isGroup, chatKey, qq: ev.user_id, who, ids, stickers, tags: {}, running: () => phoneWatch.on };
    await emit('turn:start', turn); // 插件在这一轮开始时要做的（手机看门狗、记下要给的明信片……）
    if (cfg.ackPrivate && !isGroup) {
      await reply(ev, '等下');
    }
    activeRuns++;
    try {
      const stickerShown = new Set(stickers.map((x) => x.shown));
      const imgNote = images.length
        ? `\n\n[对方发来 ${images.length} 张图片，已保存到：\n${images.map((x) => (stickerShown.has(x) ? `${x}（表情包）` : x)).join('\n')}\n用 read_image 工具看一下再回（GIF 会拆成多帧拼图 .sheet.png，按帧号顺序看）` +
          collect('prompt:images', turn) +
          ']'
        : '';
      const tRun = Date.now();
      const known = use('life')?.memoryOff() ? null : sessions[chatKey]?.sessionId; // 开着 ChronoLife 但它没起来：不续接旧会话
      // 这段会话里已经有哪些块（没变的不再塞）；新会话就整个发
      let built = buildPrompt(ev, text, isGroup, chatKey, ids, known ? sessions[chatKey]?.sent || null : null);
      let fresh = !known;
      // 权限分级：只有主人私聊用 DSH_PERMISSION_MODE（能动手机、电脑、文件）；别人私聊、群里（谁都一样）只读，只陪聊
      const agentOpts = isOwnerChat(ev) ? {} : { permissionMode: 'read-only' };
      let result;
      try {
        result = await runAgent(built.text + imgNote, known, agentOpts);
      } catch (err) {
        // 只有会话真没了 / 坏了（清过 DSH_HOME、换过 profile）才丢掉重开；超时、起不来这些保留会话，
        // 不整轮重跑（不然一轮超时会变成两轮、还把上下文丢了），下面统一用人设口吻回一句让对方再说一遍。
        if (!known || !SESSION_GONE.test(err.message)) throw err;
        log(`会话 ${known} 不可用，重开: ${err.message}`);
        delete sessions[chatKey];
        saveSessions();
        built = buildPrompt(ev, text, isGroup, chatKey, ids, null); // 新会话里什么都没有：整个重发
        fresh = true;
        result = await runAgent(built.text + imgNote, null, agentOpts);
      }
      if (result.session) {
        const prevCtx = (!fresh && sessions[chatKey]?.ctx) || 0;
        // 这轮带的上下文比上一轮少了一大截：会话被压缩过，前面塞的人设、记得的事可能跟着压成了摘要，下一轮整个重发
        const compacted = !fresh && prevCtx > 50_000 && result.ctx > 0 && result.ctx < prevCtx * 0.6;
        if (compacted) log(`会话 ${result.session} 被压缩过（上下文 ${prevCtx} → ${result.ctx} token），下一轮整个重发提示词`);
        // 跑进了别的会话（没带 known 的那段）也当没塞过，下一轮整个发
        const sent = (fresh || result.session === known) && !compacted ? built.sent : null;
        sessions[chatKey] = { sessionId: result.session, updatedAt: Date.now(), ...(sent ? { sent } : {}), ...(result.ctx ? { ctx: result.ctx } : {}) };
        saveSessions();
      }
      let answer = humanize(result.text);
      if (!answer) {
        // 模型只干活没说话：追一句，让它交代结果，别直接甩“没憋出话”。
        try {
          const retry = await runAgent('对方还在等你回话。用一句话说下刚才的结果，别沉默。', result.session, agentOpts);
          answer = humanize(retry.text);
        } catch (err) {
          log(`补话失败: ${err.message}`);
        }
      }
      if (!answer) answer = '弄完了，就是一时不知道咋说';
      // 回复里给插件的标记（[收表情] [心情] [电台] [照片] [放歌] [收礼物]……）各插件在 turn:answer 里抠掉、记进 turn.tags；
      // 大白话办事的标记（[提醒:…] [写信] [城市:…] ……）本体在 turn:answer 65 抠掉，回完这句再交给 natural:act 去办
      answer = pipe('turn:answer', answer, turn);
      if (turn.tags.natural?.length) log(`大白话标记：${turn.tags.natural.map((a) => (a.body ? `${a.kind}:${a.body.slice(0, 30)}` : a.kind)).join('、')}`);
      log(`← ${who}: ${answer.slice(0, 80).replace(/\n/g, ' ')}${answer.length > 80 ? '…' : ''}`);
      // 记进短期记忆的是发出去的字（标记都去掉），再加上插件补的“（唱了一段……）”这种
      const said = pipe('say:extract', { text: answer, tags: {} });
      const spoken = said.text + collect('turn:spoken', said.tags, turn);
      turn.raw = answer;
      turn.spoken = spoken;
      appendMemory(chatKey, text, spoken || '（发了个表情）');
      await emit('turn:record', turn); // 发之前记账（日记流水……），跟短期记忆同一时刻
      lastAnswer.set(chatKey, { text: spoken, at: Date.now() });
      // 模型自己点了表情就一定发；没点就按梗的概率补一张，别每句都发。
      const slow = Date.now() - tRun > 45_000;
      await say(ev, answer, {
        casual: true,
        credit: Date.now() - tRun,
        autoMood: 0.35,
        quote: isGroup && cfg.groupQuote && groupMovedOn(ev),
        at: isGroup && cfg.groupQuote && slow,
      });
      await emit('turn:after', turn); // 回完之后插件要做的（拍照、放歌、收礼物、追问、点电台、提炼事实……）
      const st = userState(ev.user_id);
      st.turns += 1;
      saveState();
    } catch (err) {
      log(`任务失败 ${who}: ${err.message}`);
      await reply(ev, failLine(err));
    } finally {
      phoneWatch.on = false;
      clearInterval(watchdog);
      activeChats.delete(chatKey);
      busyRuns.delete(chatKey);
      activeRuns--;
    }
  });
}

// [心情:词|为啥]：本体抠掉（没装心情和作息插件也不会原样发出去），心情交给 moodChanged
on('turn:answer', (answer, t) => {
  const mt = extractMoodTag(answer);
  if (mt.mood) moodChanged(mt.mood, mt.reason, t.chatKey);
  return mt.text || '[表情:开心]';
}, 20);

// ── 大白话办事：以前要发斜杠命令的事，现在直接跟她说就行 ─────────────────────────────
// 模型在回复里写个标记（[提醒:30|喝水] [城市:杭州] [写信] [学说话:2] [记住:…] [喇叭:要说的话] [音乐:暂停] [发图:路径] [画:描述]……），
// 本体在 turn:answer 65 把这些标记全抠掉（不管管它的插件装没装，都不会原样发出去），记进 turn.tags.natural；
// 回完这句在 turn:after 32 挨个交给 natural:act（谁管谁办，跟斜杠命令走同一套，谁能办照旧按发消息的人算），
// 她自己已经回过一句了，办成了不另外发“好，30 分钟后提醒你”这种；办不成补一句人设口吻的话。没人接的标记补一句“这个我现在弄不了”。
// 教她写哪些标记：提示词末尾（prompt:hint 50）拼各插件 natural:hint 给的行。斜杠命令照样能用；/new /status 这些排错的不教给模型。
// 本体自己管：[提醒]（提醒在本体）、[发图]（发的是数据目录下几个插件做出来的图，见 PIC_DIRS）。
const NATURAL_RE = /\[(提醒|城市|生日|学说话|记住|忘掉|更正|生活|喇叭|音乐|发图|画)[:：]\s*([^\]]*?)\s*\]|\[(看日记|写信|寄明信片|发说说|别学了)\]/g;
/** 从回复里抠出大白话办事的标记。没冒号的只认这几个，免得把 [生日] 这种别的字吃掉。 */
function extractNatural(raw) {
  const acts = [];
  const text = String(raw || '').replace(NATURAL_RE, (_, k1, body, k2) => {
    const a = { kind: k1 || k2, body: String(body || '').trim() };
    if (!acts.some((x) => x.kind === a.kind && x.body === a.body)) acts.push(a);
    return '';
  });
  return { text: text.replace(/[ \t]+\n/g, '\n').replace(/[ \t]{2,}/g, ' ').trim(), acts };
}
on('turn:answer', (answer, t) => {
  const nat = extractNatural(answer);
  t.tags.natural = nat.acts;
  return nat.text || '行';
}, 65);
// 记进短期记忆的一句：答应了什么（下一轮还记得），按标记的先后问各插件（natural:note）
on('turn:spoken', (tags, t) => (t.tags.natural || []).map((a) => collect('natural:note', a, t)).join(''), 40);
// 回完这句再去办（排在收礼物、给明信片 30 后面，记“问了没回” 35 前面，跟原来一样）
on('turn:after', async (t) => {
  if (t.tags.natural?.length) await runNatural(t.ev, t.tags.natural, { chatKey: t.chatKey, isGroup: t.isGroup, turn: t, pics: 0 });
}, 32);
async function runNatural(ev, acts, ctx) {
  for (const a of acts) {
    try {
      let done = false;
      for (const h of hookList('natural:act')) {
        if (await h.fn(ev, a, ctx)) {
          done = true;
          break;
        }
      }
      if (!done) {
        log(`大白话[${a.kind}]：没装管这个的插件，没办`);
        await reply(ev, '诶 这个我现在弄不了');
      }
    } catch (err) {
      log(`大白话[${a.kind}]没办成: ${err.message}`);
      await reply(ev, '诶 刚答应你的那个没弄成').catch(() => {});
    }
  }
}

// [提醒:时间|内容]
const pad2 = (n) => String(n).padStart(2, '0');
function addReminder(qq, at, text) {
  reminders.push({ qq: String(qq), at, text });
  saveReminders();
}
/** 提醒的时间说成人话：今天 08:00 / 明天 08:00 / 11月3日 08:00。 */
function whenDesc(at) {
  const d = new Date(at);
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const diff = Math.round((Date.parse(dayKey(d)) - Date.parse(dayKey())) / 86400_000);
  return diff === 0 ? `今天 ${hm}` : diff === 1 ? `明天 ${hm}` : diff === 2 ? `后天 ${hm}` : `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}
/**
 * [提醒:时间|内容] 的时间：分钟数（30、2小时、0.5）或钟点（2026-10-29 08:00、10-29 08:00、明天 8:00、21:30）。
 * 得在以后（至少 1 秒）、一年以内；看不懂、已经过了的返回 null。
 */
const REMIND_MAX_MS = 366 * 86400_000;
function parseRemind(body) {
  const [rawWhen, ...rest] = String(body || '').split(/[|｜]/);
  let what = rest.join(' ').replace(/\s+/g, ' ').trim();
  if (/^该.+了$/.test(what)) what = what.slice(1, -1); // 到点发的是“该…了”，别变成“该该喝水了了”
  what = what.slice(0, 100);
  const w = String(rawWhen || '').trim();
  if (!what || !w) return null;
  const now = Date.now();
  const hm = (h, mi) => Number(h) <= 23 && Number(mi || 0) <= 59;
  let at = NaN;
  let m;
  if ((m = w.match(/^(\d+(?:\.\d+)?)\s*(分钟|分|min|m|小时|个小时|h|hour)?后?$/i))) {
    at = now + Number(m[1]) * (/小时|^h|hour/i.test(m[2] || '') ? 3600_000 : 60_000);
  } else if ((m = w.match(/^(?:(\d{4})[-/.年])?(\d{1,2})[-/.月](\d{1,2})[日号]?\s*(\d{1,2})[:：点](\d{1,2})?分?$/))) {
    if (!hm(m[4], m[5])) return null;
    const d = new Date(m[1] ? Number(m[1]) : new Date().getFullYear(), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5] || 0));
    if (d.getMonth() !== Number(m[2]) - 1 || d.getDate() !== Number(m[3])) return null; // 2 月 30 号这种
    at = d.getTime();
  } else if ((m = w.match(/^(今天|明天|后天)?\s*(\d{1,2})[:：点](\d{1,2})?分?$/))) {
    if (!hm(m[2], m[3])) return null;
    const d = new Date();
    d.setHours(Number(m[2]), Number(m[3] || 0), 0, 0);
    d.setDate(d.getDate() + ({ 明天: 1, 后天: 2 }[m[1]] || 0));
    if (!m[1] && d.getTime() <= now) d.setDate(d.getDate() + 1); // 只说了钟点、今天已经过了：算明天的
    at = d.getTime();
  }
  if (!Number.isFinite(at) || at - now < 1000 || at - now > REMIND_MAX_MS) return null;
  return { at, text: what };
}
on('natural:act', async (ev, a, ctx) => {
  if (a.kind === '提醒') {
    const r = parseRemind(a.body);
    if (!r) {
      log(`大白话提醒：看不懂「${a.body.slice(0, 40)}」（时间不对或者已经过了），没设`);
      await reply(ev, pick(['诶 这个时间我没看明白 你再说下几点？', '几点来着 我没整明白 再说一遍']));
    } else {
      addReminder(ev.user_id, r.at, r.text);
      log(`大白话提醒：${ev.user_id} ${whenDesc(r.at)} ${r.text}`);
    }
    return true;
  }
  if (a.kind === '发图') {
    if (++ctx.pics > 3) log('大白话发图：一轮最多发 3 张，多的不发');
    else await sendPicAsked(ev, a.body);
    return true;
  }
  return false;
}, 10);
on('natural:note', (a) => {
  if (a.kind !== '提醒') return '';
  const r = parseRemind(a.body);
  return r ? `（答应了${whenDesc(r.at)}提醒对方：${r.text}）` : '';
});

// [发图:路径]：她截了图（手机截图、看直播的截图、现场照…）想给主人看。
// 只发数据目录下她自己弄出来的图（PIC_DIRS：手机截图、直播截图、现场照、刷 B站 截的帧、信、明信片、画的画，另加 SCENE_DIR），
// 路径解开真实路径后还得在这几个文件夹里面（防 ../ 越界、防链接），要是真有的图片文件、10MB 以内；
// 只在主人私聊里能用（群里、别人私聊都不发，截图可能有主人的隐私）；一轮最多 3 张。发不了就说一句。
const PIC_DIRS = ['shots', 'live', 'scene', path.join('bili', 'frames'), 'letters', 'postcards', 'drawings'];
const PIC_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;
/** 能发就返回 { file: 真实路径 }，不能发返回 { why }。 */
function picAllowed(raw) {
  const p0 = String(raw || '').trim().replace(/^["'“”‘’]+|["'“”‘’]+$/g, '');
  if (!p0) return { why: '没写路径' };
  if (p0.split(/[\\/]+/).includes('..')) return { why: '路径里有 ..' };
  const tries = path.isAbsolute(p0) ? [p0] : [path.resolve(cfg.agentCwd, p0), path.resolve(DATA_DIR, p0)];
  const found = tries.find((f) => fs.existsSync(f));
  if (!found) return { why: '没有这个文件' };
  let real;
  try {
    real = fs.realpathSync(found);
  } catch {
    return { why: '路径解不开' };
  }
  const inside = PIC_DIRS.map((d) => path.join(DATA_DIR, d)).concat(env.SCENE_DIR ? [path.resolve(env.SCENE_DIR)] : []).some((dir) => {
    let base;
    try {
      base = fs.realpathSync(dir);
    } catch {
      return false;
    }
    const rel = path.relative(base, real);
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  });
  if (!inside) return { why: '不在能发的文件夹里' };
  const st = fs.statSync(real);
  if (!st.isFile() || !PIC_EXT.test(real)) return { why: '不是图片' };
  if (st.size > 10 * 1048576) return { why: '太大' };
  return { file: real };
}
async function sendPicAsked(ev, raw) {
  if (!isOwnerChat(ev)) {
    log(`大白话发图：${ev.user_id} 不是主人或者在群里，不发`);
    return void (await reply(ev, '图只能私聊发给主人'));
  }
  const r = picAllowed(raw);
  if (!r.file) {
    log(`大白话发图：没发「${String(raw).slice(0, 80)}」（${r.why}）`);
    return void (await reply(ev, r.why === '没有这个文件' ? '诶 那张图我找不着了' : '那张图发不了'));
  }
  await sleep((600 + Math.random() * 800) * pace());
  await sendMsg(ev, [{ type: 'image', data: { file: 'base64://' + fs.readFileSync(r.file).toString('base64') } }]);
  log(`大白话发图：发了 ${path.basename(r.file)}`);
}

/** 提示词里教她写这些标记（本体的 [提醒] [发图] 加上各插件 natural:hint 给的行）。功能关着的不教；只在对方明确要办的时候写。 */
function naturalHint(t) {
  const uid = String(t.qq);
  let out = '\n- 对方让你过会儿或到点提醒 TA 做什么：写 [提醒:几分钟后|提醒啥]（“半小时后”写 30，“两个小时后”写 120）；说的是钟点就写 [提醒:年-月-日 时:分|提醒啥]（照上面【此刻】的日期时间算，比如“明天早上8点”）。提醒啥写短点，像“喝水”“出门拿快递”，到点会私聊发“该喝水了”。没说什么时候就先问，别自己定。';
  const mine = t.isGroup ? [] : reminders.filter((r) => r.qq === uid && r.at > Date.now()).sort((a, b) => a.at - b.at);
  if (mine.length) out += `\n- 你答应了到点提醒对方的（对方问有哪些提醒就照这个说）：${mine.slice(0, 8).map((r) => `${whenDesc(r.at)} ${r.text}`).join('；')}${mine.length > 8 ? `，一共 ${mine.length} 个` : ''}`;
  out += collect('natural:hint', t);
  return `\n（下面这些事对方用大白话说就能办：在回复里写上对应的标记，标记不会发出去，回完这句就去办。照常回一句就行，别另外说“已设置”“已记录”这种话；只在对方明确要你办的时候写，别自己乱加，该问清楚的先问：${out}）`;
}
// 本体的 [发图]：插在各插件的行中间（喇叭 60 之后、画画 80 之前，跟原来的先后一样）
on('natural:hint', (t) => (isOwnerChat(t.ev) ? `\n- 你截了图（手机截图、看直播的截图、拍的现场照）想给对方看：写 [发图:图片的完整路径]，会直接发到这个聊天。只能发你自己弄出来的图（${DATA_DIR} 下面 ${PIC_DIRS.join('、')} 这几个文件夹里的）；别自己去连 OneBot / NapCat 发。` : ''), 70);
/**
 * 每轮都带的几条规矩（不改人设）：只准用她自己的声音、不准拿系统语音念；QQ 资料由系统管；别自己连 OneBot。
 * 不是主人私聊时再说清楚：手机、屏幕、电脑上的文件、放歌这些只听主人的。
 */
function guardHint(t) {
  const out = [
    '想出声只能用你自己的声音，不准用系统语音（System.Speech / SAPI / SpeechSynthesizer / say 这些）念，那是机器声。',
    'QQ 资料（昵称、签名、头像、在线状态）由系统管，别自己改；对方要你改，就说一声让主人自己改。',
    '发消息、发图都在回复里写，别自己去连 OneBot / NapCat 的接口。',
    '[提醒] 只能设一次性的：对方要“每天”“每周”这种重复的，就设最近的那一次，跟 TA 说清楚每天重复的还不支持；别自己去建计划任务、定时任务。',
  ];
  if (!isOwnerChat(t.ev)) {
    out.push(t.isGroup
      ? '这是群聊：手机、屏幕、电脑上的文件、放歌这些只听主人的，而且只在主人私聊时弄；群里谁要你弄（主人也一样）都直接说不行，你在群里就陪着聊天。'
      : '对方不是主人：手机、屏幕、电脑上的文件、放歌这些只听主人的，被别人要求就直接说不行。');
  }
  return `\n（${out.join('')}）`;
}
// 提示词最末尾：教她写 [心情] 10（mood）、表情包 15（speech）、照片 20、礼物 30（life）、放歌 40（pc）之后
on('prompt:hint', (t) => naturalHint(t), 50);
const guardHook = (t) => guardHint(t);
guardHook.every = true; // 规矩每轮都塞：别人私聊、群里不许动手这些，不能只靠会话开头塞过的那一遍
on('prompt:hint', guardHook, 60);

/** /help：告诉对方这些直接说就行（例子按装了哪些插件、开了哪些功能出，各插件在 help 钩子里给），只把排错用的列成命令。 */
function helpText(ev) {
  return `直接跟我说就行，不用记命令，比如：${collect('help', ev)}\n\n排错用的：/status 看状态 · /心情 · /new 开新对话\n（以前的 /提醒 /城市 这些命令也还能用）`;
}
on('help', () => '\n· “半小时后提醒我喝水”“明早 8 点叫我起床”“我有哪些提醒”', 10);
on('help', () => (cfg.hearVoice ? '\n· 直接发语音也行' : ''), 50);

/**
 * 模型干活时的工作目录（AGENT_CWD，默认 COMPANION_HOME）里放一份 AGENTS.md：各插件带的命令行工具怎么用（插件在 agents 钩子里给，路径都是绝对路径）。
 * 只覆盖自己写的那份（第一行有标记）；用户自己写的 AGENTS.md 不动。
 */
const AGENTS_MARK = '<!-- 由 dsh-companion 生成，装卸插件后会重写；想自己写就删掉这一行 -->';
// 本体的几条规矩排最前面（order 0），各插件的工具说明接在后面
on('agents', () => `
## 几条规矩

- 别读 \`${path.join(HOME, '.env')}\`（里面有密钥）。要看开了哪些功能、现在的设置，用 \`node "${path.join(ROOT, 'scripts', 'features.mjs')}" --text\`。
- 电脑上开网页或软件：只有主人明确让你开、而且主人这会儿在电脑前才开；夜里（安静时段，默认 23 点到早上 9 点）不开。别关别人的程序和窗口，只关你自己开的。
- 每天重复的提醒（“每天早上 8 点叫我”）还不支持：跟对方说清楚现在只能设一次的。别自己用 \`schtasks\` / \`Register-ScheduledTask\` 建计划任务。
- 临时脚本和临时文件只放 \`${path.join(DATA_DIR, 'tmp')}\`；别改插件和内核的代码。
- 别 \`pip install\` / \`npm install -g\`，别自己装软件。缺东西做不了就跟对方说做不了。
- 发消息、发图都在回复里写（发图写 \`[发图:图片的完整路径]\`），别自己去连 OneBot / NapCat 的接口。QQ 资料（昵称、签名、头像、在线状态）由系统管，别自己改。
`, 0);
function writeAgentsMd() {
  if (!env.COMPANION_HOME) return; // 只在装进 DSH 跑时写（测试、开发时工作目录是仓库，别往里写）
  const body = collect('agents');
  const file = path.join(cfg.agentCwd, 'AGENTS.md');
  try {
    if (fs.existsSync(file) && !fs.readFileSync(file, 'utf8').startsWith(AGENTS_MARK)) return;
    if (!body) {
      if (fs.existsSync(file)) fs.rmSync(file); // 插件都卸了：这份也没用了
      return;
    }
    const head = '# 你能用的工具\n\nQQ 发来的图片会下载到本机，绝对路径附在消息里；用 read_image 工具直接看，别用 OCR 硬解。\n';
    fs.writeFileSync(file, `${AGENTS_MARK}\n${head}${body}`);
  } catch (err) {
    log(`AGENTS.md 没写成：${err.message}`);
  }
}

// ── main ──────────────────────────────────────────────────────────────────
// 同一份数据只能有一个内核在跑（不然一条消息回两遍）：data/kernel.pid 里记着正在跑的那个
const PID_FILE = path.join(DATA_DIR, 'kernel.pid');
{
  // 老版本的机器人（agent-bridge 的 bridge.mjs，记在 bridge.pid）在同一份数据上跑着也算；它改跑插件版时两个文件记的是同一个进程
  let other = 0;
  let alive = false;
  for (const f of [PID_FILE, path.join(DATA_DIR, 'bridge.pid')]) {
    other = Number(readJson(f, 0, false)) || 0;
    if (!other || other === process.pid) continue;
    try {
      process.kill(other, 0);
      alive = true;
    } catch (err) {
      alive = err.code === 'EPERM'; // 管理员身份跑的进程，普通身份查会被拒，但它是活的；别的错就是那个进程已经没了
    }
    // pid 可能被别的程序复用了：Windows 上再确认一下那是不是 node
    if (alive && process.platform === 'win32') {
      try {
        alive = /node\.exe/i.test(execFileSync('tasklist', ['/FI', `PID eq ${other}`, '/NH'], { encoding: 'utf8', windowsHide: true }));
      } catch {}
    }
    if (alive) break;
  }
  if (alive) {
    log(`已经有一个内核在跑（进程 ${other}），这个先不起`);
    process.exit(3);
  }
  fs.writeFileSync(PID_FILE, String(process.pid));
  // 由 DSH 里的本体起的：DSH 没了（崩溃、被强行关掉）就跟着退，别留一个没人管的机器人在后台接着回消息
  if (env.COMPANION_CHILD && process.ppid > 1) {
    const parent = process.ppid;
    setInterval(() => {
      try {
        process.kill(parent, 0);
      } catch {
        log('DSH 已经退出，内核跟着退');
        process.exit(0);
      }
    }, 5000).unref();
  }
  process.on('exit', () => {
    try {
      if (Number(fs.readFileSync(PID_FILE, 'utf8')) === process.pid) fs.rmSync(PID_FILE);
    } catch {
      /* 删不掉就算了，下次启动会看进程还在不在 */
    }
  });
}
if (!fs.existsSync(cfg.dshCli)) {
  console.error(`找不到 dsh CLI: ${cfg.dshCli}\n请在 .env 设置 DSH_CLI=<...>/lib/bin.js`);
  process.exit(1);
}
if (cfg.allowedQQ.length === 0 && cfg.allowedGroups.length === 0) {
  log('警告：ALLOWED_QQ / ALLOWED_GROUPS 都为空，所有消息都会被忽略。');
}
log(`DSH: ${cfg.dshCli}`);
log(`工作目录: ${cfg.agentCwd}`);
log(`白名单: QQ=[${cfg.allowedQQ.join(',')}] 群=[${cfg.allowedGroups.join(',')}]`);
backfillCloseness();
applyClosenessSet(); // 要在补齐之后：目标分是按补齐后的自然分来算的

// 插件拿到的东西：内核的状态、发消息、调模型、拼提示词用的小工具，加上登记钩子 / 服务 / 定时任务的方法。
// 只放插件真用得到的；插件之间不直接 import，要用别人的东西走 use('服务名')。
const api = {
  cfg, env, parseList, human, ROOT, DATA_DIR, log, readJson, writeAtomic, pick, sleep, pace,
  state, saveState, userState, closeness, sessions, saveSessions,
  persona, memoryFile, readMemory, appendMemory, diaryToday, addDiary,
  online: () => !!ws && ws.readyState === 1, selfId: () => selfId,
  sendRaw, sendMsg, sendPrivate, reply, say, showTyping, recordGroup, segments, textOf, typedOf, parseCard, senderName,
  groupContext, mentions, quotesMe, activeChats, batches, owner: () => ownerQQ(), isOwnerChat, // 主人是谁、是不是主人私聊（权限分级都认这个）
  runAgent, runQueued, runPyJson, downloadTo, saveImages, humanize, humanBubbles,
  myState: (...a) => myState(...a), quiet: () => quietNow(), lifeBlock: (...a) => lifeBlock(...a),
  moodChanged: (...a) => moodChanged(...a), // 抠出 [心情:词|为啥] 后交给它（自己找事做那边用）
  activeRuns: () => activeRuns, lastAnswer, markRead, // 正在回的轮数、每个聊天上一句回了啥（判断“好的”是不是在回答问题）、标已读
  on, collect, emit, first, pipe, provide, use, every,
};
for (const p of JSON.parse(env.COMPANION_MODULES || '[]')) {
  loadingPlugin = p.id;
  try {
    const mod = await import(pathToFileURL(path.resolve(p.file)).href);
    await mod.default(api, p.config || {});
    plugins.push(p);
  } catch (err) {
    log(`插件 ${p.id} 没加载上：${err?.stack || err?.message || err}`);
  }
}
loadingPlugin = 'core';
log(`插件：${plugins.map((p) => p.id).join('、') || '（没装）'}`);
await emit('startup');
writeAgentsMd();
connect();
for (const t of timers) {
  const run = () => Promise.resolve().then(t.fn).catch((err) => log(`插件 ${t.from} 的定时任务出错：${err?.message || err}`));
  if (t.first !== undefined) setTimeout(run, t.first);
  setInterval(run, t.ms);
}

// 提醒每 REMINDER_CHECK_MS（默认 30 秒）查一次。主动找人（早安晚安、回访、戳你、等你回、写信）在 proactive 插件里。
setInterval(checkReminders, cfg.reminderCheckMs);

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    stopped = true;
    log('退出中…');
    try {
      ws?.close();
    } catch {}
    saveSessions();
    collect('shutdown'); // 插件退出前要收拾的（关 ChronoLife 的数据库……），同步跑一遍
    process.exit(0);
  });
}

// 静默崩溃太难受：至少把原因写进 bridge.log。
process.on('uncaughtException', (err) => {
  log('未捕获异常:', err?.stack || String(err));
});
process.on('unhandledRejection', (err) => {
  log('未处理拒绝:', err?.stack || String(err));
});
