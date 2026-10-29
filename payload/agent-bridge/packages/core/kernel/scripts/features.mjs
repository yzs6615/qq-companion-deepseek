#!/usr/bin/env node
/**
 * “功能与机制”页：机器人自己不再聊它是怎么实现的，要查就看这一页。
 * 列出每个功能开没开、现在的设置、怎么工作，以及每个人的熟悉度 / 长期事实 / 回访待办、它此刻的心情。
 *
 *   node scripts/features.mjs            # 生成 data/features.html 并用浏览器打开
 *   node scripts/features.mjs --no-open  # 只生成（再自己用 explorer 打开，免得浏览器跟着变成管理员权限）
 *   node scripts/features.mjs --out <文件>
 *   node scripts/features.mjs --text     # 只在终端打印功能开关和设置（不生成网页、不带每个人的记忆；机器人自己查开了啥用这个，代替去读 .env）
 *
 * 在哪个目录跑都行。本体的行写在这里；别的插件的行由插件自己给：module.mjs 导出的 settings(env, parseList)（设置的默认值）
 * 和 features(cfg, ctx)（它那几行），见 docs/插件接口.md。这里只 import 插件、不跑它的 setup：不连 QQ、不开定时任务、不写数据。
 * 装了哪些插件：内核里跑时照 COMPANION_MODULES；单独跑时扫本体旁边的插件（仓库里是 packages/*，装进 DSH 是 node_modules/dsh-companion-*），
 * COMPANION_ONLY 跟 bridge.mjs 一样能只挑几个（COMPANION_ONLY=none = 只有本体）。没装的插件不出现在这页上。
 * 数据目录跟内核一样：BRIDGE_DATA，没有就是 <COMPANION_HOME>/data。装进 DSH 后单独跑、又没设 COMPANION_HOME 时，
 * 内核目录里没有 .env 就用本体默认的 <DSH_HOME，没有就是 ~/.dsh>/companion（跟 index.js 一样）。
 *
 * 只读本机文件，不联网。页面里不放 API Key、OneBot token、手机 PIN 这类密钥。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
// 找 COMPANION_HOME（装进 DSH 后单独跑、又没设时用 <DSH_HOME 或 ~/.dsh>/companion），跟别的小工具共用 home.mjs
import { dataDir } from './home.mjs';

// config.mjs 一 import 就按 COMPANION_HOME 读 .env，所以在 home.mjs 定下 COMPANION_HOME 之后再 import
const { cfg, env, parseList, ROOT, HOME } = await import('../config.mjs');
const { selfState, familiarity, nowDesc, dayKey } = await import('../human.mjs');

const argv = process.argv.slice(2);
const outIdx = argv.indexOf('--out');
const DATA_DIR = dataDir(env);
const out = path.resolve(outIdx >= 0 && argv[outIdx + 1] ? argv[outIdx + 1] : path.join(DATA_DIR, 'features.html'));

const readJson = (f, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return fallback;
  }
};
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const when = (ms) => (ms ? new Date(ms).toLocaleString('zh-CN', { hour12: false }) : '—');
const pct = (p) => `${Math.round(p * 100)}%`;
const on = (cond) => (cond ? 'on' : 'off');

const state = readJson(path.join(DATA_DIR, 'state.json'), {});
const closeness = (st) => (st.affection || 0) + (st.days || 0) * 2 + (st.turns || 0) * 0.1 + (st.bonus || 0);

// ── 装了哪些插件 ──────────────────────────────────────────────────────────
function installed() {
  if (env.COMPANION_MODULES) {
    try {
      return JSON.parse(env.COMPANION_MODULES);
    } catch {
      return [];
    }
  }
  const only = parseList(env.COMPANION_ONLY);
  const core = path.dirname(ROOT); // 本体的包目录
  const dirs = [path.dirname(core)]; // 仓库里是 packages/，装进 DSH 是 node_modules/
  const pnpm = core.lastIndexOf(`${path.sep}.pnpm${path.sep}`);
  if (pnpm >= 0) dirs.push(core.slice(0, pnpm)); // pnpm 装的：别的插件的软链接在 .pnpm 外面那层 node_modules 里
  const found = new Map();
  for (const dir of dirs) {
    const inNodeModules = path.basename(dir) === 'node_modules';
    let names = [];
    try {
      names = fs.readdirSync(dir).sort();
    } catch {
      /* 没有这个目录 */
    }
    for (const n of names) {
      const file = path.join(dir, n, 'module.mjs');
      const id = n.replace(/^dsh-companion-/, '');
      if (id === 'core' || found.has(id) || (inNodeModules && !n.startsWith('dsh-companion-')) || !fs.existsSync(file)) continue;
      if (only.length && !only.includes(id)) continue;
      found.set(id, { id, file });
    }
  }
  return [...found.values()];
}
const plugins = []; // { id, mod }
const broken = []; // 没加载上的：“id（原因）”
for (const p of installed()) {
  try {
    plugins.push({ id: p.id, mod: await import(pathToFileURL(path.resolve(p.file)).href) });
  } catch (err) {
    broken.push(`${p.id}（${err?.message || err}）`);
  }
}
// 先把各插件的设置都挂到 cfg 上（跟内核里各插件 setup 开头那句 Object.assign(cfg, settings(...)) 一样），再要功能行：有的行要看别的插件的设置
for (const p of plugins) {
  try {
    if (typeof p.mod.settings === 'function') Object.assign(cfg, p.mod.settings(env, parseList));
  } catch (err) {
    broken.push(`${p.id} 的设置（${err?.message || err}）`);
  }
}

// ── 本体自己的行 ──────────────────────────────────────────────────────────
// 各部分的格式跟插件的 features(cfg, ctx) 一样（见 docs/插件接口.md）：
//   groups   [[组名, [[名字, level, 现在的设置, 怎么工作, order?], ...]], ...]   level: on 开着 / off 关了 / idle 开着但现在用不上（比如没配群）/ warn 注意
//   commands [[命令, 说明, order?], ...]   tools [[名字, HTML, order?], ...]
// 一个组里几个插件都有行时按 order 排（没写是 100，同样大的按插件加载的先后）。
function coreFeatures() {
  let personaInfo = '没找到人设文件';
  try {
    const st = fs.statSync(cfg.personaFile);
    personaInfo = `${path.basename(cfg.personaFile)}，${fs.readFileSync(cfg.personaFile, 'utf8').length} 字，改于 ${when(st.mtimeMs)}`;
  } catch {
    /* missing */
  }
  const script = (name) => esc(path.join(ROOT, 'scripts', name));
  return {
    groups: [
      ['聊天', [
        ['人设', 'on', personaInfo, '每条消息都会带上人设；改完 persona.md 下一条消息就生效，不用重启。'],
        ['连发合并', on(cfg.mergeMs > 0), `安静 ${cfg.mergeMs / 1000}s 再回（句子收尾了 ${(cfg.mergeMs * 0.6) / 1000}s），最多等 ${cfg.mergeMaxMs / 1000}s`, '对方连发几条，等说完合成一轮再回，不会一条回一遍。'],
        ['打字节奏', on(cfg.typingMsPerChar > 0), `${cfg.typingMsPerChar}ms/字，封顶 6s · 正在输入：${cfg.inputStatus ? '开' : '关'} · 标已读：${cfg.markRead ? '开' : '关'}`, '回复拆成几个气泡，按字数“打字”；模型想的时间算进第一个气泡。'],
        ['睡觉时段慢回', on(cfg.sleepDelayProb > 0), `${cfg.sleepStart}–${cfg.sleepEnd} 点，${pct(cfg.sleepDelayProb)} 概率晚 1–5 分钟回（只限私聊）`, '像人睡着了一样，不是每条都秒回；不会“已读不回”。'],
        ['聊天记忆', on(cfg.memoryEnabled), '每个聊天存最近 30 行，新开会话时带最近 12 行', '短期的“刚才聊到哪了”。同一段会话里聊过的她本来就看得到（会话能装 100 万 token），这几行只在新开会话、整个重发时带上。'],
        ['不重复塞人设', on(cfg.stickyPrompt), `没变的不重复塞 · 每 ${cfg.fullPromptEvery} 轮、会话被压缩过整个重发一次`, '每轮塞给她的人设、记得的事、日记、能办的事（每个插件给的那段各算一块），同一段会话里已经有、又没变过的就不再塞，只塞变了的和此刻的状态；省下的上下文留给真聊天，会话也晚很多才压缩。装了记得你（memory）时，主人私聊里还会告诉她：想不起来的老事可以去日记流水里翻。'],
        ['超时', 'on', `单轮最多 ${Math.round(cfg.timeoutMs / 1000)}s`, '超时会用人话说卡住了，真实原因只写日志；会话留着、不整轮重跑，它这一轮开出来的命令（整棵进程树）一起结束。只有会话真没了 / 坏了才丢掉重开。'],
        ['看懂引用', 'on', '引用消息时会把原文（和里面的图）一起给它看', 'QQ 里引用/回复某条消息，它能看到你引用的是谁说的哪句话；引用的是它自己说过的话它也知道。群里没 @ 它、但引用了它的话，也算在跟它说话。'],
        ['看懂分享卡片', on(cfg.shareCards), '装了她自己的生活（life）时，B站视频会真去看一眼', '用“分享”发来的 B站视频、QQ音乐/网易云的歌、网页链接，她都能看到是什么；B站视频（卡片，或者直接发 BV 号、链接）会用刷 B站那套去看简介、弹幕、热评。只发一张卡片也会回。'],
        ['看懂视频和文件', on(cfg.media), `${cfg.mediaMaxMB}MB 以内`, '发视频：挑几帧画面拼图给她看，10 分钟以内的再听一下说了啥。发文件：文本、PDF、Word、Excel、PPT 直接读成字，图片当图片看，别的告诉她存在哪。'],
        ['听语音', !cfg.hearVoice ? 'off' : env.ASR_SCRIPT || (env.WHISPER_MODEL_DIR && fs.existsSync(path.join(path.resolve(env.WHISPER_MODEL_DIR), 'base', 'model.bin'))) ? 'on' : 'idle', cfg.hearVoice ? (env.WHISPER_MODEL_DIR ? `本地 Whisper：${env.WHISPER_MODEL_DIR}` : '没设 WHISPER_MODEL_DIR，听不了') : '', '对方发来的 QQ 语音，用本地 Whisper（base）转成字再回；只用本地模型，没有就不听（不去网上下）。没听清就让对方打字。群里也听，只是得先叫到她。HEAR_VOICE=false 关。'],
        ['发现撤回', on(cfg.recall), `熟人撤回后 ${Math.round(cfg.recallTeaseProb * 100)}% 会调侃一句`, '你撤回一条消息：还没回的就不回了；私聊里熟一点的人，她偶尔会说“撤回了啥 我都看到了”。群里不调侃。'],
        ['手滑', on(cfg.typoProb > 0), `${pct(cfg.typoProb)} 概率，10 分钟最多一次`, '把一个字打成同音字，过一两秒补一句“*对的字”或撤回重发。'],
        ['附和点表情', on(cfg.react), `${pct(cfg.reactProb)} 概率`, '对方只回“嗯嗯/好的/哈哈”且上一句不是问句时，点个 QQ 表情回应，不调模型。'],
      ]],
      ['记得你', [
        ['熟悉度', 'on', `门槛：刚认识 <5 · 一般熟 <25 · 熟 <80 · 很熟${env.CLOSENESS_SET ? ` · 手动调分：${env.CLOSENESS_SET}` : ''}`, '亲密度 + 聊过天数×2 + 轮数×0.1 + 手动调整；越熟越敢损、越随便。', 20],
      ]],
      ['心情和作息', [
        ['心情和精力', 'on', '按日期和时段定，同一时段不变', '午后犯困、深夜低电量；影响语气，被问“在干嘛”时要对得上今天干过的事。', 10],
      ]],
      ['手机和权限', [
        ['守护', 'on', '装在 DSH 里时由本体（dsh-companion-core）看着内核', '内核意外停了（崩溃、被结束进程）本体过 10 秒把它拉起来；退出码 3（同一份数据已经有一个内核在跑，比如另开了一个 DSH）就隔一分钟再看。崩溃的原因记在 bridge.log。在仓库里直接 node bridge.mjs 跑的没人守。', 10],
        ['权限模式', cfg.permissionMode === 'danger-full-access' ? 'warn' : 'on', `主人私聊：${cfg.permissionMode || '（默认）'} · 别人私聊、群里：read-only · 主人：${cfg.pcOwner || cfg.proactiveQQ[0] || '（没设，谁都按别人算）'}`, `只有主人（PC_OWNER，没填就是 PROACTIVE_QQ 第一个）私聊时用 DSH_PERMISSION_MODE，能让她动手机、电脑、文件；别人私聊、群里（主人在群里也一样）都只读、只陪聊，主动消息和提炼长期事实也只读。${cfg.permissionMode === 'danger-full-access' ? '主人私聊时能让它执行任意命令、读写任意文件。' : ''}`, 30],
        ['私聊白名单', 'on', cfg.allowedQQ.join(', ') || '（空）', '', 40],
      ]],
    ],
    commands: [
      ['/status', '在线状态、活跃任务数、熟悉度和综合分（给你排错用）', 10],
      ['/心情', '它回一句人话说心情，不报数字', 20],
      ['/new', '开新对话（清掉这个聊天的模型会话，长期事实和熟悉度不受影响）', 30],
      ['/提醒 30m 喝水', '到点私聊提醒；单发 /提醒 看列表（直接说“半小时后提醒我喝水”也行）', 40],
      ['/喂鱼 /摸摸', '亲密度 +1', 100],
      ['/help', '看能直接跟她说哪些事', 200],
    ],
    natural: [
      ['“半小时后提醒我喝水”', '到点私聊“该喝水了”；“明早 8 点叫我起床”这种钟点也行，没说多久她会先问；问“我有哪些提醒”她知道。只能设一次的，每天重复的还不支持', 10],
      ['直接发语音', cfg.hearVoice ? '用本地 Whisper 听懂了再回（要有本地模型）' : '没开（HEAR_VOICE=false）', 50],
      ['“截图给我看看”', '主人私聊时，她把自己截的图（手机截图、看直播的截图、现场照、画的画…）直接发过来；只发数据目录里她自己弄出来的图', 75],
    ],
    tools: [
      ['启动', '装在 DSH 里：启动 DSH（比如 <code>dsh web</code>）时本体把内核一起带起来，插件装上、卸掉后重启 DSH 生效；在仓库里开发：<code>node bridge.mjs</code>', 10],
      ['日志', `<code>${esc(path.join(DATA_DIR, 'bridge.log'))}</code>：连没连上 QQ、装了哪些插件、报错、掉线`, 20],
      ['功能与机制', `<code>node "${script('features.mjs')}"</code>：重新生成这页并打开（<code>--no-open</code> 只生成，<code>--text</code> 只在终端打印开关和设置）`, 25],
      ['日记网页', `<code>node "${script('journal-view.mjs')}"</code>：选日期看那天的日记、跟谁聊了啥、当天的聊天（含聊天内容，只在本机看）`, 40],
      ['会话查看', `<code>node "${script('session-view.mjs')}"</code>：每轮的上下文和思考过程（含对话内容，别外发）`, 50],
      ['配置', `<code>${esc(path.join(HOME, '.env'))}</code>（COMPANION_HOME 里的 .env；改完要重启 DSH，人设除外）`, 60],
      ['说明', '每个插件文件夹里的 README.md：开关、设置和原理', 70],
    ],
  };
}

// ── 合起来 ────────────────────────────────────────────────────────────────
const ctx = { env, ROOT, DATA_DIR, state, readJson, esc, when, pct, on, dayKey };
const parts = [coreFeatures()];
for (const p of plugins) {
  if (typeof p.mod.features !== 'function') continue;
  try {
    parts.push((await p.mod.features(cfg, ctx)) || {});
  } catch (err) {
    broken.push(`${p.id} 的功能行（${err?.message || err}）`);
  }
}
const byOrder = (list, at) => [...list].sort((a, b) => (a[at] ?? 100) - (b[at] ?? 100)); // sort 是稳定的：order 一样就按原来的先后
const GROUPS = ['聊天', '说话的样子', '记得你', '心情和作息', '她自己的生活', '主动找你', '电脑上的她', 'QQ 上的样子', '群聊', '手机和权限'];
const grouped = new Map();
for (const part of parts) for (const [group, rows] of part.groups || []) grouped.set(group, [...(grouped.get(group) || []), ...rows]);
const rank = (g) => (GROUPS.includes(g) ? GROUPS.indexOf(g) : GROUPS.length); // 不在上面这张表里的组排在最后，按插件加载的先后
const features = [...grouped].sort(([a], [b]) => rank(a) - rank(b)).map(([group, rows]) => [group, byOrder(rows, 4)]);
const commands = byOrder(parts.flatMap((part) => part.commands || []), 2);
const natural = byOrder(parts.flatMap((part) => part.natural || []), 2); // “直接跟她说”的例子
const tools = byOrder(parts.flatMap((part) => part.tools || []), 2);
const sections = parts.flatMap((part) => part.sections || []); // [[标题, HTML]]，放在“它此刻”后面
const personExtras = parts.map((part) => part.person).filter((fn) => typeof fn === 'function'); // (qq, st) → 这个人的卡片里补的 HTML
// 开着 ChronoLife 时，有些旧的主动通道交给它管（她自己的生活 life 插件给的 taken：{ 行名: [说明, 是否整个不单独发了] }）
const taken = Object.assign({}, ...parts.map((part) => part.taken || {}));

// ── 每个人 ────────────────────────────────────────────────────────────────
const people = Object.keys(state)
  .filter((k) => /^\d+$/.test(k) && cfg.allowedQQ.includes(k))
  .map((qq) => {
    const st = state[qq];
    const score = closeness(st);
    return { qq, st, score, fam: familiarity(score) };
  });

// ── 它此刻 ────────────────────────────────────────────────────────────────
const me = selfState();
// 被事情影响的心情（心情和作息 mood 插件给的 mood，没有就按时段）：这里只显示心情，不显示为啥
for (const part of parts) if (part.mood) me.mood = part.mood;
const diary = (state._self?.log || []).filter((e) => e.day === dayKey());

// ── render ────────────────────────────────────────────────────────────────
const pill = { on: ['开', 'on'], off: ['关', 'off'], idle: ['开着·用不上', 'idle'], warn: ['注意', 'warn'], life: ['归 ChronoLife 管', 'idle'] };

// --text：只在终端打印每个功能开没开、现在的设置（给机器人自己查“开了哪些功能”用，代替去读 .env）。
// 不生成网页，也不带每个人的熟悉度和记得的事。
if (argv.includes('--text')) {
  const lines = [`装了的插件：${plugins.map((p) => p.id).join('、') || '没装（只有本体）'}${broken.length ? `（没加载上：${broken.join('；')}）` : ''}`];
  for (const [group, rows] of features) {
    lines.push(`【${group}】`);
    for (let [name, level, setting] of rows) {
      const t = level === 'on' && taken[name];
      if (t && t[1]) level = 'life';
      lines.push(`- ${name}：${pill[level]?.[0] || level}${setting ? ` · ${String(setting).replace(/\s+/g, ' ')}` : ''}`);
    }
  }
  console.log(lines.join('\n'));
  process.exit(0);
}
const featureHtml = features
  .map(
    ([group, rows]) => `<h2>${esc(group)}</h2><div class="card"><table>${rows
      .map(([name, level, setting, how]) => {
        const t = level === 'on' && taken[name];
        if (t) [level, how] = [t[1] ? 'life' : level, `${t[0]}${how}`];
        return [name, level, setting, how];
      })
      .map(([name, level, setting, how]) => `<tr><td class="n">${esc(name)}</td><td><span class="pill ${pill[level][1]}">${pill[level][0]}</span></td><td>${esc(setting)}${how ? `<div class="how">${esc(how)}</div>` : ''}</td></tr>`)
      .join('')}</table></div>`,
  )
  .join('\n');

const peopleHtml = people.length
  ? people
      .map(
        (p) => `<div class="card person">
<div class="ph"><b>${esc(p.qq)}</b><span class="pill on">${esc(p.fam.tier)}</span><span class="big">${p.score.toFixed(1)}</span></div>
<div class="kv">亲密度 ${p.st.affection || 0} + 天数 ${p.st.days || 0}×2 + 轮数 ${p.st.turns || 0}×0.1${p.st.bonus ? ` + 手动调整 ${p.st.bonus > 0 ? '+' : ''}${p.st.bonus}` : ''}</div>
<div class="kv">最后说话 ${esc(when(p.st.lastUserAt))} · 今天主动找过 ${p.st.day === dayKey() ? p.st.count || 0 : 0} 次 · 最后一次主动 ${esc(when(p.st.lastProactiveAt))}${p.st.ignored ? ` · 主动找了 ${p.st.ignored} 次还没回` : ''}</div>
${personExtras.map((fn) => fn(p.qq, p.st) || '').join('')}</div>`,
      )
      .join('\n')
  : '<div class="card how">还没有人聊过（state.json 里没有白名单里的人）。</div>';

const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(cfg.botName)} · 功能与机制</title>
<style>
:root{--bg:#fafafb;--card:#fff;--ink:#1f2328;--mute:#6e7681;--line:#d0d7de;--on:#1aaa62;--off:#8c959f;--idle:#9a6700;--warn:#cf222e}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--card:#161b22;--ink:#e6edf3;--mute:#8b949e;--line:#30363d;--idle:#d29922;--warn:#ff7b72}}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.6 "Microsoft YaHei UI","Segoe UI",sans-serif}
main{max-width:880px;margin:0 auto;padding:20px 16px 60px}
h1{font-size:19px;margin:0 0 2px}h2{font-size:15px;margin:22px 0 6px}.sub{color:var(--mute);font-size:12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 14px;margin:8px 0}
table{width:100%;border-collapse:collapse}td{padding:7px 6px;border-top:1px solid var(--line);vertical-align:top}tr:first-child td{border-top:0}
td.n{width:120px;font-weight:600;white-space:nowrap}td:nth-child(2){width:96px}
.how{color:var(--mute);font-size:12px;margin-top:2px}
.pill{display:inline-block;font-size:11px;border-radius:10px;padding:0 8px;border:1px solid currentColor;white-space:nowrap}
.pill.on{color:var(--on)}.pill.off{color:var(--off)}.pill.idle{color:var(--idle)}.pill.warn{color:var(--warn)}
.ph{display:flex;align-items:center;gap:10px}.big{margin-left:auto;font-size:20px;font-weight:700}.kv{color:var(--mute);font-size:12px}
details{margin-top:4px}summary{cursor:pointer;font-size:13px}ul{margin:4px 0 4px 18px;padding:0}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px}.grid div{font-size:12px;color:var(--mute)}.grid b{display:block;font-size:15px;color:var(--ink)}
code{font:12px Consolas,monospace;background:var(--line);padding:0 4px;border-radius:3px}
@media (max-width:560px){td.n{width:auto;white-space:normal}}
</style></head><body><main>
<h1>${esc(cfg.botName)} · 功能与机制</h1>
<div class="sub">生成于 ${esc(when(Date.now()))} · 只在本机生成，不含 API Key / token / PIN · 它自己不再聊这些，要查就看这页</div>
<div class="sub">装了的插件：${esc(plugins.map((p) => p.id).join('、') || '没装（只有本体）')}${broken.length ? ` · 没加载上：${esc(broken.join('；'))}` : ''} · 没装的插件不出现在这页上</div>

<h2>它此刻</h2>
<div class="card grid">
<div>时间<b>${esc(nowDesc())}</b></div>
<div>心情<b>${esc(me.mood)}</b></div>
<div>精力<b>${esc(me.energyDesc)}</b></div>
</div>
<div class="card"><b style="font-size:13px">今天干过</b>${diary.length ? `<ul>${diary.map((e) => `<li>${esc(e.time)} ${esc(e.text)}</li>`).join('')}</ul>` : '<div class="how">今天还没有自己找事做的记录</div>'}</div>
${sections.map(([title, body]) => `\n<h2>${esc(title)}</h2>\n${body}\n`).join('')}
<h2>每个人</h2>
${peopleHtml}

${featureHtml}

<h2>直接跟她说</h2>
<div class="card"><table>
${natural.map(([say, desc]) => `<tr><td class="n">${esc(say)}</td><td>${esc(desc)}</td></tr>`).join('\n')}
</table><div class="how">她在回复里写个标记（[提醒:30|喝水] 这种），本体抠掉后交给管这件事的插件，照原来的命令去办，谁能办跟命令一样；不会另外发“已设置”，办不成会补一句。没装的插件，它的事她不会答应。下面的命令也都还能用。</div></div>

<h2>命令（在 QQ 里发）</h2>
<div class="card"><table>
${commands.map(([cmd, desc]) => `<tr><td class="n">${esc(cmd)}</td><td>${esc(desc)}</td></tr>`).join('\n')}
</table></div>

<h2>工具和文件</h2>
<div class="card"><table>
${tools.map(([name, body]) => `<tr><td class="n">${esc(name)}</td><td>${body}</td></tr>`).join('\n')}
</table></div>
</main></body></html>`;

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, html);
console.log(`已生成：${out}`);
if (!argv.includes('--no-open') && process.platform === 'win32') {
  spawn('cmd.exe', ['/c', 'start', '', out], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}
