#!/usr/bin/env node
/**
 * 下载一套默认表情包：FeWOO/DeepSeek-meme 的 DeepSeek 小鲸鱼表情（MIT），按情绪放进表情库 <数据目录>/stickers/<情绪>/（设了 STICKER_DIR 就放那）。
 * 一共 18 张；已存在就跳过。不再下 Twemoji 那套小黄脸 emoji。
 * 想多要就自己往情绪目录里丢图，她也会从聊天里收你发的表情包。
 *
 *   node scripts/fetch-stickers.mjs
 *
 * STICKER_BASE 可以换下载地址（测试用本地的假服务器，不联网）。
 */
import fs from 'node:fs';
import path from 'node:path';
// 放进数据目录下的 stickers/（跟 speech 插件一样：STICKER_DIR 优先，其次 <数据目录>/stickers；
// 数据目录 BRIDGE_DATA，没有就是 <COMPANION_HOME>/data，装进 DSH 后单独跑也找得到，见 home.mjs；它要排在 config.mjs 前面）
import { dataDir } from './home.mjs';
import { env } from '../config.mjs';

const DIR = env.STICKER_DIR ? path.resolve(env.STICKER_DIR) : path.join(dataDir(env), 'stickers');
const BASE = env.STICKER_BASE || 'https://raw.githubusercontent.com/FeWOO/DeepSeek-meme/main/assets';

// 包 → 图 → 情绪（按图里的意思分的）
const PACKS = {
  community: { 'big-idea': '得意', doomed: '委屈', 'full-belly': '卖萌', 'happy-point': '开心', kneel: '生气', stare: '无语', 'user-revolt': '生气', 'war-torn': '震惊' },
  default: {
    '01-received': '卖萌', '02-thanks': '开心', '03-im-here': '卖萌', '04-nice-work': '得意', '05-good-night': '委屈',
    '06-good-morning': '开心', '07-milk-tea': '卖萌', '08-huh': '无语', '09-hmph': '得意', '10-sleepy': '委屈',
  },
};

let got = 0;
let failed = 0;
for (const [pack, files] of Object.entries(PACKS)) {
  for (const [name, mood] of Object.entries(files)) {
    const dir = path.join(DIR, mood);
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, `deepseek-${pack}-${name}.webp`);
    if (fs.existsSync(dest) && fs.statSync(dest).size > 500) {
      got++;
      continue;
    }
    try {
      const res = await fetch(`${BASE}/${pack}/${name}.webp`, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 500) throw new Error('太小');
      fs.writeFileSync(dest, buf);
      got++;
    } catch (err) {
      failed++;
      console.log(`没下成 ${pack}/${name}：${err.message}`);
    }
  }
}
for (const mood of new Set(Object.values(PACKS).flatMap((p) => Object.values(p)))) {
  const n = fs.readdirSync(path.join(DIR, mood)).filter((f) => /\.(png|jpe?g|webp|gif)$/i.test(f)).length;
  console.log(`${mood}: ${n} 张`);
}
console.log(`默认表情包：${got} 张到位${failed ? `，${failed} 张没下成` : ''}（目录 ${DIR}）`);
process.exitCode = got > 0 ? 0 : 1; // 别 process.exit()：fetch 的连接还没收完就退，Windows 上的 Node 会崩（退出码 3221226505）
