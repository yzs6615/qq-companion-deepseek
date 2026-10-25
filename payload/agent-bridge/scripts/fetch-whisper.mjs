#!/usr/bin/env node
/**
 * 下载 faster-whisper 模型到 tools/whisper-models/<name>/（HF 镜像）。
 * 用法：node scripts/fetch-whisper.mjs [base|small|tiny]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TOOLS = path.join(ROOT, '..', 'tools');
const MODEL = process.argv[2] || 'base';
const BASE = `https://modelscope.cn/models/gpustack/faster-whisper-${MODEL}/resolve/master`;
const DEST = path.join(TOOLS, 'whisper-models', MODEL);

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
