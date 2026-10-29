/**
 * 生图：阿里云百炼“通义万相”文生图（跟语音用同一个 DASHSCOPE_API_KEY）。异步任务：提交 → 隔几秒查一次 → 下载。
 * 只画图不写字（中文字模型画不好），字由调用方用字体排上去。每张大概一两毛钱，从百炼账户扣。
 */
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.DASHSCOPE_HTTP || 'https://dashscope.aliyuncs.com/api/v1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 画一张图存到 out，返回 out。opts：prompt、negative、size（'1024*1024'，宽高各 512~1440）、model、apiKey、timeoutMs，
 * seed（同一个种子 + 差不多的描述，画出来的构图就差不多）、extend（让它自己把描述扩写得更细，默认开）。
 * 失败抛错（调用方自己决定退回什么）。
 */
export async function genImage(out, { prompt, negative = '', size = '1024*1024', model = 'wanx2.1-t2i-turbo', apiKey, timeoutMs = 180_000, seed, extend = true }) {
  if (!apiKey) throw new Error('没有 DASHSCOPE_API_KEY');
  const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
  const r = await fetch(`${BASE}/services/aigc/text2image/image-synthesis`, {
    method: 'POST',
    headers: { ...headers, 'X-DashScope-Async': 'enable' },
    body: JSON.stringify({ model, input: { prompt, negative_prompt: negative || undefined }, parameters: { size, n: 1, seed, prompt_extend: extend } }),
    signal: AbortSignal.timeout(30_000),
  });
  const j = await r.json().catch(() => ({}));
  const id = j?.output?.task_id;
  if (!r.ok || !id) throw new Error(`提交失败：${j?.code || r.status} ${j?.message || ''}`.trim());
  const t0 = Date.now();
  for (;;) {
    await sleep(3000);
    const q = await fetch(`${BASE}/tasks/${id}`, { headers, signal: AbortSignal.timeout(30_000) });
    const s = await q.json().catch(() => ({}));
    const st = s?.output?.task_status;
    if (st === 'SUCCEEDED') {
      const url = s.output.results?.find((x) => x.url)?.url;
      if (!url) throw new Error(`没给图：${s.output.results?.[0]?.message || ''}`);
      const img = await fetch(url, { signal: AbortSignal.timeout(60_000) });
      if (!img.ok) throw new Error(`下载失败 HTTP ${img.status}`);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, Buffer.from(await img.arrayBuffer()));
      return out;
    }
    if (st === 'FAILED' || st === 'CANCELED' || st === 'UNKNOWN') throw new Error(`生成失败：${s?.output?.code || st} ${s?.output?.message || ''}`.trim());
    if (Date.now() - t0 > timeoutMs) throw new Error('生成超时');
  }
}
