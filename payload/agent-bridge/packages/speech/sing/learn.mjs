#!/usr/bin/env node
// 学新歌：下载 B站 音轨（或用本地音频）→ 转 wav → sing/render.py 换成自己的嗓子 → <数据目录>/songs/<歌名>/。
// 一段 30 秒要 4~5 分钟，比一轮聊天长得多，所以在后台跑。
// 干活的进程不能是 DSH 启动的：DSH 会记下这一轮里出现过的所有子孙进程（pid + 创建时间），
// 一轮结束全杀，父进程先退也躲不掉（之前就是这样每次死在“换嗓子”那步）。所以：
//   start 只把任务记成“排队”，内核每 3 秒看一眼（speech 插件 setup 里 api.every 调 learnJobsTick），由它来起后台进程；
//   10 秒没人接（内核没开、在普通终端里跑），start 就自己起。
//
// node sing/learn.mjs start --title 歌名 --artist 歌手 --bv BV号 --seg 104-134 [--seg 起-止 …] [--lyrics 歌词.json] [--shift 0]
// node sing/learn.mjs start --title 歌名 --audio 本地音频 --seg 起-止
// node sing/learn.mjs status [歌名]
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const ROOT = path.resolve(HERE, '..'); // 插件目录（sing/ 的上一层）
// 数据目录跟内核、sing/paths.py 认的一样：BRIDGE_DATA 优先，其次 <COMPANION_HOME>/data（没设 COMPANION_HOME 就当插件目录）
const COMPANION = process.env.COMPANION_HOME ? path.resolve(process.env.COMPANION_HOME) : ROOT;
const DATA = process.env.BRIDGE_DATA ? path.resolve(process.env.BRIDGE_DATA) : path.join(COMPANION, 'data');
const JOBS = path.join(DATA, 'sing-model', 'jobs');
const INPUT = path.join(DATA, 'sing-input');
const PY = process.env.PYTHON || 'python';
const MIN_PER_SEG = 5; // 分离人声 ~1.5 分钟 + 换嗓子 ~3 分钟 + 收尾

const readJson = (f, d = null) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return d;
  }
};
const writeJson = (f, v) => {
  fs.writeFileSync(f + '.tmp', JSON.stringify(v, null, 1));
  fs.renameSync(f + '.tmp', f);
};
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // 内核用管理员起的，普通权限探不了，但它在
  }
};
const ago = (t) => {
  const m = Math.round((Date.now() - t) / 60_000);
  return m < 1 ? '刚刚' : `${m} 分钟前`;
};

function parseArgs(argv) {
  const a = { seg: [] };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!k.startsWith('--')) continue;
    const v = argv[++i];
    if (k === '--seg') a.seg.push(v);
    else a[k.slice(2)] = v;
  }
  return a;
}

function jobs() {
  if (!fs.existsSync(JOBS)) return [];
  return fs
    .readdirSync(JOBS)
    .filter((f) => f.endsWith('.json'))
    .map((f) => readJson(path.join(JOBS, f)))
    .filter(Boolean)
    .sort((x, y) => y.startedAt - x.startedAt);
}

// 状态文件里写着 running，但进程已经没了（关机、被杀）：当失败处理
function settle(job) {
  if (job.state === 'queued' && Date.now() - job.startedAt > 120_000) {
    job.state = 'failed';
    job.error = '排了两分钟没人接手，重新 start 一次';
  }
  if (job.state === 'running' && !alive(job.pid)) {
    job.state = 'failed';
    job.error = job.error || '后台进程没了（可能关机或被杀了），重新 start 一次';
  }
  return job;
}

// 谁先建出 <id>.claim 谁来跑，内核和 start 的兜底不会把同一首学两遍
function claim(id) {
  try {
    fs.closeSync(fs.openSync(path.join(JOBS, `${id}.claim`), 'wx'));
    return true;
  } catch {
    return false;
  }
}

function launch(id) {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '_run', id], {
    cwd: ROOT,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  return child.pid;
}

/** 内核里调（speech 插件 api.every 每 3 秒一次）：有排队的学歌任务就由内核起后台进程（不在 DSH 的进程树里）。 */
export function learnJobsTick(log = () => {}) {
  try {
    for (const job of jobs()) {
      if (job.state !== 'queued' || !claim(job.id)) continue;
      const pid = launch(job.id);
      log(`学歌：开始学《${job.title}》（${job.seg.join(' ')}，后台进程 ${pid}）`);
    }
  } catch (err) {
    log(`学歌：看任务出错 ${err.message}`);
  }
}
/** 自己开定时器每 3 秒看一眼（不走插件定时任务时用）。 */
export function watchLearnJobs(log = () => {}) {
  return setInterval(() => learnJobsTick(log), 3000);
}

async function start(argv) {
  const a = parseArgs(argv);
  if (!a.title || !(a.bv || a.audio) || !a.seg.length) {
    console.log('用法：learn.mjs start --title 歌名 [--artist 歌手] (--bv BV号 | --audio 音频文件) --seg 起-止 [--seg …] [--lyrics 歌词.json]');
    process.exit(2);
  }
  for (const s of a.seg) {
    const [x, y] = s.split('-').map(Number);
    if (!(y > x && x >= 0)) {
      console.log(`--seg ${s} 不对，要写成 起-止（秒），比如 104-134`);
      process.exit(2);
    }
  }
  const busy = jobs().map(settle).find((j) => j.state === 'running' || j.state === 'queued');
  if (busy) {
    console.log(`显卡正在学《${busy.title}》（${busy.step}，${ago(busy.startedAt)}开始），等它学完再学下一首。`);
    process.exit(1);
  }
  fs.mkdirSync(JOBS, { recursive: true });
  const id = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const job = {
    id,
    title: a.title,
    artist: a.artist || '',
    bv: a.bv ? (a.bv.match(/BV[0-9A-Za-z]{10}/) || [a.bv])[0] : null,
    audio: a.audio ? path.resolve(a.audio) : null,
    seg: a.seg,
    lyrics: a.lyrics ? path.resolve(a.lyrics) : null,
    shift: a.shift || '0',
    state: 'queued',
    step: '排队',
    startedAt: Date.now(),
    updatedAt: Date.now(),
    log: path.join(JOBS, `${id}.log`),
  };
  const file = path.join(JOBS, `${id}.json`);
  writeJson(file, job);
  // 等内核接手（它每 3 秒看一次）
  for (let i = 0; i < 20 && readJson(file)?.state === 'queued'; i++) await new Promise((r) => setTimeout(r, 500));
  if (readJson(file)?.state === 'queued' && claim(id)) launch(id);
  const mins = a.seg.length * MIN_PER_SEG + (job.bv ? 1 : 0);
  console.log(`开始学《${a.title}》了，${a.seg.length} 段，大概 ${mins} 分钟，在后台跑，这轮聊完也不会断。`);
  console.log(`进度：node "${SELF}" status ${a.title}`);
  console.log(`学好了它会出现在“你学会唱的歌”里，到时候写 [唱歌:${a.title}] 就能唱。`);
}

function status(argv) {
  const title = argv.filter((x) => !x.startsWith('--')).join(' ');
  const list = jobs().map(settle).filter((j) => !title || j.title === title);
  if (!list.length) {
    console.log(title ? `没在学《${title}》。` : '最近没学歌。');
    return;
  }
  for (const j of list.slice(0, title ? 1 : 3)) {
    const head = { running: '正在学', done: '学好了', failed: '没学成' }[j.state] || j.state;
    console.log(`《${j.title}》${head} · ${ago(j.startedAt)}开始 · ${j.seg.join(' ')}`);
    if (j.state === 'running') console.log(`  现在：${j.step}（${ago(j.updatedAt)}更新）`);
    if (j.state === 'done') console.log(`  ${j.result || ''}`.trimEnd() || `  写 [唱歌:${j.title}] 就能唱`);
    if (j.state === 'failed') console.log(`  原因：${j.error}`);
    if (j.state !== 'done') {
      const tail = fs.existsSync(j.log) ? fs.readFileSync(j.log, 'utf8').trim().split(/\r?\n/).slice(-6) : [];
      if (tail.length) console.log('  日志最后几行：\n' + tail.map((l) => '    ' + l).join('\n'));
    }
  }
}

// ---- 后台进程 ----

async function run(id) {
  const file = path.join(JOBS, `${id}.json`);
  const job = readJson(file);
  job.pid = process.pid;
  job.state = 'running';
  job.updatedAt = Date.now();
  writeJson(file, job);
  const say = (line) => fs.appendFileSync(job.log, `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${line}\n`);
  const step = (s) => {
    job.step = s;
    job.updatedAt = Date.now();
    writeJson(file, job);
    say(s);
  };
  try {
    fs.mkdirSync(INPUT, { recursive: true });
    let audio = job.audio;
    if (job.bv) {
      step(`从 B站 下音轨（${job.bv}）`);
      const m4a = path.join(INPUT, `${job.bv}.m4a`);
      if (!fs.existsSync(m4a)) await downloadAudio(job.bv, m4a, say);
      audio = m4a;
    }
    if (!/\.(wav|flac)$/i.test(audio)) {
      step('转成 wav');
      const wav = path.join(INPUT, path.basename(audio).replace(/\.[^.]+$/, '') + '.wav');
      toWav(audio, wav);
      audio = wav;
    }
    step(`换嗓子：${job.seg.length} 段，一段大概 ${MIN_PER_SEG} 分钟`);
    const args = ['-u', path.join(HERE, 'render.py'), '--audio', audio, '--title', job.title, '--shift', String(job.shift)];
    if (job.artist) args.push('--artist', job.artist);
    if (job.lyrics) args.push('--lyrics', job.lyrics);
    for (const s of job.seg) args.push('--seg', s);
    const out = await pyStream(args, (line) => {
      say(line);
      // render.py 每步打一行：“[歌名 起-止] 截取…”“  分离人声…”“  换嗓子（显卡）…”“  好了：…”
      const t = line.trim();
      if (t) {
        job.step = t.replace(/…$/, '');
        job.updatedAt = Date.now();
        writeJson(file, job);
      }
    });
    if (out.code !== 0) throw new Error(out.tail || `render.py 退出码 ${out.code}`);
    job.state = 'done';
    job.step = '学好了';
    job.result = out.lines.filter((l) => l.includes('好了：')).map((l) => l.trim()).join('\n');
  } catch (err) {
    job.state = 'failed';
    job.error = String(err.message || err).slice(0, 600);
    say('失败：' + job.error);
  }
  job.updatedAt = Date.now();
  writeJson(file, job);
}

function pyStream(args, onLine) {
  return new Promise((resolve) => {
    const p = spawn(PY, args, {
      cwd: ROOT,
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    });
    const lines = [];
    let buf = '';
    const feed = (chunk) => {
      buf += chunk.toString('utf8');
      const parts = buf.split(/\r?\n/);
      buf = parts.pop();
      for (const l of parts) {
        lines.push(l);
        onLine(l);
      }
    };
    p.stdout.on('data', feed);
    p.stderr.on('data', feed);
    p.on('error', (e) => resolve({ code: -1, lines, tail: String(e.message) }));
    p.on('close', (code) => {
      if (buf) {
        lines.push(buf);
        onLine(buf);
      }
      resolve({ code, lines, tail: lines.slice(-8).join('\n') });
    });
  });
}

function toWav(src, dst) {
  const ff = spawnSync(PY, ['-c', 'import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())'], { encoding: 'utf8', windowsHide: true });
  const exe = (ff.stdout || '').trim() || 'ffmpeg';
  const r = spawnSync(exe, ['-y', '-loglevel', 'error', '-i', src, '-ar', '44100', '-ac', '2', dst], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0 || !fs.existsSync(dst)) throw new Error(`转 wav 失败：${(r.stderr || r.error?.message || '').slice(-300)}`);
}

/** life 插件的 bili.mjs 在哪（跟这个插件装在一起才有），没有返回 ''。 */
function biliScript() {
  for (const dir of ['life', 'dsh-companion-life']) {
    const f = path.resolve(ROOT, '..', dir, 'bili', 'bili.mjs');
    if (fs.existsSync(f)) return f;
  }
  return '';
}

// B站 音轨：跟 life 插件的 bili/bili.mjs 一样用它的 cookie 和 wbi 签名（<数据目录>/bili/cache.json，12 小时内有效，过期先让 bili.mjs 刷一下）
async function downloadAudio(bvid, out, say) {
  const cacheFile = path.join(DATA, 'bili', 'cache.json');
  let c = readJson(cacheFile, {});
  if (!c.mixin || !c.at || Date.now() - c.at > 12 * 3600_000) {
    say('B站 登录态过期，先刷新一下');
    // B站 的登录态是 life 插件的 bili.mjs 攒的：在旁边（仓库里 packages/life，装进 DSH 是 dsh-companion-life）就让它刷一下
    const bili = biliScript();
    if (bili) spawnSync(process.execPath, [bili, 'rank', '1'], { cwd: path.dirname(path.dirname(bili)), windowsHide: true, timeout: 60_000 });
    c = readJson(cacheFile, {});
  }
  if (!c.mixin) throw new Error(`拿不到 B站 的签名（${cacheFile}），${biliScript() ? `先跑一次 node "${biliScript()}" hot 1` : '要装“她自己的生活”（life）插件刷 B站，或者用 --audio 给本地音频'}`);
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
  const headers = {
    'User-Agent': UA,
    Referer: 'https://www.bilibili.com/',
    Origin: 'https://www.bilibili.com',
    Cookie: `buvid3=${c.buvid3}; b_nut=${c.bnut}` + (c.buvid4 ? `; buvid4=${encodeURIComponent(c.buvid4)}` : ''),
  };
  const wbi = (params) => {
    const p = { ...params, wts: Math.floor(Date.now() / 1000) };
    const q = Object.keys(p)
      .sort()
      .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(p[k]).replace(/[!'()*]/g, ''))}`)
      .join('&');
    return `${q}&w_rid=${crypto.createHash('md5').update(q + c.mixin).digest('hex')}`;
  };
  const get = async (u) => {
    const r = await fetch('https://api.bilibili.com' + u, { headers, signal: AbortSignal.timeout(30_000) });
    if (!r.ok) throw new Error(`B站 HTTP ${r.status}（可能风控了，过一会儿再试）`);
    const j = await r.json();
    if (j.code !== 0) throw new Error(`B站 ${j.code} ${j.message}`);
    return j.data;
  };
  const view = await get('/x/web-interface/wbi/view?' + wbi({ bvid }));
  await new Promise((r) => setTimeout(r, 600));
  const pu = await get('/x/player/wbi/playurl?' + wbi({ bvid, cid: view.cid, fnval: 16, fourk: 0 }));
  const audio = (pu.dash?.audio || []).sort((x, y) => y.bandwidth - x.bandwidth)[0];
  if (!audio) throw new Error('这个视频没有单独的音轨');
  say(`《${view.title}》${view.duration}s，音轨 ${Math.round(audio.bandwidth / 1000)}kbps`);
  const r = await fetch(audio.baseUrl || audio.base_url, { headers, signal: AbortSignal.timeout(180_000) });
  if (!r.ok) throw new Error(`下音轨 HTTP ${r.status}`);
  fs.writeFileSync(out, Buffer.from(await r.arrayBuffer()));
}

// 被 speech 插件 import 时只导出 learnJobsTick / watchLearnJobs，不跑命令行
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'start') await start(rest);
  else if (cmd === 'status') status(rest);
  else if (cmd === '_run') await run(rest[0]);
  else console.log('用法：learn.mjs start … | status [歌名]（见文件开头）');
}
