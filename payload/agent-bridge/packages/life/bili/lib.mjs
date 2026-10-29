/** 刷 B站用到的纯计算（不联网），单独放这里方便测试。 */
export const strip = (s) => String(s || '').replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'");

export function parseDanmaku(xml) {
  const out = [];
  for (const m of xml.matchAll(/<d p="([^"]*)">([^<]*)<\/d>/g)) out.push({ t: Number(m[1].split(',')[0]) || 0, text: strip(m[2]).trim() });
  return out.filter((d) => d.text);
}

export function topDanmaku(list, k = 10) {
  const norm = (s) => s.replace(/\s+/g, '').replace(/(.)\1{2,}/g, '$1$1$1').replace(/[!！?？。.~～]+$/g, '');
  const count = new Map();
  for (const d of list) {
    const key = norm(d.text);
    if (key.length < 1 || key.length > 30) continue;
    count.set(key, (count.get(key) || 0) + 1);
  }
  return [...count.entries()].filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1]).slice(0, k);
}

/** 看多少帧：短视频一张 9 格，10 分钟内两张，再长三张。 */
export function autoFrames(duration) {
  return duration <= 180 ? 9 : duration <= 600 ? 18 : 27;
}

/**
 * 弹幕突然变密的地方 = 观众反应最大的时刻（几千个人帮它划的重点）。
 * 返回 [{t, count, words}]，按热度排，彼此至少隔 20 秒；t 往前挪 2 秒（弹幕比画面慢半拍）。
 */
export function danmakuPeaks(dm, duration, k) {
  if (dm.length < 20 || !duration || k <= 0) return [];
  const bin = Math.max(5, Math.round(duration / 120));
  const bins = new Array(Math.ceil(duration / bin) + 1).fill(0);
  for (const d of dm) if (d.t >= 0 && d.t <= duration) bins[Math.floor(d.t / bin)]++;
  const smooth = bins.map((c, i) => (bins[i - 1] || 0) * 0.5 + c + (bins[i + 1] || 0) * 0.5);
  const mean = smooth.reduce((a, b) => a + b, 0) / smooth.length;
  const std = Math.sqrt(smooth.reduce((a, b) => a + (b - mean) ** 2, 0) / smooth.length);
  const cand = smooth
    .map((s, i) => ({ i, s }))
    .filter(({ i, s }) => s > mean + std && s >= (smooth[i - 1] ?? 0) && s >= (smooth[i + 1] ?? 0))
    .sort((a, b) => b.s - a.s);
  const gap = Math.ceil(20 / bin);
  const picked = [];
  for (const c of cand) {
    if (picked.length >= k) break;
    if (picked.some((p) => Math.abs(p.i - c.i) < gap)) continue;
    picked.push(c);
  }
  return picked.map(({ i }) => {
    const from = (i - 1) * bin;
    const to = (i + 2) * bin;
    const inWin = dm.filter((d) => d.t >= from && d.t < to);
    return { t: Math.max(0, i * bin + bin / 2 - 2), count: inWin.length, words: topDanmaku(inWin, 3).map(([w, c]) => `${w}×${c}`) };
  });
}

/** 读 DASH 视频流开头的 sidx：每个分片（约 5 秒）的起止时间和字节范围。 */
export function parseSidx(buf, indexStart) {
  const p = indexStart;
  if (buf.toString('ascii', p + 4, p + 8) !== 'sidx') return null;
  const boxEnd = p + buf.readUInt32BE(p);
  const ver = buf[p + 8];
  const timescale = buf.readUInt32BE(p + 16);
  let q = p + 20;
  const ept = ver === 0 ? buf.readUInt32BE(q) : Number(buf.readBigUInt64BE(q));
  q += ver === 0 ? 4 : 8;
  const first = ver === 0 ? buf.readUInt32BE(q) : Number(buf.readBigUInt64BE(q));
  q += ver === 0 ? 4 : 8;
  const count = buf.readUInt16BE(q + 2);
  q += 4;
  let offset = boxEnd + first;
  let t = ept / timescale;
  const refs = [];
  for (let i = 0; i < count; i++) {
    const size = buf.readUInt32BE(q) & 0x7fffffff;
    const d = buf.readUInt32BE(q + 4) / timescale;
    refs.push({ start: t, end: t + d, from: offset, to: offset + size - 1 });
    offset += size;
    t += d;
    q += 12;
  }
  return refs;
}

// ── 视频号：BV 号、av 号、b23.tv 短链 ────────────────────────────────────
const SHORT_RE = /(?:https?:\/\/)?(?:b23\.tv|bili2233\.cn)\/[0-9A-Za-z]+/i;

/** 从一段文字（BV 号、链接、分享文案）里认出视频：{ bvid } / { aid } / { short: 短链 } / null。 */
export function parseVideoRef(text) {
  const s = String(text || '');
  const bv = s.match(/BV[0-9A-Za-z]{10}/);
  if (bv) return { bvid: bv[0] };
  const short = s.match(SHORT_RE);
  if (short) return { short: /^https?:/i.test(short[0]) ? short[0] : `https://${short[0]}` };
  const av = s.match(/(?:^|[^0-9A-Za-z])av(\d{1,12})(?![0-9])/i) || s.match(/[?&]aid=(\d{1,12})/);
  if (av) return { aid: av[1] };
  return null;
}

/**
 * 认出视频；是 b23.tv 短链就自己跟跳转（不自动跳，只读 Location，最多 3 次）拿到 BV / av 号。
 * fetchImpl 可以换成假的，方便离线测试。认不出返回 null。
 */
export async function resolveVideoRef(text, fetchImpl = fetch) {
  let ref = parseVideoRef(text);
  for (let hop = 0; ref?.short && hop < 3; hop++) {
    const r = await fetchImpl(ref.short, {
      method: 'GET',
      redirect: 'manual',
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36' },
      signal: AbortSignal.timeout(15_000),
    });
    const loc = r.headers?.get?.('location') || '';
    if (!loc) return null;
    const next = parseVideoRef(loc);
    // 跳到的地方还是短链才接着跟；跳到别处（不是视频）就算认不出
    if (!next) return null;
    ref = next;
  }
  return ref?.short ? null : ref;
}
