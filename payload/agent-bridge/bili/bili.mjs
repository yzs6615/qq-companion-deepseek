#!/usr/bin/env node
/**
 * 刷 B站：不用手机，直接走 B站网页接口。默认不登录（buvid + wbi 签名），
 * .env 里有 BILIBILI_SESSDATA 时能读 AI 字幕。
 *
 *   node agent-bridge/bili/bili.mjs hot [条数]                  热门
 *   node agent-bridge/bili/bili.mjs rank [条数]                 全站排行
 *   node agent-bridge/bili/bili.mjs search 关键词 [--n 8] [--order click|pubdate]
 *   node agent-bridge/bili/bili.mjs watch BV号或链接 [--listen 3] [--frames]
 *        看一个视频：简介、标签、字幕（登录才有）、弹幕刷得最多的、热评；
 *        --listen N：没字幕时下载音轨用本地 Whisper 听前 N 分钟（慢，十几秒到一分钟）
 *        --frames [N]：挑弹幕最密的时刻 + 换镜头的地方 + 均匀铺开截图，去掉重复镜头，
 *          每 9 格拼一张（不写 N 就按时长：≤3 分钟 9 帧，≤10 分钟 18，再长 27），再用 read_image 看
 *   node agent-bridge/bili/bili.mjs seen [条数]                 最近看过的
 *
 * B站风控（412 / -352 / -412）时不硬刷：记 15 分钟冷却，期间直接说“歇会”。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { strip, parseDanmaku, topDanmaku, autoFrames, danmakuPeaks, parseSidx } from './lib.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { env } = await import('../config.mjs');
const DATA = path.join(env.BRIDGE_DATA ? path.resolve(env.BRIDGE_DATA) : path.join(ROOT, 'data'), 'bili');
const CACHE = path.join(DATA, 'cache.json');
const SEEN = path.join(DATA, 'seen.json');
const COOLDOWN = path.join(DATA, 'cooldown');
const API = env.BILI_API || 'https://api.bilibili.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const SESSDATA = (env.BILIBILI_SESSDATA || '').trim();

fs.mkdirSync(DATA, { recursive: true });
const readJson = (f, d) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return d;
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class RiskControl extends Error {}
function checkCooldown() {
  const until = Number(readJson(COOLDOWN, 0)) || 0;
  if (until > Date.now()) {
    console.log(`B站说刷太快了（风控），还得歇 ${Math.ceil((until - Date.now()) / 60_000)} 分钟再刷。先干点别的吧。`);
    process.exit(0);
  }
}

// ── 请求：限速 + cookie + wbi 签名 ─────────────────────────────────────────
let cache = readJson(CACHE, {});
let lastReq = 0;
let lastCdn = 0;
function cookie() {
  const parts = [];
  if (cache.buvid3) parts.push(`buvid3=${cache.buvid3}`, `b_nut=${cache.bnut}`);
  if (cache.buvid4) parts.push(`buvid4=${encodeURIComponent(cache.buvid4)}`);
  if (SESSDATA) parts.push(`SESSDATA=${SESSDATA}`);
  return parts.join('; ');
}
async function raw(url, { binary = false, range, cdn = false } = {}) {
  // 接口请求间隔 ≥700ms；视频 CDN 分片可以快一点
  if (cdn) {
    const wait = 120 - (Date.now() - lastCdn);
    lastCdn = Date.now() + Math.max(0, wait);
    if (wait > 0) await sleep(wait);
  } else {
    const wait = 700 - (Date.now() - lastReq);
    if (wait > 0) await sleep(wait);
    lastReq = Date.now();
  }
  const headers = { 'User-Agent': UA, Referer: 'https://www.bilibili.com/', Origin: 'https://www.bilibili.com', Cookie: cookie() };
  if (range) headers.Range = range;
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(binary ? 120_000 : 30_000) });
  if (r.status === 412) throw new RiskControl('412');
  if (binary) return Buffer.from(await r.arrayBuffer());
  return r.text();
}
async function get(pathAndQuery) {
  const text = await raw(pathAndQuery.startsWith('http') ? pathAndQuery : API + pathAndQuery);
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    throw new Error('B站返回的不是 JSON');
  }
  if (j.code === -412 || j.code === -352) throw new RiskControl(String(j.code));
  if (j.code !== 0) throw new Error(`B站：${j.message || j.code}`);
  return j.data;
}
async function ensureSession() {
  const fresh = cache.at && Date.now() - cache.at < 12 * 3600_000;
  if (fresh && cache.buvid3 && cache.mixin) return;
  try {
    const spi = await get('/x/frontend/finger/spi');
    Object.assign(cache, { buvid3: spi.b_3, buvid4: spi.b_4, bnut: Math.floor(Date.now() / 1000) });
  } catch (err) {
    if (err instanceof RiskControl) throw err;
  }
  // nav 没登录时 code=-101，但 wbi_img 照样给
  const text = await raw(API + '/x/web-interface/nav');
  const nav = JSON.parse(text).data;
  const key = (u) => u.split('/').pop().split('.')[0];
  const rawKey = key(nav.wbi_img.img_url) + key(nav.wbi_img.sub_url);
  const TAB = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52];
  cache.mixin = TAB.map((i) => rawKey[i]).join('').slice(0, 32);
  cache.at = Date.now();
  fs.writeFileSync(CACHE, JSON.stringify(cache));
}
function wbi(params) {
  const p = { ...params, wts: Math.floor(Date.now() / 1000) };
  const q = Object.keys(p)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(p[k]).replace(/[!'()*]/g, ''))}`)
    .join('&');
  return `${q}&w_rid=${crypto.createHash('md5').update(q + cache.mixin).digest('hex')}`;
}

// ── 格式化 ───────────────────────────────────────────────────────────────
const num = (n) => (n >= 1e8 ? `${(n / 1e8).toFixed(1)}亿` : n >= 1e4 ? `${(n / 1e4).toFixed(1)}万` : String(n ?? 0));
const dur = (s) => {
  s = Number(s) || 0;
  return s >= 3600 ? `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const date = (ts) => {
  const d = new Date(ts * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const seenList = () => readJson(SEEN, []);
const seenSet = () => new Set(seenList().map((s) => s.bvid));
function listLine(v, i, seen) {
  const tag = seen.has(v.bvid) ? '（看过）' : '';
  // 搜索接口的时长是 "3:6" 这种字符串
  const d = typeof v.duration === 'number' ? v.duration : String(v.duration || '0').split(':').reduce((s, x) => s * 60 + Number(x || 0), 0);
  return `${i + 1}. ${strip(v.title)}${tag}\n   ${v.bvid} · UP ${v.owner?.name ?? v.author ?? '?'} · 播放 ${num(v.stat?.view ?? v.play)} · ${dur(d)}`;
}

// ── 命令 ─────────────────────────────────────────────────────────────────
async function hot(n = 10) {
  const data = await get(`/x/web-interface/popular?ps=${Math.min(n, 20)}&pn=1`);
  const seen = seenSet();
  console.log(`B站热门：\n${data.list.map((v, i) => listLine(v, i, seen)).join('\n')}`);
}
async function rank(n = 10) {
  const data = await get('/x/web-interface/ranking/v2?' + wbi({ rid: 0, type: 'all' }));
  const seen = seenSet();
  console.log(`全站排行：\n${data.list.slice(0, n).map((v, i) => listLine(v, i, seen)).join('\n')}`);
}
async function search(keyword, n = 8, order = 'totalrank') {
  if (!keyword) throw new Error('搜啥？search 后面跟关键词');
  const data = await get('/x/web-interface/wbi/search/type?' + wbi({ search_type: 'video', keyword, order, page: 1 }));
  const list = (data.result || []).slice(0, n);
  const seen = seenSet();
  console.log(list.length ? `搜「${keyword}」：\n${list.map((v, i) => listLine(v, i, seen)).join('\n')}` : `搜「${keyword}」啥也没有`);
}

/** 用本地 Whisper 听前 minutes 分钟（下载最低码率音轨的一部分）。 */
async function listen(bvid, cid, minutes) {
  const pu = await get('/x/player/wbi/playurl?' + wbi({ bvid, cid, fnval: 16, fourk: 0 }));
  const audio = (pu.dash?.audio || []).sort((a, b) => a.bandwidth - b.bandwidth)[0];
  if (!audio) return '';
  const bytes = Math.ceil((audio.bandwidth / 8) * minutes * 60 * 1.1) + 200_000;
  const buf = await raw(audio.baseUrl || audio.base_url, { binary: true, range: `bytes=0-${bytes}` });
  const file = path.join(DATA, `listen-${bvid}.m4a`);
  fs.writeFileSync(file, buf);
  try {
    const py = spawnSync(env.PYTHON || 'python', [path.join(ROOT, 'live', 'phone_live.py'), 'asr', file, '--model', 'base'], {
      encoding: 'utf8',
      timeout: 10 * 60_000,
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    const last = (py.stdout || '').trim().split(/\r?\n/).pop() || '';
    try {
      return JSON.parse(last).text || '';
    } catch {
      return '';
    }
  } finally {
    fs.rmSync(file, { force: true });
  }
}

/**
 * 看画面：按弹幕高峰 + 均匀铺开挑分片，只下这些 5 秒的小段（整段视频都能覆盖到，总共不超过 ~25MB），
 * 交给 frames.py 在每段里找换镜头的那一帧、去掉重复镜头，拼成每张 9 格的图。
 */
async function frames(bvid, cid, n, duration, dm) {
  const pu = await get('/x/player/wbi/playurl?' + wbi({ bvid, cid, fnval: 16, fourk: 0 }));
  const videos = pu.dash?.video || [];
  const pick = videos.filter((v) => v.codecid === 7).sort((a, b) => a.bandwidth - b.bandwidth)[0] || videos.sort((a, b) => a.bandwidth - b.bandwidth)[0];
  if (!pick) return null;
  const url = pick.baseUrl || pick.base_url;
  const seg = pick.segment_base || pick.SegmentBase || {};
  const [, initEnd] = String(seg.initialization || seg.Initialization || '').split('-').map(Number);
  const [idxStart, idxEnd] = String(seg.index_range || seg.indexRange || '').split('-').map(Number);
  const peaks = danmakuPeaks(dm, duration, Math.ceil(n / 2));
  const work = path.join(DATA, `work-${bvid}`);
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });
  const segments = [];
  let partial = false;
  try {
    const head = Number.isFinite(idxEnd) ? await raw(url, { binary: true, range: `bytes=0-${idxEnd}`, cdn: true }) : null;
    const refs = head && Number.isFinite(initEnd) ? parseSidx(head, idxStart) : null;
    if (refs?.length) {
      const init = head.subarray(0, initEnd + 1);
      const chosen = new Map(); // ref 下标 → 段信息
      const at = (t) => Math.max(0, refs.findIndex((r) => t >= r.start && t < r.end));
      for (const p of peaks) {
        const i = at(p.t);
        if (!chosen.has(i)) chosen.set(i, { kind: 'peak', target: p.t, note: p.words.join('、') });
      }
      // 均匀铺开：段数是帧数的两倍，给“找换镜头”留挑选余地
      const even = Math.min(refs.length, n * 2);
      for (let k = 0; k < even; k++) {
        const i = Math.min(refs.length - 1, Math.floor(((k + 0.5) * refs.length) / even));
        if (!chosen.has(i)) chosen.set(i, { kind: 'even' });
      }
      // 控制下载量：超过 25MB 就从均匀段里匀着去掉
      const budget = 25 * 1024 * 1024;
      let list = [...chosen.entries()].sort((a, b) => a[0] - b[0]);
      const size = (l) => l.reduce((s, [i]) => s + refs[i].to - refs[i].from + 1, 0);
      while (size(list) > budget && list.some(([, s]) => s.kind === 'even')) {
        const evens = list.filter(([, s]) => s.kind === 'even');
        const drop = new Set(evens.filter((_, j) => j % 2 === 1).map(([i]) => i));
        if (!drop.size) drop.add(evens[0][0]);
        list = list.filter(([i]) => !drop.has(i));
      }
      // 并发 4 个下载
      let next = 0;
      await Promise.all(
        Array.from({ length: 4 }, async () => {
          while (next < list.length) {
            const [i, s] = list[next++];
            const r = refs[i];
            const body = await raw(url, { binary: true, range: `bytes=${r.from}-${r.to}`, cdn: true });
            const file = path.join(work, `seg-${i}.m4s`);
            fs.writeFileSync(file, Buffer.concat([init, body]));
            segments.push({ file, start: r.start, end: r.end, ...s });
          }
        }),
      );
    } else {
      // 没有索引：退回老办法，从头下一段
      const cap = 30 * 1024 * 1024;
      const buf = await raw(url, { binary: true, range: `bytes=0-${cap}`, cdn: true });
      const span = Math.min(duration, buf.length >= cap ? (cap * 8) / pick.bandwidth : duration);
      partial = span < duration;
      const file = path.join(work, 'whole.m4s');
      fs.writeFileSync(file, buf);
      segments.push({ file, start: 0, end: span, kind: 'whole' });
      for (const p of peaks) if (p.t < span) segments.push({ file, start: Math.max(0, p.t - 2.5), end: p.t + 2.5, kind: 'peak', target: p.t, note: p.words.join('、') });
    }
    const dir = path.join(DATA, 'frames');
    const plan = path.join(work, 'plan.json');
    fs.writeFileSync(plan, JSON.stringify({ segments, max: n, duration, out: path.join(dir, bvid) }));
    const py = spawnSync(env.PYTHON || 'python', [path.join(ROOT, 'bili', 'frames.py'), plan], {
      encoding: 'utf8',
      timeout: 5 * 60_000,
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    const last = (py.stdout || '').trim().split(/\r?\n/).pop() || '';
    let res;
    try {
      res = JSON.parse(last);
    } catch {
      return null;
    }
    // 只留最近 30 张
    const old = fs.readdirSync(dir).map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t).slice(30);
    for (const o of old) fs.rmSync(path.join(dir, o.f), { force: true });
    return { ...res, partial, peaks };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

async function watch(target, listenMin = 0, frameCount = 0) {
  const bvid = (String(target || '').match(/BV[0-9A-Za-z]{10}/) || [])[0];
  if (!bvid) throw new Error('看哪个？watch 后面跟 BV 号或链接');
  const v = await get('/x/web-interface/wbi/view?' + wbi({ bvid }));
  const lines = [];
  lines.push(`【${strip(v.title)}】`);
  lines.push([`UP ${v.owner?.name}`, `播放 ${num(v.stat.view)}`, `弹幕 ${num(v.stat.danmaku)}`, `点赞 ${num(v.stat.like)}`, `投币 ${num(v.stat.coin)}`, `时长 ${dur(v.duration)}`, date(v.pubdate), v.tname].filter(Boolean).join(' · '));
  const desc = strip(v.desc).replace(/\s+/g, ' ').trim();
  if (desc && desc !== '-') lines.push(`简介：${desc.slice(0, 300)}${desc.length > 300 ? '…' : ''}`);
  lines.push(`链接：https://www.bilibili.com/video/${bvid}`);

  let tags = [];
  try {
    tags = (await get(`/x/tag/archive/tags?bvid=${bvid}`)).map((t) => t.tag_name);
  } catch (err) {
    if (err instanceof RiskControl) throw err;
  }
  if (tags.length) lines.push(`标签：${tags.slice(0, 10).join('、')}`);

  // 字幕：登录才有；没有就看要不要“听”
  let words = '';
  let wordsFrom = '';
  try {
    const pl = await get('/x/player/wbi/v2?' + wbi({ bvid, cid: v.cid }));
    const subs = pl.subtitle?.subtitles || [];
    const sub = subs.find((s) => /zh/.test(s.lan)) || subs[0];
    if (sub?.subtitle_url) {
      const url = sub.subtitle_url.startsWith('//') ? `https:${sub.subtitle_url}` : sub.subtitle_url;
      const body = JSON.parse(await raw(url)).body || [];
      words = body.map((b) => b.content).join('，');
      wordsFrom = '字幕';
    }
  } catch (err) {
    if (err instanceof RiskControl) throw err;
  }
  if (!words && listenMin > 0) {
    words = await listen(bvid, v.cid, listenMin);
    wordsFrom = `听了前 ${listenMin} 分钟`;
  }
  if (words) lines.push(`${wordsFrom}：${words.slice(0, 2500)}${words.length > 2500 ? '…' : ''}`);
  else lines.push(SESSDATA ? '（这个视频没字幕；想知道讲了啥可以加 --listen 3 听一下）' : '（没登录看不到字幕；想知道讲了啥可以加 --listen 3 听一下）');
  let dm = [];
  try {
    dm = parseDanmaku(await raw(`${API}/x/v1/dm/list.so?oid=${v.cid}`));
  } catch (err) {
    if (err instanceof RiskControl) throw err;
  }

  if (frameCount) {
    const n = frameCount === 'auto' ? autoFrames(v.duration) : frameCount;
    const f = await frames(bvid, v.cid, n, v.duration, dm);
    if (f?.sheets?.length) {
      const why = { peak: '弹幕高峰', cut: '换镜头', even: '' };
      lines.push(`画面：挑了 ${f.frames.length} 帧（弹幕最密的时刻 + 换镜头的地方 + 均匀铺开，重复镜头去掉了），拼成 ${f.sheets.length} 张图，每格左上角是时间${f.partial ? '；视频太长只看了前面一段' : ''}。用 read_image 一张张看：`);
      for (const s of f.sheets) lines.push(`  ${s}`);
      lines.push(`  时间轴：${f.frames.map((x) => `[${dur(Math.floor(x.t))}]${why[x.kind] || ''}${x.note ? `（${x.note}）` : ''}`).join(' ')}`);
    } else lines.push('（画面没抓到）');
  } else {
    lines.push('（想看画面可以加 --frames，会挑弹幕最密的时刻和换镜头的地方截图）');
  }

  try {
    if (dm.length) {
      const top = topDanmaku(dm);
      if (top.length) lines.push(`弹幕刷得最多：${top.map(([t, c]) => `${t}×${c}`).join('、')}`);
      const sample = dm.filter((_, i) => i % Math.max(1, Math.floor(dm.length / 12)) === 0).slice(0, 12).sort((a, b) => a.t - b.t);
      lines.push(`随便几条弹幕：${sample.map((d) => `[${dur(Math.floor(d.t))}]${d.text}`).join(' / ')}`);
    }
  } catch {
    /* 弹幕统计出错不影响别的 */
  }

  try {
    const rp = await get('/x/v2/reply/wbi/main?' + wbi({ oid: v.aid, type: 1, mode: 3, plat: 1 }));
    const hotReplies = (rp.replies || []).slice(0, 6).map((r) => `- (${num(r.like)}赞) ${strip(r.content?.message).replace(/\s+/g, ' ').slice(0, 120)}`);
    if (hotReplies.length) lines.push(`热评：\n${hotReplies.join('\n')}`);
  } catch (err) {
    if (err instanceof RiskControl) throw err;
  }

  const seen = seenList().filter((s) => s.bvid !== bvid);
  seen.unshift({ bvid, title: strip(v.title), up: v.owner?.name, at: Date.now() });
  fs.writeFileSync(SEEN, JSON.stringify(seen.slice(0, 300)));
  console.log(lines.join('\n'));
}

function showSeen(n = 10) {
  const list = seenList().slice(0, n);
  console.log(list.length ? `最近看过：\n${list.map((s) => `- ${new Date(s.at).toLocaleString('zh-CN', { hour12: false })} ${s.title}（${s.bvid}，UP ${s.up}）`).join('\n')}` : '最近没看过啥');
}

// ── main ─────────────────────────────────────────────────────────────────
const [cmd, ...rest] = process.argv.slice(2);
const opt = (name, d) => {
  const i = rest.indexOf(name);
  return i >= 0 && rest[i + 1] !== undefined ? rest[i + 1] : d;
};
const positional = rest.filter((a, i) => !a.startsWith('--') && !(i > 0 && rest[i - 1].startsWith('--')));

if (cmd === 'seen') {
  showSeen(Number(positional[0]) || 10);
  process.exit(0);
}
if (!['hot', 'rank', 'search', 'watch'].includes(cmd)) {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^#!.*\n\/\*\*?/, '').replace(/^ \* ?/gm, '').trim());
  process.exit(cmd ? 1 : 0);
}
checkCooldown();
try {
  await ensureSession();
  if (cmd === 'hot') await hot(Number(positional[0]) || 10);
  else if (cmd === 'rank') await rank(Number(positional[0]) || 10);
  else if (cmd === 'search') await search(positional.join(' '), Number(opt('--n', 8)), opt('--order', 'totalrank'));
  else if (cmd === 'watch') {
    // --frames 不带数字 = 按时长自动（9 / 18 / 27 帧）；带数字最多 27
    const fi = rest.indexOf('--frames');
    const fn = fi >= 0 ? Number(rest[fi + 1]) : 0;
    const frameCount = fi < 0 ? 0 : fn > 0 ? Math.min(27, fn) : 'auto';
    await watch(positional[0], Math.min(10, Number(opt('--listen', 0)) || 0), frameCount);
  }
} catch (err) {
  if (err instanceof RiskControl) {
    fs.writeFileSync(COOLDOWN, String(Date.now() + 15 * 60_000));
    console.log('B站说刷太快了（风控），先歇 15 分钟再刷。先干点别的吧。');
    process.exit(0);
  }
  console.log(`刷 B站出错：${err.message}`);
  process.exit(1);
}
