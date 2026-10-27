#!/usr/bin/env node
/**
 * “功能与机制”页：机器人自己不再聊它是怎么实现的，要查就看这一页。
 * 列出每个功能开没开、现在的设置、怎么工作，以及每个人的熟悉度 / 长期事实 / 回访待办、它此刻的心情。
 *
 *   node scripts/features.mjs            # 生成 data/features.html 并用浏览器打开
 *   node scripts/features.mjs --no-open  # 只生成（启动器用这个，再用 explorer 打开，免得浏览器跟着变成管理员权限）
 *   node scripts/features.mjs --out <文件>
 *
 * 只读本机文件，不联网。页面里不放 API Key、OneBot token、手机 PIN 这类密钥。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { cfg, env, ROOT } from '../config.mjs';
import { selfState, familiarity, nowDesc, dayKey } from '../human.mjs';

const argv = process.argv.slice(2);
const outIdx = argv.indexOf('--out');
const DATA_DIR = env.BRIDGE_DATA ? path.resolve(env.BRIDGE_DATA) : path.join(ROOT, 'data');
const STICKER_DIR = env.STICKER_DIR ? path.resolve(env.STICKER_DIR) : path.join(DATA_DIR, 'stickers');
const AVATAR_DIR = env.MOOD_AVATAR_DIR ? path.resolve(env.MOOD_AVATAR_DIR) : path.join(DATA_DIR, 'avatars');
const SCENE_DIR = env.SCENE_DIR ? path.resolve(env.SCENE_DIR) : path.join(DATA_DIR, 'scene');
const out = path.resolve(outIdx >= 0 && argv[outIdx + 1] ? argv[outIdx + 1] : path.join(DATA_DIR, 'features.html'));

const readJson = (f, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return fallback;
  }
};
const clockOfMin = (m) => { const x = (m + 300) % 1440; return `${Math.floor(x / 60)}:${String(x % 60).padStart(2, '0')}`; };
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const when = (ms) => (ms ? new Date(ms).toLocaleString('zh-CN', { hour12: false }) : '—');
const pct = (p) => `${Math.round(p * 100)}%`;

const state = readJson(path.join(DATA_DIR, 'state.json'), {});
const closeness = (st) => (st.affection || 0) + (st.days || 0) * 2 + (st.turns || 0) * 0.1 + (st.bonus || 0);
const factsOf = (chatKey) => {
  const f = readJson(path.join(DATA_DIR, 'memory', `${chatKey.replace(/[^a-zA-Z0-9:_-]/g, '_')}.facts.json`), null);
  return { facts: Array.isArray(f?.facts) ? f.facts : [], followups: Array.isArray(f?.followups) ? f.followups : [], style: Array.isArray(f?.style) ? f.style : [] };
};

// ── 功能清单 ──────────────────────────────────────────────────────────────
// level: on 开着 / off 关了 / idle 开着但现在用不上（比如没配群）
const groups = cfg.allowedGroups.length;
let stickers = 0;
let learnedStickers = 0;
try {
  // 只数情绪子目录；stickers 下面还有 README.md 之类的文件，不能当目录读
  for (const d of fs.readdirSync(STICKER_DIR, { withFileTypes: true }).filter((e) => e.isDirectory())) {
    const files = fs.readdirSync(path.join(STICKER_DIR, d.name)).filter((f) => /\.(png|jpe?g|gif|webp)$/i.test(f));
    stickers += files.length;
    learnedStickers += files.filter((f) => f.startsWith('learned-')).length;
  }
} catch {
  /* no stickers */
}
let personaInfo = '没找到人设文件';
try {
  const st = fs.statSync(cfg.personaFile);
  personaInfo = `${path.basename(cfg.personaFile)}，${fs.readFileSync(cfg.personaFile, 'utf8').length} 字，改于 ${when(st.mtimeMs)}`;
} catch {
  /* missing */
}
const on = (cond) => (cond ? 'on' : 'off');
// ChronoLife：只读打开它的数据库看现在的样子（打不开就只显示开关）
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
// 开着 ChronoLife 时这些旧的主动通道交给它管：[说明, 是否整个不单独发了]
const LIFE_TAKEN = {
  '早安 / 晚安 / 冒泡': ['开着 ChronoLife：不单独发，主动找你走上面那条。', true],
  '回访': ['开着 ChronoLife：不到点单独去问；你提过的事她还记得，聊天时会接着问。', true],
  '主动戳你': ['开着 ChronoLife：不戳。', true],
  '等你回': ['开着 ChronoLife：不追问。', true],
  '被冷落有情绪': ['开着 ChronoLife：你没回不算冷落，不闹情绪。', true],
  '每周一封信': ['开着 ChronoLife：不自动写；发 /信 照样马上写一封。', true],
  '插嘴': ['开着 ChronoLife：群里没被叫就不插嘴。', true],
  '电脑室友': ['开着 ChronoLife：聊天时照样知道电脑上的事，只是不因为这些主动开口。', false],
  '纪念日和天气': ['开着 ChronoLife：上午不单独发；聊天时照样知道、会提。', false],
  '做梦': ['开着 ChronoLife：不在早安里说，你来聊天时可能提。', false],
};
const features = [
  ['聊天', [
    ['人设', 'on', personaInfo, '每条消息都会带上人设；改完 persona.md 下一条消息就生效，不用重启。'],
    ['连发合并', on(cfg.mergeMs > 0), `安静 ${cfg.mergeMs / 1000}s 再回（句子收尾了 ${(cfg.mergeMs * 0.6) / 1000}s），最多等 ${cfg.mergeMaxMs / 1000}s`, '对方连发几条，等说完合成一轮再回，不会一条回一遍。'],
    ['打字节奏', on(cfg.typingMsPerChar > 0), `${cfg.typingMsPerChar}ms/字，封顶 6s · 正在输入：${cfg.inputStatus ? '开' : '关'} · 标已读：${cfg.markRead ? '开' : '关'}`, '回复拆成几个气泡，按字数“打字”；模型想的时间算进第一个气泡。'],
    ['睡觉时段慢回', on(cfg.sleepDelayProb > 0), `${cfg.sleepStart}–${cfg.sleepEnd} 点，${pct(cfg.sleepDelayProb)} 概率晚 1–5 分钟回（只限私聊）`, '像人睡着了一样，不是每条都秒回；不会“已读不回”。'],
    ['聊天记忆', on(cfg.memoryEnabled), '每个聊天存最近 30 行，带最近 12 行进提示词', '短期的“刚才聊到哪了”。'],
    ['超时', 'on', `单轮最多 ${Math.round(cfg.timeoutMs / 1000)}s`, '超时会用人话说卡住了，真实原因只写日志。'],
    ['看懂引用', 'on', '引用消息时会把原文（和里面的图）一起给它看', 'QQ 里引用/回复某条消息，它能看到你引用的是谁说的哪句话；引用的是它自己说过的话它也知道。群里没 @ 它、但引用了它的话，也算在跟它说话。'],
    ['看懂视频和文件', on(cfg.media), `${cfg.mediaMaxMB}MB 以内`, '发视频：挑几帧画面拼图给她看，10 分钟以内的再听一下说了啥。发文件：文本、PDF、Word、Excel、PPT 直接读成字，图片当图片看，别的告诉她存在哪。'],
    ['发现撤回', on(cfg.recall), `熟人撤回后 ${Math.round(cfg.recallTeaseProb * 100)}% 会调侃一句`, '你撤回一条消息：还没回的就不回了；私聊里熟一点的人，她偶尔会说“撤回了啥 我都看到了”。群里不调侃。'],
    ['手滑', on(cfg.typoProb > 0), `${pct(cfg.typoProb)} 概率，10 分钟最多一次`, '把一个字打成同音字，过一两秒补一句“*对的字”或撤回重发。'],
    ['附和点表情', on(cfg.react), `${pct(cfg.reactProb)} 概率`, '对方只回“嗯嗯/好的/哈哈”且上一句不是问句时，点个 QQ 表情回应，不调模型。'],
  ]],
  ['说话的样子', [
    ['表情包', on(stickers > 0), `${stickers} 张（其中 ${learnedStickers} 张是从聊天里收的）· 模型没点表情时 35% 概率按梗补一张`, '一条回复最多一张，发在文字后面。'],
    ['表情包按意思挑', 'on', (() => { const idx = readJson(path.join(env.STICKER_DIR ? path.resolve(env.STICKER_DIR) : path.join(DATA_DIR, 'stickers'), 'index.json'), {}); return `${Object.keys(idx).length} 张有描述`; })(), '每张表情图配了一句“画面：用法”的描述（node scripts\\sticker-index.mjs 让模型看图写），她想表达“无语翻白眼”“笑到打滚”就挑最贴的那张；对不上就不硬发。新收的表情包会自己补描述。'],
    ['偷表情包', on(cfg.stealStickers), `每种情绪最多留 ${cfg.stealMax} 张收来的 · 发表情时一半机会用收来的`, '对方发的表情包（只认 QQ 标成表情的图，普通照片不收），它觉得好玩就按情绪收进自己的表情库，以后自己也用。'],
    ['学说话', on(cfg.learnStyle && cfg.facts), '和长期事实一起提炼，不多花模型调用', '从聊天里学对方的口头禅、语气词、爱用的梗，偶尔学着用（越熟越容易被带跑偏）。'],
    ['学某个人说话', on(cfg.mimic), (() => { const m = readJson(path.join(DATA_DIR, 'mimic.json'), {}).active; if (!m) return '没在学谁：把一段聊天合并转发给它，回序号选人'; const k = Math.max(0.15, Math.min(1, cfg.mimicRampDays > 0 ? (Date.now() - m.startedAt) / 86400_000 / cfg.mimicRampDays : 1)); return `在学「${m.name}」· 大概 ${Math.round(k * 10)} 成（${cfg.mimicRampDays} 天学到位）· 习惯：${(m.traits || []).join('；')}`; })(), '合并转发聊天记录给它 → 选一个人 → 总结 TA 的说话习惯，按天数慢慢带进自己的语气；不冒充那个人、不搬原话里的私事。/学说话 看进度，/别学了 停掉并删掉素材。'],
    ['发语音', on(cfg.voice), cfg.voice ? `百炼 CosyVoice 复刻音色 · ${cfg.voiceModel} · ${cfg.voiceMaxChars} 字以内才念 · 一天最多 ${cfg.voiceMaxDay} 条${cfg.voiceCutMs ? ` · 句尾再剪 ${cfg.voiceCutMs}ms` : ''}` : '没开：.env 里要有 VOICE_ID 和 DASHSCOPE_API_KEY', '它觉得这句适合说出来（笑、吐槽、撒娇、晚安，或者你让它发语音）就用自己的声音发 QQ 语音；合成后自动去掉开头结尾的杂音。太长、发够了、合成失败都改成打字。语音能带语气：生气、难过、委屈、害怕、惊讶、嫌弃、困，她可以写 [语音:害怕] 自己点；没点就跟着有来由的心情走（你惹她生气、委屈、烦你，或者熬夜后犯困），没来由的心情不算；带语气的音量压一压，不会突然很大声。开心的语气试过跟生气听不出区别，没做。/说话 xxx 直接念给你听（不带心情）。'],
    ['唱歌', on(cfg.sing), (() => { const dir = env.SONG_DIR ? path.resolve(env.SONG_DIR) : path.join(DATA_DIR, 'songs'); let songs = []; try { songs = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => readJson(path.join(dir, d.name, 'song.json'), null)).filter((m) => m && (m.clips || []).length); } catch {} return songs.length ? `会唱 ${songs.map((m) => `${m.title}（${m.clips.length} 段）`).join('、')} · 一天最多主动唱 ${cfg.singMaxDay} 段` : '还没有歌：用 sing/render.py 转一首'; })(), '用她自己的嗓子唱：提前把歌转好放进歌库（Seed-VC 唱歌模型用她的声音微调过，参考用她唱歌的片段），聊天时它想唱、或者你让它唱，就挑一段发 QQ 语音，不连着唱同一段。没学过的歌说还没学会；唱够了说嗓子累了。/唱歌 歌名 直接听，/歌单 看会哪些。'],
  ]],
  ['记得你', [
    ['长期事实', on(cfg.facts), `每 ${cfg.factsEvery} 轮提炼一次，提到考试/生日/称呼等要紧事 2 轮后提前`, '让模型把聊天提炼成长期记得的事（每人最多 40 条），以后的对话会带上。'],
    ['熟悉度', 'on', `门槛：刚认识 <5 · 一般熟 <25 · 熟 <80 · 很熟${env.CLOSENESS_SET ? ` · 手动调分：${env.CLOSENESS_SET}` : ''}`, '亲密度 + 聊过天数×2 + 轮数×0.1 + 手动调整；越熟越敢损、越随便。'],
    ['记得你的作息', on(cfg.rhythm), (() => { const qs = Object.entries(state).filter(([k, v]) => /^\d+$/.test(k) && v?.rhythm); return qs.length ? qs.map(([k, v]) => `${k}：平时 ${clockOfMin(v.rhythm.wake)} 冒头、${clockOfMin(v.rhythm.sleep)} 没动静（${v.rhythm.days} 天）`).join('；') : '聊满 4 天才看得出'; })(), '从聊天时间摸清你平时几点冒头、几点没动静；今天比平时晚睡、早起，她会注意到，顺口说一句（一天只说一次）。'],
    ['对你好奇', on(cfg.curious), `每轮 ${Math.round(cfg.curiousProb * 100)}% 提醒她一次，一天最多一次`, '记住的事里还没提到的方面（是干嘛的、住哪、喜欢干嘛、爱吃啥、养没养猫狗、生日），她会找机会自然地问一句，同一个方面一周内不重复。'],
    ['纪念日和天气', on(cfg.anniversary || cfg.weather), cfg.weatherCity ? `默认城市：${cfg.weatherCity}` : '在 QQ 里发 /城市 杭州 告诉她你在哪', '认识第 100 天、周年、你的生日（/生日 5-20）那天她心里知道，上午会主动说一句；你那边下雨、降温、很热很冷时会顺口提醒（天气来自 Open-Meteo，免费）。认识的日子可以在 .env 写 MEET_DATE=QQ号:2025-05-15。'],
    ['日记', on(cfg.journal), (() => { let days = []; try { days = fs.readdirSync(path.join(DATA_DIR, 'journal')).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort(); } catch {} return days.length ? `写了 ${days.length} 篇，最近一篇 ${days.at(-1).slice(0, 10)} · 每天 ${cfg.journalHour} 点后写 · 聊天带最近 ${cfg.journalDays} 天` : `还没写过 · 每天 ${cfg.journalHour} 点后写`; })(), '白天每轮聊天记一行流水（一直留着），睡前用自己的口吻写当天的日记：今天干了啥、什么心情，再给每个聊过的人记一行聊了啥。聊天时带上最近几天的日记，但只带跟这个人的那行，跟 A 聊的不会出现在跟 B 的对话里；更早的只留跟这个人有关的，当长期记忆。/日记 看最新一篇；启动器右上角“日记”打开日记网页，能选日期翻、能搜。'],
  ]],
  ['心情和作息', [
    ['心情和精力', 'on', '按日期和时段定，同一时段不变', '午后犯困、深夜低电量；影响语气，被问“在干嘛”时要对得上今天干过的事。'],
    ['心情有来由', on(cfg.emotion), (() => { const e = state._emotion; return e && Date.now() < e.until ? `现在：${e.mood}（还有 ${Math.max(1, Math.round((e.until - Date.now()) / 60_000))} 分钟）` : '现在按时段的日常心情'; })(), '聊天或自己刷东西时真有事让她心情变了（被夸、被怼、看哭了、被气到），这个心情会延续几个小时（生气委屈久一点），说话语气、在线状态、想不想玩都跟着变；凌晨还在聊，第二天上午会犯困。为啥心情变了只有那个聊天的人知道，别人只看得出心情。'],
    ['作息被你带偏', on(cfg.sleepDrift), (() => { const d = state._sleepDrift; return d?.shift ? `现在被带${d.shift > 0 ? '晚' : '早'}了 ${Math.abs(d.shift)} 小时` : '还没被带偏'; })(), `按电脑的主人最近 7 天几点没动静，把她的睡觉时段往你那边挪：你老熬夜，她最多跟着晚睡 ${cfg.sleepDriftMax} 小时；你早睡，她最多早 1 小时。在线状态、睡觉慢回、现场照都跟着变，挪得明显时她会抱怨一句“都怪你”。`],
    ['被冷落有情绪', on(cfg.ignoreLimit > 0), `主动找了 ${cfg.ignoreLimit} 次都没回就先不找 · 隔 ${cfg.sulkAfterMin} 分钟以上才回算被冷落${cfg.sulk ? '，回来第一句带点小情绪' : ''}`, '早安/冒泡/回访/自主分享都算“主动找”；对方一开口就清零。'],
  ]],
  ['她自己的生活', [
    ['ChronoLife 小屋', on(cfg.chronolife), life ? (life.error ? '数据库打不开：普通聊天照常，小屋暂停' : `现在：${life.mode} · 窗台植物：${life.plant}${life.last ? ` · 最近：${life.last}` : ''}`) : '', '她有一间自己的小屋，每 30 分钟过一次日子：窗台养着一盆植物（种子→发芽→幼苗→展开新叶，按天长），有时照顾植物、整理笔记、写点东西、发呆休息（一天最多 4 件，也可能一件都不做；夜里和你刚找过她时不开始新的）。每件事先记个大概，再让模型补一两句这次具体干了啥。聊天时她知道小屋里最近的事，不会说成在现实里出了门。电脑关着时由 Windows 定时任务接着算，开机只补一句“离开了几个小时”。/生活 帮助 看命令，详细说明在 chronolife\\README.md。'],
    ['自己找事做', on(cfg.autonomy), `10–23 点每小时掷一次骰子（基础 ${Math.round(cfg.autonomyRollProb * 100)}%）· 两次至少隔 ${cfg.autonomyMinutes} 分钟 · 每天最多 ${cfg.autonomyMax} 次`, `每小时在随机的某一分钟问自己“要不要玩会”：无聊、兴奋的时候更想玩，困、懒、没精神就不太想动；你 ${cfg.autonomyIdleMin} 分钟内找过它就先陪你。想玩就先挑一件想干的事——刷 B站、看番、刷知乎热榜、刷微博热搜、听歌（看榜单、歌词和网易云热评），有手机的话还会玩手机，记得你喜欢什么的话还会专门找点你会喜欢的；跟上一次的错开，今天干过的少挑。刷到跟你喜好有关的会发给你（“看到这个就想到你”）；你在她刷东西的时候来找她，她知道自己正在干嘛；顺手记“今天干过啥”。${cfg.chronolife ? '开着 ChronoLife 时照常玩，算她小屋生活里的一件事（休息、停用时不玩）；想发给你也要过 ChronoLife 主动分享那几条规矩。' : ''}`],
    ['刷 B站', 'on', (() => { const seen = readJson(path.join(DATA_DIR, 'bili', 'seen.json'), []); return `${env.BILIBILI_SESSDATA ? '已登录（能读字幕）' : '没登录（看弹幕热评，字幕靠听）'} · 最近看过 ${seen.length} 个${seen[0] ? `，上一个：${seen[0].title}` : ''}`; })(), '不用手机，直接走 B站接口：热门 / 排行 / 搜索；看一个视频能拿到简介、标签、弹幕刷得最多的、热评；--listen 用本地 Whisper 听前几分钟，--frames 挑弹幕最密的时刻和换镜头的地方截图（整段都覆盖，去掉重复镜头），每 9 格拼一张图看画面。看过的打标记不重复看；被风控就歇 15 分钟。不发评论、不点赞投币。'],
    ['做梦', on(cfg.dream), `每天 ${Math.round(cfg.dreamProb * 100)}% 会梦见`, '早上醒来有时记得昨晚的梦：拿最近刷到的、跟你聊过的事打乱了拼的，荒诞又有你。今天第一次聊天、或者发早安时，她可能顺口说一句“我昨晚梦见……”，只说一次。'],
    ['人设成长', on(cfg.reflect), `每天 ${cfg.reflectHour} 点后回想一次（攒够 8 件事会提前）· 最多 ${cfg.selfMax} 条 · ${cfg.selfForgetDays} 天没再印证就淡忘（“最近在看” ${cfg.recentForgetDays} 天）`, '把自己找事做的日记反思成它自己的喜好、观点、最近在看的、学到的梗；又印证一次就加深。persona.md 的核心人设不动，这只是“最近的自己”。'],
    ['深夜电台', on(cfg.radio), (() => { let n = 0; let last = ''; try { for (const d of fs.readdirSync(path.join(DATA_DIR, 'radio'), { withFileTypes: true })) { if (!d.isDirectory()) continue; for (const e of readJson(path.join(DATA_DIR, 'radio', d.name, 'episodes.json'), [])) { n++; if (e.createdAt > last) last = e.createdAt; } } } catch {} return n ? `录了 ${n} 期，最近一期 ${last.slice(5, 10)} · 一天最多 ${cfg.radioMaxDay} 期` : `还没录过 · 一天最多 ${cfg.radioMaxDay} 期`; })(), '说“开台，今晚想听点适合下雨的”“来一期开心的，别聊大道理”“今晚只听一分钟”，她就录一期两三分钟（或一分钟）的语音节目：用她自己的口气，讲她最近真刷到的事，配一张节目卡，推荐一首网易云上真搜得到的歌（歌名歌手对不上就不给链接）。“我来投稿，你帮我念”她帮你念，“上期那个话题接着讲”她接着聊，“再放一遍”不再花钱。私聊节目能用上她记得的你的事，群节目不带私事。录的时候来找她，她知道自己在录；录完聊天里也记得录过。'],
    ['旅行明信片', on(cfg.postcard), cfg.postcard ? (() => { const t = state._trips?.cur; return t ? `这趟：${t.city}（${t.spot}）${t.sent ? '，已寄出' : ''}` : `每 ${cfg.postcardEveryWeeks} 周出去一趟`; })() : '', `隔几周的周末，她在自己的小世界里出去玩一趟（周五定去哪：厦门、青岛、大理、哈尔滨…按季节挑），周日下午给你寄一张明信片：正面用百炼画当地风景（一张一两毛钱），背面手写几句、贴邮票、盖邮戳。开着 ChronoLife 时不主动发，等你下次来聊天时她提一句再给。发 /明信片 可以马上寄一张。`],
    ['现场照', on(cfg.photo), (() => { const n = (d) => { try { return fs.readdirSync(path.join(SCENE_DIR, d)).length; } catch { return 0; } }; return `${n('bg')} 个房间背景、${n('pose')} 个动作 · 一天最多 ${cfg.photoMaxDay} 张`; })(), `问她“在干嘛”，她可能回一张“现在的她”：按几点、你那边的天气挑她房间的样子（早上、白天、傍晚、夜里开着台灯、下雨、下雪），按她在干嘛和心情挑动作（睡觉、刷手机、听歌、吃饭、生闷气、犯困…）。图在 ${SCENE_DIR} 里（bg 房间、pose 动作）。`],
    ['送她的东西摆进房间', on(cfg.photo), (() => { const g = readJson(path.join(SCENE_DIR, 'gifts', 'gifts.json'), []); return g.length ? `房间里：${g.slice(-3).map((x) => x.name).join('、')}` : '还没收到过'; })(), '跟着现场照一起开。你发张图或者说“送你个…”，她想收就收下：用百炼把这个东西画出来（白底，抠成透明的），摆进她的房间，马上拍一张“摆好了”给你看；以后的现场照里也能看到最近收的 3 件。她只记得你送过她什么，别人送的不会跟你提。一天最多画 3 件。'],
  ]],
  ['主动找你', [
    ['ChronoLife 主动分享', cfg.chronolife && life?.settings?.proactive ? 'on' : 'off', life?.settings ? `这周发了 ${life.week}/${life.settings.weeklyMax} 条 · ${life.settings.quietStart}~${life.settings.quietEnd} 点不发 · 同一个人隔 ${life.settings.cooldownHours} 小时` : '', '开着 ChronoLife 时，主动找你只走这一条：小屋里刚有了具体内容的事（写了句什么、植物换了阶段、旅行回来），或者自己找事做时刷到你会喜欢的，她用自己的口气随口说一句，不想说就不说。只发 PROACTIVE_QQ 里的人、不发群；上一条你没回就不发下一条；你 20 分钟内刚聊过就留到聊天里说。主人私聊 /生活 主动 开 / 关。'],
    ['早安 / 晚安 / 冒泡', on(cfg.proactive && cfg.greetings), `每天最多 ${cfg.proactiveMax} 条 · ${cfg.proactiveIdleHours} 小时没动静可能冒个泡`, '早上、晚上掷骰子决定今天说不说；内容由模型现写。'],
    ['回访', on(cfg.followup && cfg.facts && cfg.proactive), `${cfg.followupHours.join('–')} 点 · 只找 ${cfg.proactiveQQ.join(', ') || '（没配 PROACTIVE_QQ）'} · 隔 2 小时以上`, '对方提到将来的事（考试、面试…），事后到点顺口问一句；超过 36 小时就不问了。'],
    ['主动戳你', on(cfg.pokeSelf), '一天最多一次', `白天你 ${cfg.pokeSelfIdleMin} 分钟以上没动静、她没在睡觉的时候，偶尔在 QQ 里戳你一下，什么都不说；无聊、嘴贫的时候更想戳。戳完会记进日记，你问“戳我干嘛”她对得上。`],
    ['等你回', on(cfg.chase), `问了没回 ${cfg.chaseMinMin}~${cfg.chaseMaxMin} 分钟后 ${Math.round(cfg.chaseProb * 100)}% 会追一句`, '她问了你一句、你半天没回，偶尔追一句“人呢”“？”，熟了会说“已读不回是吧”；一个问题最多追一次。你说了去洗澡、睡了、上课这种就不追，半夜也不追。'],
    ['每周一封信', on(cfg.letter), `每周${'日一二三四五六'[cfg.letterWeekday] || '日'} ${cfg.letterHour} 点后`, '每周给你写一封信，聊聊这一周你们之间的事：信纸用百炼通义万相画（按季节换花样，不写字，一张一两毛钱），字用手写体排上去，角上盖个小章；画不成就用素纸。发 /信 可以马上写一封（算这周的）。'],
  ]],
  ['电脑上的她', [
    ['电脑室友', on(cfg.pcBuddy), cfg.pcBuddy ? `只跟 ${cfg.pcOwner || cfg.proactiveQQ[0] || '（没设）'} 提 · 一天最多主动说 ${cfg.pcMaxDay} 句` : '', '她“住在这台电脑里”：看得见电脑上在放什么歌（网易云、QQ音乐、酷狗、Spotify…）、开着什么游戏、电脑开了多久、深夜人还在不在电脑前。聊天时心里知道；一首歌这周放到第 3 遍、凌晨还在打游戏、电脑连开好几天，会像室友一样顺口说一句。只看这几样，别的窗口一概不看；只在私聊里跟电脑的主人提。'],
    ['电脑喇叭说话', on(cfg.speaker), cfg.speaker ? `一天最多 ${cfg.speakerMaxDay} 句 · ${cfg.quietHours.join('~')} 点不出声` : '', '早上你第一次坐到电脑前、或者离开两个小时以上又回来，她用自己的声音从电脑喇叭说一句（“早”“回来啦 去哪了”）。要开电脑室友和语音；睡觉时段、夜里、ChronoLife 休息时都不出声，两句至少隔一小时。'],
    ['电脑上留便条', on(cfg.notes), cfg.notes ? `离开 ${cfg.noteAfterMin} 分钟以上 · 一天最多一张` : '', '你离开电脑好几个小时，她偶尔在桌面上留一张“<名字>的便条.txt”，像室友贴门上的纸条（1~3 句，不写私事和聊天内容）；你回来时右下角弹个通知“<名字>给你留了张便条”。夜里不留。'],
    ['桌面抽屉', on(cfg.drawer), cfg.drawer ? '桌面上“<名字>的抽屉”' : '', '桌面上一个“<名字>的抽屉”文件夹：她写给你的信、寄的明信片、发给你的现场照、梦见你的梦（梦.txt）、留过的便条（便条.txt）、自己找事做时收藏的视频（收藏.txt），都放一份。只放跟电脑的主人有关的。'],
    ['用 QQ 音乐放歌', on(cfg.playMusic), cfg.playMusic ? (fs.existsSync(cfg.qqMusicExe) ? `QQ 音乐：${cfg.qqMusicExe}` : '没找到 QQ 音乐，只发链接') + ` · 一天最多 ${cfg.playMusicMaxDay} 首` : '', '让她放首歌、或者她夜里想给你放首睡前听的：先在 QQ 音乐搜到这首（挑原版，不挑 Live / 伴奏），你在电脑前（键盘鼠标 5 分钟内动过）就直接在电脑上的 QQ 音乐里放；你不在电脑前就发 QQ 音乐的链接。只在私聊里。'],
  ]],
  ['QQ 上的样子', [
    ['在线状态和个签', on(cfg.onlineStatus || cfg.longnick), (() => { const p = state._presence || {}; return [p.name ? `现在：${p.name}` : '', p.sign ? `个签：${p.sign}` : ''].filter(Boolean).join(' · ') || '还没改过'; })(), 'QQ 在线状态跟着她过日子变：半夜睡觉中、熬夜中、自己找事做时摸鱼中、唱完歌听歌中，平时跟心情（元气满满、无聊中、想静静…）。每晚写完日记换一句个性签名（不带任何人名和私事）。'],
    ['自定义在线状态', on(cfg.diyStatus), (() => { const n = state._presence?.name || ''; return n.startsWith('diy:') ? `现在：${n.slice(4)}` : ''; })(), 'QQ 名字旁边的状态写她自己的一句话：自己找事做时“在刷B站：…”、录电台时“在录电台”、你电脑上在放歌时“陪你听：歌名”、生气委屈时一句心情（“别惹我”）；没有具体的事、或者在睡觉，就用预设的那几种。10 分钟内不来回换，设置失败 3 次就退回预设。'],
    ['心情头像', on(cfg.moodAvatar), (() => { const a = state._avatar || {}; const n = (() => { try { return fs.readdirSync(AVATAR_DIR).filter((f) => /\.(png|jpe?g|webp)$/i.test(f)).length; } catch { return 0; } })(); return `${n} 张图${a.name ? ` · 现在：${a.name}（${a.day === dayKey() ? `今天换了 ${a.count} 次` : '今天还没换'}）` : ''}`; })(), `她心情变了，QQ 头像跟着换成对应的图：${AVATAR_DIR} 里按名字放图（平常、开心、生气、委屈、困、睡觉、得意、烦、无聊、懒，没有的就用相近的，最后用“平常”），半夜换成“睡觉”。一天最多换 ${cfg.moodAvatarMaxDay} 次、两次至少隔 ${cfg.moodAvatarGapMin} 分钟，免得小号被风控。`],
    ['QQ 空间说说', on(cfg.qzone), cfg.qzone ? `${{ 1: '所有人', 4: '好友', 64: '仅自己' }[cfg.qzoneRight] || cfg.qzoneRight}可见 · 一天最多一条` : '', `${cfg.qzoneHours.join('~')} 点之间偶尔发一条说说（大概两天一条），写她自己最近干的事（刷到的视频、出去玩…），有时配一张“现在的她”。只写她自己的事：不写聊天内容，写到最近聊过的人的名字、QQ 号就不发；开着 ChronoLife 时只用它记下的虚拟事件。主人私聊发 /说说 可以让她马上发一条。`],
  ]],
  ['群聊', [
    ['群白名单', groups ? 'on' : 'off', groups ? `${groups} 个群` : '没配 ALLOWED_GROUPS，群消息一律不理', '只有白名单里的群会被理会。'],
    ['唤醒', groups ? 'on' : 'idle', `@ 它，或叫 ${cfg.wakeWords.join(' / ')} · 叫过后 ${cfg.groupFollowSec}s 内接着说不用再叫`, ''],
    ['引用回复', groups && cfg.groupQuote ? 'on' : groups ? 'off' : 'idle', '群里聊开了就引用原消息，等太久会 @', ''],
    ['插嘴', groups && cfg.chimeProb > 0 ? 'on' : cfg.chimeProb > 0 ? 'idle' : 'off', `基础 ${pct(cfg.chimeProb)}，每群冷却 ${cfg.chimeCooldownMin} 分钟、每天最多 ${cfg.chimeMaxDay} 次`, '没被叫时偶尔接一句；这一路只给只读权限、不给工具。'],
    ['戳一戳', on(cfg.poke), '按一分钟内被戳次数换说法，40% 戳回去', '不调模型。私聊和白名单群都有效。'],
  ]],
  ['手机和权限', [
    ['守护', 'on', `启动器启动 bridge 时会带上 bridge-guard.ps1（“${cfg.botName}状态”窗口能看到在不在守）`, 'bridge 意外停了（崩溃、被结束进程）就自动拉起，越崩越等得久（3s→10s→30s→1min→5min），每次都在 bridge.log 记一笔“守护：…”，崩溃时连报错一起记。'],
    ['手机看门狗', on(cfg.phoneMonitor), '只在它正在用手机时才看', '它自己想玩手机、或者你让它看手机，用着用着屏幕黑了/锁了就悄悄解开；平时手机锁着不去碰。解不开才跟你说。'],
    ['权限模式', cfg.permissionMode === 'danger-full-access' ? 'warn' : 'on', cfg.permissionMode || '（默认）', cfg.permissionMode === 'danger-full-access' ? '白名单里的人能让它执行任意命令、读写任意文件。只加信得过的人。' : ''],
    ['私聊白名单', 'on', cfg.allowedQQ.join(', ') || '（空）', ''],
  ]],
];

// ── 每个人 ────────────────────────────────────────────────────────────────
const people = Object.keys(state)
  .filter((k) => /^\d+$/.test(k) && cfg.allowedQQ.includes(k))
  .map((qq) => {
    const st = state[qq];
    const score = closeness(st);
    const { facts, followups, style } = factsOf(`u${qq}`);
    return { qq, st, score, fam: familiarity(score), facts, style, pending: followups.filter((f) => !f.done) };
  });

// ── 它此刻 ────────────────────────────────────────────────────────────────
const me = selfState();
// 被事情影响的心情（跟 bridge 的 myState 一样）：这里只显示心情，不显示为啥
{
  const e = state._emotion;
  const t = state._tired;
  if (cfg.emotion && e && Date.now() >= e.from && Date.now() < e.until) me.mood = e.mood;
  else if (cfg.emotion && t && Date.now() >= t.from && Date.now() < t.until) me.mood = '困';
}
const diary = (state._self?.log || []).filter((e) => e.day === dayKey());
const selfProfile = readJson(path.join(DATA_DIR, 'self-profile.json'), {});
const selfItems = Array.isArray(selfProfile.items) ? selfProfile.items : [];

// ── render ────────────────────────────────────────────────────────────────
const pill = { on: ['开', 'on'], off: ['关', 'off'], idle: ['开着·用不上', 'idle'], warn: ['注意', 'warn'], life: ['归 ChronoLife 管', 'idle'] };
const featureHtml = features
  .map(
    ([group, rows]) => `<h2>${esc(group)}</h2><div class="card"><table>${rows
      .map(([name, level, setting, how]) => {
        const taken = cfg.chronolife && level === 'on' && LIFE_TAKEN[name];
        if (taken) [level, how] = [taken[1] ? 'life' : level, `${taken[0]}${how}`];
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
<details><summary>它记得的事（${p.facts.length} 条）</summary>${p.facts.length ? `<ul>${p.facts.map((f) => `<li>${esc(f.t)}</li>`).join('')}</ul>` : '<div class="how">还没有</div>'}</details>
<details><summary>学到的说话习惯（${p.style.length} 条）</summary>${p.style.length ? `<ul>${p.style.map((x) => `<li>${esc(x.t)}</li>`).join('')}</ul>` : '<div class="how">还没学到</div>'}</details>
<details><summary>回访待办（${p.pending.length} 个）</summary>${p.pending.length ? `<ul>${p.pending.map((f) => `<li>${esc(when(f.due))}：${esc(f.ask)}</li>`).join('')}</ul>` : '<div class="how">没有</div>'}</details>
</div>`,
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

<h2>它此刻</h2>
<div class="card grid">
<div>时间<b>${esc(nowDesc())}</b></div>
<div>心情<b>${esc(me.mood)}</b></div>
<div>精力<b>${esc(me.energyDesc)}</b></div>
</div>
<div class="card"><b style="font-size:13px">今天干过</b>${diary.length ? `<ul>${diary.map((e) => `<li>${esc(e.time)} ${esc(e.text)}</li>`).join('')}</ul>` : '<div class="how">今天还没有自己找事做的记录</div>'}</div>

<h2>它慢慢长出来的样子</h2>
<div class="card">${selfItems.length ? `<table>${['喜好', '观点', '最近在看', '梗', '习惯'].map((k) => [k, selfItems.filter((i) => i.kind === k)]).filter(([, v]) => v.length).map(([k, v]) => `<tr><td class="n">${esc(k)}</td><td>${v.map((i) => `${esc(i.t)}${(i.seen || 1) > 1 ? ` <span class="how">×${i.seen}</span>` : ''}`).join('<br>')}</td></tr>`).join('')}</table>` : '<div class="how">还没长出来：要先有自己找事做的日记，晚上回想过才会有。</div>'}<div class="how">上次回想：${esc(when(selfProfile.lastReflectAt))} · ×N 表示被印证过 N 次</div></div>

<h2>每个人</h2>
${peopleHtml}

${featureHtml}

<h2>命令（在 QQ 里发）</h2>
<div class="card"><table>
<tr><td class="n">/status</td><td>在线状态、活跃任务数、熟悉度和综合分（给你排错用）</td></tr>
<tr><td class="n">/心情</td><td>它回一句人话说心情，不报数字</td></tr>
<tr><td class="n">/new</td><td>开新对话（清掉这个聊天的模型会话，长期事实和熟悉度不受影响）</td></tr>
<tr><td class="n">/提醒 30m 喝水</td><td>到点私聊提醒；单发 /提醒 看列表</td></tr>
<tr><td class="n">/唱歌 第一天</td><td>用她的嗓子唱一段（不写歌名就随便唱一首，不算每天的条数）</td></tr>
<tr><td class="n">/歌单</td><td>它会唱哪些歌、每首几段</td></tr>
<tr><td class="n">/说话 你好呀</td><td>用它的声音把这句念成语音发给你（试音色用，不算每天的条数）</td></tr>
<tr><td class="n">/城市 杭州</td><td>告诉她你在哪（看天气用）；单发 /城市 看她记的是哪</td></tr>
<tr><td class="n">/生日 5-20</td><td>告诉她你的生日</td></tr>
<tr><td class="n">/喂鱼 /摸摸</td><td>亲密度 +1</td></tr>
<tr><td class="n">/日记</td><td>看她最新一篇日记</td></tr>
<tr><td class="n">/信</td><td>马上给你写一封信（算这周的；只在私聊）</td></tr>
<tr><td class="n">/明信片</td><td>马上寄一张旅行明信片（只在私聊）</td></tr>
<tr><td class="n">/说说</td><td>让她马上发一条 QQ 空间说说（只听主人的）</td></tr>
<tr><td class="n">/学说话 /别学了</td><td>看她在学谁说话、学到几成；别学了就停掉并删掉素材</td></tr>
<tr><td class="n">/生活 帮助</td><td>ChronoLife 的命令：/生活 状态、事件、记忆、记住 内容、更正 编号 新内容、删除 编号；主人私聊还有 主动 开/关、暂停/恢复、停用/启用、兴趣 plant 2</td></tr>
</table></div>

<h2>工具和文件</h2>
<div class="card"><table>
<tr><td class="n">启动QQ机器人</td><td>桌面快捷方式：完整启动（扫码）或只重启 bridge；窗口右上角的“功能与机制”打开这页</td></tr>
<tr><td class="n">${esc(cfg.botName)}状态</td><td>桌面快捷方式：是否在线、报错、掉线（不显示对话）</td></tr>
<tr><td class="n">刷 B站</td><td><code>node bili\\bili.mjs hot</code> / <code>search 关键词</code> / <code>watch BV号 --listen 3 --frames 6</code> / <code>seen</code></td></tr>
<tr><td class="n">日记网页</td><td>启动器右上角“日记”，或 <code>node scripts\\journal-view.mjs</code>：选日期看那天的日记、跟谁聊了啥、当天的聊天（含聊天内容，只在本机看）</td></tr>
<tr><td class="n">会话查看</td><td><code>node scripts\\session-view.mjs</code>：每轮的上下文和思考过程（含对话内容，别外发）</td></tr>
<tr><td class="n">配置</td><td><code>agent-bridge\\.env</code>（改完要重启 bridge；人设除外）</td></tr>
<tr><td class="n">说明</td><td><code>agent-bridge\\HANDOFF.md</code></td></tr>
</table></div>
</main></body></html>`;

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, html);
console.log(`已生成：${out}`);
if (!argv.includes('--no-open') && process.platform === 'win32') {
  spawn('cmd.exe', ['/c', 'start', '', out], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}
