/**
 * 语音：阿里云百炼 CosyVoice（复刻音色）合成 → 去掉句尾杂音 → 24kHz 单声道 wav。
 * 只用 ws 依赖，不需要 ffmpeg；NapCat 发语音时自己转 silk。
 */
import WebSocket from 'ws';
import crypto from 'node:crypto';

const WS_URL = 'wss://dashscope.aliyuncs.com/api-ws/v1/inference';

/** 调 CosyVoice 合成一段话，返回原始 wav Buffer。 */
export function synthesize(text, { url = WS_URL, apiKey, voice, model = 'cosyvoice-v3.5-flash', sampleRate = 24000, rate = 1, volume = 50, timeoutMs = 30_000, instruction = '' } = {}) {
  return new Promise((resolve, reject) => {
    if (!apiKey || !voice) return reject(new Error('缺 DASHSCOPE_API_KEY 或 VOICE_ID'));
    const taskId = crypto.randomUUID().replace(/-/g, '');
    const ws = new WebSocket(url, { headers: { Authorization: `bearer ${apiKey}`, 'X-DashScope-DataInspection': 'enable' } });
    const chunks = [];
    let settled = false;
    const done = (err, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      err ? reject(err) : resolve(val);
    };
    const timer = setTimeout(() => done(new Error('语音合成超时')), timeoutMs);
    const header = (action) => ({ action, task_id: taskId, streaming: 'duplex' });
    ws.on('open', () => {
      ws.send(JSON.stringify({
        header: header('run-task'),
        payload: {
          task_group: 'audio', task: 'tts', function: 'SpeechSynthesizer', model,
          // instruction：一句话指定语气，比如“你说话的情感是angry。”（v3.5 的复刻音色也认）
          parameters: { text_type: 'PlainText', voice, format: 'wav', sample_rate: sampleRate, volume, rate, pitch: 1, ...(instruction ? { instruction } : {}) },
          input: {},
        },
      }));
    });
    ws.on('message', (data, isBinary) => {
      if (isBinary) return void chunks.push(Buffer.from(data));
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      const ev = msg.header?.event;
      if (ev === 'task-started') {
        ws.send(JSON.stringify({ header: header('continue-task'), payload: { input: { text } } }));
        ws.send(JSON.stringify({ header: header('finish-task'), payload: { input: {} } }));
      } else if (ev === 'task-finished') {
        done(null, Buffer.concat(chunks));
      } else if (ev === 'task-failed') {
        done(new Error(`语音合成失败：${msg.header?.error_code || ''} ${msg.header?.error_message || ''}`.trim()));
      }
    });
    ws.on('error', (err) => done(err));
    ws.on('close', () => done(new Error('语音连接断了')));
  });
}

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

/** 每 frameMs 一帧的响度（dBFS）。 */
function frameDb(samples, rate, frameMs) {
  const n = Math.max(1, Math.round((rate * frameMs) / 1000));
  const out = [];
  for (let i = 0; i < samples.length; i += n) {
    let s = 0;
    const end = Math.min(samples.length, i + n);
    for (let j = i; j < end; j++) s += samples[j] * samples[j];
    out.push(10 * Math.log10(s / (end - i) / 1073741824 + 1e-12));
  }
  return { db: out, n };
}

/**
 * 去掉开头结尾的杂音：
 * 1. 按响度找“真在说话”的范围（比最响处低 35dB 以内，且不低于 -50dB），前留 80ms、后留 150ms；
 * 2. 末尾如果有一小段跟正文隔着 ≥300ms 静音、又明显比正文小声的尾巴（≤2.5s），整段扔掉；
 * 3. 再按 cutMs 硬剪掉末尾（复刻音色固定带尾巴杂音时用），最后 60ms 淡出，免得“咔”一声。
 */
export function cleanEdges(samples, rate, { cutMs = 0 } = {}) {
  const frameMs = 20;
  const { db, n } = frameDb(samples, rate, frameMs);
  if (!db.length) return samples;
  const peak = Math.max(...db);
  const th = Math.max(peak - 35, -50);
  const loud = db.map((d) => d >= th);
  let first = loud.indexOf(true);
  let last = loud.lastIndexOf(true);
  if (first < 0) return samples;

  // 找末尾“隔着静音的小声尾巴”
  const gapFrames = Math.round(300 / frameMs);
  const tailMax = Math.round(2500 / frameMs);
  for (let guard = 0; guard < 3; guard++) {
    let k = last;
    while (k > first && loud[k]) k--; // 尾巴的开头
    let g = k;
    while (g > first && !loud[g]) g--; // 静音之前正文的结尾
    const tailLen = last - k;
    const gap = k - g;
    if (g <= first || gap < gapFrames || tailLen > tailMax) break;
    // 正文的“一般音量”：尾巴之前那些在说话的帧取中位数
    const speech = db.slice(first, g + 1).filter((d) => d >= th).sort((a, b) => a - b);
    const median = speech[Math.floor(speech.length / 2)] ?? peak;
    const tail = db.slice(k + 1, last + 1);
    const tailMean = tail.reduce((a, b) => a + b, 0) / tail.length;
    if (tailMean > median - 10) break; // 跟正文差不多响，多半是真话
    last = g;
  }

  const start = Math.max(0, first * n - Math.round(rate * 0.08));
  let end = Math.min(samples.length, (last + 1) * n + Math.round(rate * 0.15));
  if (cutMs > 0) end = Math.max(start + Math.round(rate * 0.3), end - Math.round((rate * cutMs) / 1000));
  const out = samples.slice(start, end);
  const fade = Math.min(out.length, Math.round(rate * 0.06));
  for (let i = 0; i < fade; i++) out[out.length - fade + i] = Math.round(out[out.length - fade + i] * (1 - (i + 1) / fade));
  return out;
}

/**
 * 有声部分的平均响度（dBFS）超过 maxDb 就整段压下来，只压不抬。
 * 带语气指令合成的比平常响十几分贝，不压的话一生气就突然很大声。
 */
export function capLevel(samples, rate, maxDb) {
  const voiced = frameDb(samples, rate, 20).db.filter((d) => d > -34);
  if (!voiced.length) return samples;
  const mean = 10 * Math.log10(voiced.reduce((a, d) => a + 10 ** (d / 10), 0) / voiced.length);
  if (mean <= maxDb) return samples;
  const k = 10 ** ((maxDb - mean) / 20);
  return Int16Array.from(samples, (v) => Math.round(v * k));
}

/** 合成 + 去杂音，返回能直接发 QQ 语音的 wav Buffer 和时长。opts.maxDb：再按 capLevel 压一下音量。 */
export async function speak(text, opts = {}) {
  const raw = await synthesize(text, opts);
  const { rate, samples } = parseWav(raw);
  if (!samples.length) throw new Error('语音合成没出声');
  let clean = opts.trim === false ? samples : cleanEdges(samples, rate, { cutMs: opts.cutMs || 0 });
  if (Number.isFinite(opts.maxDb)) clean = capLevel(clean, rate, opts.maxDb);
  return { wav: makeWav(clean, rate), seconds: clean.length / rate, rawSeconds: samples.length / rate };
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
