#!/usr/bin/env node
/**
 * 给表情库每张图配一句描述（“画面：用法”），存 data/stickers/index.json，聊天时按意思挑图用。
 * 让模型用 read_image 看图（只读权限），一次看 6 张。已经有描述的跳过；--all 全部重写。会花一点 DeepSeek 额度。
 *
 *   node scripts/sticker-index.mjs          # 补没描述的
 *   node scripts/sticker-index.mjs --all    # 全部重写
 *   node scripts/sticker-index.mjs --dry    # 只看有多少张要写
 *   node scripts/sticker-index.mjs --limit 6   # 先试几张
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
// 数据目录跟内核一样（BRIDGE_DATA，没有就是 <COMPANION_HOME>/data；装进 DSH 后单独跑也找得到），见 home.mjs；它要排在 config.mjs 前面
import { dataDir } from './home.mjs';
import { cfg, env } from '../config.mjs';
import { parseJsonLoose } from '../human.mjs';

// 表情库怎么放、index.json 怎么写，跟 speech 插件（说话的样子）的 stickers.mjs 一样；这个脚本要用本体的设置调模型，所以抄一份在这里
const MOODS = ['开心', '无语', '生气', '卖萌', '得意', '委屈', '震惊'];
const IMG = /\.(png|jpe?g|gif|webp)$/i;
function readIndex(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
  } catch {
    return {};
  }
}
function writeIndex(dir, idx) {
  const f = path.join(dir, 'index.json');
  fs.writeFileSync(f + '.tmp', JSON.stringify(idx, null, 1));
  fs.renameSync(f + '.tmp', f);
}
/** 库里所有图：[{ rel: '开心/a.png', mood, file }] */
function listStickers(dir) {
  const out = [];
  for (const mood of MOODS) {
    let files = [];
    try {
      files = fs.readdirSync(path.join(dir, mood)).filter((f) => IMG.test(f));
    } catch {}
    for (const f of files) out.push({ rel: `${mood}/${f}`, mood, file: path.join(dir, mood, f) });
  }
  return out;
}

const argv = process.argv.slice(2);
const DATA_DIR = dataDir(env);
const DIR = env.STICKER_DIR ? path.resolve(env.STICKER_DIR) : path.join(DATA_DIR, 'stickers');
const BATCH = 6;

function runAgent(prompt) {
  return new Promise((resolve, reject) => {
    const childEnv = { ...process.env, DSH_HOME: cfg.dshHome, DSH_PERMISSION_MODE: 'read-only' };
    if (cfg.apiKey) childEnv.DEEPSEEK_API_KEY = cfg.apiKey;
    const p = spawn(process.execPath, [cfg.dshCli, '--profile', 'headless', '--json', prompt], { cwd: cfg.agentCwd, env: childEnv, windowsHide: true });
    let out = '';
    const timer = setTimeout(() => p.kill(), 5 * 60_000);
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', () => {});
    p.on('error', reject);
    p.on('close', () => {
      clearTimeout(timer);
      let text = '';
      for (const line of out.split(/\r?\n/)) {
        try {
          const j = JSON.parse(line);
          if (j.type === 'final') text = j.text || '';
        } catch {}
      }
      text ? resolve(text) : reject(new Error('模型没给结果'));
    });
  });
}

const idx = readIndex(DIR);
const all = listStickers(DIR);
const li = argv.indexOf('--limit');
const todo = (argv.includes('--all') ? all : all.filter((s) => !idx[s.rel]?.desc)).slice(0, li >= 0 ? Number(argv[li + 1]) || 6 : Infinity);
console.log(`表情库 ${all.length} 张，要写描述的 ${todo.length} 张`);
if (argv.includes('--dry') || !todo.length) process.exit(0);

let done = 0;
for (let i = 0; i < todo.length; i += BATCH) {
  const batch = todo.slice(i, i + BATCH);
  const prompt =
    `依次用 read_image 工具看下面这 ${batch.length} 张表情包图片（每张都要真的看，再回答）。\n` +
    batch.map((s, k) => `${k + 1}. ${s.file}`).join('\n') +
    `\n\n每张用一句话写：画面是什么 + 适合什么时候用/表达什么，格式“画面：用法”，20 字以内，比如“熊猫头翻白眼：无语、看不下去”“猫咪捂嘴偷笑：笑死、憋不住”。\n` +
    `只输出一个 JSON 对象，键是编号，值是描述：{"1":"…","2":"…"}。不要解释。`;
  try {
    const out = parseJsonLoose(await runAgent(prompt)) || {};
    batch.forEach((s, k) => {
      const desc = String(out[String(k + 1)] || '').replace(/\s+/g, ' ').trim().slice(0, 40);
      if (desc) {
        idx[s.rel] = { desc, at: Date.now() };
        done++;
      }
    });
    writeIndex(DIR, idx);
    console.log(`  ${Math.min(i + BATCH, todo.length)}/${todo.length}  ${batch.map((s) => idx[s.rel]?.desc || '（没写出来）').join(' | ')}`);
  } catch (err) {
    console.log(`  ${i + 1}-${i + batch.length} 没写成：${err.message}`);
  }
}
console.log(`写好了 ${done} 张，存在 ${path.join(DIR, 'index.json')}`);
