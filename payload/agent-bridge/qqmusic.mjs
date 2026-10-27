/**
 * 用电脑上的 QQ 音乐放歌：先在 QQ 音乐搜歌拿到歌曲 id，再让客户端按 id 点播。
 * 点播用的是 QQ 音乐自己的命令行：QQMusic.exe /playbysongid cmd_count==1&&id_0==<歌曲id>&&songtype_0==0
 * （客户端里拼 tencent://QQMusic/ 链接用的也是这个格式；开着就交给开着的那个，没开就先打开再放）。
 * bridge 是用管理员权限跑的：直接起 QQ 音乐会变成管理员进程，以后用户自己开的 QQ 音乐就跟它说不上话。
 * 所以写一个快捷方式，交给 explorer 去打开——跟用户双击快捷方式一样，用普通权限起。
 * 测试用：QQMUSIC_SEARCH_FILE（不联网，读这个 JSON 当搜索结果）、PLAY_MUSIC_LOG（不真的放，记一行）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const UA = { referer: 'https://y.qq.com/', 'user-agent': 'Mozilla/5.0' };

/** QQ 音乐搜歌 → [{ id, mid, name, singer }]；搜不到给空数组，网络出错抛错。 */
export async function searchSong(query, { file } = {}) {
  if (file) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const url = `https://c.y.qq.com/soso/fcgi-bin/client_search_cp?format=json&p=1&n=8&w=${encodeURIComponent(query)}`;
  const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const list = (await r.json())?.data?.song?.list || [];
  return list
    .filter((s) => s.songid && s.songmid)
    .map((s) => ({ id: Number(s.songid), mid: String(s.songmid), name: String(s.songname || ''), singer: (s.singer || []).map((x) => x.name).join('/') }));
}

/** 挑最像的那首：歌名对得上、歌手对得上的优先；没要 Live / 伴奏 / DJ 版就别挑这些。 */
export function pickSong(list, query) {
  const q = String(query).toLowerCase();
  const wantOdd = /live|现场|伴奏|dj|remix|翻唱|cover/i.test(q);
  let best = null;
  let bestScore = -Infinity;
  list.forEach((s, i) => {
    const name = s.name.toLowerCase();
    const base = name.replace(/\s*[（(][^)）]*[)）]\s*/g, '').trim();
    let score = -i; // 越靠前越好
    if (base && q.includes(base)) score += 20 + base.length;
    if (s.singer && s.singer.split('/').some((x) => x && q.includes(x.toLowerCase()))) score += 10;
    if (!wantOdd && /live|现场|伴奏|dj|remix|翻唱|cover|片段/i.test(name)) score -= 15;
    if (score > bestScore) [best, bestScore] = [s, score];
  });
  return best;
}

export const songUrl = (mid) => `https://y.qq.com/n/ryqq/songDetail/${mid}`;
export const playArgs = (id) => `/playbysongid cmd_count==1&&id_0==${Number(id)}&&songtype_0==0`;

const psq = (s) => `'${String(s).replace(/'/g, "''")}'`;
function hiddenPs(script) {
  spawn('powershell', ['-NoProfile', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

/** 用普通权限打开程序：程序 + 参数写进快捷方式，交给 explorer。 */
function openAsUser(dir, exe, args) {
  fs.mkdirSync(dir, { recursive: true });
  const lnk = path.join(dir, 'play.lnk');
  hiddenPs(
    `$s = (New-Object -ComObject WScript.Shell).CreateShortcut(${psq(lnk)}); $s.TargetPath = ${psq(exe)}; $s.Arguments = ${psq(args)}; $s.WindowStyle = 7; $s.Save(); ` +
      `Start-Process explorer.exe -ArgumentList ${psq(`"${lnk}"`)}`,
  );
}

/** 在 QQ 音乐客户端里放这首。没装 QQ 音乐就返回 false。 */
export function playInClient(song, { exe, dir, log } = {}) {
  if (log) return fs.appendFileSync(log, `client ${playArgs(song.id)}\n`), true;
  if (!exe || !fs.existsSync(exe)) return false;
  openAsUser(dir, exe, playArgs(song.id));
  return true;
}

/** 退一步：在浏览器里打开 QQ 音乐网页版这首歌的页面（也经 explorer，用普通权限开默认浏览器）。 */
export function openSongPage(song, { log } = {}) {
  if (log) return void fs.appendFileSync(log, `web ${songUrl(song.mid)}\n`);
  hiddenPs(`Start-Process explorer.exe -ArgumentList ${psq(`"${songUrl(song.mid)}"`)}`);
}
