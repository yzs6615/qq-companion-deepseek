/**
 * 用电脑上的 QQ 音乐放歌：先在 QQ 音乐搜歌挑出原版，再在客户端界面上搜这首、点第一条的播放，最后看系统媒体控制确认真的在放。
 * 以前用的点播命令 QQMusic.exe /playbysongid cmd_count==1&&id_0==<id>&&songtype_0==0 在 v22 的客户端上不灵了：
 * 收到后会清空播放队列，但取不到歌（换了七八种参数都一样），后台 PostMessage 点界面也没反应，界面又没有 UI Automation 元素。
 * 所以只能真的点：把 QQ 音乐叫到前台，点搜索框、输歌名歌手、回车，认字找到这首那一行，悬停再点它封面上的播放按钮；
 * 鼠标位置和原来的前台窗口点完放回去，前后几秒。搜索框的坐标是按 100% 缩放量的（480,37，相对窗口左上角），按系统 DPI 换算。
 * 确认用系统媒体控制（SMTC）：QQ 音乐会把正在放的歌名、歌手、播放状态报给 Windows，比看窗口标题准。
 * bridge 是用管理员权限跑的：直接起 QQ 音乐会变成管理员进程，以后用户自己开的 QQ 音乐就跟它说不上话。
 * 所以没开时写一个快捷方式，交给 explorer 去打开——跟用户双击快捷方式一样，用普通权限起。
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
/** 在客户端里搜的词：歌名 + 歌手（多个歌手用空格隔开） */
export const clientQuery = (song) => `${song.name} ${song.singer.split(/[/;]/).join(' ')}`.trim();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const psq = (s) => `'${String(s).replace(/'/g, "''")}'`;
const encoded = (script) => Buffer.from(script, 'utf16le').toString('base64');
function hiddenPs(script) {
  spawn('powershell', ['-NoProfile', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded(script)], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}
/** 跑一段 PowerShell 等它结束 → { code, out } */
function runPs(script, timeoutMs) {
  return new Promise((resolve) => {
    const p = spawn('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded(`[Console]::OutputEncoding = [Text.Encoding]::UTF8\n$ProgressPreference = 'SilentlyContinue'\n${script}`)], { windowsHide: true });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    const t = setTimeout(() => p.kill(), timeoutMs);
    // 出错时把 stderr 也带上（去掉 PowerShell 的 CLIXML 进度噪音）
    p.on('close', (code) => (clearTimeout(t), resolve({ code: code ?? -1, out: (code ? `${out}\n${err.replace(/#< CLIXML|<Objs[\s\S]*?<\/Objs>/g, '')}` : out).trim() })));
    p.on('error', (err) => (clearTimeout(t), resolve({ code: -1, out: err.message })));
  });
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

// 点 QQ 音乐界面用的 Win32 小工具：找主窗口（TXGuiFoundation 里最大的那个）、换前台、悬停再点、输 Unicode 字
const UI_TYPES = `
Add-Type @'
using System; using System.Runtime.InteropServices; using System.Threading;
public class Q {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  public delegate bool CB(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(CB cb, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, System.Text.StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool f);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool GetWindowPlacement(IntPtr h, ref PLACEMENT p);
  [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr h);
  [DllImport("gdi32.dll")] static extern int GetDeviceCaps(IntPtr dc, int i);
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint f);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint f, UIntPtr x);
  [DllImport("user32.dll")] static extern void mouse_event(uint f, int x, int y, uint d, UIntPtr x2);
  [DllImport("user32.dll")] static extern uint SendInput(uint n, INPUT[] i, int size);
  public struct RECT { public int L, T, R, B; }
  public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] struct PLACEMENT { public int len, flags, show; public POINT min, max; public RECT normal; }
  [StructLayout(LayoutKind.Sequential)] struct KI { public ushort vk, scan; public uint flags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct MI { public int dx, dy; public uint data, flags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Explicit)] struct U { [FieldOffset(0)] public KI k; [FieldOffset(0)] public MI m; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public U u; }

  public static double Scale() { return GetDeviceCaps(GetDC(IntPtr.Zero), 88) / 96.0; }
  public static IntPtr Find(uint pid) {
    IntPtr best = IntPtr.Zero; long area = 0;
    EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p); if (p != pid) return true;
      var s = new System.Text.StringBuilder(64); GetClassName(h, s, 64);
      if (s.ToString() != "TXGuiFoundation") return true;
      // 按还原后的大小比：最小化的主窗口 GetWindowRect 只剩一小条
      var pl = new PLACEMENT { len = Marshal.SizeOf(typeof(PLACEMENT)) }; GetWindowPlacement(h, ref pl);
      RECT r = pl.normal; long a = (long)(r.R - r.L) * (r.B - r.T);
      if (a > area) { area = a; best = h; } return true;
    }, IntPtr.Zero);
    return best;
  }
  // 后台进程换前台：先挂到当前前台窗口的输入队列上再换；不行再按住 Alt 换（松 Alt 时前台已经是目标窗口）
  public static bool Front(IntPtr h) {
    uint dummy, fg = GetWindowThreadProcessId(GetForegroundWindow(), out dummy), me = GetCurrentThreadId();
    if (fg != 0 && fg != me) AttachThreadInput(me, fg, true);
    SetForegroundWindow(h); BringWindowToTop(h);
    if (fg != 0 && fg != me) AttachThreadInput(me, fg, false);
    for (int i = 0; i < 2 && GetForegroundWindow() != h; i++) {
      keybd_event(0x12, 0, 0, UIntPtr.Zero); SetForegroundWindow(h); keybd_event(0x12, 0, 2, UIntPtr.Zero); Thread.Sleep(200);
    }
    Thread.Sleep(150);
    return GetForegroundWindow() == h;
  }
  public static bool Owns(IntPtr h, int x, int y) { var p = new POINT { X = x, Y = y }; return GetAncestor(WindowFromPoint(p), 2) == h; }
  public static void Click(int x, int y) {
    SetCursorPos(x, y); Thread.Sleep(300); // 先悬停，行上的播放按钮才会出来
    mouse_event(2, 0, 0, 0, UIntPtr.Zero); Thread.Sleep(50); mouse_event(4, 0, 0, 0, UIntPtr.Zero);
  }
  public static void Key(byte vk, int times) {
    for (int i = 0; i < times; i++) { keybd_event(vk, 0, 0, UIntPtr.Zero); keybd_event(vk, 0, 2, UIntPtr.Zero); }
  }
  public static void Type(string s) {
    foreach (char c in s) {
      var a = new INPUT[2];
      a[0].type = 1; a[0].u.k.scan = c; a[0].u.k.flags = 4; // KEYEVENTF_UNICODE
      a[1].type = 1; a[1].u.k.scan = c; a[1].u.k.flags = 4 | 2;
      SendInput(2, a, Marshal.SizeOf(typeof(INPUT))); Thread.Sleep(15);
    }
  }
}
'@
[Q]::SetProcessDPIAware() | Out-Null
$proc = Get-Process QQMusic -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $proc) { 'norun'; exit 2 }
$h = [Q]::Find([uint32]$proc.Id)
if ($h -eq [IntPtr]::Zero) { 'nowin'; exit 3 }
`;

// PowerShell 里等 WinRT 的异步调用（系统媒体控制、文字识别都要用）
const WINRT = `
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' } | Select-Object -First 1
function Await($op, $t) { $task = $asTask.MakeGenericMethod($t).Invoke($null, @($op)); $task.Wait(10000) | Out-Null; $task.Result }
`;

/** 歌名比对用：小写、去空白、去掉括号里的版本说明 */
const normName = (s) => String(s || '').replace(/\s*[（(].*$/, '').toLowerCase().replace(/\s+/g, '');

/**
 * 界面上搜 query，在结果里找歌名是 name 的那一行，点它封面上的播放。
 * 结果列表上面有时是一行“搜索…/你要找的是不是…”，有时是一张歌手卡片，第一条的高度不固定，
 * 所以截 QQ 音乐窗口用 Windows 自带的中文文字识别：先找“歌名/歌手”表头，再往下找歌名对得上的那行（不带括号版本的优先）。
 * 退出码：0 点了，2 没开，3 没窗口，4 叫不到前台，5 被挡住，6 窗口太小（迷你模式），7 结果里没认出这首，8 系统没有中文文字识别
 */
const uiScript = (query, name, probe) =>
  UI_TYPES +
  (probe
    ? 'exit 0'
    : WINRT +
      `
Add-Type -AssemblyName System.Drawing
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime]
$null = [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]
$ocr = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage((New-Object Windows.Globalization.Language 'zh-Hans-CN'))
if (-not $ocr) { 'noocr'; exit 8 }
# 截列表那块（左边栏、顶栏、底下播放条不要），放大两倍、转灰度反色成白底黑字再认——深色界面上的小灰字直接认不出来
$gray = [single[][]]@([single[]]@(-0.3, -0.3, -0.3, 0, 0), [single[]]@(-0.59, -0.59, -0.59, 0, 0), [single[]]@(-0.11, -0.11, -0.11, 0, 0), [single[]]@(0, 0, 0, 1, 0), [single[]]@(1, 1, 1, 0, 1))
function Read-Lines {
  $x0 = [int](232 * $s); $y0 = [int](60 * $s)
  $bmp = New-Object Drawing.Bitmap ([int](($r.R - $r.L) * 0.7) - $x0), ($r.B - $r.T - [int](90 * $s) - $y0)
  [Drawing.Graphics]::FromImage($bmp).CopyFromScreen($r.L + $x0, $r.T + $y0, 0, 0, $bmp.Size)
  $big = New-Object Drawing.Bitmap ($bmp.Width * 2), ($bmp.Height * 2)
  $g = [Drawing.Graphics]::FromImage($big); $g.InterpolationMode = 'HighQualityBicubic'
  $ia = New-Object Drawing.Imaging.ImageAttributes; $ia.SetColorMatrix((New-Object Drawing.Imaging.ColorMatrix (, $gray)))
  $g.DrawImage($bmp, (New-Object Drawing.Rectangle 0, 0, $big.Width, $big.Height), 0, 0, $bmp.Width, $bmp.Height, [Drawing.GraphicsUnit]::Pixel, $ia)
  $ms = New-Object IO.MemoryStream; $big.Save($ms, [Drawing.Imaging.ImageFormat]::Bmp); $ms.Position = 0
  $dec = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync([System.IO.WindowsRuntimeStreamExtensions]::AsRandomAccessStream($ms))) ([Windows.Graphics.Imaging.BitmapDecoder])
  $sb = Await ($dec.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $res = Await ($ocr.RecognizeAsync($sb)) ([Windows.Media.Ocr.OcrResult])
  foreach ($l in $res.Lines) {
    $b = @($l.Words)[0].BoundingRect
    [pscustomobject]@{ x = $r.L + $x0 + $b.X / 2; y = $r.T + $y0 + ($b.Y + $b.Height / 2) / 2; t = ($l.Text -replace '\\s', '').ToLower() }
  }
}
$want = ${psq(name)}
if ([Q]::IsIconic($h) -or -not [Q]::IsWindowVisible($h)) { [Q]::ShowWindow($h, 9) | Out-Null; Start-Sleep -Milliseconds 800 }
$prev = [Q]::GetForegroundWindow(); $cur = New-Object Q+POINT; [Q]::GetCursorPos([ref]$cur) | Out-Null
try {
  if (-not [Q]::Front($h)) { 'nofront'; exit 4 }
  $r = New-Object Q+RECT; $s = [Q]::Scale()
  for ($i = 0; $i -lt 10; $i++) { # 最小化的窗口还原有动画，等它变回原来的大小
    if ([Q]::IsIconic($h)) { [Q]::ShowWindow($h, 9) | Out-Null }
    [Q]::GetWindowRect($h, [ref]$r) | Out-Null
    if (($r.R - $r.L) -ge 860 * $s -and ($r.B - $r.T) -ge 560 * $s) { break }
    Start-Sleep -Milliseconds 200
  }
  if (($r.R - $r.L) -lt 860 * $s -or ($r.B - $r.T) -lt 560 * $s) { 'small'; exit 6 }
  Start-Sleep -Milliseconds 200
  $bx = [int]($r.L + 480 * $s); $by = [int]($r.T + 37 * $s)
  if (-not ([Q]::Owns($h, $bx, $by) -and [Q]::Owns($h, [int]($r.L + 400 * $s), [int]($r.T + 400 * $s)))) { 'covered'; exit 5 }
  [Q]::Click($bx, $by); Start-Sleep -Milliseconds 300
  [Q]::Key(0x23, 1); [Q]::Key(0x08, 60) # End + 退格清掉上次搜的
  [Q]::Type(${psq(query)}); Start-Sleep -Milliseconds 200; [Q]::Key(0x0D, 1)
  # 连着两次认到同一个位置才算：刚回车时屏幕上可能还是上次的结果，点下去的那一刻列表才重新排版
  $hit = $null; $last = $null
  for ($i = 0; $i -lt 10 -and -not $hit; $i++) {
    Start-Sleep -Milliseconds 700
    $lines = @(Read-Lines)
    $head = $lines | Where-Object { $_.t -match '歌名|名/|/歌手' } | Select-Object -First 1 # “歌名/歌手”常被认成“歇名/歌手”
    if (-not $head) { $last = $null; continue }
    # 歌名那一列：表头下面、比表头往右 30~90 像素起头的行（左边是封面）
    $rows = @($lines | Where-Object { $_.y -gt $head.y + 15 * $s -and $_.x -gt $head.x + 30 * $s -and $_.x -lt $head.x + 90 * $s } | Sort-Object y)
    $named = @($rows | Where-Object { $_.t.Contains($want) })
    $cand = @($named | Where-Object { $_.t.Substring($_.t.IndexOf($want) + $want.Length) -notmatch '^[(（]' }) + $named | Select-Object -First 1
    if ($cand -and $last -and [Math]::Abs($cand.y - $last.y) -lt 4 -and $cand.t -eq $last.t) { $hit = $cand }
    $last = $cand
  }
  if (-not $hit) { 'nofound ' + (($lines | Select-Object -First 14 | ForEach-Object { "$([int]$_.x - $r.L),$([int]$_.y - $r.T):$($_.t)" }) -join ' | '); exit 7 }
  $px = [int]($head.x + 18 * $s); $py = [int]($hit.y + 10 * $s) # 封面中间：比歌名那行低 10 像素
  if (-not [Q]::Owns($h, $px, $py)) { 'covered'; exit 5 }
  [Q]::Click($px, $py); "clicked $($hit.t)"
} finally {
  [Q]::SetCursorPos($cur.X, $cur.Y) | Out-Null
  if ($prev -ne [IntPtr]::Zero -and $prev -ne $h) { [Q]::Front($prev) | Out-Null }
}`);

const SMTC =
  WINRT +
  `
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
$mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
foreach ($s in $mgr.GetSessions()) {
  if ($s.SourceAppUserModelId -notmatch 'QQMusic') { continue }
  $p = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
  [pscustomobject]@{ status = "$($s.GetPlaybackInfo().PlaybackStatus)"; title = $p.Title; artist = $p.Artist } | ConvertTo-Json -Compress
}`;

/** QQ 音乐现在在放什么（系统媒体控制里读）→ { status: 'Playing'|'Paused'|…, title, artist }；没有就 null */
export async function nowPlaying() {
  const { out } = await runPs(SMTC, 20_000);
  try {
    return JSON.parse(out.split('\n').find((l) => l.startsWith('{')) || 'null');
  } catch {
    return null;
  }
}

/** 系统媒体控制里正在放的是不是这首：在放、歌名对得上（版本也对：要原版就不能是 Live / DJ 版）；报了歌手的话至少一个歌手对得上 */
export function isPlaying(np, song) {
  if (!np || np.status !== 'Playing') return false;
  const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, '');
  const base = norm(song.name.replace(/\s*[（(].*$/, ''));
  if (!base || !norm(np.title).includes(base)) return false;
  const version = (s) => (String(s).match(/[（(]([^)）]*)[)）]/)?.[1] || '').toLowerCase().replace(/\s+/g, '');
  if (version(np.title) !== version(song.name)) return false;
  const artist = norm(np.artist);
  return !artist || song.singer.split(/[/;]/).some((x) => x && (artist.includes(norm(x)) || norm(x).includes(artist)));
}

const UI_FAIL = {
  2: 'QQ 音乐没开起来',
  3: '没找到 QQ 音乐的窗口',
  4: '叫不到前台',
  5: 'QQ 音乐被别的窗口挡住了',
  6: 'QQ 音乐是迷你模式',
  7: '搜索结果里没认出这首',
  8: '系统没有中文文字识别',
};

/**
 * 在 QQ 音乐客户端里放这首，放起来了才算 → { ok, why }。
 * 已经在放这首就不动（再点一下会变成暂停）；没开就用普通权限打开、等窗口出来；点完等 10 秒，系统媒体控制里看到在放这首才 ok。
 */
export async function playInClient(song, { exe, dir, log } = {}) {
  const query = clientQuery(song);
  if (log) return fs.appendFileSync(log, `client ${query}\n`), { ok: true };
  if (!exe || !fs.existsSync(exe)) return { ok: false, why: '没装 QQ 音乐' };
  if (isPlaying(await nowPlaying(), song)) return { ok: true };
  if ((await runPs(uiScript('', '', true), 30_000)).code === 2) {
    openAsUser(dir, exe, '');
    let up = false;
    for (let i = 0; i < 10 && !up; i++) await sleep(3000), (up = (await runPs(uiScript('', '', true), 30_000)).code === 0);
    if (!up) return { ok: false, why: UI_FAIL[2] };
    await sleep(5000); // 窗口出来了界面还在加载
  }
  const r = await runPs(uiScript(query, normName(song.name)), 60_000);
  if (r.code !== 0) return { ok: false, why: UI_FAIL[r.code] ? (r.code === 7 ? `${UI_FAIL[7]}（${r.out.slice(-300)}）` : UI_FAIL[r.code]) : `点界面出错（${r.out.slice(-120)}）` };
  for (let i = 0; i < 5; i++) {
    await sleep(2000);
    if (isPlaying(await nowPlaying(), song)) return { ok: true };
  }
  const np = await nowPlaying();
  const clicked = r.out.match(/clicked (.*)/)?.[1] || '';
  return { ok: false, why: `点了“${clicked}”那行，但系统里${np ? `显示的是《${np.title}》${np.status}` : '没看到 QQ 音乐在放'}` };
}
