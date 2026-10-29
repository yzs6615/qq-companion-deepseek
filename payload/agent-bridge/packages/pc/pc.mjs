/**
 * 电脑室友：她“住在这台电脑里”，能看见电脑上的几件事——在放什么歌、开着什么游戏、电脑开了多久、人还在不在电脑前。
 * 只认这几样：音乐软件的窗口标题、认识的游戏（或者 Steam / Epic / WeGame 目录里的程序）、开机时间、键盘鼠标多久没动。
 * 别的窗口在 PowerShell 那一步就过滤掉，标题不进 node、不进日志。
 * PC_SNAPSHOT_FILE（测试用）：不跑 PowerShell，直接读这个 JSON（格式跟 PowerShell 输出的一样）。
 */
import fs from 'node:fs';
import { execFile } from 'node:child_process';

// 进程名（小写，不带 .exe）→ 软件 / 游戏叫什么
const MUSIC = { cloudmusic: '网易云音乐', qqmusic: 'QQ音乐', kugou: '酷狗音乐', kwmusic: '酷我音乐', spotify: 'Spotify', foobar2000: 'foobar2000', applemusic: 'Apple Music' };
const MUSIC_IDLE = /^(网易云音乐|QQ音乐.*|酷狗音乐|酷我音乐|Spotify( Premium| Free)?|foobar2000.*|Apple Music)$/i; // 没在放歌时的标题
const GAMES = {
  'league of legends': '英雄联盟', yuanshen: '原神', genshinimpact: '原神', starrail: '星穹铁道', zenlesszonezero: '绝区零',
  'valorant-win64-shipping': '无畏契约', cs2: 'CS2', dota2: 'Dota 2', tslgame: 'PUBG', narakabladepoint: '永劫无间',
  overwatch: '守望先锋', r5apex: 'Apex 英雄', r5apex_dx12: 'Apex 英雄', bh3: '崩坏3', dwrg: '第五人格', crossfire: '穿越火线',
  dnf: '地下城与勇士', wow: '魔兽世界', hearthstone: '炉石传说', 'b1-win64-shipping': '黑神话：悟空', eldenring: '艾尔登法环',
};
const NOT_GAME = /wallpaper_engine|steamworks|steamvr|soundpad|lossless scaling|redist/i;

const PS = `$ErrorActionPreference = 'SilentlyContinue'
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class QqbIdle { [StructLayout(LayoutKind.Sequential)] struct L { public uint s; public uint t; } [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref L p); public static long Ms() { var l = new L(); l.s = (uint)Marshal.SizeOf(l); GetLastInputInfo(ref l); return (long)(uint)(Environment.TickCount - (int)l.t); } }'
$names = @(${[...Object.keys(MUSIC), ...Object.keys(GAMES)].map((n) => `'${n}'`).join(',')})
$w = Get-Process | Where-Object { $_.MainWindowTitle -and (($names -contains $_.ProcessName.ToLower()) -or ($_.Path -match '\\\\steamapps\\\\common\\\\|\\\\Epic Games\\\\|\\\\WeGameApps\\\\') -or ($_.ProcessName -eq 'javaw' -and $_.MainWindowTitle -like 'Minecraft*')) } | ForEach-Object { [pscustomobject]@{ p = $_.ProcessName; t = $_.MainWindowTitle; path = $_.Path; s = $(try { $_.StartTime.ToString('o') } catch { '' }) } }
$boot = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToString('o')
[pscustomobject]@{ idleMs = [QqbIdle]::Ms(); boot = $boot; w = @($w) } | ConvertTo-Json -Compress -Depth 3`;

function rawSnapshot() {
  const file = process.env.PC_SNAPSHOT_FILE;
  if (file) return Promise.resolve(JSON.parse(fs.readFileSync(file, 'utf8')));
  return new Promise((resolve, reject) => {
    const enc = Buffer.from(PS, 'utf16le').toString('base64');
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc], { windowsHide: true, timeout: 30_000, maxBuffer: 1 << 20 }, (err, out) => {
      if (err) return reject(err);
      try {
        resolve(JSON.parse(String(out).trim()));
      } catch (e) {
        reject(e);
      }
    });
  });
}

/** 现在电脑上：{ music: { app, title } | null, game: { name, since } | null, idleSec, bootAt, at }；拿不到就抛错。 */
export async function pcSnapshot() {
  const j = await rawSnapshot();
  const wins = Array.isArray(j?.w) ? j.w : j?.w ? [j.w] : [];
  let music = null;
  let game = null;
  for (const w of wins) {
    const p = String(w.p || '').toLowerCase();
    const t = String(w.t || '').trim();
    if (!t) continue;
    if (!music && MUSIC[p] && / [-–] /.test(t) && !MUSIC_IDLE.test(t)) music = { app: MUSIC[p], title: t.slice(0, 80) };
    if (game) continue;
    const dir = String(w.path || '').match(/\\(?:steamapps\\common|Epic Games|WeGameApps)\\([^\\]+)\\/i)?.[1];
    const name = GAMES[p] || (p === 'javaw' && /^Minecraft/i.test(t) ? 'Minecraft' : '') || (dir && !NOT_GAME.test(dir) ? t || dir : '');
    if (name) game = { name: name.slice(0, 40), since: Date.parse(w.s) || Date.now() };
  }
  const boot = Date.parse(j?.boot);
  return { music, game, idleSec: Math.round((Number(j?.idleMs) || 0) / 1000), bootAt: Number.isFinite(boot) ? boot : 0, at: Date.now() };
}
