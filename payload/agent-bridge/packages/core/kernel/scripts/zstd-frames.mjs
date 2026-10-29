/**
 * DSH 会话存档（session.v4.jsonl.zstd）读取：每次写入追加一个 zstd 帧，
 * 而 Node 自带的解压只解第一个帧，所以先按帧头/块头把它切开再逐帧解压。
 */
import fs from 'node:fs';
import zlib from 'node:zlib';

/** Cut a buffer of concatenated zstd frames into single frames by walking the frame/block headers. */
export function splitZstdFrames(buf) {
  const frames = [];
  let p = 0;
  while (p + 4 <= buf.length) {
    const magic = buf.readUInt32LE(p);
    if (magic >= 0x184d2a50 && magic <= 0x184d2a5f) {
      // skippable frame: magic + 4-byte size + payload
      if (p + 8 > buf.length) break;
      p += 8 + buf.readUInt32LE(p + 4);
      continue;
    }
    if (magic !== 0xfd2fb528) break; // not a frame boundary: give up on the rest
    let q = p + 4;
    const fhd = buf[q++];
    const fcsFlag = fhd >> 6;
    const single = (fhd >> 5) & 1;
    const checksum = (fhd >> 2) & 1;
    const dictFlag = fhd & 3;
    if (!single) q += 1; // window descriptor
    q += [0, 1, 2, 4][dictFlag];
    q += fcsFlag === 0 ? (single ? 1 : 0) : [0, 2, 4, 8][fcsFlag];
    for (;;) {
      if (q + 3 > buf.length) {
        q = buf.length + 1; // header cut off: frame is incomplete
        break;
      }
      const h = buf[q] | (buf[q + 1] << 8) | (buf[q + 2] << 16);
      const last = h & 1;
      const type = (h >> 1) & 3;
      const size = h >> 3;
      q += 3 + (type === 1 ? 1 : size); // RLE blocks carry a single byte
      if (last) break;
    }
    if (checksum) q += 4;
    frames.push(buf.subarray(p, Math.min(q, buf.length)));
    if (q > buf.length) break;
    p = q;
  }
  return frames;
}
export function readZstd(f) {
  const frames = splitZstdFrames(fs.readFileSync(f));
  const parts = [];
  let warn = '';
  frames.forEach((fr, i) => {
    try {
      parts.push(zlib.zstdDecompressSync(fr));
    } catch (err) {
      // the bridge may be appending right now: keep what decoded cleanly
      if (i === frames.length - 1) warn = '文件末尾可能正在写入，最后一小段没读到';
      else warn = `第 ${i + 1} 段解压失败（${err.message}），已跳过`;
    }
  });
  return Promise.resolve({ text: Buffer.concat(parts).toString('utf8'), warn });
}

