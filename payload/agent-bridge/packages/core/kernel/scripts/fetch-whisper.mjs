#!/usr/bin/env node
/**
 * 下载 faster-whisper 模型到 <模型目录>/<name>/（ModelScope 镜像），手动跑。
 * 模型目录：.env 里设了 WHISPER_MODEL_DIR 就下到那；没设就下到 <COMPANION_HOME>/tools/whisper-models，
 * 下完照提示在 .env 里写上 WHISPER_MODEL_DIR（本体看视频、life 刷 B站“听”只认它；手机插件看直播没设时
 * 先找 <COMPANION_HOME>/tools/whisper-models，再找手机插件目录下的 tools/whisper-models）。
 * 不下到插件包里面：包更新时会被整个换掉。
 * 用法：node scripts/fetch-whisper.mjs [base|small|tiny]
 */
import fs from 'node:fs';
import path from 'node:path';
// COMPANION_HOME 跟内核一样找（装进 DSH 后单独跑也找得到），见 home.mjs；它要排在 config.mjs 前面（config.mjs 读 .env）
import { companionHome } from './home.mjs';
import { env } from '../config.mjs';

const MODEL = process.argv[2] || 'base';
const BASE = `https://modelscope.cn/models/gpustack/faster-whisper-${MODEL}/resolve/master`;
const MODELS = env.WHISPER_MODEL_DIR ? path.resolve(env.WHISPER_MODEL_DIR) : path.join(companionHome(env), 'tools', 'whisper-models');
const DEST = path.join(MODELS, MODEL);

const FILES = ['config.json', 'tokenizer.json', 'vocabulary.txt', 'model.bin'];

async function download(name) {
  const dest = path.join(DEST, name);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 1000 && name !== 'model.bin') {
    console.log(`${name}: exists`);
    return;
  }
  const url = `${BASE}/${name}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length') || 0);
  console.log(`${name}: ${(total / 1048576).toFixed(1)} MB`);
  fs.mkdirSync(DEST, { recursive: true });
  const out = fs.createWriteStream(dest);
  const reader = res.body.getReader();
  let got = 0;
  let last = Date.now();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    got += value.length;
    out.write(Buffer.from(value));
    if (Date.now() - last > 5000) {
      const mb = got / 1048576;
      console.log(`  ${mb.toFixed(1)}/${(total / 1048576).toFixed(1)} MB`);
      last = Date.now();
    }
  }
  await new Promise((r) => out.end(r));
  console.log(`${name}: done ${(got / 1048576).toFixed(1)} MB`);
}

for (const f of FILES) {
  await download(f);
}
console.log(`model dir: ${DEST}`);
if (!env.WHISPER_MODEL_DIR) console.log(`还没设 WHISPER_MODEL_DIR：在 ${path.join(companionHome(env), '.env')} 里加一行 WHISPER_MODEL_DIR=${MODELS}（看视频、刷 B站“听”要它）`);
