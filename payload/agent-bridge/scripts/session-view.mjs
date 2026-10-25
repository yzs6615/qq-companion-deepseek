#!/usr/bin/env node
/**
 * 看机器人的“上下文 + 思考过程”：把 DSH 的会话存档（session.v4.jsonl.zstd）渲染成一页本地 HTML。
 *
 *   node scripts/session-view.mjs                  # 最近活跃的那个聊天
 *   node scripts/session-view.mjs u12345678        # 指定聊天（data/sessions.json 里的 key）
 *   node scripts/session-view.mjs session-xxxx     # 直接指定会话 id
 *   node scripts/session-view.mjs --list           # 列出所有聊天和会话文件
 *   选项：--last N（默认 15 轮）  --all（全部轮次）  --no-open（只生成不打开）
 *         --out <文件>  --no-redact（不打码，默认会遮掉 API Key / PIN / token 一类的值）
 *
 * 全程只在本机读文件、写 data/session-view.html，不联网。页面里有聊天内容和模型的思考过程，别外发。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readZstd } from './zstd-frames.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ── args / env ────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const target = argv.find((a, i) => !a.startsWith('--') && !['--last', '--out'].includes(argv[i - 1]));

function envFile(key) {
  if (process.env[key]) return process.env[key];
  try {
    const m = fs.readFileSync(path.join(ROOT, '.env'), 'utf8').match(new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*$`, 'm'));
    return m ? m[1].replace(/^["']|["']$/g, '') : '';
  } catch {
    return '';
  }
}
const DSH_HOME = envFile('DSH_HOME') || path.resolve(ROOT, '..', '.dsh-qq');
const DATA_DIR = envFile('BRIDGE_DATA') ? path.resolve(envFile('BRIDGE_DATA')) : path.join(ROOT, 'data');
const SESSIONS_DIR = path.join(DSH_HOME, 'sessions');

// ── locating a session ────────────────────────────────────────────────────
function sessionFileFor(id) {
  try {
    for (const dir of fs.readdirSync(SESSIONS_DIR)) {
      const f = path.join(SESSIONS_DIR, dir, id, 'session.v4.jsonl.zstd');
      if (fs.existsSync(f)) return f;
    }
  } catch {
    /* no sessions dir */
  }
  return null;
}
function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}
const chats = readJson(path.join(DATA_DIR, 'sessions.json'), {});
const when = (ms) => (ms ? new Date(ms).toLocaleString('zh-CN', { hour12: false }) : '?');

if (flag('--list')) {
  console.log(`DSH_HOME: ${DSH_HOME}\n\n聊天 -> 会话（${path.join(DATA_DIR, 'sessions.json')}）：`);
  for (const [key, v] of Object.entries(chats)) {
    const f = sessionFileFor(v.sessionId);
    console.log(`  ${key}  ${v.sessionId}  更新 ${when(v.updatedAt)}  ${f ? `${(fs.statSync(f).size / 1024).toFixed(0)} KB` : '（找不到文件）'}`);
  }
  console.log('\n全部会话文件（新的在前）：');
  try {
    const all = fs
      .readdirSync(SESSIONS_DIR)
      .flatMap((d) => fs.readdirSync(path.join(SESSIONS_DIR, d)).map((s) => path.join(SESSIONS_DIR, d, s, 'session.v4.jsonl.zstd')))
      .filter((f) => fs.existsSync(f))
      .map((f) => ({ f, st: fs.statSync(f) }))
      .sort((a, b) => b.st.mtimeMs - a.st.mtimeMs)
      .slice(0, 15);
    for (const { f, st } of all) console.log(`  ${path.basename(path.dirname(f))}  ${(st.size / 1024).toFixed(0)} KB  ${when(st.mtimeMs)}`);
  } catch {
    console.log('  （没有）');
  }
  process.exit(0);
}

let chatKey = '';
let sessionId = '';
if (target && /^session-|^[0-9a-f]{8}-/.test(target)) {
  sessionId = target;
  chatKey = Object.keys(chats).find((k) => chats[k].sessionId === target) || '';
} else if (target) {
  if (!chats[target]) {
    console.error(`sessions.json 里没有 "${target}"。已有：${Object.keys(chats).join(', ') || '（空）'}（或用 --list 看看）`);
    process.exit(1);
  }
  chatKey = target;
  sessionId = chats[target].sessionId;
} else {
  const newest = Object.entries(chats).sort((a, b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0))[0];
  if (!newest) {
    console.error('data/sessions.json 是空的，还没有聊天会话。用 --list 看看会话文件。');
    process.exit(1);
  }
  [chatKey, { sessionId }] = newest;
}
const file = sessionFileFor(sessionId);
if (!file) {
  console.error(`找不到会话文件：${sessionId}（在 ${SESSIONS_DIR} 下）`);
  process.exit(1);
}

// ── helpers ───────────────────────────────────────────────────────────────
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const noRedact = flag('--no-redact');
function redact(s) {
  if (noRedact) return s;
  return String(s)
    .replace(/\bsk-[A-Za-z0-9_-]{16,}/g, 'sk-****')
    .replace(/((?:api[_-]?key|access[_-]?token|token|secret|password|passwd|phone_pin|pin)\s*[=:：]\s*)(["']?)[^\s"',;]+/gi, '$1$2****');
}
const clip = (s, n) => {
  const t = String(s ?? '');
  return t.length > n ? t.slice(0, n) + `\n…（已截断，还有 ${t.length - n} 字）` : t;
};
const show = (s, n = 4000) => esc(redact(clip(s, n)));
const textOfContent = (content) =>
  (Array.isArray(content) ? content : [])
    .map((b) => (b?.type === 'text' || b?.type === 'reasoning' ? b.text : b?.attachment ? '[附件]' : ''))
    .filter(Boolean)
    .join('\n');
function userSaid(prompt) {
  const m = prompt.match(/对方刚说：\s*\n([\s\S]*?)(?:\n\n（不管|$)/);
  return m ? m[1].trim() : null;
}
const SECTIONS = [
  ['【此刻】', '此刻状态'],
  ['你记得关于这个人的事', '长期事实'],
  ['你之前和这个人聊过', '最近聊天记录'],
  ['群里刚才在聊', '群聊近况'],
  ['[对方发来', '图片'],
];

// ── build turns ───────────────────────────────────────────────────────────
function buildTurns(recs) {
  const turns = new Map();
  const getTurn = (n) => {
    if (!turns.has(n)) turns.set(n, { n, at: 0, user: [], events: [], ctx: 0, out: 0, reason: '', ended: false, hasAssistant: false, steps: 0 });
    return turns.get(n);
  };
  let current = null;
  const pendingUser = [];
  for (const r of recs) {
    const d = r.data || {};
    switch (r.type) {
      case 'turn/start':
        current = getTurn(d.turn);
        current.at = r.time;
        for (const u of pendingUser.splice(0)) current.user.push(u);
        break;
      case 'user/message': {
        const u = { text: textOfContent(d.content), kind: d.source?.kind || '', at: r.time };
        if (current && !current.hasAssistant && !current.ended) current.user.push(u);
        else pendingUser.push(u);
        break;
      }
      case 'assistant/message': {
        const t = getTurn(d.turn);
        t.hasAssistant = true;
        t.steps = Math.max(t.steps, d.step || 0);
        for (const b of d.message?.content || []) {
          if (b.type === 'reasoning') t.events.push({ k: 'reasoning', text: b.text || '' });
          else if (b.type === 'text') t.events.push({ k: 'text', text: b.text || '' });
          else if (b.type === 'tool-call') t.events.push({ k: 'call', name: b.name || b.toolName || '工具', args: b.arguments ?? b.input ?? b.args ?? '' });
        }
        const u = d.usage;
        if (u) {
          t.ctx = (u.inputTokens || 0) + (u.cacheReadTokens || 0);
          t.out += u.outputTokens || 0;
        }
        break;
      }
      case 'tool/call':
        // already shown from the assistant message's tool-call block
        break;
      case 'tool/result': {
        const t = getTurn(d.turn);
        t.events.push({ k: 'result', text: textOfContent(d.message?.content), error: !!d.message?.isError });
        break;
      }
      case 'turn/end': {
        const t = getTurn(d.turn);
        t.ended = true;
        t.reason = d.reason?.kind || '';
        break;
      }
      default:
    }
  }
  return [...turns.values()].filter((t) => t.user.length || t.events.length).sort((a, b) => a.n - b.n);
}

// ── render ────────────────────────────────────────────────────────────────
function renderTurn(t, windowSize, open) {
  const prompts = t.user.filter((u) => u.kind === 'user' || !u.kind);
  const prompt = prompts.map((u) => u.text).join('\n\n');
  const said = userSaid(prompt) ?? prompt;
  const reply = t.events.filter((e) => e.k === 'text').map((e) => e.text).join(' / ');
  const calls = t.events.filter((e) => e.k === 'call').length;
  const pct = windowSize ? Math.min(100, (t.ctx / windowSize) * 100) : 0;
  const chips = SECTIONS.filter(([key]) => prompt.includes(key)).map(([, label]) => `<span class="chip">${label}</span>`).join('');
  const flags = [calls ? `<span class="chip warn">${calls} 次工具调用</span>` : '', t.reason && t.reason !== 'completed' ? `<span class="chip bad">${esc(t.reason)}</span>` : ''].join('');

  const body = t.events
    .map((e) => {
      if (e.k === 'reasoning') return `<div class="blk think"><b>思考</b><pre>${show(e.text, 6000)}</pre></div>`;
      if (e.k === 'text') return `<div class="blk reply"><b>回复</b><pre>${show(e.text, 4000)}</pre></div>`;
      if (e.k === 'call') return `<div class="blk tool"><b>调用 ${esc(e.name)}</b><pre>${show(typeof e.args === 'string' ? e.args : JSON.stringify(e.args), 1500)}</pre></div>`;
      return `<div class="blk tool${e.error ? ' err' : ''}"><b>工具结果${e.error ? '（出错）' : ''}</b><pre>${show(e.text, 1500)}</pre></div>`;
    })
    .join('\n');

  return `<details class="turn"${open ? ' open' : ''}>
<summary><span class="n">#${t.n}</span> <span class="t">${esc(when(t.at))}</span> <span class="said">${esc(redact(clip(said.replace(/\s+/g, ' '), 60)))}</span>
<span class="bar" title="上下文 ${t.ctx} tokens"><i style="width:${pct.toFixed(1)}%"></i></span> <span class="tok">${t.ctx.toLocaleString()} tok</span> ${flags}</summary>
<div class="blk ask"><b>对方刚说</b><pre>${show(said, 2000)}</pre></div>
<details class="ctx"><summary>喂给模型的完整提示词 ${chips}</summary><pre>${show(prompt, 20000)}</pre></details>
${body || '<div class="blk"><i>（这一轮没有记录到模型输出）</i></div>'}
<div class="meta">本轮 ${t.steps || 1} 步 · 上下文 ${t.ctx.toLocaleString()} tokens${windowSize ? `（窗口的 ${pct.toFixed(1)}%）` : ''} · 输出 ${t.out.toLocaleString()} tokens${reply ? '' : ''}</div>
</details>`;
}

function renderPage({ recs, turns, shown, warn }) {
  const ctxRec = recs.find((r) => r.type === 'request/context')?.data || {};
  const header = [...recs].reverse().find((r) => r.type === 'request/header')?.data?.header?.config || {};
  const sys = recs.find((r) => r.type === 'system/message')?.data?.message?.content;
  const windowSize = ctxRec.contextWindow || 0;
  const last = turns[turns.length - 1];
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>会话查看 · ${esc(chatKey || sessionId)}</title>
<style>
:root{--bg:#fafafb;--card:#fff;--ink:#1f2328;--mute:#6e7681;--line:#d0d7de;--think:#f4f0ff;--reply:#eefaf3;--tool:#f6f8fa;--ask:#eef5ff;--bad:#cf222e;--warn:#9a6700}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--card:#161b22;--ink:#e6edf3;--mute:#8b949e;--line:#30363d;--think:#1e1a2e;--reply:#12261a;--tool:#161b22;--ask:#10233a;--bad:#ff7b72;--warn:#d29922}}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.6 "Microsoft YaHei UI","Segoe UI",sans-serif}
main{max-width:920px;margin:0 auto;padding:20px 16px 60px}
h1{font-size:18px;margin:0 0 4px}.sub{color:var(--mute);font-size:12px;margin-bottom:14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px 14px;margin:10px 0}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:8px}.grid div{font-size:12px;color:var(--mute)}.grid b{display:block;font-size:15px;color:var(--ink);font-weight:600}
.notice{border-color:var(--warn);color:var(--warn);font-size:12px}
details.turn{background:var(--card);border:1px solid var(--line);border-radius:8px;margin:8px 0;padding:0 12px}
details.turn>summary{cursor:pointer;padding:9px 0;list-style:none;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
details.turn>summary::-webkit-details-marker{display:none}
.n{font-weight:700}.t,.tok,.meta{color:var(--mute);font-size:12px}.said{flex:1;min-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bar{width:70px;height:6px;background:var(--line);border-radius:3px;overflow:hidden}.bar i{display:block;height:100%;background:#1aaa62}
.chip{font-size:11px;border:1px solid var(--line);border-radius:10px;padding:0 7px;color:var(--mute)}.chip.warn{color:var(--warn);border-color:var(--warn)}.chip.bad{color:var(--bad);border-color:var(--bad)}
.blk{border-radius:6px;padding:6px 10px;margin:6px 0}.blk b{font-size:12px;color:var(--mute)}.think{background:var(--think)}.reply{background:var(--reply)}.tool{background:var(--tool);border:1px solid var(--line)}.ask{background:var(--ask)}.err{border-color:var(--bad)}
pre{margin:4px 0 0;white-space:pre-wrap;word-break:break-word;font:13px/1.55 "Cascadia Mono",Consolas,"Microsoft YaHei UI",monospace}
details.ctx{margin:6px 0}details.ctx>summary{cursor:pointer;color:var(--mute);font-size:12px}
.meta{padding:4px 0 10px}
</style></head><body><main>
<h1>会话查看 · ${esc(chatKey || '(未登记的会话)')}</h1>
<div class="sub">${esc(sessionId)} · 生成于 ${esc(when(Date.now()))} · 只在本机生成，含聊天内容和思考过程，别外发${noRedact ? '' : ' · 已遮掉疑似密钥/PIN 的值'}</div>
${warn ? `<div class="card notice">${esc(warn)}</div>` : ''}
<div class="card grid">
<div>模型<b>${esc(header.model || ctxRec.model || '?')}</b></div>
<div>思考强度<b>${esc(header.reasoningEffort || '?')}</b></div>
<div>上下文窗口<b>${windowSize ? windowSize.toLocaleString() + ' tokens' : '?'}</b></div>
<div>最新一轮上下文<b>${last ? last.ctx.toLocaleString() + ' tokens' + (windowSize ? `（${((last.ctx / windowSize) * 100).toFixed(1)}%）` : '') : '?'}</b></div>
<div>轮次<b>共 ${turns.length}，显示最近 ${shown.length}</b></div>
</div>
${sys ? `<details class="card"><summary>DSH 自带的系统提示词（折叠）</summary><pre>${show(textOfContent(sys), 20000)}</pre></details>` : ''}
${shown.map((t, i) => renderTurn(t, windowSize, i >= shown.length - 2)).join('\n')}
</main></body></html>`;
}

// ── main ──────────────────────────────────────────────────────────────────
const { text, warn } = await readZstd(file);
const recs = text
  .split(/\r?\n/)
  .filter(Boolean)
  .map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  })
  .filter(Boolean)
  .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
const turns = buildTurns(recs);
const lastN = flag('--all') ? turns.length : Number(opt('--last', 15)) || 15;
const shown = turns.slice(-lastN);
const out = path.resolve(opt('--out', path.join(DATA_DIR, 'session-view.html')));
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, renderPage({ recs, turns, shown, warn }));
console.log(`已生成：${out}\n  会话 ${sessionId}${chatKey ? `（${chatKey}）` : ''}，共 ${turns.length} 轮，显示最近 ${shown.length} 轮${warn ? `\n  ⚠ ${warn}` : ''}`);
if (!flag('--no-open') && process.platform === 'win32') {
  spawn('cmd.exe', ['/c', 'start', '', out], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}
