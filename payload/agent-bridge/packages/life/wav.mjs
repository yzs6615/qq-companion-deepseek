/**
 * wav 小工具：电台拼语音要用（解析、拼回去）。语音合成（tts.mjs，要 ws 包）在 speech 插件里，这两个跟那边的一样，这里带一份（跟 radio.mjs 放一起）。
 */

/** 把 wav（可能是多段拼起来的）解析成 16-bit 单声道 PCM。 */
export function parseWav(buf) {
  let rate = 24000;
  const parts = [];
  let i = 0;
  while (i + 12 <= buf.length) {
    if (buf.toString('ascii', i, i + 4) !== 'RIFF') {
      // 没有头的裸 PCM（流式分片）：直接当数据
      parts.push(buf.subarray(i));
      break;
    }
    let p = i + 12;
    let end = buf.length;
    while (p + 8 <= buf.length) {
      const id = buf.toString('ascii', p, p + 4);
      let size = buf.readUInt32LE(p + 4);
      if (id === 'fmt ') rate = buf.readUInt32LE(p + 12);
      if (id === 'data') {
        // 流式输出时 data 长度常常写成 0 或 0xFFFFFFFF：取到下一个 RIFF 或结尾
        const next = buf.indexOf('RIFF', p + 8, 'ascii');
        const limit = next > 0 ? next : buf.length;
        if (!size || size === 0xffffffff || p + 8 + size > limit) size = limit - (p + 8);
        parts.push(buf.subarray(p + 8, p + 8 + size));
        end = p + 8 + size;
        break;
      }
      p += 8 + size + (size & 1);
    }
    i = end;
  }
  const pcm = Buffer.concat(parts);
  const samples = new Int16Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + (pcm.length & ~1)));
  return { rate, samples };
}

export function makeWav(samples, rate) {
  const data = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii');
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVEfmt ', 8, 'ascii');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36, 'ascii');
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}
