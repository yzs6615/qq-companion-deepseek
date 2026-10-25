/**
 * 表情库：data/stickers/<情绪>/ 里的图 + index.json 里每张图的一句描述（“熊猫头翻白眼：无语、看不下去”）。
 * 模型写 [表情:想表达的意思]，按描述挑最贴的一张；写的是七种情绪之一就按情绪目录随机挑。
 * 描述用 scripts/sticker-index.mjs 让模型看图写（收来的新表情包 bridge 会自己补）。
 */
import fs from 'node:fs';
import path from 'node:path';

export const MOODS = ['开心', '无语', '生气', '卖萌', '得意', '委屈', '震惊'];
const IMG = /\.(png|jpe?g|gif|webp)$/i;

export function readIndex(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
  } catch {
    return {};
  }
}
export function writeIndex(dir, idx) {
  const f = path.join(dir, 'index.json');
  fs.writeFileSync(f + '.tmp', JSON.stringify(idx, null, 1));
  fs.renameSync(f + '.tmp', f);
}
/** 库里所有图：[{ rel: '开心/a.png', mood, file }] */
export function listStickers(dir) {
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

const norm = (s) => String(s || '').toLowerCase().replace(/[\s,，。.!！?？、:：;；"“”'‘’()（）\[\]【】~～-]+/g, '');
const grams = (s) => {
  const out = new Set();
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
};
/** 想表达的意思 和 一张图的描述 有多贴：0~1（字和相邻两个字的重合，整段包含再加分）。 */
export function matchScore(query, desc) {
  const q = norm(query);
  const d = norm(desc);
  if (!q || !d) return 0;
  const qc = new Set(q);
  const dc = new Set(d);
  const qg = grams(q);
  const dg = grams(d);
  let chars = 0;
  for (const c of qc) if (dc.has(c)) chars++;
  let pairs = 0;
  for (const g of qg) if (dg.has(g)) pairs++;
  let score = (chars + pairs * 2) / (qc.size + qg.size * 2 || 1);
  if (q.length >= 2 && d.includes(q)) score += 0.4;
  return Math.min(1, score);
}
/**
 * 按意思挑一张：分数够高（≥ min）的里面，跟最高分差不多的随机挑一张（别老发同一张）。
 * 返回 { file, rel, desc, score } 或 null。
 */
export function pickByMeaning(dir, query, { min = 0.35, avoid = '' } = {}) {
  const idx = readIndex(dir);
  const scored = listStickers(dir)
    .map((s) => ({ ...s, desc: idx[s.rel]?.desc || '', score: matchScore(query, `${idx[s.rel]?.desc || ''} ${s.mood}`) }))
    .filter((s) => s.desc && s.score >= min)
    .sort((a, b) => b.score - a.score);
  if (!scored.length) return null;
  const top = scored.filter((s) => s.score >= scored[0].score - 0.08 && s.rel !== avoid);
  const pool = top.length ? top : scored.slice(0, 1);
  return pool[Math.floor(Math.random() * pool.length)];
}
