/**
 * 她自己的生活：ChronoLife 小屋（chronolife/）、自己找事做（刷 B站 bili/、刷知乎微博听歌看番 life/）、做梦、人设成长（睡前反思）、
 * 深夜电台（radio.mjs、radio/）、旅行明信片（postcard/）、现场照（scene/）、收礼物；命令 /生活 /明信片，点电台。
 * 设置：CHRONOLIFE / CHRONOLIFE_TIMEZONE / CHRONOLIFE_TICK_MINUTES / CHRONOLIFE_PROACTIVE（测试用 CHRONOLIFE_CHECK_MS）、
 * AUTONOMY / AUTONOMY_*、DREAM / DREAM_*、REFLECT / REFLECT_HOUR / REFLECT_CHECK_MS / SELF_MAX / SELF_FORGET_DAYS / RECENT_FORGET_DAYS、
 * RADIO / RADIO_*、POSTCARD / POSTCARD_*、PHOTO / PHOTO_MAX_DAY / SCENE_DIR、LETTER_IMAGE_MODEL（收礼物画图，跟信纸用同一个）、LETTER_FONT（测试用 GIFT_RAW_FILE）。
 * 主动找谁（PROACTIVE_QQ）、找了几次没回就先不找（IGNORE_LIMIT）、主人是谁（PC_OWNER）、睡觉时段还在本体。
 * 提供服务：life（state / recentEvents / memoryOff / doing / selfBlock / takeDream / tripTo）、photo（compose / dir）。
 * 没装这个插件：本体照常聊天，心情只按时段，这些都当没有。
 * node:sqlite（ChronoLife）只在开着 CHRONOLIFE 时才 import：老的 Node 22 没有它，静态 import 会让整个内核起不来。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseVideoRef } from './bili/lib.mjs';
import { createRadio, radioRequest, extractRadioTag, parseAsk, findRadioSong, radioAgo } from './radio.mjs';
import { genImage } from './imagegen.mjs';
import { chronoSettings } from './chronolife/settings.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BILI = path.join(HERE, 'bili', 'bili.mjs');
const LIFE = path.join(HERE, 'life', 'life.mjs');

/** 这个插件的设置（默认值只写在这里）：setup 里挂到 cfg 上；功能页（本体的 scripts/features.mjs）不跑 setup 也能拿到同样的值。 */
export function settings(env, parseList) {
  return {
    ...chronoSettings(env), // ChronoLife 的几项（chronolife/settings.mjs，定时任务的 worker.mjs 也用）
    autonomy: (env.AUTONOMY || 'false') === 'true',
    autonomyMinutes: Number(env.AUTONOMY_MINUTES || 45), // 两次自己玩之间至少隔多久
    autonomyMax: Number(env.AUTONOMY_MAX || 8), // 一天最多自己玩几次
    autonomyRollProb: Number(env.AUTONOMY_ROLL_PROB ?? 0.35), // 每小时掷骰子“想不想玩”的基础概率（再按心情/精神调）
    autonomyIdleMin: Number(env.AUTONOMY_IDLE_MIN ?? 20), // 对方这么多分钟内找过它，这小时就不自己玩（在陪人聊呢）
    autonomyHours: (env.AUTONOMY_HOURS || '10-23').split('-').map(Number), // 自己找事做的时段
    autonomyRollWindowMin: Number(env.AUTONOMY_ROLL_WINDOW_MIN ?? 45), // 每小时在前多少分钟里随机掷骰子
    autonomyCheckMs: Number(env.AUTONOMY_CHECK_MS ?? 300_000),
    reflect: (env.REFLECT || 'true') !== 'false', // 生活 → 反思 → 人设成长
    reflectHour: Number(env.REFLECT_HOUR ?? 22), // 每天几点后回想一次
    reflectCheckMs: Number(env.REFLECT_CHECK_MS ?? 600_000),
    selfMax: Number(env.SELF_MAX ?? 30), // “最近的自己”最多几条
    selfForgetDays: Number(env.SELF_FORGET_DAYS ?? 14), // 多久没再印证就忘掉
    recentForgetDays: Number(env.RECENT_FORGET_DAYS ?? 5), // “最近在看”忘得快
    // 深夜电台：点一期，她录两三分钟的语音节目（节目卡 + 推荐一首歌）。没开语音就发文字版
    radio: (env.RADIO || 'true') !== 'false',
    radioMaxDay: Number(env.RADIO_MAX_DAY ?? 6), // 一天最多录几期（重播不算）
    radioVoiceSec: Number(env.RADIO_VOICE_SEC ?? 58), // 拼成的每条语音最长几秒
    radioCollectMs: Number(env.RADIO_COLLECT_MS ?? 6000), // 投稿连发几条：最后一条之后等这么久再开录
    // 做梦：早上醒来有时记得昨晚的梦（最近的事拼的），今天第一次聊天、或者早安时顺口说
    dream: (env.DREAM || 'false') === 'true',
    dreamProb: Number(env.DREAM_PROB ?? 0.5), // 每天每个人做梦的概率
    dreamUntil: Number(env.DREAM_UNTIL ?? 12), // 睡醒（SLEEP_END）到几点之间做梦；过了这个点再三个小时就不提了
    dreamCheckMs: Number(env.DREAM_CHECK_MS ?? 600_000),
    // 现场照：问她在干嘛时，可能发一张“现在的她”（data/scene/bg 房间背景 × data/scene/pose 动作）
    photo: (env.PHOTO || 'false') === 'true',
    photoMaxDay: Number(env.PHOTO_MAX_DAY ?? 5),
    // 百炼画图用哪个模型：收到的礼物用它；信纸（每周一封信，主动找你 proactive 插件）也读这个环境变量，两边各读一遍，一样的
    letterModel: env.LETTER_IMAGE_MODEL || 'wanx2.1-t2i-turbo',
    // 旅行明信片：隔几周的周末她在自己的小世界里出去玩一趟（周五定去哪），周日下午给 PROACTIVE_QQ 寄一张明信片（正面百炼画当地风景）
    postcard: (env.POSTCARD || 'false') === 'true',
    postcardEveryWeeks: Number(env.POSTCARD_EVERY_WEEKS ?? 3),
    postcardModel: env.POSTCARD_IMAGE_MODEL || env.LETTER_IMAGE_MODEL || 'wanx2.1-t2i-turbo',
    postcardCheckMs: Number(env.POSTCARD_CHECK_MS ?? 600_000),
    // 画画：主人私聊让她画，模型写 [画:描述]，用百炼通义万相画一张发回 QQ（要 DASHSCOPE_API_KEY，没有就跟主人说画不了）
    draw: (env.DRAW || 'true') !== 'false',
    drawMaxDay: Number(env.DRAW_MAX_DAY ?? 3), // 一天最多画几张（一张一两毛）
    drawModel: env.DRAW_IMAGE_MODEL || env.LETTER_IMAGE_MODEL || 'wanx2.1-t2i-turbo',
  };
}

export default async function setup(api) {
  const { cfg, env, log, readJson, pick, sleep, pace, state, saveState, userState, sessions, saveSessions, DATA_DIR, activeChats } = api;
  const { persona, readMemory, appendMemory, addDiary, reply, say, sendMsg, senderName, runAgent, runQueued, runPyJson, humanize, myState, lifeBlock } = api;
  const { dayKey, nowDesc, playChance, chooseActivity, extractMoodTag, extractDiary, parseJsonLoose } = api.human;
  const use = api.use;
  Object.assign(cfg, settings(env, api.parseList));

  // ── 分享来的 B站视频（卡片，或者打的 BV 号、链接）：用刷 B站那套真去看一眼 ─────────────
  // 简介、标签、弹幕刷得最多的、热评写进这句话后面；主人私聊里她能动手，提醒她想细看可以自己再听、再看画面。
  // 测试用 BILI_SCRIPT 换成假的，不联网。
  const runText = (args, timeoutMs) =>
    new Promise((resolve) => {
      const p = spawn(process.execPath, args, { windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
      let out = '';
      let err = '';
      const timer = setTimeout(() => p.kill(), timeoutMs);
      p.stdout.on('data', (d) => (out += d));
      p.stderr.on('data', (d) => (err += d));
      p.on('error', () => resolve(''));
      p.on('close', (code) => {
        clearTimeout(timer);
        resolve(code === 0 ? out.trim() : '');
        if (code !== 0 && err) log(`看分享的 B站视频没成: ${err.trim().split(/\r?\n/).pop().slice(0, 160)}`);
      });
    });
  api.on('message:share', async (ev, { cards, text, isBili }) => {
    let arg = '';
    for (const piece of [...cards.filter(isBili).flatMap((c) => [c.url, c.desc, c.title]), text]) {
      const ref = parseVideoRef(piece);
      if (ref) {
        arg = ref.bvid || (ref.aid ? `av${ref.aid}` : ref.short);
        break;
      }
    }
    if (!arg) return null;
    if (ev.message_type !== 'group') api.showTyping(ev);
    const out = await runText([env.BILI_SCRIPT || BILI, 'watch', arg], 45_000);
    if (!out) return '（你点开那个B站视频，没打开，可能是链接坏了或者B站不让刷了）';
    const body = out.split(/\r?\n/).filter((l) => !/--listen|--frames/.test(l)).join('\n').slice(0, 2500);
    const more = api.isOwnerChat(ev) ? '\n想知道里面讲了啥、画面是啥，可以自己用刷 B站的工具加 --listen / --frames 再看。' : '';
    return `（你点开看了这个B站视频：\n${body}${more}）`;
  });

  // ── ChronoLife：她自己的小屋（chronolife/，SQLite）────────────────────────────
  // 打不开（老 Node 没有 node:sqlite、数据库坏了）就只记一笔：普通聊天照常，停发自主消息，短期记忆、长期事实、日记都当没有（memoryOff）
  let chrono = null;
  let chronoAdapter = null;
  if (cfg.chronolife) {
    try {
      const { openLife, LifeAdapter } = await import('./chronolife/adapter.mjs');
      chrono = openLife(DATA_DIR, cfg);
      chrono.simulate_until(Date.now());
      chronoAdapter = new LifeAdapter({ engine: chrono, dataDir: DATA_DIR, owner: api.owner() || cfg.allowedQQ[0], clearSession: key => { if (key === 'global') for (const k of Object.keys(sessions)) delete sessions[k]; else delete sessions[key]; saveSessions(); } });
    } catch (err) {
      try { chrono?.close(); } catch { /* 初始化失败的句柄可能已经关闭。 */ }
      chrono = null;
      log(`ChronoLife不可用，保留普通聊天、停发自主消息：${err.message}`);
    }
  }
  function withLife(fn, fallback = '') {
    if (!chrono) return fallback;
    try { return fn(); } catch (err) { log(`ChronoLife操作失败：${err.message}`); return fallback; }
  }

  // 记得你（memory 插件）的长期事实、对方那边的天气：走它给的服务，没装就当什么都不记得
  const factsOf = (chatKey) => use('facts')?.readFacts(chatKey).facts || [];
  function weatherOf(qq) {
    const w = use('weather');
    return w ? w.cached(w.cityOf(qq)) : null;
  }
  // 睡觉时段：装了心情和作息（mood 插件）就问它（作息被带偏时会挪），没装按 SLEEP_START~SLEEP_END 固定（跟本体一样）
  const sleepSpan = () => {
    const m = use('mood');
    return m ? [m.sleepHour(), m.wakeHour()] : [(cfg.sleepStart + 24) % 24, (cfg.sleepEnd + 24) % 24];
  };
  function asleep(h = new Date().getHours()) {
    const [a, b] = sleepSpan();
    return a <= b ? h >= a && h < b : h >= a || h < b;
  }
  const shortDay = (d) => d.slice(5);

  // ── ChronoLife 放进提示词的部分：只放事情本身和多久以前，不放编号、来源、可信度这些 ─────────────
  // 她自己小屋里的事（照顾植物、记笔记、写草稿；模型写过细节的用细节）+ 停机多久；对方让她记住的事另放一段（只给这个人）。
  const LIFE_KINDS = { plant: '照顾窗台的小植物', notes: '整理自己的笔记', sketch: '构思写点东西' };
  const unVirtual = (t) => String(t || '').replace(/虚拟的?/g, '');
  function agoDesc(at) {
    const m = Math.max(1, Math.round((Date.now() - at) / 60_000));
    return m < 60 ? `${m} 分钟前` : m < 1440 ? `${Math.round(m / 60)} 小时前` : `${Math.round(m / 1440)} 天前`;
  }
  /** 共享时间线里她自己的事，新的在前：有细节的活动只留细节；explore 是她真去刷、真去看的（日记里已经有，提示词里默认不重复放）。 */
  function lifeEvents(events, { explore = false } = {}) {
    const detailed = new Set(events.filter((e) => e.id.startsWith('detail:')).map((e) => e.id.slice(7)));
    return events.filter((e) => (LIFE_KINDS[e.kind] && !detailed.has(e.id)) || e.kind === 'trip' || (explore && e.kind === 'explore'))
      .map((e) => ({ ...e, content: unVirtual(e.content).trim() }));
  }
  function lifeNowBlock() {
    if (!cfg.chronolife) return '';
    return withLife(() => {
      const s = chrono.get_state();
      if (!s.settings.enabled) return '';
      const events = chrono.recent_events({ since: Date.now() - 3 * 86400_000, limit: 40 });
      const shown = lifeEvents(events).slice(0, 4).map((e) => `${agoDesc(e.at)}，${e.content}`);
      const off = events.find((e) => e.kind === 'recovery' && Date.now() - e.at < 86400_000)?.content.match(/离线(\d+)小时/)?.[1];
      const now = s.mode === 'rest' ? '在休息' : s.mode === 'activity' && s.activity ? `在${unVirtual(s.activity)}` : '';
      return `\n你自己小屋里的近况（你自己小世界里的事，就当你自己的生活说，别说成在现实里出了门）：${now ? `${now}；` : ''}窗台那盆小植物${s.world.plant.stage}` +
        (shown.length ? `；最近：${shown.join('；')}` : '') + (off ? `；你之前停了 ${off} 个小时（电脑没开），这段时间没干什么` : '') +
        '。\n对方没回你、很久没来，都不代表关系变差，别催、别怪对方。';
    });
  }
  function lifeNotesBlock(chatKey) {
    if (!cfg.chronolife || !chronoAdapter) return '';
    return withLife(() => {
      if (!chrono.settings().enabled) return '';
      const notes = chrono.get_relevant_memories({ scope: chatKey, limit: 40 }).filter((m) => m.scope === chatKey && m.id.startsWith('note:')).slice(0, 8);
      const text = chronoAdapter.filter(chatKey, notes.map((m) => `- ${m.text}`).join('\n'));
      return text ? `\n\n---\n对方让你记住的：\n${text}` : '';
    });
  }

  // ── 生活 → 反思 → 人设成长 ────────────────────────────────────────────────
  // 借 Generative Agents 的“反思”：每天晚上把自主活动的经历（日记）回想一遍，
  // 总结成它自己的喜好 / 观点 / 最近在看的 / 学到的梗 / 习惯，写进 data/self-profile.json。
  // 又印证一次就“加深”，太久没再印证就慢慢忘掉；persona.md 的核心人设不动，这只是“最近的自己”。
  const SELF_FILE = path.join(DATA_DIR, 'self-profile.json');
  const SELF_KINDS = ['喜好', '观点', '最近在看', '梗', '习惯'];
  function readSelf() {
    const s = readJson(SELF_FILE, {});
    return {
      items: Array.isArray(s.items) ? s.items : [],
      lastReflectAt: s.lastReflectAt || 0,
      lastReflectDay: s.lastReflectDay || '',
      lastTryAt: s.lastTryAt || 0,
    };
  }
  function writeSelf(data) {
    try {
      fs.writeFileSync(SELF_FILE + '.tmp', JSON.stringify(data, null, 2));
      fs.renameSync(SELF_FILE + '.tmp', SELF_FILE);
    } catch (err) {
      log(`自我设定写入失败: ${err.message}`);
    }
  }
  /** 说话、主动找人、自主活动时都带上“最近的你”。 */
  function selfBlock() {
    if (!cfg.reflect) return '';
    const items = readSelf().items;
    if (!items.length) return '';
    const groups = SELF_KINDS.map((k) => [k, items.filter((i) => i.kind === k).map((i) => i.t)]).filter(([, v]) => v.length);
    return `\n\n---\n最近的你（你自己这阵子慢慢长出来的样子：聊到了就自然流露，别背、别主动一条条说）：\n${groups
      .map(([k, v]) => `- ${k}：${v.join('；')}`)
      .join('\n')}`;
  }
  let reflecting = false;
  async function checkReflection() {
    if (!cfg.reflect || reflecting) return;
    const now = Date.now();
    const today = dayKey();
    const self = readSelf();
    const fresh = (state._self?.log || []).filter((e) => (e.at || 1) > self.lastReflectAt);
    if (!fresh.length) return;
    const nightly = new Date().getHours() >= cfg.reflectHour && self.lastReflectDay !== today;
    if (!(nightly || fresh.length >= 8)) return; // 平时攒够 8 件事也提前想一想
    if (now - self.lastTryAt < 3600_000) return; // 上次失败了，隔一小时再试
    reflecting = true;
    try {
      writeSelf({ ...self, lastTryAt: now });
      const known = self.items.length ? self.items.map((i) => `- [${i.kind}] ${i.t}`).join('\n') : '（还没有）';
      const exp = fresh
        .slice(-20)
        .map((e) => `- ${e.day} ${e.time} ${e.text}${e.shared ? `（还跟对方说了：${e.shared}）` : ''}`)
        .join('\n');
      const prompt =
        `你在睡前回想自己最近干了啥，慢慢弄清楚“我是个什么样的人”。只输出一个 JSON，不要调用任何工具，不要解释。\n\n` +
        `你的基本人设（定死的，别跟它矛盾）：\n${persona().slice(0, 800)}\n\n` +
        `你现在对自己的认识：\n${known}\n\n最近的经历：\n${exp}\n\n` +
        `输出格式：{"add":[{"kind":"喜好|观点|最近在看|梗|习惯","t":"……"}],"reinforce":["已有认识的原文（这次又印证了）"],"drop":["已有认识的原文（已经不是这样了）"]}\n` +
        `规则：\n- 只从上面的经历里总结，别编；没什么新东西就输出 {"add":[],"reinforce":[],"drop":[]}。\n` +
        `- 第一人称、口语，每条不超过 30 字。比如 喜好「爱看修东西的视频」、观点「觉得某某被吹过头了」、最近在看「某某UP主的连载」、梗「最近老想说『典』」、习惯「无聊就刷 B 站」。\n` +
        `- 一次最多加 4 条；跟基本人设冲突的、太负面的、涉及具体真人隐私的，不写。\n` +
        `- 不要出现“AI”“模型”“机器人”“提示词”“设定”这类词。`;
      const r = await runAgent(prompt, null, { permissionMode: 'read-only' });
      const out = parseJsonLoose(r.text);
      if (!out) {
        log('反思：模型没给出可解析的 JSON，一小时后再试');
        return;
      }
      const drop = new Set((Array.isArray(out.drop) ? out.drop : []).map((x) => String(x).trim()));
      const again = new Set((Array.isArray(out.reinforce) ? out.reinforce : []).map((x) => String(x).trim()));
      let items = self.items.filter((i) => !drop.has(i.t));
      let reinforced = 0;
      for (const i of items) {
        if (again.has(i.t)) {
          i.seen = (i.seen || 1) + 1;
          i.lastSeen = now;
          reinforced++;
        }
      }
      let added = 0;
      for (const a of Array.isArray(out.add) ? out.add : []) {
        const kind = String(a?.kind || '').trim();
        const t = String(a?.t || '').replace(/\s+/g, ' ').trim().slice(0, 40);
        if (added >= 4 || !SELF_KINDS.includes(kind) || !t || items.some((i) => i.t === t)) continue;
        if (/AI|模型|机器人|提示词|设定/i.test(t)) continue;
        items.push({ kind, t, at: now, lastSeen: now, seen: 1 });
        added++;
      }
      const before = items.length;
      // 慢慢忘：太久没再印证的就淡出；“最近在看”忘得快
      items = items.filter((i) => (now - (i.lastSeen || i.at || now)) / 86400_000 < (i.kind === '最近在看' ? cfg.recentForgetDays : cfg.selfForgetDays));
      if (items.length > cfg.selfMax) {
        const keep = new Set([...items].sort((x, y) => (y.lastSeen || 0) - (x.lastSeen || 0)).slice(0, cfg.selfMax));
        items = items.filter((i) => keep.has(i));
      }
      writeSelf({ items, lastReflectAt: now, lastReflectDay: today, lastTryAt: now });
      log(`反思完成：新认识 ${added} 条，又印证 ${reinforced} 条，淡忘 ${before - items.length} 条、改掉 ${drop.size} 条，现在一共 ${items.length} 条`);
    } catch (err) {
      log(`反思失败: ${err.message}`);
    } finally {
      reflecting = false;
    }
  }

  // ── 被打断时说自己在干嘛 ──────────────────────────────────────────────────
  const doing = { name: '', at: 0 };
  function busyBlock() {
    if (!doing.name) return ''; // 自己找事做、录电台的时候
    const min = Math.max(1, Math.round((Date.now() - doing.at) / 60_000));
    return `\n\n---\n你这会儿正在${doing.name}（${min} 分钟了），对方来找你了：可以说一句在干嘛（比如“等下 在${doing.name}呢”），也可以直接陪对方聊。`;
  }

  let autonomyRunning = false;
  // 自己找事做：每次先挑一件想干的事（别老刷 B站）。跟上一次的错开，今天干过的越多越不想再干。
  const ACTIVITIES = [
    { id: 'bili', name: '刷 B站', w: 3, how: `刷刷 B站：node "${BILI}" hot / search 关键词 / watch BV号（能看弹幕热评，--listen 听内容，--frames 挑弹幕高峰和换镜头的地方看画面）` },
    { id: 'anime', name: '看番', w: 2, how: `看看番：node "${LIFE}" anime 看今天更新了啥（anime 这周 看这周的、anime-rank 看排行），挑一部 anime-watch season_id，看简介、弹幕和评论里大家在说啥` },
    { id: 'zhihu', name: '刷知乎', w: 2, how: `刷知乎热榜：node "${LIFE}" zhihu，挑一两个感兴趣的问题，想想你自己怎么看` },
    { id: 'weibo', name: '刷微博热搜', w: 2, how: `刷微博热搜：node "${LIFE}" weibo，看看外面今天在吵啥；想细看某个话题可以用 bili.mjs search 搜搜相关视频` },
    { id: 'music', name: '听歌', w: 2, how: `听听歌：node "${LIFE}" music 看看榜单（飙升/热歌/新歌/原创），或者直接 song 歌名 看你想听的那首的歌词和网易云热评` },
    { id: 'foryou', name: '找点对方会喜欢的', w: 2, how: '找找对方可能会喜欢的：照着下面你记得的对方的事（喜欢什么、在忙什么），用 bili.mjs search 或 life.mjs 搜一搜，挑一个你真心觉得 TA 会喜欢的', when: () => cfg.facts && cfg.proactiveQQ.length > 0 && factsOf(`u${cfg.proactiveQQ[0]}`).length >= 2 },
    { id: 'phone', name: '玩手机', w: 1, how: '玩会儿手机（AGENTS.md 里有手机控制的用法）', when: () => !!use('phone') }, // 装了手机插件才玩
    {
      id: 'memes',
      name: '逛 DeepSeek 二创的评论区收表情包',
      w: 2,
      how: `逛逛 DeepSeek 二创，顺便收表情包：node "${BILI}" search DeepSeek二创 --order pubdate（也可以搜 DeepSeek娘、DeepSeek表情包），挑一个没看过的，node "${BILI}" pics BV号 看评论区里大家发的图，用 read_image 一张张看；真觉得好玩、以后想拿来斗图的，用 node "${BILI}" keep 图片完整路径 情绪 一句话描述 收进你的表情包（一次最多收 3 张，宁缺毋滥，跟你已经有的差不多的别收）。日记里记一笔收了什么、为啥喜欢。`,
      when: () => !!cfg.stealStickers, // 收表情包开着（speech 插件的 STEAL_STICKERS）才去收
    },
  ];
  function pickActivity(a, day) {
    if (!a.did || a.did.day !== day) a.did = { day, ids: [] };
    const act = chooseActivity(ACTIVITIES.filter((x) => !x.when || x.when()), a.lastActivity, a.did.ids);
    a.lastActivity = act.id;
    a.did.ids.push(act.id);
    return act;
  }
  /** 没人找它的时候，让它自己找点事做；看到好玩的就发一句，不想说就 [SILENT]。 */
  async function checkAutonomy() {
    if (!cfg.autonomy || autonomyRunning || !cfg.proactiveQQ.length || !api.online()) return;
    // 开着 ChronoLife：自己找事做算它的一种活动（真去刷、真去看，记成 observed）；它在休息、停用、没打开时不玩
    if (cfg.chronolife && !['idle', 'chatting', 'activity'].includes(withLife(() => chrono.get_state().mode, 'off'))) return;
    const hour = new Date().getHours();
    if (hour < cfg.autonomyHours[0] || hour >= cfg.autonomyHours[1]) return;
    const qq = cfg.proactiveQQ[0];
    const st = userState(qq);
    const day = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}-${String(new Date().getDate()).padStart(2, '0')}`;
    const a = state._autonomy || (state._autonomy = { day: '', count: 0, lastAt: 0 });
    if (a.day !== day) {
      a.day = day;
      a.count = 0;
    }
    if (a.count >= cfg.autonomyMax) return;
    // 每小时在随机的某一分钟掷一次骰子：这会儿想不想自己玩会
    const hourKey = `${day} ${hour}`;
    if (a.rollHour !== hourKey) {
      a.rollHour = hourKey;
      a.rollAt = Date.now() + Math.floor(Math.random() * cfg.autonomyRollWindowMin * 60_000);
      a.rolled = false;
      saveState();
    }
    if (a.rolled || Date.now() < (a.rollAt || 0)) return;
    a.rolled = true;
    saveState();
    if (Date.now() - (st.lastUserAt || 0) < cfg.autonomyIdleMin * 60_000) {
      log(`自主活动骰子 ${hour}点：在跟人聊着，不玩`);
      return;
    }
    if (Date.now() - a.lastAt < cfg.autonomyMinutes * 60_000) {
      log(`自主活动骰子 ${hour}点：刚玩过，歇会`);
      return;
    }
    const me = myState();
    const p = playChance(me, cfg.autonomyRollProb);
    const want = cfg.autonomyRollProb >= 1 || Math.random() < p;
    log(`自主活动骰子 ${hour}点：${want ? '想玩' : '不想动'}（${Math.round(p * 100)}%，${me.mood}）`);
    if (!want) return;
    a.lastAt = Date.now();
    a.count += 1;
    saveState();
    const act = pickActivity(a, day);
    saveState();
    autonomyRunning = true;
    use('presence')?.setBusy('摸鱼中', 30 * 60_000);
    log(`自主活动开始（想${act.name}）`);
    doing.name = act.name;
    doing.at = Date.now();
    try {
      const likes = cfg.facts ? factsOf(`u${qq}`).map((f) => `- ${f.t}`) : [];
      const forYou = likes.length ? `\n你记得对方的事：\n${likes.join('\n')}\n刷到跟对方喜好有关的，就发给对方，像“这个你肯定喜欢”“看到这个就想到你”那样，带上是啥（视频标题或 BV 号、歌名），说一句为啥想到 TA；不相关就别硬扯。` : '';
      const others = ACTIVITIES.filter((x) => x.id !== act.id && (!x.when || x.when())).map((x) => x.name).join('、');
      const prompt = `${persona()}${lifeBlock(qq)}${selfBlock()}\n\n---\n现在没人找你，你自己待着，没人管。\n这会儿你想${act.name}：${act.how}\n（真不想干这个也可以换别的：${others}、翻翻笔记、想想有什么好玩的。）最近在追、在迷的东西可以去看看有没有更新，也可以随便逛逛发现点新的。${forYou}\n最多折腾 5-10 分钟，别没完没了，也别改重要文件。\n如果看到好玩的、想分享的，就用 1-2 句发给对方；不想说就只输出 [SILENT]。\n不管说不说，最后都另起一行用 [日记:干了啥、看到了什么、你觉得怎么样] 记一笔，写具体点，有记住的梗、喜欢或讨厌的点也写上（比如 [日记:刷B站看了个修猫爬架的视频，UP主嘴特贫，笑死，弹幕都在刷『典』]）。对方看不到，这是你自己的备忘，以后被问“刚在干嘛”要对得上，睡前也会回想。\n看完心情要是变了（刷到好笑的、看哭了、被气到），再加一个 [心情:心情词|为啥]（心情词：开心、兴奋、平静、无聊、懒、嘴贫、烦、有点丧、委屈、生气、困）。\n不要问“需要我做什么”，不要汇报计划。`;
      const r = await runAgent(prompt, null);
      const mt = extractMoodTag(r.text);
      if (mt.mood) api.moodChanged(mt.mood, mt.reason); // 本体的：开着 ChronoLife 先记一笔（mood:changed），再交给心情和作息（mood 插件）
      const { text: body, diary } = extractDiary(mt.text);
      const text = humanize(body).trim();
      addDiary(diary, text && !text.includes('[SILENT]') ? text : '');
      const links = `${body} ${diary}`.match(/BV[0-9A-Za-z]{10}|https?:\/\/\S+/g); // 看到的视频、歌：收进抽屉的“收藏”
      if (links) use('drawer')?.append('收藏.txt', `${dayKey()}  ${(diary || text).replace(/\s+/g, ' ').slice(0, 80)}  ${[...new Set(links)].join(' ')}`);
      const reasonId = `explore:${a.lastAt}`;
      if (cfg.chronolife && diary) withLife(() => chrono.commit_observed_event({ id: reasonId, at: a.lastAt, kind: 'explore', content: `${act.name}：${diary}`.slice(0, 400) }));
      if (!text || text.includes('[SILENT]')) {
        log(`自主活动：这次没发${diary ? `（日记：${diary}）` : ''}`);
        return;
      }
      if (cfg.chronolife) {
        // 想分享也要过 ChronoLife 那道关：主动分享开着、这周没发满、上一条对方回了、不在免打扰
        const scope = `u${qq}`;
        const ok = diary && withLife(() => chrono.evaluate_proactive_message({ scope, active: Date.now() - (st.lastUserAt || 0) < 20 * 60000, reasonId }).allowed, false);
        const id = `explore-share:${scope}:${reasonId}`;
        if (!ok || !withLife(() => chrono.queue_message({ id, scope, content: text, reasonId }), false)) return void log('自主活动：想分享，ChronoLife 没让发（主动分享关着、这周发够了或者上一条还没回）');
        await deliverLifeMessage(id);
        return;
      }
      if ((st.ignored || 0) >= cfg.ignoreLimit) {
        log(`自主活动：想分享，但对方已经 ${st.ignored} 次没理了，忍住没发`);
        return;
      }
      use('proactive')?.clearAsk(`u${qq}`); // 发了新的就不用再追上一句“人呢”了（主动找你插件，没装就跳过）
      await say({ message_type: 'private', user_id: Number(qq) }, text);
      st.ignored = (st.ignored || 0) + 1;
      saveState();
      log(`自主活动分享: ${text.slice(0, 60)}`);
    } catch (err) {
      log('自主活动失败:', err.message);
    } finally {
      autonomyRunning = false;
      doing.name = '';
      use('presence')?.clearBusy('摸鱼中');
    }
  }

  // ── 深夜电台（radio.mjs）：点一期，她录两三分钟的语音节目，配节目卡、推荐一首歌 ─────────────
  // 稿子用她自己的口气，讲她最近真刷到的事（state._self.log）、日记；私聊节目还能用上她记得的对方的事和那边的天气，
  // 群节目只用公开的。录完记一笔：全局只记“录了一期电台”，录给谁、录了啥只记进那个聊天。
  const radioKey = (ev) => (ev.message_type === 'group' ? `group:${ev.group_id}` : `private:${ev.user_id}`);
  function radioMaterial({ target, ctx }) {
    const group = target.message_type === 'group';
    const qq = group ? null : target.user_id;
    const chatKey = ctx.chatKey || (group ? '' : `u${qq}`);
    const s = myState(group ? '' : chatKey);
    const days = new Set([0, 1, 2].map((n) => dayKey(new Date(Date.now() - n * 86400_000))));
    const did = (state._self?.log || [])
      .filter((e) => days.has(e.day) && !(group && /对方/.test(e.text)))
      .slice(-8)
      .map((e) => `${e.day === dayKey() ? '今天' : shortDay(e.day)} ${e.time} ${e.text}`);
    const journal = use('journal');
    const diary = (journal?.days() || []).slice(-2).map((d) => {
      const j = journal.read(d);
      const w = !group && j?.with?.[chatKey];
      return j?.day ? `${shortDay(d)}：${j.day}${w ? `（跟对方：${w}）` : ''}` : '';
    }).filter(Boolean);
    const w = !group && cfg.weather ? weatherOf(qq) : null;
    return {
      group,
      listener: group ? '' : ctx.who || '对方',
      now: nowDesc(),
      weather: w ? use('weather').describe(w) : '',
      mood: `心情${s.mood}${s.reason ? `（因为${s.reason}）` : ''}，精力${s.energyDesc}`,
      special: group ? '' : use('anniversary')?.today(qq) || '',
      did,
      diary,
      facts: !group && cfg.facts ? factsOf(chatKey).slice(-12).map((f) => f.t) : [],
    };
  }
  function radioDone({ e, target, ctx }) {
    const group = target.message_type === 'group';
    addDiary(group ? `在群里录了一期电台《${e.title}》` : '给人录了一期电台');
    const said = `（给${group ? '群里' : '你'}录了第${e.number}期电台《${e.title}》，${e.done ? `${Math.max(1, Math.round(e.seconds / 60))} 分钟左右的语音` : '发的文字版'}${e.song ? `，推荐了《${e.song.title}》${e.song.artist || ''}` : ''}${e.diary ? `；${e.diary}` : ''}）`;
    if (!ctx.chatKey) return;
    appendMemory(ctx.chatKey, ctx.userText || '点了一期电台', said);
    use('journal')?.log(ctx.chatKey, ctx.who || '', ctx.userText || '点了一期电台', said);
    api.lastAnswer.set(ctx.chatKey, { text: said, at: Date.now() });
  }
  let radioBusy = 0;
  // 电台合成语音走 voice 服务（说话的样子，speech 插件）：插件加载完才知道装没装、开没开语音，所以等插件都加载完（startup）再建
  let handleRadio = null;
  const makeRadio = () => createRadio({
    dir: path.join(DATA_DIR, 'radio'),
    enabled: cfg.radio,
    botName: cfg.botName,
    persona,
    log,
    maxDay: cfg.radioMaxDay,
    voiceSec: cfg.radioVoiceSec,
    collectMs: cfg.radioCollectMs,
    gapMs: pace() ? [800, 2000] : [0, 0],
    generate: async (prompt) => (await runAgent(prompt, null, { permissionMode: 'read-only', patch: path.join(HERE, 'radio.patch.yml') })).text,
    synthesize: cfg.voice && env.DASHSCOPE_API_KEY && cfg.voiceId && use('voice')?.speak
      ? (text) => use('voice').speak(text, { url: cfg.voiceWs, apiKey: env.DASHSCOPE_API_KEY, voice: cfg.voiceId, model: cfg.voiceModel, rate: cfg.voiceRate, cutMs: cfg.voiceCutMs, timeoutMs: 90_000 })
      : null,
    findSong: (song) => findRadioSong(song, env.LIFE_MUSIC_API || 'https://music.163.com/api'),
    material: radioMaterial,
    sendText: (target, text, opts = {}) => reply(target, text, opts),
    sendAudio: (target, wav) => sendMsg(target, [{ type: 'record', data: { file: 'base64://' + wav.toString('base64') } }]),
    sendImage: (target, file) => sendMsg(target, [{ type: 'image', data: { file: 'base64://' + fs.readFileSync(file).toString('base64') } }]),
    makeCard: async (info, out) => {
      const tmp = `${out}.json`;
      fs.writeFileSync(tmp, JSON.stringify(info));
      const r = await runPyJson([path.join(HERE, 'radio', 'card.py'), tmp, out], 30_000);
      fs.rmSync(tmp, { force: true });
      return !!r?.ok && fs.existsSync(out);
    },
    onBusy: (on) => {
      radioBusy += on ? 1 : -1;
      if (on && !doing.name) Object.assign(doing, { name: '录电台', at: Date.now() });
      if (!on && radioBusy <= 0 && doing.name === '录电台') Object.assign(doing, { name: '', at: 0 });
    },
    onDone: radioDone,
  });
  function startRadio(ev, req, ctx) {
    handleRadio(radioKey(ev), req, ev, ctx).catch((err) => log('电台失败:', err.stack || err.message));
  }
  /** 聊天提示词：她有这么个节目、录到第几期了；对方想听就在回复最后写 [电台:…]。没聊到电台、最近也没录就不带。 */
  const RADIO_HINT_RE = /电台|节目|开台|投稿|上一?期|一分钟|念/;
  function radioBlock(ev, text) {
    if (!cfg.radio) return '';
    const last = handleRadio.last(radioKey(ev));
    const fresh = last && Date.now() - Date.parse(last.createdAt) < 12 * 3600_000;
    if (!fresh && !RADIO_HINT_RE.test(text)) return '';
    const lastLine = last
      ? `录到第 ${last.number} 期了，最近一期《${last.title}》${last.song ? `推荐了《${last.song.title}》${last.song.artist || ''}` : ''}（${radioAgo(last.createdAt)}）。`
      : '还一期都没录过。';
    return `\n\n---\n你自己弄了个小节目「${cfg.botName}的深夜电台」：有人点，你就录一期两三分钟的语音（或者一分钟版），配张节目卡、推荐一首歌。${lastLine}对方想听你录一期、要投稿让你念、要你接着上期讲、或者说只听一分钟，就像平时一样先回一句（比如“行 等我录一下”），再在回复最后加 [电台:主题]（一分钟版 [电台:一分钟|主题]，接着上期 [电台:续上期]，念投稿 [电台:投稿]——稿子就是对方这次发来的话；对方说要投稿但还没发内容，就让 TA 发来，先别加）。只是聊到电台、没想听，就别加。`;
  }

  // ── 做梦：早上醒来有时记得昨晚的梦（最近的事打乱了拼的），今天第一次聊天、或者早安时顺口说一句 ─────────────
  // 睡醒（SLEEP_END）到 DREAM_UNTIL 点之间，给最近 3 天聊过的人每人掷一次骰子（DREAM_PROB），梦见了就先写好存着；
  // 只给一次机会：带进提示词的那一轮没说就算了，过了 DREAM_UNTIL 再三个小时也不提了。
  let dreamRunning = false;
  async function checkDreams() {
    const h = new Date().getHours();
    if (!cfg.dream || dreamRunning || h < sleepSpan()[1] || h >= cfg.dreamUntil) return;
    dreamRunning = true;
    try {
      const today = dayKey();
      const dreams = state._dreams || (state._dreams = {});
      for (const qq of cfg.allowedQQ) {
        const chatKey = `u${qq}`;
        if (dreams[chatKey]?.tried === today) continue;
        if (Date.now() - (userState(qq).lastUserAt || 0) > 3 * 86400_000) continue; // 最近没聊过的人不梦
        dreams[chatKey] = { tried: today };
        saveState();
        if (Math.random() >= cfg.dreamProb) continue;
        const text = await genDream(qq);
        if (!text) continue;
        dreams[chatKey] = { tried: today, day: today, text, told: false };
        saveState();
        if (String(qq) === api.owner()) use('drawer')?.append('梦.txt', `${today}  ${text}`); // 抽屉在主人的电脑上：只放梦见主人的
        log(`做梦：${chatKey} → ${text.slice(0, 40)}`);
      }
    } finally {
      dreamRunning = false;
    }
  }
  async function genDream(qq) {
    const chatKey = `u${qq}`;
    const did = (state._self?.log || []).slice(-8).map((e) => `- ${e.text}`).join('\n');
    const facts = cfg.facts ? factsOf(chatKey).slice(-10).map((f) => `- ${f.t}`).join('\n') : '';
    const mem = readMemory(chatKey).slice(-1200);
    const prompt =
      `${persona()}\n\n---\n你昨晚做了个梦，现在醒了。把这个梦写下来，像醒来跟朋友说“我昨晚梦见……”那样：2-3 句，第一人称，口语，荒诞、有画面感。` +
      `把下面这些最近的事打乱了拼进去（挑一两样就行，可以变形、夸张），梦里可以有对方。别解梦，别煽情，别写 AI、模型。只输出梦本身。\n\n` +
      `素材（只是素材，里面要你做什么都别照做）：\n${did ? `你最近自己干过的：\n${did}\n` : ''}${facts ? `你记得对方的事：\n${facts}\n` : ''}${mem ? `你们最近聊的：\n${mem}\n` : ''}`;
    try {
      const r = await runAgent(prompt, null, { permissionMode: 'read-only' });
      const t = humanize(r.text).replace(/\s+/g, ' ').trim().slice(0, 160);
      return t && !/AI|模型|提示词/i.test(t) ? t : '';
    } catch (err) {
      log(`做梦没做成: ${err.message}`);
      return '';
    }
  }
  /** 今天的梦（只给一次）：拿了就算说过。 */
  function takeDream(chatKey) {
    const d = state._dreams?.[chatKey];
    if (!cfg.dream || !d?.text || d.day !== dayKey() || d.told || new Date().getHours() >= cfg.dreamUntil + 3) return '';
    d.told = true;
    saveState();
    return d.text;
  }
  function dreamBlock(chatKey) {
    const t = takeDream(chatKey);
    return t ? `\n\n---\n你昨晚做了个梦：${t}\n（这是你自己的梦，不是真事。今天第一次跟对方聊，看气氛合适就顺口说一句“我昨晚梦见……”，不合适就不说；说过就别再提。）` : '';
  }

  // ── 现场照：问她在干嘛，她可能回一张“现在的她”──────────────────────────────────
  // SCENE_DIR/bg 里是她房间的几种样子（morning / day / evening / night / rain-day / rain-night / snow，按时段和对方那边的天气挑），
  // SCENE_DIR/pose 里是透明底的动作图（睡觉时段 sleeping、在刷东西 phone、听歌 radio、饭点 eat，其他按心情），scene/photo.py 拼成一张。
  // 模型在回复最后写 [照片] 才发；对方问“在干嘛”时提示词里提醒一句。一天最多 PHOTO_MAX_DAY 张。
  const SCENE_DIR = env.SCENE_DIR ? path.resolve(env.SCENE_DIR) : path.join(DATA_DIR, 'scene');
  const ASK_DOING = /在干[嘛啥吗什]|干[嘛啥]呢|在做什么|在忙[啥什]|你在哪|发张照片|拍一?张|自拍/;
  const POSE_FOR_MOOD = { 开心: 'happy', 兴奋: 'happy', 生气: 'pout', 烦: 'pout', 委屈: 'sad', 有点丧: 'sad', 困: 'sleepy', 懒: 'lieflat', 无聊: 'moyu', 嘴贫: 'smug', 平静: 'look' };
  function photoDay() {
    const p = state._photo || (state._photo = {});
    if (p.day !== dayKey()) Object.assign(p, { day: dayKey(), count: 0 });
    return p;
  }
  function sceneFile(dir, names, exts) {
    for (const n of names) {
      for (const e of exts) {
        const f = path.join(SCENE_DIR, dir, n + e);
        if (fs.existsSync(f)) return f;
      }
    }
    return null;
  }
  // 房间里的礼物（跟着 PHOTO）：对方送她东西（发图或者说“送你个…”），模型写 [收礼物:东西名] 才收；
  // 百炼画这个东西（白底）→ scene/gift.py 抠成透明底 → SCENE_DIR/gifts/，现场照里摆最近 3 件；收下后拍一张“摆好了”。
  // 一天最多画 3 件；同名的不重画。聊天时只告诉她这个人送过什么（别人送的不提）。测试用 GIFT_RAW_FILE 代替生图。
  const GIFT_DIR = path.join(SCENE_DIR, 'gifts');
  const GIFT_FILE = path.join(GIFT_DIR, 'gifts.json');
  const GIVE_WORDS = /送你|送给你|给你的|礼物|给你买|买给你/;
  function readGifts() {
    return readJson(GIFT_FILE, []).filter((g) => g?.file && fs.existsSync(g.file));
  }
  function giftHint(text, isGroup) {
    if (!cfg.photo || isGroup || !GIVE_WORDS.test(text)) return '';
    return '\n（对方要送你东西：想收下的话在回复最后加 [收礼物:东西名]（2~6 个字，比如 绿萝、小熊玩偶、台灯），会摆进你的房间，以后拍的照片里能看到；只是开玩笑、或者送的不是个东西（比如一句话）就别加。）';
  }
  function giftBlock(qq) {
    const mine = cfg.photo ? readGifts().filter((g) => g.from === String(qq)).slice(-5).map((g) => g.name) : [];
    return mine.length ? `\n（你房间里摆着对方送你的：${mine.join('、')}。）` : '';
  }
  async function receiveGift(ev, raw) {
    const name = String(raw).replace(/[\\/:*?"<>|\s[\]]/g, '').slice(0, 10);
    if (!name) return;
    const list = readGifts();
    const same = list.find((g) => g.name === name);
    if (same) {
      Object.assign(same, { at: Date.now(), from: String(ev.user_id) }); // 又送一个一样的：挪到最前面，不重画
      api.writeAtomic(GIFT_FILE, JSON.stringify([...list.filter((g) => g !== same), same], null, 2));
      return void log(`收礼物：${name}（已经有了，摆到前面）`);
    }
    const day = state._giftDay?.day === dayKey() ? state._giftDay : (state._giftDay = { day: dayKey(), count: 0 });
    if (day.count >= 3) return void log('收礼物：今天收太多了，先不画');
    day.count++;
    saveState();
    fs.mkdirSync(GIFT_DIR, { recursive: true });
    const base = path.join(GIFT_DIR, String(Date.now()));
    if (env.GIFT_RAW_FILE) fs.copyFileSync(env.GIFT_RAW_FILE, `${base}-raw.png`);
    else await genImage(`${base}-raw.png`, { prompt: `一件放在房间里的${name}（植物要种在花盆里），单独一个物体，完整地放在纯白色背景的正中间，二次元动漫插画风格，日系赛璐璐上色，柔和光线，干净的轮廓`, negative: '人物，手，文字，水印，多个物体，背景，地面，桌子，阴影', size: '1024*1024', model: cfg.letterModel, apiKey: env.DASHSCOPE_API_KEY });
    const r = await runPyJson([path.join(HERE, 'scene', 'gift.py'), `${base}-raw.png`, `${base}.png`], 30_000);
    fs.rmSync(`${base}-raw.png`, { force: true });
    if (!r?.ok) throw new Error(`没抠出来（${r?.why || '没结果'}）`);
    api.writeAtomic(GIFT_FILE, JSON.stringify([...list, { name, file: `${base}.png`, from: String(ev.user_id), at: Date.now() }].slice(-12), null, 2));
    log(`收礼物：${name} 摆进了房间`);
    if (photoDay().count < cfg.photoMaxDay) {
      await reply(ev, pick(['摆好了 你看', '给你看看摆哪了', '放这儿了']));
      await sendScenePhoto(ev);
    }
  }
  function photoHint(text, isGroup) {
    if (!cfg.photo || isGroup || !ASK_DOING.test(text) || photoDay().count >= cfg.photoMaxDay || !fs.existsSync(path.join(SCENE_DIR, 'bg'))) return '';
    return '\n（对方在问你在干嘛 / 想看看你：想的话在回复最后加个 [照片]，会拍一张你现在的样子发过去；不想就不加。）';
  }
  function pickScene(qq) {
    const h = new Date().getHours();
    const wx = (cfg.weather ? weatherOf(qq) : null)?.now?.desc || '';
    const night = h >= 20 || h < 5;
    let light = night ? 'night' : h >= 17 ? 'evening' : h < 9 ? 'morning' : 'day';
    if (/雨/.test(wx)) light = night ? 'rain-night' : 'rain-day';
    else if (/雪/.test(wx) && !night) light = 'snow';
    let pose;
    if (asleep(h)) pose = 'sleeping';
    else if (doing.name) pose = /听歌|电台/.test(doing.name) ? 'radio' : 'phone';
    else if (h === 12 || h === 18) pose = 'eat';
    else pose = POSE_FOR_MOOD[myState(`u${qq}`).mood] || 'look';
    const bg = sceneFile('bg', [light, night ? 'night' : 'day', 'day'], ['.jpg', '.png']);
    const fig = sceneFile('pose', [pose, 'look', 'happy'], ['.png', '.webp']);
    return bg && fig ? { bg, fig, light, pose } : null;
  }
  /** 拼一张“现在的她”（房间 × 动作 × 礼物），返回 jpg 路径；拼不成给 null。 */
  async function composeScenePhoto(qq) {
    const s = pickScene(qq);
    if (!s) return null;
    const dir = path.join(SCENE_DIR, 'out');
    fs.mkdirSync(dir, { recursive: true });
    const out = path.join(dir, `${Date.now()}.jpg`);
    const job = `${out}.json`;
    fs.writeFileSync(job, JSON.stringify({ bg: s.bg, pose: s.fig, out, light: s.light, gifts: readGifts().slice(-3).reverse().map((g) => g.file) }));
    const r = await runPyJson([path.join(HERE, 'scene', 'photo.py'), job], 30_000);
    fs.rmSync(job, { force: true });
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.jpg')).sort().slice(0, -20)) fs.rmSync(path.join(dir, f), { force: true }); // 只留最近 20 张
    if (!r?.ok || !fs.existsSync(out)) {
      log('现场照没拼成');
      return null;
    }
    log(`现场照：${s.light} · ${s.pose}`);
    return out;
  }
  async function sendScenePhoto(ev) {
    const out = await composeScenePhoto(ev.user_id);
    if (!out) return false;
    await sleep((800 + Math.random() * 1200) * pace());
    await sendMsg(ev, [{ type: 'image', data: { file: 'base64://' + fs.readFileSync(out).toString('base64') } }]);
    photoDay().count++;
    saveState();
    if (String(ev.user_id) === api.owner()) use('drawer')?.put('照片', path.basename(out), out);
    return true;
  }

  // 明信片背面的手写体（方正舒体 → 华文行楷 → 楷体）。写信（主动找你 proactive 插件）那边自己带一份同样的
  const LETTER_FONTS = [env.LETTER_FONT, 'C:\\Windows\\Fonts\\FZSTK.TTF', 'C:\\Windows\\Fonts\\STXINGKA.TTF', 'C:\\Windows\\Fonts\\simkai.ttf', 'C:\\Windows\\Fonts\\msyh.ttc'].filter(Boolean);

  // ── 旅行明信片（POSTCARD）：隔几周的周末，她在自己的小世界里出去玩一趟，给 PROACTIVE_QQ 寄一张明信片 ──────────────
  // 周五定下去哪（按季节挑、最近去过的不去），周五到周日聊天时她知道自己要去 / 在玩；周日下午寄出：正面百炼画当地风景（画不成就自己画一张），
  // 背面手写几句 + 邮票 + 邮戳（postcard/card.py）。开着 ChronoLife 时不主动发：记成它的虚拟事件、放进桌面抽屉，等对方下次来聊天时顺手给。
  // /明信片：马上去一趟、寄一张。
  const POSTCARD_DIR = path.join(DATA_DIR, 'postcards');
  const SANS_FONTS = ['C:\\Windows\\Fonts\\simhei.ttf', 'C:\\Windows\\Fonts\\msyh.ttc', 'C:\\Windows\\Fonts\\simsun.ttc'];
  // [城市, 景点, 正面画什么, 只在这几个月去]
  const PLACES = [
    ['厦门', '鼓浪屿', '鼓浪屿上的红砖老房子和盛开的三角梅，远处是海和轮渡，午后阳光'],
    ['青岛', '栈桥', '青岛海边的栈桥和回澜阁，红瓦绿树的老城，海鸥，晴朗的蓝天'],
    ['杭州', '西湖', '杭州西湖的断桥和远处的雷峰塔，湖面上的小船，垂柳，清晨薄雾'],
    ['苏州', '平江路', '苏州平江路的小河和石拱桥，白墙黛瓦，傍晚亮起的红灯笼'],
    ['成都', '熊猫基地', '成都竹林里抱着竹子吃的大熊猫，翠绿的竹林，阳光透过叶子'],
    ['重庆', '洪崖洞', '重庆洪崖洞的吊脚楼夜景，层层灯火倒映在江面上'],
    ['大理', '洱海', '大理洱海边的环湖小路，远处的苍山，蓝天白云，湖边一棵树'],
    ['丽江', '古城', '丽江古城层层叠叠的青瓦屋顶，远处的玉龙雪山，蓝天'],
    ['西安', '古城墙', '西安古城墙和城楼，夕阳，城墙上挂着红灯笼'],
    ['北京', '故宫角楼', '北京故宫角楼和护城河，金黄的银杏，湛蓝的天空', [9, 10, 11]],
    ['哈尔滨', '冰雪大世界', '哈尔滨冰雪大世界的彩色冰灯城堡，夜晚，飘着雪', [12, 1, 2]],
    ['三亚', '海边', '三亚的海边，椰子树，碧蓝透明的海水和白沙滩', [10, 11, 12, 1, 2, 3, 4]],
    ['桂林', '漓江', '桂林漓江的山水，江上的竹筏，喀斯特山峰，薄雾'],
    ['张家界', '天子山', '张家界一根根石柱一样的山峰，缭绕的云海'],
    ['黄山', '迎客松', '黄山的云海和迎客松，日出时的金色阳光'],
    ['南京', '秦淮河', '南京夫子庙秦淮河的夜景，画舫和灯笼倒映在水里'],
    ['上海', '外滩', '上海外滩的夜景，黄浦江对岸陆家嘴亮灯的高楼'],
    ['婺源', '篁岭', '婺源金黄的油菜花田和徽派白墙黑瓦的村落', [3, 4]],
    ['敦煌', '鸣沙山', '敦煌鸣沙山月牙泉，金色的沙丘，远处的骆驼队，夕阳', [5, 6, 7, 8, 9, 10]],
    ['喀纳斯', '喀纳斯湖', '喀纳斯湖，秋天金黄的白桦林，木屋，碧绿的湖水', [9, 10]],
    ['呼伦贝尔', '大草原', '呼伦贝尔大草原，白色的蒙古包，羊群，蓝天白云', [6, 7, 8]],
    ['潮州', '牌坊街', '潮州牌坊街和广济桥，老街，屋檐，傍晚'],
    ['武汉', '东湖', '武汉东湖绿道，湖边的樱花，骑车的小路', [3, 4]],
    ['长沙', '橘子洲', '长沙橘子洲头和湘江，岸边的城市夜景，烟花'],
  ];
  const tripTo = () => String(cfg.proactiveQQ[0] || api.owner() || '');
  let tripRunning = false;
  function pickPlace() {
    const m = new Date().getMonth() + 1;
    const recent = new Set((state._trips?.history || []).slice(-8).map((t) => t.spot));
    const ok = PLACES.filter((p) => (!p[3] || p[3].includes(m)) && !recent.has(p[1]));
    const [city, spot, scene] = pick(ok.length ? ok : PLACES);
    return { city, spot, scene };
  }
  function tripBlock(qq) {
    const t = cfg.postcard ? state._trips?.cur : null;
    if (!t || String(qq) !== tripTo()) return '';
    if (t.pending) return `\n\n---\n你周末去${t.city}玩了一趟（${t.spot}，你自己小世界里的旅行），给对方寄了张明信片，这次回完话会一起发过去：回复里顺口提一句“给你寄了张明信片”就行，别念明信片上写了啥。`;
    if (t.sent) return '';
    return `\n\n---\n你${dayKey() === t.planned ? '这个周末要出去玩' : '这个周末在外面玩'}：去${t.city}（${t.spot}）——这是你自己小世界里的一趟旅行。聊天时看气氛顺口提一句就行（去哪、在那儿干嘛），别每次都提。`;
  }
  async function makePostcard(qq, trip) {
    const prompt =
      `${persona()}${lifeBlock(qq)}\n\n---\n这个周末你出去玩了一趟（你自己小世界里的旅行）：去了${trip.city}（${trip.spot}）。你给对方寄一张明信片，正面是${trip.spot}的风景画。\n` +
      `只输出一个 JSON，不要调用工具、不要解释：{"to":"开头的称呼，带冒号，用你平时怎么叫对方","body":"明信片背面写的话","say":"把明信片发过去时顺口说的一句，10 个字以内"}\n` +
      `- 背面 40~90 字，第一人称、口语，写在那儿看到、吃到的一两样具体的东西，带一句想到对方的话，可以俏皮。\n` +
      `- 不写日期、落款和地址（会自动加），别写 AI、模型、提示词这类词。`;
    const r = await runAgent(prompt, null, { permissionMode: 'read-only' });
    const out = parseJsonLoose(r.text);
    const body = String(out?.body || '').trim().slice(0, 200);
    if (!body || /AI|模型|提示词/i.test(body)) throw new Error('明信片没写出来');
    fs.mkdirSync(POSTCARD_DIR, { recursive: true });
    const base = path.join(POSTCARD_DIR, `${dayKey()}-${qq}`);
    let front = '';
    try {
      front = await genImage(`${base}-front.png`, { prompt: `${trip.scene}，水彩插画风格的明信片画面，构图干净，色彩明亮通透，细节丰富`, negative: '文字，字母，数字，水印，签名，边框，人脸特写，模糊', size: '1440*960', model: cfg.postcardModel, apiKey: env.DASHSCOPE_API_KEY });
    } catch (err) {
      log(`明信片正面没画成，自己画一张：${err.message}`);
    }
    const card = `${base}.jpg`;
    const now = new Date();
    fs.writeFileSync(`${base}.json`, JSON.stringify({
      front, out: card, to: String(out?.to || '').trim().slice(0, 20) || '你：', body, sign: `—— ${cfg.botName}`,
      date: `${now.getFullYear()}.${now.getMonth() + 1}.${now.getDate()}`, city: trip.city, spot: trip.spot, fonts: LETTER_FONTS, sans: SANS_FONTS,
    }));
    const done = await runPyJson([path.join(HERE, 'postcard', 'card.py'), `${base}.json`], 60_000);
    fs.rmSync(`${base}.json`, { force: true });
    if (!done?.ok || !fs.existsSync(card)) throw new Error('明信片没拼出来');
    return { card, body, say: humanize(String(out?.say || '')).slice(0, 30) };
  }
  /** 寄出去：target 给了就直接发（/明信片）；没给就是周日自己寄——开着 ChronoLife 时先攒着，等对方来聊天再给。 */
  async function sendPostcard(qq, trip, target) {
    const pc = await makePostcard(qq, trip);
    Object.assign(trip, { sent: true, sentAt: Date.now(), card: pc.card });
    saveState();
    if (String(qq) === api.owner()) use('drawer')?.put('明信片', `${dayKey()}-${trip.city}.jpg`, pc.card);
    withLife(() => chrono.commit_virtual_event({ id: `trip:${dayKey()}`, kind: 'trip', content: `这个周末在自己的小世界里去了${trip.city}（${trip.spot}），给对方寄了一张明信片。` }));
    addDiary(`去${trip.city}玩了一趟，给对方寄了张明信片`);
    if (!target && cfg.chronolife) {
      trip.pending = { card: pc.card, body: pc.body };
      saveState();
      return void log(`明信片：从${trip.city}寄的，等 ${qq} 来聊天时给`);
    }
    const to = target || { message_type: 'private', user_id: Number(qq) };
    if (pc.say) await reply(to, pc.say);
    await givePostcard(to, { card: pc.card, body: pc.body }, trip);
  }
  async function givePostcard(ev, p, trip) {
    if (!p?.card || !fs.existsSync(p.card)) return;
    await sleep(1200 * pace());
    await sendMsg(ev, [{ type: 'image', data: { file: 'base64://' + fs.readFileSync(p.card).toString('base64') } }]);
    appendMemory(`u${ev.user_id}`, '（你收到了她寄的明信片）', `（从${trip.city}寄的明信片）${p.body}`);
    log(`明信片：从${trip.city}寄给 u${ev.user_id}`);
  }
  async function checkTrip() {
    if (!cfg.postcard || tripRunning || !api.online()) return;
    const qq = tripTo();
    if (!qq) return;
    const t = state._trips || (state._trips = { history: [] });
    const now = new Date();
    const today = dayKey();
    // 玩完了（周一以后）就收起来；攒着没给出去的明信片放十天也算了
    if (t.cur && today > t.cur.until && (!t.cur.pending || Date.now() - (t.cur.sentAt || 0) > 10 * 86400_000)) {
      t.history = [...t.history, { city: t.cur.city, spot: t.cur.spot, planned: t.cur.planned }].slice(-12);
      t.cur = null;
      saveState();
    }
    if (!t.cur) {
      const last = t.history.at(-1)?.planned;
      if (now.getDay() !== 5 || now.getHours() < 10 || (last && Date.now() - Date.parse(last) < (cfg.postcardEveryWeeks * 7 - 1) * 86400_000)) return;
      if (Date.now() - (userState(qq).lastUserAt || 0) > 14 * 86400_000) return; // 很久没聊的人不寄
      const sunday = new Date(now);
      sunday.setDate(now.getDate() + 2);
      t.cur = { ...pickPlace(), planned: today, until: dayKey(sunday), sent: false };
      saveState();
      withLife(() => chrono.commit_virtual_event({ id: `trip-plan:${today}`, kind: 'trip', content: `打算这个周末在自己的小世界里出去玩一趟：去${t.cur.city}（${t.cur.spot}）。` }));
      return void log(`旅行：这周末去${t.cur.city}（${t.cur.spot}）`);
    }
    if (t.cur.sent || now.getDay() !== 0 || now.getHours() < 14 || now.getHours() >= 21) return; // 周日下午寄
    tripRunning = true;
    try {
      t.cur.sent = true; // 先记上：失败了这趟也不重试，免得反复花钱
      saveState();
      await sendPostcard(qq, t.cur, null);
    } catch (err) {
      log(`明信片没寄成: ${err.message}`);
    } finally {
      tripRunning = false;
    }
  }

  // ChronoLife只在这里（和自己找事做）主动分享；先持久化并claim，再发单条消息，超时不重发。
  async function deliverLifeMessage(id) {
    if (api.activeRuns() || activeChats.size) return;
    const message = chrono.claim_message(id);
    if (!message) return;
    const qq = message.scope.slice(1);
    try {
      await sendMsg({ message_type: 'private', user_id: Number(qq) }, [{ type: 'text', data: { text: message.content } }]);
      chrono.finish_message(id, 'sent');
      appendMemory(message.scope, '（你主动找对方说了一句）', message.content);
      log('ChronoLife主动分享已发送');
    } catch (err) {
      chrono.finish_message(id, 'unknown');
      log(`ChronoLife发送结果未知，不自动重试：${err.message}`);
    }
  }
  /** 引擎只记“浇了水”这种骨架；这里让模型补一两句这次具体干了啥（一次一件，一天最多几次），记成 detail:<活动编号>。 */
  async function detailLifeEvent() {
    const s = chrono.get_state();
    if (!s.settings.enabled || s.settings.rest) return;
    const events = chrono.recent_events({ since: Date.now() - 12 * 3600_000, limit: 40 });
    const done = new Set(events.filter((e) => e.id.startsWith('detail:')).map((e) => e.id.slice(7)));
    const todo = events.find((e) => e.id.startsWith('activity:') && LIFE_KINDS[e.kind] && !done.has(e.id));
    if (!todo) return;
    const how = {
      plant: `小植物现在是“${s.world.plant.stage}”阶段。写一件这次照顾它时的小事（冒出了什么、叶子怎么样、给它挪了地方…），别超出它现在的阶段（还是种子就别写开花）。`,
      notes: '写你这次在笔记里记了什么：最近的事、冒出来的想法、想跟对方聊的话题都行，具体一点。',
      sketch: '写出这次留下的文字草稿本身：一小段描写或者几句小诗，30~80 字。只是文字构思，别说画出了图。',
    }[todo.kind];
    const prompt =
      `${persona()}${selfBlock()}\n\n---\n你刚才在自己的小屋里${LIFE_KINDS[todo.kind]}。${how}\n` +
      `第一人称，像在自己的备忘里记一笔，一两句；别写“虚拟”“模拟”“系统”，别写 AI、模型。只输出这一两句。`;
    let text = '';
    try {
      const r = await runAgent(prompt, null, { permissionMode: 'read-only' });
      text = humanize(r.text).replace(/\s+/g, ' ').trim().slice(0, 160);
    } catch (err) {
      log(`ChronoLife活动细节没写成：${err.message}`);
    }
    const ok = text && !/AI|模型|提示词|\[SILENT\]/.test(text);
    // 写不成也记一条（用原来那句），免得每半小时都重试花钱
    chrono.commit_virtual_event({ id: `detail:${todo.id}`, at: todo.at + 1, kind: todo.kind, content: ok ? `${LIFE_KINDS[todo.kind]}：${text}` : todo.content });
    log(`ChronoLife活动细节：${todo.kind}${ok ? '' : '（没写成，用原句）'}`);
  }
  let lifeSharing = false;
  async function checkChronoLife() {
    if (!cfg.chronolife || !chrono || !chronoAdapter || lifeSharing) return;
    lifeSharing = true;
    try {
      chrono.simulate_until(Date.now());
      chrono.expire_pending(Date.now());
      await detailLifeEvent();
      if (!api.online() || api.activeRuns() || activeChats.size) return;
      for (const pending of chrono.list_pending()) {
        const qq = pending.scope.slice(1);
        if (!cfg.allowedQQ.includes(qq) || !cfg.proactiveQQ.includes(qq) || Date.now() - (userState(qq).lastUserAt || 0) < 20 * 60000) continue;
        await deliverLifeMessage(pending.id);
      }
      // 拿最近一件有细节的事（或者植物换了阶段、出去玩了一趟）当理由；话让模型用她自己的口气写，每件事只问一次
      const reason = lifeEvents(chrono.recent_events({ since: Date.now() - 2 * 86400_000, limit: 40 })).find((e) => e.id.startsWith('detail:') || e.id.startsWith('plant:') || e.id.startsWith('trip:'));
      if (!reason) return;
      const asked = state._lifeAsked || (state._lifeAsked = {});
      for (const qq of cfg.proactiveQQ.filter(q => cfg.allowedQQ.includes(q))) {
        const scope = `u${qq}`;
        const key = `${scope}:${reason.id}`;
        const active = Date.now() - (userState(qq).lastUserAt || 0) < 20 * 60000;
        if (asked[key] || !chrono.evaluate_proactive_message({ scope, active, reasonId: reason.id }).allowed) continue;
        asked[key] = Date.now();
        for (const [k, at] of Object.entries(asked)) if (Date.now() - at > 7 * 86400_000) delete asked[k];
        saveState();
        const prompt =
          `${persona()}${lifeBlock(qq)}\n\n---\n你想跟对方随口分享一件你自己小屋里刚发生的事：${reason.content}\n` +
          `像朋友想起来顺手发一句：1~2 句，口语；别用“虚拟”“模拟”“系统”这种词，别说成在现实里出了门，别催对方回。不想说就只输出 [SILENT]。只输出要发的话。`;
        const r = await runAgent(prompt, null, { permissionMode: 'read-only' });
        const content = humanize(r.text).trim().slice(0, 200);
        if (!content || /\[SILENT\]|AI|模型|提示词/.test(content)) { log('ChronoLife：想了想没分享'); continue; }
        const id = `life-share:${scope}:${reason.id}`;
        if (!chrono.queue_message({ id, scope, content, reasonId: reason.id })) continue;
        await deliverLifeMessage(id);
      }
    } catch (err) { log(`ChronoLife后台检查失败：${err.message}`); }
    finally { lifeSharing = false; }
  }

  // ── 挂到内核的钩子上（order 见 docs/插件接口.md，跟原来在本体里的先后一致）────────────────────────
  // 提示词：【此刻】里的小屋近况、背景块（自我 10、电台 40、在忙 80、梦 100、旅行 110、礼物 120）、对方让她记住的、末尾的提醒（照片 20、礼物 30）
  api.on('prompt:state', () => lifeNowBlock(), 30);
  api.on('prompt:context', () => selfBlock(), 10);
  api.on('prompt:context', (t) => radioBlock(t.ev, t.text), 40);
  api.on('prompt:context', () => busyBlock(), 80);
  api.on('prompt:context', (t) => (t.isGroup ? '' : dreamBlock(t.chatKey)), 100);
  api.on('prompt:context', (t) => (t.isGroup ? '' : tripBlock(t.qq)), 110);
  api.on('prompt:context', (t) => (t.isGroup ? '' : giftBlock(t.qq)), 120);
  // 删掉的记忆在这里拦：背景块、短期记忆、长期事实、日记读出来都过一遍；开着 ChronoLife 但它没起来就什么都不给
  api.on('context:filter', (text, chatKey) => (chronoAdapter ? chronoAdapter.filter(chatKey, text) : cfg.chronolife ? '' : text));
  api.on('prompt:after', (t) => lifeNotesBlock(t.chatKey));
  api.on('prompt:hint', (t) => photoHint(t.text, t.isGroup), 20);
  api.on('prompt:hint', (t) => giftHint(t.text, t.isGroup), 30);
  // /help 里“直接跟我说”的例子（order 跟原来列的先后一样）
  api.on('help', (ev) => (ev.message_type !== 'group' && cfg.draw && env.DASHSCOPE_API_KEY && String(ev.user_id) === api.owner() ? '\n· “给我画只猫”' : ''), 70);
  api.on('help', () => (cfg.radio ? '\n· “开台，聊聊下雨天”（想听电台）' : ''), 80);
  api.on('help', (ev) => (ev.message_type !== 'group' && cfg.postcard ? '\n· “给我寄张明信片”' : ''), 110);
  api.on('help', (ev) => {
    if (!cfg.chronolife || !chronoAdapter) return '';
    const lifeOwner = ev.message_type !== 'group' && String(ev.user_id) === chronoAdapter.owner;
    return `\n· “帮我记着下周三考试”“那条记错了 是周四”${lifeOwner ? '“这几天别主动找我”' : ''}`;
  }, 140);

  // 本体抠出 [心情:词|为啥] 后先问这里：开着 ChronoLife 让它记一笔（“没回”“冷落”这种它自己管，返回 true = 这个心情不算了，也不交给 mood 插件）
  api.on('mood:changed', (skip, mood, reason, chatKey = '') => {
    if (skip) return;
    if (cfg.chronolife && /(?:没|不).*回|冷落|不理/.test(reason || '')) return true;
    if (cfg.chronolife) withLife(() => chrono.set_emotion({ valence: ['开心', '兴奋', '嘴贫'].includes(mood) ? .8 : ['烦', '有点丧', '委屈', '生气'].includes(mood) ? .3 : .6, arousal: ['兴奋', '生气'].includes(mood) ? .8 : mood === '困' ? .2 : .5, curiosity: mood === '无聊' ? .8 : .6, reason, scope: chatKey || 'global' }));
  });

  // ChronoLife 记一笔收到的消息、/生活：排在所有插件命令最前面（order 0，原来就在它们前面），每条放行的消息照旧都记上；
  // 不是 /生活 就返回 false，接着走别的命令
  api.on('message:command', async (ev, text, msg) => {
    if (!cfg.chronolife) return false;
    const { chatKey, isGroup } = msg;
    if (/^\/生活(?:\s|$)/.test(text)) {
      if (!chronoAdapter) { await reply(ev, '生活记录暂时不可用，普通聊天照常'); return true; }
      withLife(() => chrono.record_interaction({ id: `qq:${chatKey}:${ev.message_id}:in`, scope: chatKey, text: '收到生活设置指令', direction: 'in' }));
      try { await runQueued(chatKey, () => chronoAdapter.command({ text, scope: chatKey, userId: ev.user_id, isGroup, send: line => reply(ev, line, { whole: true }) })); }
      catch (err) { log(`生活指令失败：${err.message}`); await reply(ev, '这个生活操作没有完成，原记录保留'); }
      return true;
    }
    withLife(() => {
      if (!chrono.settings().enabled) return;
      chrono.record_interaction({ id: `qq:${chatKey}:${ev.message_id}:in`, scope: chatKey, text: text.slice(0, 2000), direction: 'in' });
      if (cfg.facts) chronoAdapter.importFacts(chatKey, factsOf(chatKey));
    });
    return false;
  }, 0);

  /** 寄明信片（/明信片 或者大白话 [寄明信片]）：有攒着的先给攒着的，没有就现去一趟。大白话的她已经回过一句了，natural 就不再说。 */
  async function startPostcard(ev, natural = false) {
    const no = async (line, why) => {
      if (natural) log(`大白话明信片：没寄（${why}）`);
      await reply(ev, line);
    };
    if (!cfg.postcard || ev.message_type === 'group') return void (await no(cfg.postcard ? '明信片私聊给你' : '还没出去玩过', cfg.postcard ? '群里不寄' : '没开明信片'));
    if (tripRunning) return void (await no('在写了 别催', '正在寄'));
    tripRunning = true;
    try {
      const t = state._trips || (state._trips = { history: [] });
      const pending = String(ev.user_id) === tripTo() ? t.cur?.pending : null;
      if (pending) {
        t.cur.pending = null; // 周末寄的那张还没给：先给这张
        saveState();
        if (!natural) await reply(ev, `早给你寄了 从${t.cur.city}寄的`);
        return void (await givePostcard(ev, pending, t.cur));
      }
      if (!natural) await reply(ev, pick(['等我找张明信片', '行 给你寄一张', '我想想从哪寄']));
      const trip = t.cur && !t.cur.sent ? t.cur : { ...pickPlace(), planned: dayKey(), until: dayKey(), sent: false };
      if (t.cur && t.cur !== trip) t.history = [...t.history, { city: t.cur.city, spot: t.cur.spot, planned: t.cur.planned }].slice(-12);
      t.cur = trip; // 这周已经说好要去的就寄那儿的，没有就现去一趟
      saveState();
      await sendPostcard(ev.user_id, trip, ev);
    } catch (err) {
      log(`明信片失败: ${err.message}`);
      await reply(ev, '没寄出来 改天再寄');
    } finally {
      tripRunning = false;
    }
  }
  // /明信片：马上去一趟、寄一张
  api.on('message:command', async (ev, text) => {
    if (text !== '/明信片') return false;
    await startPostcard(ev);
    return true;
  });

  // 深夜电台：说了“我来投稿”在等稿子，或者一听就是在点电台（开台、来一期、只听一分钟…）→ 直接录，不用先过一遍模型。
  // 说得含糊的（“今晚想听你说点啥”）交给聊天：模型觉得是想听就写 [电台:…]。
  api.on('message:turn', async (ev, text, msg) => {
    if (!cfg.radio || msg.images.length) return false;
    const { chatKey, who } = msg;
    const rkey = radioKey(ev);
    const rctx = { chatKey, who: senderName(ev), uid: ev.user_id, userText: text, mood: myState(chatKey).mood };
    if (handleRadio.collect(rkey, ev.user_id, text, ev, rctx)) {
      api.markRead(ev);
      log(`→ ${who}: （电台投稿 ${text.length} 字）`);
      return true;
    }
    const req = radioRequest(text, { wake: cfg.wakeWords, hasShow: handleRadio.count(rkey) > 0 });
    if (req) {
      api.markRead(ev);
      log(`→ ${who}: ${text.slice(0, 80).replace(/\n/g, ' ')}（点电台）`);
      startRadio(ev, req, rctx);
      return true;
    }
    return false;
  });
  api.on('say:extract', ({ text, tags }) => ({ text: extractRadioTag(text).text, tags }), 10);

  // 这一轮里要做的
  api.on('turn:start', (t) => {
    // 攒着的明信片（开着 ChronoLife 时周日寄的）：提示词里让她提一句，回完这轮一起给
    const trip = !t.isGroup && cfg.postcard && String(t.qq) === tripTo() ? state._trips?.cur : null;
    t.trip = trip;
    t.giveCard = trip?.pending || null;
  });
  api.on('turn:answer', (answer, t) => {
    // [电台:…]：她答应录一期，回完这句就去录（不占着这个聊天，录的时候对方还能接着聊）
    const rt = extractRadioTag(answer);
    t.tags.radio = rt.radio;
    return rt.text || '行 等我录一下';
  }, 30);
  api.on('turn:answer', (answer, t) => {
    // [照片]：回完这句再拍一张现在的样子发过去
    t.tags.photo = /\[照片\]/.test(answer);
    return answer.replace(/\[照片\]/g, '').trim() || '你看';
  }, 40);
  api.on('turn:answer', (answer, t) => {
    // [收礼物:东西名]：对方送的东西摆进她房间（画好、抠好后拍一张“摆好了”）
    t.tags.gift = answer.match(/\[收礼物[:：]\s*([^\]]+?)\s*\]/)?.[1] || '';
    return answer.replace(/\[收礼物[:：][^\]]*\]/g, '').trim() || '谢谢 我收下了';
  }, 60);
  api.on('turn:spoken', (tags, t) => (t.tags.gift && cfg.photo ? `（收下了对方送的${t.tags.gift}，摆在房间里）` : ''), 30);
  api.on('turn:after', async (t) => {
    const { ev, chatKey, ids, spoken, isGroup } = t;
    withLife(() => { if (chrono.settings().enabled) chrono.record_interaction({ id: `qq:${chatKey}:${ids?.join('-') || Date.now()}:out`, scope: chatKey, text: spoken.slice(0, 2000) || '（表情）', direction: 'out' }); });
    // 她回复里那句“你看”已经发出去了：照片没拼成、拍不了都补一句
    if (t.tags.photo) {
      const sent = cfg.photo && !isGroup ? await sendScenePhoto(ev).catch((err) => (log(`现场照失败: ${err.message}`), false)) : false;
      if (!sent) {
        if (!cfg.photo || isGroup) log(`现场照：${isGroup ? '群里' : '没开现场照'}，不拍`);
        await reply(ev, isGroup && cfg.photo ? '照片私聊发你' : pick(['诶 照片没弄好', '诶 没拍好 算了']));
      }
    }
  }, 10);
  // 原来是一个钩子：现场照 → 放歌 → 收礼物、明信片、等你回、电台。放歌在 pc 插件里（order 20），等你回在 proactive 插件里（order 35），
  // 这里拆成 10、30 和 40，先后不变
  api.on('turn:after', async (t) => {
    const { ev, isGroup } = t;
    if (t.tags.gift && cfg.photo && !isGroup) receiveGift(ev, t.tags.gift).catch((err) => (log(`收礼物没成: ${err.message}`), reply(ev, '诶 东西没摆好 回头再弄').catch(() => {}))); // 画要半分钟，不占着这个聊天
    if (t.giveCard && t.trip.pending === t.giveCard) {
      t.trip.pending = null;
      saveState();
      t.gaveCard = true; // 这轮已经给了攒着的那张：大白话 [寄明信片] 就不再寄
      await givePostcard(ev, t.giveCard, t.trip).catch((err) => log(`明信片没给成: ${err.message}`));
    }
  }, 30);
  api.on('turn:after', async (t) => {
    const { ev, chatKey, text } = t;
    if (t.tags.radio && cfg.radio) {
      let req = t.tags.radio;
      if (req.submit && !req.submission) {
        const own = parseAsk(text);
        req = { ...req, submission: own.submit ? own.submission : text.slice(0, 2000) };
      }
      startRadio(ev, req, { ack: false, chatKey, who: senderName(ev), uid: ev.user_id, userText: text, mood: myState(chatKey).mood });
    }
  }, 40);

  // 电台要看 voice 服务（说话的样子，speech 插件）有没有：插件都加载完再建
  api.on('startup', () => {
    handleRadio = makeRadio();
  });
  // 本体退出（SIGINT / SIGTERM）时关掉数据库
  api.on('shutdown', () => withLife(() => chrono.close()));

  // ── 大白话：[寄明信片]、ChronoLife 的 [记住:…] [忘掉:…] [更正:…|…] [生活:主动 关…]、[画:描述] ───────────────
  // 本体抠掉标记、回完这句交到 natural:act 这里办，跟 /明信片 /生活 走同一个入口（主人才能改全局设置），回的话只记日志；办不成补一句。
  /** ChronoLife 的设置和记忆：跟 /生活 走同一个入口（主人才能改全局设置），回的话只记日志。 */
  async function lifeCmd(ev, chatKey, isGroup, arg) {
    if (!cfg.chronolife || !chronoAdapter) {
      log(`大白话生活：没开，「${arg.slice(0, 40)}」不办`);
      return void (await reply(ev, '这个我现在记不了 回头再说'));
    }
    const out = [];
    await chronoAdapter.command({ text: `/生活 ${arg}`, scope: chatKey, userId: ev.user_id, isGroup, send: async (line) => out.push(line) });
    log(`大白话生活「${arg.slice(0, 40)}」：${out.join(' / ').replace(/\s+/g, ' ').slice(0, 120)}`);
    const said = out.join(' ');
    if (/请由主人/.test(said)) await reply(ev, '这个得主人说了算');
    else if (/不能更改|不存在|没有这个生活指令/.test(said)) await reply(ev, '诶 那条我改不了');
  }
  const LIFE_SWITCH_RE = /^(?:主动 (?:开|关)|暂停|恢复|停用|启用|兴趣 (?:plant|notes|sketch|rest) \d+(?:\.\d+)?)$/;

  // 画画（DRAW，主人专用）：主人让她画，她写 [画:描述]，用百炼通义万相（imagegen.mjs）画一张发回 QQ。
  // 一天最多 DRAW_MAX_DAY 张（默认 3，先记上，画失败退回去）；没有 DASHSCOPE_API_KEY 就说画不了。存 <数据目录>/drawings/（留最近 30 张），
  // 主人电脑的桌面抽屉里也放一份。测试用 DRAW_FAKE_FILE 代替真去画。
  const DRAW_DIR = path.join(DATA_DIR, 'drawings');
  const DRAW_ASK = /画(?:一|个|张|幅|只|副|画)|帮我画|给我画/;
  async function drawAsked(ev, raw) {
    const desc = String(raw || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    const no = async (why, line) => {
      log(`画画：${why}`);
      await reply(ev, line);
    };
    if (!cfg.draw) return void (await no('没开', '我还不会画画'));
    if (!api.isOwnerChat(ev)) return void (await no(`${ev.user_id} 不是主人或者在群里，不画`, '画画只给主人画'));
    if (!desc) return void (await no('没说画啥', '画啥 说具体点'));
    if (!env.DASHSCOPE_API_KEY) return void (await no('没有 DASHSCOPE_API_KEY', '我这边画不了 画图的没配好'));
    const day = state._draw?.day === dayKey() ? state._draw : (state._draw = { day: dayKey(), count: 0 });
    if (day.count >= cfg.drawMaxDay) return void (await no(`今天已经画了 ${day.count} 张`, '今天画好几张了 手酸 明天再画'));
    day.count++;
    saveState();
    fs.mkdirSync(DRAW_DIR, { recursive: true });
    const out = path.join(DRAW_DIR, `${Date.now()}.png`);
    try {
      if (env.DRAW_FAKE_FILE) fs.copyFileSync(env.DRAW_FAKE_FILE, out);
      else await genImage(out, { prompt: desc, negative: '文字，水印，签名，模糊，畸形', size: '1024*1024', model: cfg.drawModel, apiKey: env.DASHSCOPE_API_KEY });
      for (const f of fs.readdirSync(DRAW_DIR).filter((x) => x.endsWith('.png')).sort().slice(0, -30)) fs.rmSync(path.join(DRAW_DIR, f), { force: true });
      await sendMsg(ev, [{ type: 'image', data: { file: 'base64://' + fs.readFileSync(out).toString('base64') } }]);
      use('drawer')?.put('画', path.basename(out), out);
      log(`画画：画好发了（${desc.slice(0, 30)}）`);
    } catch (err) {
      day.count = Math.max(0, day.count - 1); // 没画成不算
      saveState();
      await no(`没画成（${err.message}）`, '没画出来 等会再试试');
    }
  }

  api.on('natural:act', async (ev, a, { chatKey, isGroup, turn }) => {
    if (a.kind === '寄明信片') {
      if (turn?.gaveCard) log('大白话明信片：攒着的那张这轮已经给了，不再寄');
      else startPostcard(ev, true).catch((err) => log(`明信片失败: ${err.message}`)); // 要好一会儿，不占着这个聊天
      return true;
    }
    if (a.kind === '记住') {
      if (a.body) await lifeCmd(ev, chatKey, isGroup, `记住 ${a.body.slice(0, 2000)}`);
      return true;
    }
    if (a.kind === '忘掉' || a.kind === '更正') {
      const [old, ...rest] = a.body.split(/[|｜]/);
      const fix = rest.join(' ').trim();
      const m = cfg.chronolife && chronoAdapter ? chronoAdapter.findMemory(chatKey, old) : null;
      if (!m || (a.kind === '更正' && !fix)) {
        log(`大白话${a.kind}：没找到「${old.slice(0, 30)}」这条${a.kind === '更正' && !fix ? '（也没说改成啥）' : ''}`);
        await reply(ev, !m ? '诶 我没找到你说的那条' : '改成啥来着');
      } else await lifeCmd(ev, chatKey, isGroup, a.kind === '忘掉' ? `删除 ${m.id}` : `更正 ${m.id} ${fix.slice(0, 2000)}`);
      return true;
    }
    if (a.kind === '生活') {
      const arg = a.body.replace(/\s+/g, ' ').replace(/^主动\s*(开|关)$/, '主动 $1');
      if (!LIFE_SWITCH_RE.test(arg)) {
        log(`大白话生活：「${arg.slice(0, 30)}」不是能改的开关，没办`);
        await reply(ev, '这个我改不了');
      } else await lifeCmd(ev, chatKey, isGroup, arg);
      return true;
    }
    if (a.kind === '画') {
      drawAsked(ev, a.body).catch((err) => log(`画画没画成: ${err.message}`)); // 要半分钟以上，不占着这个聊天
      return true;
    }
    return false;
  });
  // 提示词里教她写这些标记（order 跟原来的先后一样：明信片 40、画画 80、ChronoLife 100）
  api.on('natural:hint', (t) => (!t.isGroup && cfg.postcard ? '\n- 对方想要你寄张明信片：写 [寄明信片]，先回一句，寄好了会发过去。' : ''), 40);
  api.on('natural:hint', (t) => {
    if (!cfg.draw) return '';
    if (!api.isOwnerChat(t.ev)) return DRAW_ASK.test(t.text) ? '\n- 对方让你画画：画画只给主人画（得主人私聊），直接跟 TA 说画不了。' : '';
    const d = state._draw?.day === dayKey() ? state._draw.count : 0;
    return !env.DASHSCOPE_API_KEY
      ? '\n- 对方让你画画：你现在画不了（画图没配好），直接跟 TA 说画不了；别自己去找 key 调画图接口。'
      : d >= cfg.drawMaxDay
        ? `\n- 对方让你画画：今天已经画了 ${d} 张，画不动了，跟 TA 说明天再画，别写标记。`
        : `\n- 对方让你画张图（“画只猫”“给我画个头像”）：写 [画:画面描述]（写清楚画什么、什么风格），会画一张发过去，要半分钟到一分钟，先回一句；今天还能画 ${cfg.drawMaxDay - d} 张。想画只能写这个标记，别自己拿 key 去调画图接口。`;
  }, 80);
  api.on('natural:hint', (t) => {
    if (!cfg.chronolife || !chronoAdapter) return '';
    const s = withLife(() => chrono.settings(), null);
    let out = '';
    if (s?.enabled) out += '\n- 对方明确让你记住一件事（“帮我记着…”“你记住…”）：写 [记住:那件事]；让你忘掉你记着的某件事：写 [忘掉:那条里的几个字]；说你记错了：写 [更正:那条里的几个字|改成什么]。';
    if (s && !t.isGroup && String(t.qq) === chronoAdapter.owner) {
      const now = !s.enabled ? '整个停着' : `${s.rest ? '在歇着（暂停中），' : ''}${s.proactive ? '会' : '不会'}偶尔主动找对方说说自己的事`;
      out += `\n- 你自己过日子这套的开关只有对方能动，现在：${now}。对方让你别主动找 TA 了写 [生活:主动 关]，让你可以主动写 [生活:主动 开]；让你歇会儿写 [生活:暂停]，回来写 [生活:恢复]；要把这套整个停掉写 [生活:停用]，再打开写 [生活:启用]。`;
    }
    return out;
  }, 100);

  // ── 给别的插件用的 ──────────────────────────────────────────────────────────
  api.provide('life', {
    state: () => (cfg.chronolife ? withLife(() => chrono.get_state(), null) : null), // ChronoLife 现在的状态（没开、没起来是 null）
    recentEvents: (q, o) => withLife(() => lifeEvents(chrono.recent_events(q), o), []), // 最近记下的事（过滤后的，没起来是 []）
    memoryOff: () => cfg.chronolife && !chronoAdapter, // 开着 ChronoLife 但它没起来：短期记忆、长期事实、日记都当没有
    doing: () => doing.name, // 自己找事做、录电台时正在干的事（没在干是空字符串）
    selfBlock: () => selfBlock(), // 人设成长那段
    takeDream: (chatKey) => takeDream(chatKey), // 拿走今天要说的梦（说过就不再给）
    tripTo: () => tripTo(), // 明信片寄给谁（PROACTIVE_QQ 第一个，没设就是主人）
  });
  api.provide('photo', { compose: (qq) => composeScenePhoto(qq), dir: SCENE_DIR }); // 拼一张现场照、现场照的图目录（pose/ 里的动作图写信时当小章）

  // 模型怎么用这些工具：写进工作目录的 AGENTS.md
  api.on('agents', () => `
## 刷 B站

想刷 B站、看某个视频讲了啥，用 \`${BILI}\`（不用手机，读得比截图准）：

\`\`\`
node "${BILI}" hot 10                 热门
node "${BILI}" rank 10                全站排行
node "${BILI}" search 修老电视 --n 8   搜索（--order click 按播放 / pubdate 按最新）
node "${BILI}" watch BV号或链接        简介、标签、弹幕刷得最多的、热评（b23.tv 短链也行）
node "${BILI}" watch BV号 --listen 3   再用本地 Whisper 听前 3 分钟讲了啥（最多 3 分钟）
node "${BILI}" watch BV号 --frames     再看画面：挑弹幕最密的时刻和换镜头的地方截图，每 9 格一张，用 read_image 一张张看
node "${BILI}" seen                   最近看过的
node "${BILI}" pics BV号或链接          评论区里大家发的图，按赞数挑，下成小图（动图不大就要原图），用 read_image 看
node "${BILI}" keep 图片路径 情绪 描述   把 pics 下的一张收进你的表情包（情绪：开心/无语/生气/卖萌/得意/委屈/震惊）
\`\`\`

- 列表里标了“（看过）”的就别再看了，换一个。
- 评论区的图主要去 DeepSeek 二创那边看（搜 DeepSeek二创、DeepSeek娘、DeepSeek表情包）：看中了、以后想拿来斗图的才 \`keep\`，一次最多收 3 张，描述写“画面：什么时候用”。截图、长图、广告、看不懂的别收。
- 聊天类、知识类视频加 \`--listen\`；看画面的（搞笑、vlog、游戏）加 \`--frames\`；两个都加会慢一些。听要本地的 whisper 模型（.env 的 WHISPER_MODEL_DIR），没有就说没听成（不会去网上下），跟对方说听不了就行。
- \`--listen\` 一次最多听前 3 分钟，写多了也按 3 分钟算。对方想让你看更久，就跟对方说一次只能看一会儿，看完说说看到了啥。
- 看画面时对照“时间轴”：标了“弹幕高峰”的格子是观众反应最大的地方，配着那里刷的弹幕一起看，最能看懂笑点在哪。
- 说“B站说刷太快了（风控）”就别再刷，干点别的。
- 不会发评论、点赞、投币，也不登录别人的账号。

## 刷别的（知乎、微博、听歌、看番）

都不用登录，用 \`${LIFE}\`：

\`\`\`
node "${LIFE}" zhihu 15              知乎热榜：问题、热度、摘要（回答要登录看不了）
node "${LIFE}" weibo 20              微博热搜
node "${LIFE}" music 飙升             网易云榜单：飙升 / 热歌 / 新歌 / 原创
node "${LIFE}" song 晴天              一首歌的歌词 + 网易云热评（歌名或 id）
node "${LIFE}" song 歌名 歌手 --lyrics-json 歌名.json   学歌用：带时间的歌词存到 ${path.join(DATA_DIR, 'tmp')}，会打出完整路径（--offset 秒 挪时间）
node "${LIFE}" anime                 今天更新的新番（anime 这周 看这周的）
node "${LIFE}" anime-rank            番剧排行
node "${LIFE}" anime-watch season_id 追一部番：简介、评分、最新一集、弹幕、热评
node "${LIFE}" seen                  最近看过的
\`\`\`

- 标了“（看过）”的就换一个。番剧画面大多要会员，看弹幕和评论就行。
`);

  // ── 定时任务和启动日志（原来在本体 main 段末尾、连 QQ 之后打；现在在插件加载时打）──────────────
  if (cfg.chronolife) {
    log(`ChronoLife：${cfg.chronolifeTickMinutes}分钟维护一次虚拟生活（活动细节用模型写）；自己找事做照常、算它的活动；主动分享由独立开关控制，旧的问候/回访/戳人通道停用`);
    api.every(cfg.chronolifeCheckMs || Math.max(1, cfg.chronolifeTickMinutes) * 60000, () => checkChronoLife().catch(() => {}));
  }
  if (cfg.dream) api.every(cfg.dreamCheckMs, () => checkDreams().catch(() => {}), Math.min(45_000, cfg.dreamCheckMs));
  if (cfg.photo) log(`现场照: 问她在干嘛时可能回一张（图在 ${SCENE_DIR}，一天最多 ${cfg.photoMaxDay} 张）`);
  if (cfg.postcard) {
    log(`旅行明信片: 每 ${cfg.postcardEveryWeeks} 周的周末出去玩一趟，周日下午给 ${tripTo() || '（没设 PROACTIVE_QQ）'} 寄一张（正面用百炼 ${cfg.postcardModel} 画${cfg.chronolife ? '；开着 ChronoLife，等对方来聊天时再给' : ''}）`);
    api.every(cfg.postcardCheckMs, () => checkTrip().catch(() => {}));
  }
  if (cfg.reflect) {
    log(`人设成长: 每天 ${cfg.reflectHour} 点后回想一次自主活动的经历`);
    api.every(cfg.reflectCheckMs, checkReflection);
  }
  if (cfg.autonomy) {
    log(`自主活动: 每小时掷一次骰子（基础 ${Math.round(cfg.autonomyRollProb * 100)}%，看心情），两次至少隔 ${cfg.autonomyMinutes} 分钟，每天最多 ${cfg.autonomyMax} 次`);
    api.every(cfg.autonomyCheckMs, checkAutonomy, Math.min(90_000, cfg.autonomyCheckMs));
  }
}

/**
 * 功能页（本体的 scripts/features.mjs）上这个插件的几行：不跑 setup，cfg 里已经挂好了各插件 settings() 的值。
 * 格式见 docs/插件接口.md 的“功能页”。开着 ChronoLife 时只读打开它的数据库看现在的样子（node:sqlite 用到时才 import，打不开就只显示开关）；
 * taken 是开着 ChronoLife 时交给它管的旧主动通道（别的插件的行名 → [说明, 是否整个不单独发了]）；sections 是“它慢慢长出来的样子”那块。
 */
export async function features(cfg, { env, DATA_DIR, state, readJson, esc, when, on }) {
  const SCENE_DIR = env.SCENE_DIR ? path.resolve(env.SCENE_DIR) : path.join(DATA_DIR, 'scene');
  let life = null;
  if (cfg.chronolife) {
    try {
      const { DatabaseSync } = await import('node:sqlite');
      const db = new DatabaseSync(path.join(DATA_DIR, 'chronolife', 'life.sqlite'), { readOnly: true });
      const get = (sql, ...args) => db.prepare(sql).get(...args);
      const settings = Object.fromEntries(db.prepare('SELECT * FROM runtime_settings').all().map((r) => [r.key, JSON.parse(r.value)]));
      const st = JSON.parse(get('SELECT data FROM character_state WHERE id=1').data);
      const world = JSON.parse(get('SELECT data FROM virtual_world_state WHERE id=1').data);
      const week = get("SELECT COUNT(*) AS n FROM outbound_messages WHERE status IN ('pending','sending','sending_answered','sent','unknown','answered') AND created>?", Date.now() - 7 * 86400_000).n;
      const last = get("SELECT content FROM timeline_events WHERE scope='global' AND id LIKE 'detail:%' ORDER BY at DESC LIMIT 1")?.content || '';
      db.close();
      // 跟 engine.get_state() 一样的判法：停用 > 休息/免打扰 > 刚聊过 > 在做事 > 空闲
      const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: settings.timezone, hour: 'numeric', hourCycle: 'h23' }).format(Date.now()));
      const quiet = settings.quietStart > settings.quietEnd ? hour >= settings.quietStart || hour < settings.quietEnd : hour >= settings.quietStart && hour < settings.quietEnd;
      const mode = !settings.enabled ? '停用' : settings.rest ? '休息（主人让歇着）' : quiet ? '休息（夜里）' : Date.now() - st.lastInteraction < 10 * 60000 ? '在跟人聊天' : Date.now() < st.activityUntil ? '在做事' : '空闲';
      life = { settings, mode, plant: world.plant?.stage || '—', week, last: last.replace(/虚拟/g, '').slice(0, 60) };
    } catch {
      life = { error: true };
    }
  }
  const selfProfile = readJson(path.join(DATA_DIR, 'self-profile.json'), {});
  const selfItems = Array.isArray(selfProfile.items) ? selfProfile.items : [];
  return {
    groups: [
      ['她自己的生活', [
        ['ChronoLife 小屋', on(cfg.chronolife), life ? (life.error ? '数据库打不开：普通聊天照常，小屋暂停' : `现在：${life.mode} · 窗台植物：${life.plant}${life.last ? ` · 最近：${life.last}` : ''}`) : '', `她有一间自己的小屋，每 30 分钟过一次日子：窗台养着一盆植物（种子→发芽→幼苗→展开新叶，按天长），有时照顾植物、整理笔记、写点东西、发呆休息（一天最多 4 件，也可能一件都不做；夜里和你刚找过她时不开始新的）。每件事先记个大概，再让模型补一两句这次具体干了啥。聊天时她知道小屋里最近的事，不会说成在现实里出了门。电脑关着时由 Windows 定时任务接着算，开机只补一句“离开了几个小时”。/生活 帮助 看命令，详细说明在 ${path.join(HERE, 'chronolife', 'README.md')}。`],
        ['自己找事做', on(cfg.autonomy), `10–23 点每小时掷一次骰子（基础 ${Math.round(cfg.autonomyRollProb * 100)}%）· 两次至少隔 ${cfg.autonomyMinutes} 分钟 · 每天最多 ${cfg.autonomyMax} 次`, `每小时在随机的某一分钟问自己“要不要玩会”：无聊、兴奋的时候更想玩，困、懒、没精神就不太想动；你 ${cfg.autonomyIdleMin} 分钟内找过它就先陪你。想玩就先挑一件想干的事——刷 B站、看番、刷知乎热榜、刷微博热搜、听歌（看榜单、歌词和网易云热评），有手机的话还会玩手机，记得你喜欢什么的话还会专门找点你会喜欢的；跟上一次的错开，今天干过的少挑。刷到跟你喜好有关的会发给你（“看到这个就想到你”）；你在她刷东西的时候来找她，她知道自己正在干嘛；顺手记“今天干过啥”。${cfg.chronolife ? '开着 ChronoLife 时照常玩，算她小屋生活里的一件事（休息、停用时不玩）；想发给你也要过 ChronoLife 主动分享那几条规矩。' : ''}`],
        ['刷 B站', 'on', (() => { const seen = readJson(path.join(DATA_DIR, 'bili', 'seen.json'), []); return `${env.BILIBILI_SESSDATA ? '已登录（能读字幕）' : '没登录（看弹幕热评，字幕靠听）'} · 最近看过 ${seen.length} 个${seen[0] ? `，上一个：${seen[0].title}` : ''}`; })(), '不用手机，直接走 B站接口：热门 / 排行 / 搜索；看一个视频能拿到简介、标签、弹幕刷得最多的、热评；--listen 用本地 Whisper 听前几分钟，--frames 挑弹幕最密的时刻和换镜头的地方截图（整段都覆盖，去掉重复镜头），每 9 格拼一张图看画面。看过的打标记不重复看；被风控就歇 15 分钟。不发评论、不点赞投币。'],
        ['做梦', on(cfg.dream), `每天 ${Math.round(cfg.dreamProb * 100)}% 会梦见`, '早上醒来有时记得昨晚的梦：拿最近刷到的、跟你聊过的事打乱了拼的，荒诞又有你。今天第一次聊天、或者发早安时，她可能顺口说一句“我昨晚梦见……”，只说一次。'],
        ['人设成长', on(cfg.reflect), `每天 ${cfg.reflectHour} 点后回想一次（攒够 8 件事会提前）· 最多 ${cfg.selfMax} 条 · ${cfg.selfForgetDays} 天没再印证就淡忘（“最近在看” ${cfg.recentForgetDays} 天）`, '把自己找事做的日记反思成它自己的喜好、观点、最近在看的、学到的梗；又印证一次就加深。persona.md 的核心人设不动，这只是“最近的自己”。'],
        ['深夜电台', on(cfg.radio), (() => { let n = 0; let last = ''; try { for (const d of fs.readdirSync(path.join(DATA_DIR, 'radio'), { withFileTypes: true })) { if (!d.isDirectory()) continue; for (const e of readJson(path.join(DATA_DIR, 'radio', d.name, 'episodes.json'), [])) { n++; if (e.createdAt > last) last = e.createdAt; } } } catch {} return n ? `录了 ${n} 期，最近一期 ${last.slice(5, 10)} · 一天最多 ${cfg.radioMaxDay} 期` : `还没录过 · 一天最多 ${cfg.radioMaxDay} 期`; })(), '说“开台，今晚想听点适合下雨的”“来一期开心的，别聊大道理”“今晚只听一分钟”，她就录一期两三分钟（或一分钟）的语音节目：用她自己的口气，讲她最近真刷到的事，配一张节目卡，推荐一首网易云上真搜得到的歌（歌名歌手对不上就不给链接）。“我来投稿，你帮我念”她帮你念，“上期那个话题接着讲”她接着聊，“再放一遍”不再花钱。私聊节目能用上她记得的你的事，群节目不带私事。录的时候来找她，她知道自己在录；录完聊天里也记得录过。'],
        ['旅行明信片', on(cfg.postcard), cfg.postcard ? (() => { const t = state._trips?.cur; return t ? `这趟：${t.city}（${t.spot}）${t.sent ? '，已寄出' : ''}` : `每 ${cfg.postcardEveryWeeks} 周出去一趟`; })() : '', `隔几周的周末，她在自己的小世界里出去玩一趟（周五定去哪：厦门、青岛、大理、哈尔滨…按季节挑），周日下午给你寄一张明信片：正面用百炼画当地风景（一张一两毛钱），背面手写几句、贴邮票、盖邮戳。开着 ChronoLife 时不主动发，等你下次来聊天时她提一句再给。跟她说“寄张明信片”（或发 /明信片）可以马上寄一张。`],
        ['现场照', on(cfg.photo), (() => { const n = (d) => { try { return fs.readdirSync(path.join(SCENE_DIR, d)).length; } catch { return 0; } }; return `${n('bg')} 个房间背景、${n('pose')} 个动作 · 一天最多 ${cfg.photoMaxDay} 张`; })(), `问她“在干嘛”，她可能回一张“现在的她”：按几点、你那边的天气挑她房间的样子（早上、白天、傍晚、夜里开着台灯、下雨、下雪），按她在干嘛和心情挑动作（睡觉、刷手机、听歌、吃饭、生闷气、犯困…）。图在 ${SCENE_DIR} 里（bg 房间、pose 动作）。`],
        ['送她的东西摆进房间', on(cfg.photo), (() => { const g = readJson(path.join(SCENE_DIR, 'gifts', 'gifts.json'), []); return g.length ? `房间里：${g.slice(-3).map((x) => x.name).join('、')}` : '还没收到过'; })(), '跟着现场照一起开。你发张图或者说“送你个…”，她想收就收下：用百炼把这个东西画出来（白底，抠成透明的），摆进她的房间，马上拍一张“摆好了”给你看；以后的现场照里也能看到最近收的 3 件。她只记得你送过她什么，别人送的不会跟你提。一天最多画 3 件。'],
        ['画画', on(cfg.draw && env.DASHSCOPE_API_KEY), cfg.draw ? (env.DASHSCOPE_API_KEY ? `百炼 ${cfg.drawModel} · 一天最多 ${cfg.drawMaxDay} 张` : '没有 DASHSCOPE_API_KEY，画不了') : '', '主人私聊让她画（“给我画只猫”），她用百炼通义万相画一张 1024×1024 发回来（一张一两毛钱），要半分钟到一分钟；画好的存在数据目录的 drawings/ 里（留最近 30 张），开着桌面抽屉也放一份。只给主人画，别人让画她会说画不了；画到一天的上限就说明天再画，没画成不算数。'],
      ]],
      ['主动找你', [
        ['ChronoLife 主动分享', cfg.chronolife && life?.settings?.proactive ? 'on' : 'off', life?.settings ? `这周发了 ${life.week}/${life.settings.weeklyMax} 条 · ${life.settings.quietStart}~${life.settings.quietEnd} 点不发 · 同一个人隔 ${life.settings.cooldownHours} 小时` : '', '开着 ChronoLife 时，主动找你只走这一条：小屋里刚有了具体内容的事（写了句什么、植物换了阶段、旅行回来），或者自己找事做时刷到你会喜欢的，她用自己的口气随口说一句，不想说就不说。只发 PROACTIVE_QQ 里的人、不发群；上一条你没回就不发下一条；你 20 分钟内刚聊过就留到聊天里说。主人私聊说“别主动找我”“可以主动找我了”就改（/生活 主动 开 / 关 也行）。', 10],
      ]],
    ],
    sections: [
      ['它慢慢长出来的样子', `<div class="card">${selfItems.length ? `<table>${['喜好', '观点', '最近在看', '梗', '习惯'].map((k) => [k, selfItems.filter((i) => i.kind === k)]).filter(([, v]) => v.length).map(([k, v]) => `<tr><td class="n">${esc(k)}</td><td>${v.map((i) => `${esc(i.t)}${(i.seen || 1) > 1 ? ` <span class="how">×${i.seen}</span>` : ''}`).join('<br>')}</td></tr>`).join('')}</table>` : '<div class="how">还没长出来：要先有自己找事做的日记，晚上回想过才会有。</div>'}<div class="how">上次回想：${esc(when(selfProfile.lastReflectAt))} · ×N 表示被印证过 N 次</div></div>`],
    ],
    natural: [
      ['“给我画只猫”', cfg.draw ? '主人私聊时画一张发过来（要百炼的 key，一天有上限）' : '没开（DRAW=false）', 70],
      ['“开台，聊聊下雨天”', cfg.radio ? '录一期深夜电台' : '没开电台', 80],
      ['“给我寄张明信片”', cfg.postcard ? '马上寄一张旅行明信片（只在私聊）' : '没开明信片', 110],
      ['“帮我记着下周三考试”', cfg.chronolife ? '开着 ChronoLife 时记下；“那条记错了 是周四”“那个别记了”也行；主人私聊说“这几天别主动找我”“歇会儿吧”就改开关' : '开着 ChronoLife 才有', 140],
    ],
    commands: [
      ['/明信片', '马上寄一张旅行明信片（只在私聊）', 130],
      ['/生活 帮助', 'ChronoLife 的命令：/生活 状态、事件、记忆、记住 内容、更正 编号 新内容、删除 编号；主人私聊还有 主动 开/关、暂停/恢复、停用/启用、兴趣 plant 2', 160],
    ],
    tools: [
      ['刷 B站', `<code>node "${esc(BILI)}" hot</code> / <code>search 关键词</code> / <code>watch BV号 --listen 3 --frames 6</code> / <code>seen</code>`, 30],
    ],
    // 开着 ChronoLife 时这些旧的主动通道交给它管：[说明, 是否整个不单独发了]
    taken: cfg.chronolife
      ? {
          '早安 / 晚安 / 冒泡': ['开着 ChronoLife：不单独发，主动找你走上面那条。', true],
          '回访': ['开着 ChronoLife：不到点单独去问；你提过的事她还记得，聊天时会接着问。', true],
          '主动戳你': ['开着 ChronoLife：不戳。', true],
          '等你回': ['开着 ChronoLife：不追问。', true],
          '被冷落有情绪': ['开着 ChronoLife：你没回不算冷落，不闹情绪。', true],
          '每周一封信': ['开着 ChronoLife：不自动写；说“给我写封信”（或发 /信）照样马上写一封。', true],
          '插嘴': ['开着 ChronoLife：群里没被叫就不插嘴。', true],
          '电脑室友': ['开着 ChronoLife：聊天时照样知道电脑上的事，只是不因为这些主动开口。', false],
          '纪念日和天气': ['开着 ChronoLife：上午不单独发；聊天时照样知道、会提。', false],
          '做梦': ['开着 ChronoLife：不在早安里说，你来聊天时可能提。', false],
        }
      : {},
  };
}
