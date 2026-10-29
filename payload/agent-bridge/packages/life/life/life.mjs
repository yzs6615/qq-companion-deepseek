#!/usr/bin/env node
/**
 * 刷别的（除了 B站）：知乎热榜、微博热搜、听歌（榜单 / 歌词 / 热评）、看番。都不用登录。
 *
 *   node life/life.mjs zhihu [条数]          知乎热榜：问题、热度、摘要（回答要登录看不了）
 *   node life/life.mjs weibo [条数]          微博热搜
 *   node life/life.mjs music [飙升|热歌|新歌|原创]   网易云榜单
 *   node life/life.mjs song 歌名或id          一首歌：歌词 + 网易云热评
 *   node life/life.mjs song 歌名 歌手 --lyrics-json 文件名 [--offset 秒]
 *        学歌用：把带时间的歌词存成 speech 插件 sing/learn.mjs --lyrics 要的 {"lines":[{"start","end","text"}]}，
 *        文件一律放 <数据目录>/tmp/ 下面；时间按网易云原版算，B站 那版前奏长短不一样就用 --offset 挪（秒，可以是负数）
 *   node life/life.mjs anime [今天|这周]       B站新番时间表
 *   node life/life.mjs anime-rank            番剧排行
 *   node life/life.mjs anime-watch season_id    追一部番：简介、评分、最新一集、弹幕刷得最多的、热评（番剧画面大多要会员，不看）
 *   node life/life.mjs seen                  最近看过的
 *
 * 看过的会记下来（data/life/seen.json），列表里标“（看过）”。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDanmaku, topDanmaku } from '../bili/lib.mjs';

const { env, DATA_DIR } = await import('../env.mjs'); // .env、数据目录（插件目录下的 env.mjs）
const DATA = path.join(DATA_DIR, 'life');
const SEEN = path.join(DATA, 'seen.json');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const API = {
  zhihu: env.LIFE_ZHIHU_API || 'https://api.zhihu.com/topstory/hot-list',
  weibo: env.LIFE_WEIBO_API || 'https://weibo.com/ajax/side/hotSearch',
  music: env.LIFE_MUSIC_API || 'https://music.163.com/api',
  bili: env.LIFE_BILI_API || 'https://api.bilibili.com',
};
const CHARTS = { 飙升: 19723756, 热歌: 3778678, 新歌: 3779629, 原创: 2884035 };
// 临时文件只放 data/tmp/（学歌的歌词 JSON 也在这）
const TMP = path.join(DATA_DIR, 'tmp');
const CREDITS = /^(作词|作曲|编曲|制作人|混音|母带|录音|和声|吉他|贝斯|鼓|弦乐|监制|出品|OP|SP)\s*[:：]/;

fs.mkdirSync(DATA, { recursive: true });
const readJson = (f, d) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return d;
  }
};
let seen = readJson(SEEN, {});
const isSeen = (kind, id) => (seen[kind] || []).some((x) => x.id === String(id));
function markSeen(kind, id, title) {
  const list = (seen[kind] || []).filter((x) => x.id !== String(id));
  list.unshift({ id: String(id), title: String(title).slice(0, 60), at: Date.now() });
  seen[kind] = list.slice(0, 300);
  fs.writeFileSync(SEEN, JSON.stringify(seen));
}
const tag = (kind, id) => (isSeen(kind, id) ? '（看过）' : '');

async function get(url, headers = {}) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, ...headers }, signal: AbortSignal.timeout(20_000) });
  if (r.status === 412 || r.status === 403 || r.status === 429) throw new Error('人家说刷太快了（风控），歇会再来');
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
const clip = (s, n) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
};

async function zhihu(n = 15) {
  const j = await get(`${API.zhihu}?limit=${Math.min(50, n)}`);
  const items = (j.data || []).slice(0, n);
  const out = items.map((x, i) => {
    const t = x.target || {};
    const line = `${i + 1}. ${t.title}${tag('zhihu', t.id)}\n   ${x.detail_text || ''} · ${t.answer_count ?? '?'} 个回答${t.excerpt ? `\n   ${clip(t.excerpt, 90)}` : ''}`;
    markSeen('zhihu', t.id, t.title);
    return line;
  });
  console.log(`知乎热榜（点进去看回答要登录，这里只有摘要）：\n${out.join('\n')}`);
}

async function weibo(n = 20) {
  const j = await get(API.weibo, { Referer: 'https://weibo.com/' });
  const items = (j.data?.realtime || []).filter((x) => !x.is_ad).slice(0, n);
  const out = items.map((x, i) => {
    const line = `${i + 1}. ${x.word}${x.label_name ? `【${x.label_name}】` : ''}${x.num ? ` ${Math.round(x.num / 10000)}万` : ''}${tag('weibo', x.word)}`;
    markSeen('weibo', x.word, x.word);
    return line;
  });
  console.log(`微博热搜：\n${out.join('\n')}`);
}

async function music(which = '飙升') {
  const id = CHARTS[which] || CHARTS['飙升'];
  const name = Object.keys(CHARTS).find((k) => CHARTS[k] === id);
  const j = await get(`${API.music}/playlist/detail?id=${id}`, { Referer: 'https://music.163.com/' });
  const tracks = (j.result?.tracks || j.playlist?.tracks || []).slice(0, 20);
  const out = tracks.map((t, i) => `${i + 1}. ${t.name} - ${(t.artists || t.ar || []).map((a) => a.name).join('/')}${tag('music', t.id)}  (id ${t.id})`);
  console.log(`网易云${name}榜：\n${out.join('\n')}\n（想听哪首：song id 看歌词和热评）`);
}

/** 网易云的 LRC → [{start, end, text}]（秒）。一句的结束 = 下一句开始（最多 10 秒，最后一句 5 秒）。 */
function lrcToLines(lrc, offset = 0) {
  const stamps = [];
  for (const raw of String(lrc || '').split('\n')) {
    const tags = [...raw.matchAll(/\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]/g)];
    if (!tags.length) continue;
    const text = raw.replace(/\[[^\]]*\]/g, '').trim();
    for (const m of tags) stamps.push({ t: Number(m[1]) * 60 + Number(m[2].replace(':', '.')), text });
  }
  stamps.sort((a, b) => a.t - b.t);
  const r2 = (x) => Math.round(x * 100) / 100;
  const out = [];
  stamps.forEach(({ t, text }, i) => {
    if (!text || CREDITS.test(text)) return;
    const next = stamps.slice(i + 1).find((x) => x.t > t);
    const end = next ? Math.min(next.t, t + 10) : t + 5;
    if (end + offset <= 0) return;
    out.push({ start: r2(Math.max(0, t + offset)), end: r2(end + offset), text });
  });
  return out;
}

/** 歌词 JSON 存到哪：只认文件名，一律放 data/tmp/ 下面。 */
function lyricsPath(name) {
  let base = path.basename(String(name || '').replace(/\\/g, '/')) || 'lyrics.json';
  if (!/\.json$/i.test(base)) base += '.json';
  return path.join(TMP, base);
}

async function song(q, { lyricsJson = '', offset = 0 } = {}) {
  if (!q) throw new Error('听哪首？song 后面跟歌名或 id');
  let id = /^\d+$/.test(q) ? q : '';
  let title = '';
  if (!id) {
    const s = await get(`${API.music}/search/get?s=${encodeURIComponent(q)}&type=1&limit=1`, { Referer: 'https://music.163.com/' });
    const hit = s.result?.songs?.[0];
    if (!hit) throw new Error(`没搜到「${q}」`);
    id = String(hit.id);
    title = `${hit.name} - ${(hit.artists || []).map((a) => a.name).join('/')}`;
  }
  const [lyr, cm] = await Promise.all([
    get(`${API.music}/song/lyric?id=${id}&lv=1`, { Referer: 'https://music.163.com/' }),
    get(`${API.music}/v1/resource/comments/R_SO_4_${id}?limit=5`, { Referer: 'https://music.163.com/' }).catch(() => ({})),
  ]);
  const lines = String(lyr.lrc?.lyric || '')
    .split('\n')
    .map((l) => l.replace(/\[[^\]]*\]/g, '').trim())
    .filter((l) => l && !CREDITS.test(l));
  const hot = (cm.hotComments || []).slice(0, 4).map((c) => `- (${c.likedCount >= 10000 ? `${(c.likedCount / 10000).toFixed(1)}万` : c.likedCount}赞) ${clip(c.content, 100)}`);
  markSeen('music', id, title || q);
  console.log(
    `${title ? `【${title}】` : `【歌 ${id}】`}\n` +
      (lines.length ? `歌词（前 30 句）：\n${lines.slice(0, 30).join('\n')}${lines.length > 30 ? '\n…' : ''}` : '（没歌词，可能是纯音乐）') +
      (hot.length ? `\n网易云热评：\n${hot.join('\n')}` : ''),
  );
  if (lyricsJson) {
    const timed = lrcToLines(lyr.lrc?.lyric, offset);
    if (!timed.length) throw new Error('这首没有带时间的歌词，学歌就别加 --lyrics 了');
    const file = lyricsPath(lyricsJson);
    fs.mkdirSync(TMP, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ lines: timed }, null, 1));
    console.log(
      `\n学歌用的歌词存好了（${timed.length} 句，${timed[0].start}s 开始${offset ? `，挪了 ${offset}s` : ''}）：${file}\n` +
        `学的时候加：--lyrics "${file}"\n` +
        '（时间按网易云原版算；B站 那版前奏长短不一样，就看对不上多少秒，重跑一次加 --offset 秒）',
    );
  }
}

async function anime(when = '今天') {
  const j = await get(`${API.bili}/pgc/web/timeline?types=1&before=${when === '这周' ? 6 : 0}&after=0`, { Referer: 'https://www.bilibili.com/' });
  const days = (j.result || []).slice(when === '这周' ? 0 : -1);
  const out = [];
  for (const d of days) {
    for (const e of d.episodes || []) out.push(`${d.date} ${e.pub_time || ''} ${e.title} ${e.pub_index || ''}${tag('anime', e.season_id)}  (season ${e.season_id})`);
  }
  console.log(out.length ? `B站新番（${when}更新的）：\n${out.slice(-30).join('\n')}\n（想看哪部：anime-watch season_id）` : `${when}没新番更新`);
}

async function animeRank() {
  const j = await get(`${API.bili}/pgc/web/rank/list?day=3&season_type=1`, { Referer: 'https://www.bilibili.com/' });
  const out = (j.result?.list || []).slice(0, 20).map((x, i) => `${i + 1}. ${x.title} ${x.new_ep?.index_show || ''}${x.rating ? ` · ${x.rating}` : ''}${tag('anime', x.season_id)}  (season ${x.season_id})`);
  console.log(`番剧排行（最近三天）：\n${out.join('\n')}`);
}

async function animeWatch(sid) {
  if (!sid) throw new Error('看哪部？anime-watch 后面跟 season_id');
  const H = { Referer: 'https://www.bilibili.com/' };
  const j = await get(`${API.bili}/pgc/view/web/season?season_id=${sid}`, H);
  const r = j.result;
  if (!r) throw new Error('这部没找到');
  let eps = r.episodes || [];
  let note = '';
  if (!eps.length) {
    // 正片这边看不了（地区/版权），退而看预告、花絮
    const sec = (r.section || []).find((x) => (x.episodes || []).length);
    if (sec) {
      eps = sec.episodes;
      note = `（正片这边看不了，只能看${sec.title || '花絮'}）`;
    }
  }
  const ep = eps.at(-1);
  markSeen('anime', sid, r.title);
  const out = [`【${r.title}】${r.rating?.score ? ` 评分 ${r.rating.score}` : ''} · ${r.new_ep?.desc || `${eps.length} 集`}${note}`, `简介：${clip(r.evaluate, 200)}`];
  if (!ep) return console.log(out.join('\n'));
  const idx = /^\d+(\.\d+)?$/.test(String(ep.title || '')) ? `第${ep.title}话 ` : ep.title ? `${ep.title} ` : '';
  out.push(`最新一集：${idx}${ep.long_title || ''}${ep.badge ? `（${ep.badge}）` : ''}`);
  // 弹幕：最新一集刚出可能还没人发，就看上一集的
  for (const e of [ep, eps.at(-2)].filter(Boolean)) {
    try {
      const xml = await (await fetch(`${API.bili}/x/v1/dm/list.so?oid=${e.cid}`, { headers: { 'User-Agent': UA, ...H }, signal: AbortSignal.timeout(20_000) })).text();
      const dm = parseDanmaku(xml);
      if (dm.length < 5) continue;
      const top = topDanmaku(dm, 8);
      out.push(`${e === ep ? '这一集' : '上一集'}弹幕刷得最多：${top.map(([t, c]) => `${t}×${c}`).join('、') || '（没刷屏的）'}`);
      out.push(`随便几条弹幕：${dm.filter((_, i) => i % Math.max(1, Math.floor(dm.length / 10)) === 0).slice(0, 10).map((d) => d.text).join(' / ')}`);
      break;
    } catch {}
  }
  try {
    const rp = await get(`${API.bili}/x/v2/reply/main?oid=${ep.aid}&type=1&mode=3`, H);
    const hot = (rp.data?.replies || []).slice(0, 5).map((x) => `- (${x.like}赞) ${clip(x.content?.message, 100)}`);
    if (hot.length) out.push(`这一集的热评：\n${hot.join('\n')}`);
  } catch {}
  out.push('（番剧画面大多要会员，就不看画面了）');
  console.log(out.join('\n'));
}

function showSeen() {
  const names = { zhihu: '知乎', weibo: '微博', music: '歌', anime: '番' };
  const all = Object.entries(seen).flatMap(([k, list]) => list.slice(0, 8).map((x) => ({ ...x, k })));
  all.sort((a, b) => b.at - a.at);
  console.log(all.length ? `最近看过：\n${all.slice(0, 20).map((x) => `- ${new Date(x.at).toLocaleString('zh-CN', { hour12: false })} [${names[x.k] || x.k}] ${x.title}`).join('\n')}` : '最近没看过啥');
}

const [cmd, ...rest] = process.argv.slice(2);
// 带值的选项（--lyrics-json 文件、--offset 秒）的值不算进歌名
const VALUE_OPTS = new Set(['--lyrics-json', '--offset']);
const opt = (name) => {
  const i = rest.indexOf(name);
  return i >= 0 && rest[i + 1] !== undefined && !rest[i + 1].startsWith('--') ? rest[i + 1] : undefined;
};
const positional = rest.filter((a, i) => !a.startsWith('--') && !VALUE_OPTS.has(rest[i - 1]));
try {
  if (cmd === 'zhihu') await zhihu(Number(positional[0]) || 15);
  else if (cmd === 'weibo') await weibo(Number(positional[0]) || 20);
  else if (cmd === 'music') await music(positional[0] || '飙升');
  else if (cmd === 'song') {
    const lj = rest.includes('--lyrics-json') ? opt('--lyrics-json') || 'lyrics.json' : '';
    await song(positional.join(' '), { lyricsJson: lj, offset: Number(opt('--offset')) || 0 });
  }
  else if (cmd === 'anime') await anime(positional[0] || '今天');
  else if (cmd === 'anime-rank') await animeRank();
  else if (cmd === 'anime-watch') await animeWatch(positional[0]);
  else if (cmd === 'seen') showSeen();
  else {
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^#!.*\n\/\*\*?/, '').replace(/^ \* ?/gm, '').trim());
    process.exit(cmd ? 1 : 0);
  }
} catch (err) {
  console.log(`没刷成：${err.message}`);
  process.exit(1);
}
