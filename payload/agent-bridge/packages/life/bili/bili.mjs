#!/usr/bin/env node
/**
 * 刷 B站：不用手机，直接走 B站网页接口。默认不登录（buvid + wbi 签名），
 * .env 里有 BILIBILI_SESSDATA 时能读 AI 字幕。
 *
 *   node bili/bili.mjs hot [条数]                  热门
 *   node bili/bili.mjs rank [条数]                 全站排行
 *   node bili/bili.mjs search 关键词 [--n 8] [--order click|pubdate]
 *   node bili/bili.mjs watch BV号或链接 [--listen 3] [--frames]
 *        看一个视频：简介、标签、字幕（登录才有）、弹幕刷得最多的、热评；b23.tv 短链也认（自己跟一次跳转）
 *        --listen N：没字幕时下载音轨用本地 Whisper 听前 N 分钟（最多 3 分钟，慢，十几秒到一分钟；只用本地模型，没有就说没听成）
 *        --frames [N]：挑弹幕最密的时刻 + 换镜头的地方 + 均匀铺开截图，去掉重复镜头，
 *          每 9 格拼一张（不写 N 就按时长：≤3 分钟 9 帧，≤10 分钟 18，再长 27），再用 read_image 看
 *   node bili/bili.mjs pics BV号或链接 [--n 12]     评论区里大家发的图（主要逛 DeepSeek 二创）：按赞数挑，下成小图，
 *        动图不大就要原图；存 <数据目录>/bili/pics/<BV号>/，用 read_image 看
 *   node bili/bili.mjs keep 图片路径 情绪 一句话描述   把 pics 下的一张收进表情包（情绪：开心/无语/生气/卖萌/得意/委屈/震惊）
 *   node bili/bili.mjs seen [条数]                 最近看过的
 *
 * B站风控（412 / -352 / -412）时不硬刷：记 15 分钟冷却，期间直接说“歇会”。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { strip, parseDanmaku, topDanmaku, autoFrames, danmakuPeaks, parseSidx, parseVideoRef, resolveVideoRef } from './lib.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { env, DATA_DIR } = await import('../env.mjs'); // .env、数据目录（插件目录下的 env.mjs）
const DATA = path.join(DATA_DIR, 'bili');
const CACHE = path.join(DATA, 'cache.json');
const SEEN = path.join(DATA, 'seen.json');
const COOLDOWN = path.join(DATA, 'cooldown');
const API = env.BILI_API || 'https://api.bilibili.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const SESSDATA = (env.BILIBILI_SESSDATA || '').trim();
const MAX_LISTEN_MIN = 3;

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
  if (!audio) return { text: '', error: '这个视频没有单独的音轨' };
  const bytes = Math.ceil((audio.bandwidth / 8) * minutes * 60 * 1.1) + 200_000;
  const buf = await raw(audio.baseUrl || audio.base_url, { binary: true, range: `bytes=0-${bytes}` });
  const file = path.join(DATA, `listen-${bvid}.m4a`);
  fs.writeFileSync(file, buf);
  try {
    const py = spawnSync(env.PYTHON || 'python', [path.join(ROOT, 'media', 'asr.py'), file, '--model', 'base'], {
      encoding: 'utf8',
      timeout: 10 * 60_000,
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    const last = (py.stdout || '').trim().split(/\r?\n/).pop() || '';
    let res;
    try {
      res = JSON.parse(last);
    } catch {
      return { text: '', error: py.error ? py.error.message : '识别脚本没给结果' };
    }
    // 没本地模型这类问题 phone_live.py 会写在 error 里（不会去网上下模型）
    return { text: res.text || '', error: res.error || '' };
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
  if (!parseVideoRef(target)) throw new Error('看哪个？watch 后面跟 BV 号或链接（b23.tv 短链也行）');
  // b23.tv 短链：自己跟一次跳转拿到 BV 号
  let ref;
  try {
    ref = await resolveVideoRef(target);
  } catch (err) {
    throw new Error(`短链打不开：${err.message}`);
  }
  if (!ref) throw new Error('这个短链跳过去不是视频，换个 BV 号或完整链接');
  const v = await get('/x/web-interface/wbi/view?' + wbi(ref.bvid ? { bvid: ref.bvid } : { aid: ref.aid }));
  const bvid = v.bvid || ref.bvid;
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
  let heardErr = '';
  if (!words && listenMin > 0) {
    const heard = await listen(bvid, v.cid, listenMin);
    words = heard.text;
    heardErr = heard.error;
    wordsFrom = `听了前 ${listenMin} 分钟`;
  }
  if (words) lines.push(`${wordsFrom}：${words.slice(0, 2500)}${words.length > 2500 ? '…' : ''}`);
  else if (heardErr) lines.push(`（没听成：${heardErr}）`);
  else if (listenMin > 0) lines.push(`（听了前 ${listenMin} 分钟，没听出有人说话）`);
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

// ── 评论区的图（主要逛 DeepSeek 二创）：下成小图给她看，看中的用 keep 收进表情包 ───────────────────────
const PICS = path.join(DATA, 'pics');
const STICKER_DIR = env.STICKER_DIR ? path.resolve(env.STICKER_DIR) : path.join(path.dirname(DATA), 'stickers');
const STICKER_MOODS = ['开心', '无语', '生气', '卖萌', '得意', '委屈', '震惊'];
const KEEP_MAX = Number(env.STEAL_MAX ?? 40); // 跟从聊天里收表情一样：每种情绪最多留这么多张收来的

async function pics(target, n = 12) {
  if (!parseVideoRef(target)) throw new Error('看哪个？pics 后面跟 BV 号或链接（b23.tv 短链也行）');
  let ref;
  try {
    ref = await resolveVideoRef(target);
  } catch (err) {
    throw new Error(`短链打不开：${err.message}`);
  }
  if (!ref) throw new Error('这个短链跳过去不是视频，换个 BV 号或完整链接');
  const v = await get('/x/web-interface/wbi/view?' + wbi(ref.bvid ? { bvid: ref.bvid } : { aid: ref.aid }));
  const bvid = v.bvid || ref.bvid;
  // 热评（带楼中楼）里带图的；最多翻 3 页，同一张图只算一次
  const found = [];
  const srcs = new Set();
  const take = (r) => {
    for (const p of r?.content?.pictures || []) {
      if (!p?.img_src || srcs.has(p.img_src)) continue;
      srcs.add(p.img_src);
      found.push({ src: p.img_src, kb: Number(p.img_size) || 0, like: r.like || 0, text: strip(r.content?.message || '').replace(/\s+/g, ' ').slice(0, 40) });
    }
    for (const sub of r?.replies || []) take(sub);
  };
  let offset = '';
  for (let page = 0; page < 3 && found.length < n; page++) {
    const q = { oid: v.aid, type: 1, mode: 3, plat: 1, ...(offset ? { pagination_str: JSON.stringify({ offset }) } : {}) };
    const rp = await get('/x/v2/reply/wbi/main?' + wbi(q));
    for (const r of [...(rp.top_replies || []), ...(rp.replies || [])]) take(r);
    offset = rp.cursor?.pagination_reply?.next_offset || '';
    if (!offset || rp.cursor?.is_end) break;
  }
  if (!found.length) {
    console.log(`【${strip(v.title)}】评论区里没翻到图，换一个看看`);
    return;
  }
  found.sort((a, b) => b.like - a.like);
  const dir = path.join(PICS, bvid);
  fs.mkdirSync(dir, { recursive: true });
  // 只留最近 20 个视频的图，旧的删掉（都是临时下的小图）
  const old = fs.readdirSync(PICS).map((d) => ({ d, t: fs.statSync(path.join(PICS, d)).mtimeMs })).sort((a, b) => b.t - a.t).slice(20);
  for (const { d } of old) fs.rmSync(path.join(PICS, d), { recursive: true, force: true });
  const lines = [`【${strip(v.title)}】评论区里的图（${bvid}，按赞数排，挑了 ${Math.min(n, found.length)} 张）：`];
  let i = 0;
  for (const p of found.slice(0, n)) {
    i++;
    // 动图不大就要原图（缩了就不动了），别的都要 300 宽的小图，省流量
    const gif = /\.gif$/i.test(p.src) && p.kb > 0 && p.kb < 2048;
    const url = (gif ? p.src : `${p.src}@300w.webp`).replace(/^http:\/\/(i\d\.hdslb\.com)\//, 'https://$1/'); // B站图床给的是 http，换成 https
    const file = path.join(dir, `${String(i).padStart(2, '0')}${gif ? '.gif' : '.webp'}`);
    try {
      const buf = await raw(url, { binary: true, cdn: true });
      if (buf.length < 200) throw new Error('太小');
      fs.writeFileSync(file, buf);
      lines.push(`${i}. ${file}（${Math.max(1, Math.round(buf.length / 1024))}KB，${num(p.like)}赞）${p.text ? ` 配的话：${p.text}` : ''}`);
    } catch (err) {
      if (err instanceof RiskControl) throw err;
      lines.push(`${i}. 没下下来（${err.message}）`);
    }
  }
  lines.push(
    '用 read_image 一张张看。真觉得好玩、以后想拿来斗图的，收进表情包（一次最多收 3 张，宁缺毋滥；截图、长图、广告、看不懂的别收）：',
    `node "${process.argv[1]}" keep 图片完整路径 情绪 一句话描述（画面：什么时候用，20 字以内）   情绪：${STICKER_MOODS.join('/')}`,
  );
  const seen = seenList().filter((s) => s.bvid !== bvid);
  seen.unshift({ bvid, title: strip(v.title), up: v.owner?.name, at: Date.now() });
  fs.writeFileSync(SEEN, JSON.stringify(seen.slice(0, 300)));
  console.log(lines.join('\n'));
}

/** 把 pics 下下来的一张收进表情包：同一张不收两次，每种情绪收来的最多 KEEP_MAX 张（满了扔最早收的），描述写进 index.json。 */
function keep(file, mood, desc = '') {
  if (!STICKER_MOODS.includes(mood)) throw new Error(`情绪只能是：${STICKER_MOODS.join('/')}`);
  const src = path.resolve(String(file || ''));
  if (!src.toLowerCase().startsWith(path.resolve(PICS).toLowerCase() + path.sep) || !fs.existsSync(src)) {
    throw new Error('只能收 pics 下下来的那些图（给完整路径）');
  }
  const buf = fs.readFileSync(src);
  const hash = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 12);
  for (const m of STICKER_MOODS) {
    const d = path.join(STICKER_DIR, m);
    if (fs.existsSync(d) && fs.readdirSync(d).some((f) => f.includes(hash))) {
      console.log('这张早就收过了');
      return;
    }
  }
  const dir = path.join(STICKER_DIR, mood);
  fs.mkdirSync(dir, { recursive: true });
  const mine = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith('learned-'))
    .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => a.t - b.t);
  while (mine.length >= KEEP_MAX) fs.unlinkSync(path.join(dir, mine.shift().f));
  const name = `learned-bili-${hash}${path.extname(src).toLowerCase()}`;
  fs.writeFileSync(path.join(dir, name), buf);
  const d = String(desc || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  if (d) {
    const idxFile = path.join(STICKER_DIR, 'index.json');
    const idx = readJson(idxFile, {});
    idx[`${mood}/${name}`] = { desc: d, at: Date.now() };
    fs.writeFileSync(idxFile + '.tmp', JSON.stringify(idx, null, 1));
    fs.renameSync(idxFile + '.tmp', idxFile);
  }
  console.log(`收好了：${mood}/${name}${d ? `（${d}）` : '（没写描述：按意思挑的时候挑不到它，只有按情绪随便挑时会用上）'}`);
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
if (cmd === 'keep') {
  try {
    keep(positional[0], positional[1], positional.slice(2).join(' '));
  } catch (err) {
    console.log(`没收成：${err.message}`);
    process.exitCode = 1;
  }
  process.exit();
}
if (!['hot', 'rank', 'search', 'watch', 'pics'].includes(cmd)) {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^#!.*\n\/\*\*?/, '').replace(/^ \* ?/gm, '').trim());
  process.exit(cmd ? 1 : 0);
}
checkCooldown();
try {
  await ensureSession();
  if (cmd === 'hot') await hot(Number(positional[0]) || 10);
  else if (cmd === 'rank') await rank(Number(positional[0]) || 10);
  else if (cmd === 'search') await search(positional.join(' '), Number(opt('--n', 8)), opt('--order', 'totalrank'));
  else if (cmd === 'pics') await pics(positional.join(' '), Math.min(20, Number(opt('--n', 12)) || 12));
  else if (cmd === 'watch') {
    // --frames 不带数字 = 按时长自动（9 / 18 / 27 帧）；带数字最多 27
    const fi = rest.indexOf('--frames');
    const fn = fi >= 0 ? Number(rest[fi + 1]) : 0;
    const frameCount = fi < 0 ? 0 : fn > 0 ? Math.min(27, fn) : 'auto';
    // --listen 最多听前 3 分钟：下载 + 本地识别差不多一分来钟，跟看直播一次最多 90 秒一个意思，再长这轮聊天就等太久了
    const want = Number(opt('--listen', 0)) || 0;
    const listenMin = Math.min(MAX_LISTEN_MIN, Math.max(0, want));
    if (want > MAX_LISTEN_MIN) console.log(`（一次最多听前 ${MAX_LISTEN_MIN} 分钟，--listen ${want} 按 ${MAX_LISTEN_MIN} 算）`);
    await watch(positional.join(' '), listenMin, frameCount);
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
