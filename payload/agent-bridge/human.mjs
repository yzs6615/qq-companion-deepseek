/**
 * 让机器人更像人的小零件。全是纯函数（随机数可注入），不碰网络和文件，
 * bridge.mjs 负责把它们接到收发消息的流程上，test/human-unit.mjs 负责单测。
 */

// ── 表情标签 ──────────────────────────────────────────────────────────────
/** 抽出所有 [表情:xx]，返回去掉标签后的文字和去重后的情绪列表。 */
export function extractStickers(raw) {
  const moods = [];
  const text = String(raw || '').replace(/\[表情[:：]([^\]]+)\]/g, (_, m) => {
    const mood = m.trim();
    if (mood && !moods.includes(mood)) moods.push(mood);
    return '';
  });
  return {
    text: text
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
    moods,
  };
}

/**
 * 语音的语气 → CosyVoice 的 instruction。官方的情感词用固定句式（复刻音色也认），困没有对应的词，用大白话。
 * 开心试过，跟生气听着分不开，不做。
 */
export const VOICE_TONES = {
  生气: '你说话的情感是angry。',
  难过: '你说话的情感是sad。',
  委屈: '你说话的情感是sad。',
  害怕: '你说话的情感是fearful。',
  惊讶: '你说话的情感是surprised。',
  嫌弃: '你说话的情感是disgusted。',
  困: '困得睁不开眼，有气无力、慢吞吞地说，声音含糊，带着哈欠。',
};
const TONE_ALIAS = { 气: '生气', 凶: '生气', 伤心: '难过', 丧: '难过', 有点丧: '难过', 哭: '委屈', 怕: '害怕', 吓: '害怕', 震惊: '惊讶', 吃惊: '惊讶', 烦: '嫌弃', 无语: '嫌弃', 恶心: '嫌弃', 犯困: '困' };
/** 她写的语气词 → 认得的语气（不认得返回空）。 */
export function voiceTone(word) {
  const w = String(word || '').trim();
  const t = TONE_ALIAS[w] || w;
  return VOICE_TONES[t] ? t : '';
}
/** 心情有来由那套记的心情 → 语音的语气（开心、平静这些不带）。 */
export const MOOD_TONE = { 生气: '生气', 委屈: '委屈', 有点丧: '难过', 烦: '嫌弃', 困: '困' };

/**
 * 模型在回复里写 [语音] 表示这句想直接说出来；[语音:害怕] 这样还能点个语气。标记一律去掉。
 * tone：认得的语气；点了个不认得的（开心之类）是“平常”，就用平常的嗓子，不再按心情猜。
 */
export function extractVoice(raw) {
  let voice = false;
  let tone = '';
  const text = String(raw || '').replace(/\[(?:语音|发语音)(?:[:：]([^\]]*))?\]/g, (_, word) => {
    voice = true;
    if (!tone && word?.trim()) tone = voiceTone(word) || '平常';
    return '';
  });
  return { text: voice ? text.replace(/[ \t]{2,}/g, ' ').trim() : text, voice, tone };
}

/** 模型写 [唱歌] / [唱歌:歌名] 表示想唱一段；标记一律去掉。返回 { text, sing: null | '' | 歌名 }。 */
export function extractSing(raw) {
  let sing = null;
  const text = String(raw || '').replace(/\[(?:唱歌|唱)(?:[:：]([^\]]*))?\]/g, (_, name) => {
    if (sing === null) sing = (name || '').replace(/[《》「」"“”]/g, '').trim();
    return '';
  });
  return { text: sing === null ? text : text.replace(/[ \t]{2,}/g, ' ').trim(), sing };
}

/** 念出来之前去掉念不了的东西：QQ 表情标记、链接、括号里的动作描写。 */
export function speakable(text) {
  return String(text || '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[（(][^）)]{0,20}[）)]/g, '')
    .replace(/\s*\n+\s*/g, '，')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 自主活动里模型用 [日记:...] 记下刚才干了啥。 */
export function extractDiary(raw) {
  let diary = '';
  const text = String(raw || '').replace(/\[日记[:：]([^\]]+)\]/g, (_, d) => {
    if (!diary) diary = d.trim().slice(0, 120);
    return '';
  });
  return { text: text.trim(), diary };
}

// ── 打字节奏 ──────────────────────────────────────────────────────────────
/** 一个气泡“打出来”要多久：按字数，带随机，封顶 6 秒。perChar 为 0 就不等。 */
export function typingDelayMs(text, perChar = 130, rnd = Math.random) {
  if (!perChar) return 0;
  const n = [...String(text || '')].length;
  const base = 350 + n * perChar;
  return Math.round(Math.min(base * (0.75 + rnd() * 0.6), 6000));
}

/** 等对方把话说完：句子收尾了就少等，没说完就多等。 */
export function mergeWaitMs(text, hasImage, base) {
  if (!base) return 0;
  const done = hasImage || /[。！？!?…~～]\s*$/.test(String(text || '').trim());
  return done ? Math.round(base * 0.6) : base;
}

// ── 时间、心情、精力 ──────────────────────────────────────────────────────
const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
const HOLIDAYS = {
  '01-01': '元旦',
  '02-14': '情人节',
  '03-08': '妇女节',
  '04-01': '愚人节',
  '05-01': '劳动节',
  '06-01': '儿童节',
  '09-10': '教师节',
  '10-01': '国庆节',
  '10-31': '万圣节',
  '11-11': '光棍节',
  '12-24': '平安夜',
  '12-25': '圣诞节',
  '12-31': '跨年夜',
};
const pad = (n) => String(n).padStart(2, '0');

export function dayKey(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
export function dayPart(hour) {
  if (hour < 6) return '凌晨';
  if (hour < 9) return '早上';
  if (hour < 12) return '上午';
  if (hour < 14) return '中午';
  if (hour < 18) return '下午';
  if (hour < 20) return '傍晚';
  return '晚上';
}
/** “2026-10-23 星期五 15:20（下午）”，节日当天会带上节日名。 */
export function nowDesc(d = new Date()) {
  const holiday = HOLIDAYS[`${pad(d.getMonth() + 1)}-${pad(d.getDate())}`];
  return `${dayKey(d)} 星期${WEEK[d.getDay()]} ${pad(d.getHours())}:${pad(d.getMinutes())}（${dayPart(d.getHours())}）${holiday ? `，今天是${holiday}` : ''}`;
}

/** 字符串 -> 稳定的伪随机序列，同一个种子永远给同一串数。 */
export function seededRand(seed) {
  let h = 1779033703 ^ String(seed).length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MOODS = [
  ['平静', 3],
  ['开心', 3],
  ['懒', 3],
  ['无聊', 2],
  ['嘴贫', 2],
  ['烦', 1],
  ['兴奋', 1],
  ['有点丧', 1],
];
const ENERGY_BY_HOUR = [0.15, 0.1, 0.1, 0.1, 0.1, 0.15, 0.3, 0.45, 0.6, 0.75, 0.85, 0.8, 0.6, 0.5, 0.55, 0.6, 0.7, 0.75, 0.75, 0.8, 0.75, 0.65, 0.5, 0.3];

/**
 * 此刻的“自我状态”。心情按（日期, 时段）固定，同一时段内不会一句一变；
 * 精力随钟点走，午后犯困、深夜低电量。
 */
export function selfState(d = new Date()) {
  const hour = d.getHours();
  const part = dayPart(hour);
  const rnd = seededRand(`${dayKey(d)}|${part}`);
  const weights = MOODS.map(([name, w]) => {
    let weight = w;
    if (name === '懒' && (part === '中午' || part === '下午')) weight *= 2;
    if (name === '有点丧' && part === '凌晨') weight *= 3;
    if (name === '兴奋' && part === '晚上') weight *= 2;
    return [name, weight];
  });
  let roll = rnd() * weights.reduce((s, [, w]) => s + w, 0);
  let mood = weights[0][0];
  for (const [name, w] of weights) {
    roll -= w;
    if (roll <= 0) {
      mood = name;
      break;
    }
  }
  if (part === '凌晨' && rnd() < 0.5) mood = '困';
  const energy = Math.min(1, Math.max(0.05, ENERGY_BY_HOUR[hour] + (rnd() - 0.5) * 0.3));
  const energyDesc = energy < 0.3 ? '很困，话少，回得慢' : energy < 0.55 ? '有点没精神，懒得多说' : energy < 0.8 ? '正常' : '精神不错，话多爱贫';
  return { part, mood, energy, energyDesc };
}

/** 每小时掷一次骰子“要不要自己玩会”：无聊/兴奋更想玩，困/懒不太想，没精神的时候也懒得动。 */
const PLAY_MOOD = { 无聊: 1.8, 兴奋: 1.4, 嘴贫: 1.2, 开心: 1.1, 平静: 1, 有点丧: 0.8, 委屈: 0.8, 烦: 0.7, 生气: 0.7, 懒: 0.6, 困: 0.3 };
export function playChance(me, base = 0.35) {
  const p = base * (PLAY_MOOD[me.mood] ?? 1) * (0.5 + me.energy);
  return Math.min(0.9, Math.max(0.05, p));
}

/** 熟悉程度：聊得越多越敢损、越随便。 */
export function familiarity(score) {
  if (score < 5) return { tier: '刚认识', hint: '还在观察对方，话不用多，但依然别客服腔' };
  if (score < 25) return { tier: '一般熟', hint: '正常聊天，偶尔开玩笑' };
  if (score < 80) return { tier: '熟', hint: '可以随便损两句、开玩笑、接梗' };
  return { tier: '很熟', hint: '老朋友，想怎么贫怎么贫，想关心就直说' };
}

// ── 小失误：打错字再补正 ──────────────────────────────────────────────────
const CONFUSABLE = {
  在: '再',
  再: '在',
  的: '得',
  得: '的',
  做: '作',
  作: '做',
  那: '哪',
  哪: '那',
  他: '她',
  她: '他',
  以: '已',
  已: '以',
  像: '象',
  象: '像',
  是: '事',
  事: '是',
  知: '只',
  到: '倒',
  就: '救',
  会: '回',
  要: '药',
  有: '又',
  又: '有',
  吗: '嘛',
  嘛: '吗',
  吧: '把',
  里: '理',
  对: '队',
  睡: '水',
  现: '线',
};

/**
 * 给一句话造个“手滑”：把一个字换成同音/形近字。
 * 返回 { typo, fix }，fix 是随后补发的 “*对的字”；不适合出错的句子返回 null。
 */
export function makeTypo(text, rnd = Math.random) {
  const t = String(text || '');
  const chars = [...t];
  if (chars.length < 5 || chars.length > 60) return null;
  if (/[A-Za-z]{4,}|https?:|\d{3,}|`|\[表情|[/\\]/.test(t)) return null;
  const slots = [];
  chars.forEach((c, i) => {
    if (CONFUSABLE[c]) slots.push(i);
  });
  if (!slots.length) return null;
  const at = slots[Math.floor(rnd() * slots.length)];
  const wrong = [...chars];
  wrong[at] = CONFUSABLE[chars[at]];
  return { typo: wrong.join(''), fix: `*${chars[at]}` };
}

// ── 不值得动模型的“嗯嗯”类消息 ────────────────────────────────────────────
const LAUGH_RE = /^(哈+|嘿+|嘻+|hh+|笑死|绷不住|乐死|蚌埠住了|草|艹)[!！~～。.…\s]*$/i;
const OK_RE = /^(嗯+|哦+|噢+|好+的?|好吧|好嘞|得嘞|行|行吧|ok|okay|知道了|懂了|明白了?|了解|收到|可以)[!！~～。.…\s]*$/i;
/** 返回 'laugh' | 'ok' | ''。只是附和一声的话，点个表情回应就够了。 */
export function ackKind(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 8) return '';
  if (LAUGH_RE.test(t)) return 'laugh';
  if (OK_RE.test(t)) return 'ok';
  return '';
}
/** 上一句是个问句的话，对方的“好”是在回答，不能当附和吞掉。 */
export function looksLikeQuestion(text) {
  return /[?？]\s*$|吗\s*$|要不要|好不好|行不行|对不对/.test(String(text || '').trim());
}

// ── 心情有来由 ────────────────────────────────────────────────────────────
export const EVENT_MOODS = ['开心', '兴奋', '平静', '无聊', '懒', '嘴贫', '烦', '有点丧', '委屈', '生气', '困'];
/** 从回复里拿出 [心情:词|为啥]（模型写的，不发出去），标记一律去掉。 */
export function extractMoodTag(raw) {
  let mood = '';
  let reason = '';
  const text = String(raw || '').replace(/\[心情[:：]\s*([^\]|｜]+?)\s*(?:[|｜]\s*([^\]]*?))?\s*\]/g, (_, m, r) => {
    if (!mood && EVENT_MOODS.includes(m.trim())) {
      mood = m.trim();
      reason = String(r || '').trim().slice(0, 40);
    }
    return '';
  });
  return { text: text.replace(/[ \t]+\n/g, '\n').trim(), mood, reason };
}
/** 一件事带来的心情能持续多久（小时）：委屈、生气、丧久一点，开心几个小时，其他短一些。 */
export function moodHours(mood) {
  return { 生气: 5, 委屈: 5, 有点丧: 4, 烦: 3, 开心: 3, 兴奋: 2, 嘴贫: 2, 无聊: 1.5, 懒: 2, 平静: 2, 困: 3 }[mood] ?? 2;
}

// ── 记得你的作息 ──────────────────────────────────────────────────────────
// 早上 5 点算新的一天：凌晨两点发的消息算前一天的“晚睡”。分钟数从 5:00 算起（0 ~ 1439）。
const LOGICAL_SHIFT = 5 * 60;
export function logicalTime(t) {
  const d = new Date(t - LOGICAL_SHIFT * 60_000);
  return { day: dayKey(d), min: d.getHours() * 60 + d.getMinutes() };
}
export const clockOf = (min) => {
  const m = (min + LOGICAL_SHIFT) % 1440;
  return `${Math.floor(m / 60)}:${pad(m % 60)}`;
};
/** 一堆消息时间 → 平时几点冒头、几点没动静（每天第一条 / 最后一条的中位数）。不够 minDays 天返回 null。 */
export function computeRhythm(times, minDays = 4) {
  const days = new Map();
  for (const t of times) {
    const { day, min } = logicalTime(t);
    const d = days.get(day) || { first: min, last: min };
    d.first = Math.min(d.first, min);
    d.last = Math.max(d.last, min);
    days.set(day, d);
  }
  if (days.size < minDays) return null;
  const med = (arr) => {
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };
  return { wake: med([...days.values()].map((d) => d.first)), sleep: med([...days.values()].map((d) => d.last)), days: days.size };
}
/**
 * 作息被带偏：对方最近几点没动静（computeRhythm 的 sleep，从 5 点算起的分钟）→ 她的睡觉时间往那边挪几个小时。
 * 被带偏一大半、不完全跟着；整小时，最多晚 maxLate、早 maxEarly。比如她平时 1 点睡、对方最近 3 点半才没动静 → 挪 2 小时。
 */
export function sleepDrift(baseStart, ownerSleepMin, maxLate = 2, maxEarly = 1) {
  if (!Number.isFinite(ownerSleepMin)) return 0;
  let d = ((ownerSleepMin + LOGICAL_SHIFT) % 1440) / 60 - baseStart;
  if (d > 12) d -= 24;
  if (d <= -12) d += 24;
  return Math.max(-maxEarly, Math.min(maxLate, Math.round(d * 0.6)));
}
/**
 * 今天跟平时比有没有反常：晚睡（现在比平时没动静的点晚 45 分钟以上）、早起（今天第一条比平时早 1 小时以上）。
 * 返回 { kind: 'late'|'early', text } 或 null。
 */
export function rhythmNote(now, rhythm, todayFirst) {
  if (!rhythm) return null;
  const n = logicalTime(now).min;
  if (n > rhythm.sleep + 45 && n - rhythm.sleep < 300) return { kind: 'late', text: `对方平时 ${clockOf(rhythm.sleep)} 左右就没动静了，今天这个点还在` };
  if (todayFirst && logicalTime(todayFirst).day === logicalTime(now).day) {
    const f = logicalTime(todayFirst).min;
    if (f < rhythm.wake - 60 && n - f < 180) return { kind: 'early', text: `对方平时 ${clockOf(rhythm.wake)} 左右才冒头，今天 ${clockOf(f)} 就来了` };
  }
  return null;
}

// ── 对你好奇 ──────────────────────────────────────────────────────────────
export const CURIOUS_TOPICS = [
  { id: 'job', ask: '是干嘛的（上学还是上班，学什么、做什么）', known: /工作|上班|公司|职业|学生|大学|高中|初中|专业|学校|老师|程序员|上课|实习|毕业|老板|同事|考研/ },
  { id: 'city', ask: '住在哪个城市', known: /住在|在[^，。,]{1,5}(市|省|县)|老家|城市/ },
  { id: 'hobby', ask: '平时喜欢干嘛（玩什么游戏、看什么、听什么）', known: /爱好|爱玩|爱看|爱听|在玩|在追|喜欢(玩|看|听|打)|游戏/ },
  { id: 'food', ask: '爱吃什么、不吃什么', known: /爱吃|喜欢吃|不吃|口味|吃辣|忌口|最爱.{0,4}吃/ },
  { id: 'pet', ask: '家里有没有养猫狗', known: /猫|狗|宠物|养了/ },
  { id: 'birthday', ask: '生日是哪天', known: /生日/ },
];
/** 还不知道的方面：记住的事里没提到、也没单独设置过（城市、生日）。 */
export function unknownTopics(factTexts, extra = {}) {
  const all = factTexts.join('\n');
  return CURIOUS_TOPICS.filter((t) => !(t.id === 'city' && extra.city) && !(t.id === 'birthday' && extra.birthday) && !t.known.test(all));
}

/**
 * 自己找事做时挑一件事：上一次干的不挑（只剩一个就无所谓），今天干过几次权重就除以几加一。
 * pool: [{ id, w }]；返回挑中的那一项。
 */
export function chooseActivity(pool, lastId, doneIds = [], rand = Math.random) {
  if (!pool.length) return null;
  const weights = pool.map((x) => (x.id === lastId && pool.length > 1 ? 0 : x.w / (1 + doneIds.filter((d) => d === x.id).length)));
  let roll = rand() * weights.reduce((t, w) => t + w, 0);
  for (let i = 0; i < pool.length; i++) {
    roll -= weights[i];
    if (roll <= 0 && weights[i] > 0) return pool[i];
  }
  return pool.find((x, i) => weights[i] > 0) || pool[0];
}

/** 她最后一句是不是在问对方（只看最后一行：问号、吗/没结尾、要不要/是不是/咋样这类）。 */
export function askedSomething(text) {
  const last = String(text || '').trim().split(/\n+/).pop().replace(/\[[^\]]*\]/g, '').trim();
  return /[?？]\s*$|(吗|没|么)\s*$|要不要|好不好|行不行|对不对|是不是|有没有|咋样|怎么样|干嘛呢|几点|啥时候/.test(last);
}
/** 对方说了要走开（去洗澡、睡了、上课、晚安……）：这时候没回很正常，别追着问。 */
export function isLeaving(text) {
  return /(去|要|得|先|准备)(洗澡|睡|上课|开会|吃饭|忙|上班|出门|打游戏|写作业)|晚安|拜拜|再见|先下了|下了|走了|睡了|忙去了|一会聊|等会聊|回头聊/.test(String(text || ''));
}

// ── 群里插嘴 ──────────────────────────────────────────────────────────────
/** 这句话值不值得插嘴：问句、笑点、点到它的领域，权重高一点。 */
export function chimeWeight(text) {
  const t = String(text || '');
  let w = 1;
  if (/[?？]/.test(t)) w += 2;
  if (/哈哈|笑死|绷不住|离谱|草|无语|太强|牛/.test(t)) w += 2;
  if (/鱼|机器人|AI|ai|DeepSeek|代码|手机|电脑|bug|游戏/.test(t)) w += 2;
  return w;
}

// ── 杂项 ──────────────────────────────────────────────────────────────────
/** 从模型输出里捞第一个 JSON 对象（兼容 ```json 围栏和前后废话）。 */
export function parseJsonLoose(raw) {
  const s = String(raw || '')
    .replace(/```(?:json)?/gi, '')
    .trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** “2026-10-24 18:00” -> 毫秒时间戳（本地时间）；解析不了返回 0。 */
export function parseLocalTime(s) {
  const m = String(s || '').match(/(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T]+(\d{1,2}):(\d{2}))?/);
  if (!m) return 0;
  const t = new Date(+m[1], +m[2] - 1, +m[3], m[4] ? +m[4] : 9, m[5] ? +m[5] : 0).getTime();
  return Number.isFinite(t) ? t : 0;
}
