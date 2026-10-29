#!/usr/bin/env node
/**
 * 日记网页：把 data/journal/ 里的日记和每天的聊天流水做成一个本地网页（data/journal.html），
 * 选日期看那天的日记、跟谁聊了啥、当天的聊天原文。只在本机打开，含聊天内容，别发给别人。
 *
 *   node scripts/journal-view.mjs              # 生成并用浏览器打开
 *   node scripts/journal-view.mjs --no-open    # 只生成
 *   node scripts/journal-view.mjs --out x.html
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
// 数据目录跟内核一样（BRIDGE_DATA，没有就是 <COMPANION_HOME>/data；装进 DSH 后单独跑也找得到），见 home.mjs；它要排在 config.mjs 前面
import { dataDir } from './home.mjs';
import { cfg, env } from '../config.mjs';

const argv = process.argv.slice(2);
const DATA_DIR = dataDir(env);
const JDIR = path.join(DATA_DIR, 'journal');
const RAW = path.join(JDIR, 'raw');
const oi = argv.indexOf('--out');
const out = oi >= 0 ? path.resolve(argv[oi + 1]) : path.join(DATA_DIR, 'journal.html');

const readJson = (f) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
};
const list = (dir, re) => {
  try {
    return fs.readdirSync(dir).filter((f) => re.test(f));
  } catch {
    return [];
  }
};
// “小明(10001)” → “小明”；群里的聊天编号 g群:u人
const nameOf = (who, k) => String(who || '').replace(/\(\d+\)$/, '').trim() || k;

const days = {};
const day = (d) => (days[d] ||= { diary: null, chats: {} });
for (const f of list(JDIR, /^\d{4}-\d{2}-\d{2}\.json$/)) {
  const j = readJson(path.join(JDIR, f));
  if (j) day(f.slice(0, 10)).diary = { day: j.day || '', with: j.with || {}, at: j.at || 0 };
}
const names = {};
for (const f of list(RAW, /^\d{4}-\d{2}-\d{2}\.jsonl$/)) {
  const d = day(f.slice(0, 10));
  let lines = [];
  try {
    lines = fs.readFileSync(path.join(RAW, f), 'utf8').split('\n').filter(Boolean);
  } catch {}
  for (const l of lines) {
    let r;
    try {
      r = JSON.parse(l);
    } catch {
      continue;
    }
    if (!r?.k) continue;
    names[r.k] = nameOf(r.who, r.k);
    (d.chats[r.k] ||= []).push({ t: r.t || 0, u: r.u || '', a: r.a || '' });
  }
}
const dates = Object.keys(days).sort();
const payload = JSON.stringify({ name: cfg.botName, dates, days, names }).replace(/</g, '\\u003c');

const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${String(cfg.botName).replace(/</g, '&lt;')} 的日记</title>
<style>
:root{--bg:#fafafb;--card:#fff;--ink:#1f2328;--mute:#6e7681;--line:#d0d7de;--accent:#1aaa62;--soft:#eef7f1;--mark:#fff3b0}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--card:#161b22;--ink:#e6edf3;--mute:#8b949e;--line:#30363d;--accent:#3fb950;--soft:#12261b;--mark:#5a4a00}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.7 "Microsoft YaHei UI","Segoe UI",sans-serif}
header{position:sticky;top:0;z-index:2;background:var(--bg);border-bottom:1px solid var(--line);padding:12px 16px}
.bar{max-width:980px;margin:0 auto;display:flex;flex-wrap:wrap;gap:8px;align-items:center}
h1{font-size:18px;margin:0 12px 0 0}
input,button{font:inherit;color:inherit;background:var(--card);border:1px solid var(--line);border-radius:8px;padding:5px 10px}
button{cursor:pointer}button:disabled{opacity:.4;cursor:default}
#q{flex:1;min-width:140px}
.wrap{max-width:980px;margin:0 auto;display:grid;grid-template-columns:200px 1fr;gap:16px;padding:16px}
@media (max-width:720px){.wrap{grid-template-columns:1fr}#side{max-height:180px}}
#side{border:1px solid var(--line);border-radius:10px;background:var(--card);overflow:auto;max-height:calc(100vh - 110px);position:sticky;top:76px}
#side a{display:flex;justify-content:space-between;padding:6px 12px;color:inherit;text-decoration:none;border-bottom:1px solid var(--line);font-size:14px}
#side a.on{background:var(--soft);font-weight:600}
#side a .tag{color:var(--mute);font-size:12px}
#side .month{padding:8px 12px 4px;color:var(--mute);font-size:12px;border-bottom:1px solid var(--line)}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px 18px;margin-bottom:14px}
.date{font-size:22px;font-weight:700;margin:0 0 2px}
.sub{color:var(--mute);font-size:13px;margin-bottom:12px}
.diary{font-size:16px;white-space:pre-wrap}
.none{color:var(--mute)}
h2{font-size:15px;margin:0 0 10px}
.with{display:grid;grid-template-columns:auto 1fr;gap:6px 14px}
.with b{white-space:nowrap}
details{border-top:1px solid var(--line);padding:8px 0}
details:first-of-type{border-top:0}
summary{cursor:pointer;font-weight:600}
summary span{color:var(--mute);font-weight:400;font-size:13px}
.msg{display:grid;grid-template-columns:48px 1fr;gap:2px 10px;padding:6px 0 0;font-size:14px}
.msg .t{color:var(--mute);font-size:12px;padding-top:2px}
.msg .u{grid-column:2}.msg .a{grid-column:2;color:var(--accent)}
mark{background:var(--mark);color:inherit;border-radius:3px}
.empty{color:var(--mute);text-align:center;padding:60px 0}
</style></head><body>
<header><div class="bar">
<h1 id="title"></h1>
<button id="prev" title="前一天">‹</button><input type="date" id="pick"><button id="next" title="后一天">›</button>
<button id="latest">最新</button>
<input id="q" type="search" placeholder="搜日记和聊天…">
</div></header>
<div class="wrap"><nav id="side"></nav><main id="main"></main></div>
<script id="data" type="application/json">${payload}</script>
<script>
const D = JSON.parse(document.getElementById('data').textContent);
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const WEEK = '日一二三四五六';
const wk = (d) => '周' + WEEK[new Date(d + 'T00:00:00').getDay()];
const who = (k) => D.names[k] || (k.startsWith('g') ? '群里 ' + k : k);
const hm = (t) => { if (!t) return ''; const x = new Date(t); return String(x.getHours()).padStart(2, '0') + ':' + String(x.getMinutes()).padStart(2, '0'); };
let q = '';
const hl = (s) => { const e = esc(s); if (!q) return e; const re = new RegExp(q.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&'), 'gi'); return e.replace(re, (m) => '<mark>' + m + '</mark>'); };
function hits(d) {
  if (!q) return true;
  const x = D.days[d]; const low = q.toLowerCase();
  const has = (s) => String(s || '').toLowerCase().includes(low);
  if (x.diary && (has(x.diary.day) || Object.values(x.diary.with || {}).some(has))) return true;
  return Object.entries(x.chats || {}).some(([k, ms]) => has(who(k)) || ms.some((m) => has(m.u) || has(m.a)));
}
function shown() { return D.dates.filter(hits); }
function side(cur) {
  let html = '', month = '';
  for (const d of shown().slice().reverse()) {
    const m = d.slice(0, 7);
    if (m !== month) { month = m; html += '<div class="month">' + m.replace('-', ' 年 ') + ' 月</div>'; }
    const x = D.days[d]; const n = Object.keys(x.chats || {}).length;
    html += '<a href="#' + d + '" data-d="' + d + '" class="' + (d === cur ? 'on' : '') + '"><span>' + d.slice(5) + ' ' + wk(d) + '</span><span class="tag">' + (x.diary ? '日记' : '') + (n ? ' · ' + n + '人' : '') + '</span></a>';
  }
  $('side').innerHTML = html || '<div class="month">没有符合的日子</div>';
  const on = $('side').querySelector('.on'); if (on) on.scrollIntoView({ block: 'nearest' });
}
function show(d) {
  const list = D.dates;
  if (!list.length) { $('main').innerHTML = '<div class="empty">还没有日记。聊过天之后，每天 23 点后会写一篇。</div>'; side(''); return; }
  if (!D.days[d]) { const after = list.find((x) => x >= d); d = after || list[list.length - 1]; }
  const x = D.days[d];
  $('pick').value = d;
  const i = list.indexOf(d);
  $('prev').disabled = i <= 0; $('next').disabled = i >= list.length - 1;
  let html = '<div class="card"><div class="date">' + d.slice(0, 4) + ' 年 ' + Number(d.slice(5, 7)) + ' 月 ' + Number(d.slice(8)) + ' 日 · ' + wk(d) + '</div>';
  html += '<div class="sub">' + (x.diary && x.diary.at ? '写于 ' + new Date(x.diary.at).toLocaleString('zh-CN', { hour12: false }) : '') + '</div>';
  html += x.diary && x.diary.day ? '<div class="diary">' + hl(x.diary.day) + '</div>' : '<div class="none">这天没写日记（还没到睡前，或者那天没写成）。下面是当天的聊天。</div>';
  html += '</div>';
  const w = Object.entries((x.diary && x.diary.with) || {});
  if (w.length) html += '<div class="card"><h2>跟谁聊了啥</h2><div class="with">' + w.map(([k, t]) => '<b>' + esc(who(k)) + '</b><span>' + hl(t) + '</span>').join('') + '</div></div>';
  const chats = Object.entries(x.chats || {});
  if (chats.length) {
    html += '<div class="card"><h2>当天的聊天</h2>';
    for (const [k, ms] of chats) {
      const open = q && ms.some((m) => (m.u + m.a).toLowerCase().includes(q.toLowerCase()));
      html += '<details' + (open || chats.length === 1 ? ' open' : '') + '><summary>' + esc(who(k)) + ' <span>' + ms.length + ' 轮</span></summary>';
      for (const m of ms) html += '<div class="msg"><span class="t">' + hm(m.t) + '</span>' + (m.u ? '<span class="u">' + hl(m.u) + '</span>' : '') + (m.a ? '<span class="a">' + hl(m.a) + '</span>' : '') + '</div>';
      html += '</details>';
    }
    html += '</div>';
  }
  $('main').innerHTML = html;
  side(d);
  try { if (location.hash.slice(1) !== d) history.replaceState(null, '', '#' + d); } catch {}
}
const cur = () => $('pick').value;
$('title').textContent = D.name + ' 的日记';
if (D.dates.length) { $('pick').min = D.dates[0]; $('pick').max = D.dates[D.dates.length - 1]; }
$('pick').addEventListener('change', () => show(cur()));
$('prev').addEventListener('click', () => { const l = shown(); const i = l.indexOf(cur()); show(l[Math.max(0, i - 1)] || l[0]); });
$('next').addEventListener('click', () => { const l = shown(); const i = l.indexOf(cur()); show(l[Math.min(l.length - 1, i + 1)] || l[l.length - 1]); });
$('latest').addEventListener('click', () => show(D.dates[D.dates.length - 1]));
$('q').addEventListener('input', (e) => { q = e.target.value.trim(); const l = shown(); show(l.includes(cur()) ? cur() : (l[l.length - 1] || cur())); });
window.addEventListener('hashchange', () => show(location.hash.slice(1)));
$('side').addEventListener('click', (e) => { const a = e.target.closest('a[data-d]'); if (!a) return; e.preventDefault(); show(a.dataset.d); });
document.addEventListener('keydown', (e) => { if (e.target.tagName === 'INPUT') return; if (e.key === 'ArrowLeft') $('prev').click(); if (e.key === 'ArrowRight') $('next').click(); });
show(location.hash.slice(1) || D.dates[D.dates.length - 1] || '');
</script>
</body></html>`;

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, html);
console.log(`已生成：${out}（${dates.length} 天）`);
if (!argv.includes('--no-open') && process.platform === 'win32') {
  spawn('cmd.exe', ['/c', 'start', '', out], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}
