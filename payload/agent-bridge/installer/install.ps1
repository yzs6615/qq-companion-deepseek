# QQ 机器人一键安装：选位置 → 填名字/QQ/key → 勾功能 → 自动装好 → 桌面快捷方式。
# 在线包只带代码，Node.js、DSH、NapCat 安装时在线下载（可选国内镜像）；离线包（根目录有 runtime.zip）自带 Node.js 和 DSH。
# NapCat 两种包都不带：装的时候打开官网下载链接，你在浏览器里下好，安装器自己找到、解开、配置。
#   -Answers <json>   不弹窗，按 json 里的答案装（测试 / 批量用）
#   -Cache <dir>      先在这个目录里找已经下好的文件（按文件名），找不到再下载
#   -Shot <dir>       每个页面截一张图（检查界面用）；再加 -Answers 就按答案在界面上真装一遍，装的过程也截图
#   -NoElevate        不请求管理员（测试用；装 Node.js 时会失败）
param([string]$Answers = '', [string]$Cache = '', [string]$Shot = '', [switch]$NoElevate)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$here    = $PSScriptRoot
$payload = Join-Path (Split-Path $here) 'payload'
$unattended = [bool]$Answers -and -not $Shot

function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}
if (-not $unattended -and -not $NoElevate -and -not (Test-Admin)) {
  $a = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-File', "`"$PSCommandPath`"")
  if ($Cache) { $a += @('-Cache', "`"$Cache`"") }
  if ($Shot) { $a += @('-Shot', "`"$Shot`"") }
  if ($Answers) { $a += @('-Answers', "`"$Answers`"") }
  Start-Process powershell -Verb RunAs -ArgumentList $a
  exit
}

# ── 功能清单 ─────────────────────────────────────────────────────────────
# id、名字、默认勾不勾、要下载多少（MB）、功能卡片上的一句话、鼠标停在卡片上看的完整说明
$Features = @(
  @{ id = 'memory';    name = '记性、日记和回访'; def = $true;  mb = 0;   short = '记住聊过的事，睡前写日记';        desc = '记住聊过的事，每天睡前写日记当长期记忆；过两天自然地问一句；会学对方的口头禅' }
  @{ id = 'proactive'; name = '主动找你';         def = $true;  mb = 0;   short = '早安晚安，好久没聊会冒个泡';      desc = '早安晚安、好久没聊冒个泡；被冷落了会有点小情绪' }
  @{ id = 'autonomy';  name = '自己找事做';       def = $true;  mb = 0;   short = '没人理时自己找事干，慢慢有了喜好'; desc = '没人理它时自己找点事干，睡前回想，慢慢长出自己的喜好和性格' }
  @{ id = 'stickers';  name = '表情包';           def = $true;  mb = 2;   short = '会发表情，还会偷你的表情包';      desc = '会发表情图、会收你发的表情包（下载一套 DeepSeek 小鲸鱼默认表情，FeWOO/DeepSeek-meme，MIT）' }
  @{ id = 'mimic';     name = '学某个人说话';     def = $true;  mb = 0;   short = '转发聊天记录，学那个人的口气';    desc = '把一段聊天记录合并转发给它，它会慢慢学那个人的说话方式' }
  @{ id = 'radio';     name = '深夜电台';         def = $true;  mb = 0;   short = '说“开台”就录一期电台节目';        desc = '说“开台”她就录一期两三分钟的语音节目，配节目卡和一首歌（没开发语音就发文字版）' }
  @{ id = 'bili';      name = '刷 B站';           def = $true;  mb = 70;  short = '刷热门，看弹幕、热评和画面';      desc = '自己刷热门、看视频的弹幕热评和画面（要允许它在电脑上执行命令；看画面要下载 Python 和图像库）' }
  @{ id = 'voice';     name = '发语音';           def = $false; mb = 0;   short = '百炼 CosyVoice，说话带语气';      desc = '用阿里云百炼 CosyVoice 发语音，生气、委屈的时候语气会变（要填百炼 API Key 和音色 ID）' }
  @{ id = 'phone';     name = '手机控制';         def = $false; mb = 10;  short = 'USB 调试控制安卓手机';            desc = '用 USB 调试控制安卓手机：截图、点、打字（下载 adb）' }
  @{ id = 'listen';    name = '听声音 / 看直播';  def = $false; mb = 450; short = '本地 Whisper 把声音转成文字';     desc = '本地 Whisper 把声音转成文字（下载 Python、语音识别库和模型）' }
  @{ id = 'sing';      name = '唱歌';             def = $false; mb = 0;   short = '发转好的歌（要另装 Seed-VC）';    desc = '发提前转好的歌（要另外装 Seed-VC 并用声音训练，安装包不带模型）' }
)
$runtimeZip = Join-Path (Split-Path $here) 'runtime.zip'   # 离线包自带的 Node.js 24 + DSH
$offline = Test-Path $runtimeZip
$CoreMB = if ($offline) { 120 } else { 30 + 500 + 125 }   # 离线包只要下 NapCat；在线包：Node.js（没装才下）+ DSH + NapCat

# ── 小工具 ───────────────────────────────────────────────────────────────
function Read-EnvFile([string]$path) {
  $h = @{}
  if (Test-Path $path) {
    foreach ($line in [IO.File]::ReadAllLines($path, [Text.Encoding]::UTF8)) {
      $m = [regex]::Match($line, '^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$')
      if ($m.Success) { $h[$m.Groups[1].Value] = $m.Groups[2].Value }
    }
  }
  return $h
}
# 改 .env：已有的键就地改值，没有的追加到末尾；别的行和注释原样保留
function Update-EnvFile([string]$path, $values) {
  $lines = New-Object System.Collections.Generic.List[string]
  if (Test-Path $path) { $lines.AddRange([string[]][IO.File]::ReadAllLines($path, [Text.Encoding]::UTF8)) }
  $added = $false
  foreach ($k in $values.Keys) {
    $line = "$k=$($values[$k])"
    $i = -1
    for ($j = 0; $j -lt $lines.Count; $j++) { if ($lines[$j] -match "^\s*$k\s*=") { $i = $j; break } }
    if ($i -ge 0) { $lines[$i] = $line }
    else {
      if (-not $added) { if ($lines.Count) { $lines.Add('') }; $lines.Add('# ── 安装器写的 ──'); $added = $true }
      $lines.Add($line)
    }
  }
  [IO.File]::WriteAllLines($path, $lines, (New-Object Text.UTF8Encoding($false)))
}
function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}
function Find-Exe([string[]]$names) {
  foreach ($n in $names) { $c = Get-Command $n -ErrorAction SilentlyContinue | Select-Object -First 1; if ($c) { return $c.Source } }
  return $null
}
function Find-QQ {
  foreach ($k in 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\QQ', 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\QQ', 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\QQ') {
    try {
      $u = (Get-ItemProperty $k -ErrorAction Stop).UninstallString.Trim('"')
      $exe = Join-Path (Split-Path $u) 'QQ.exe'
      if (Test-Path $exe) { return $exe }
    } catch {}
  }
  foreach ($p in 'C:\Program Files\Tencent\QQNT\QQ.exe', 'C:\Program Files (x86)\Tencent\QQNT\QQ.exe') { if (Test-Path $p) { return $p } }
  return $null
}

# ── 日志 / 进度（有界面就写到界面，没界面写控制台）─────────────────────────
$script:logFile = $null
$script:ui = $null
function Pump { if ($script:ui) { [System.Windows.Forms.Application]::DoEvents() } }
function Say([string]$m) {
  $line = '{0} {1}' -f (Get-Date -Format 'HH:mm:ss'), $m
  if ($script:logFile) { try { Add-Content -Path $script:logFile -Value $line -Encoding UTF8 } catch {} }
  if ($script:ui) { $script:ui.log.AppendText($line + "`r`n"); Pump } else { Write-Host $line }
}
function Set-Progress([int]$pct, [string]$what) {
  if (-not $script:ui) { return }
  $v = [Math]::Max(0, [Math]::Min(100, $pct))
  $script:ui.bar.Tag.pct = $v; $script:ui.bar.Invalidate()
  if ($script:ui.pct) { $script:ui.pct.Text = "$v%" }
  $script:ui.step.Text = $what; Pump
  if ($script:testA) { Save-Shot ('install-{0:D3}.png' -f $v) }   # -Shot 加 -Answers：装的每一步截一张
}

# 解压：先用系统自带的 tar.exe（几万个小文件也就几十秒），没有就用 .NET 一个个解（慢一些）
function Expand-Fast([string]$zip, [string]$to) {
  New-Item -ItemType Directory -Force -Path $to | Out-Null
  $tar = Join-Path $env:SystemRoot 'System32\tar.exe'
  if (Test-Path $tar) {
    $code = Invoke-Tool $tar @('-xf', $zip, '-C', $to) $to
    if ($code -eq 0) { return }
    Say "  tar 解压没成（退出码 $code），换个办法"
  }
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $z = [IO.Compression.ZipFile]::OpenRead($zip)
  try {
    $n = 0
    foreach ($e in $z.Entries) {
      $dest = Join-Path $to ($e.FullName -replace '/', '\')
      if ($e.FullName.EndsWith('/')) { New-Item -ItemType Directory -Force -Path $dest | Out-Null; continue }
      New-Item -ItemType Directory -Force -Path (Split-Path $dest) | Out-Null
      [IO.Compression.ZipFileExtensions]::ExtractToFile($e, $dest, $true)
      if (++$n % 300 -eq 0) { Pump }
    }
  } finally { $z.Dispose() }
}
function Read-ZipText([string]$zip, [string]$name) {
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $z = [IO.Compression.ZipFile]::OpenRead($zip)
  try {
    $e = $z.GetEntry($name)
    if (-not $e) { return '' }
    $r = New-Object IO.StreamReader($e.Open())
    try { return $r.ReadToEnd() } finally { $r.Dispose() }
  } finally { $z.Dispose() }
}

# ── NapCat：两种安装包都不带（它的作者不许别的项目随便转发），装的时候从官网下 ──
$NapCatName = 'NapCat.Shell.Windows.Node.zip'
function NapCat-Urls([bool]$fast) {
  $u = @("https://github.com/NapNeko/NapCatQQ/releases/latest/download/$NapCatName", "https://github.com/NapNeko/NapCatQQ/releases/download/v4.18.41/$NapCatName")
  if ($fast) { return @("https://ghfast.top/$($u[0])") + $u }
  return $u
}
# 下好的 NapCat 可能在哪：-Cache、“下载”文件夹（可能被挪过位置）、桌面、安装包旁边
function Get-DownloadDirs {
  if ($A.downloadsDir) { return @($A.downloadsDir) }   # 测试用
  $dirs = @()
  if ($Cache) { $dirs += $Cache }
  try {
    $d = (Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders' -ErrorAction Stop).'{374DE290-123F-4565-9164-39C4925E467B}'
    if ($d) { $dirs += [Environment]::ExpandEnvironmentVariables($d) }
  } catch {}
  $dirs += (Join-Path $env:USERPROFILE 'Downloads'), [Environment]::GetFolderPath('Desktop'), (Split-Path $here)
  return @($dirs | Where-Object { $_ -and (Test-Path $_) } | Select-Object -Unique)
}
# 是不是完整的 NapCat 包：能当 zip 打开、里面有 napcat\NapCatWinBootMain.exe（还在下的打不开）
function Test-NapCatZip([string]$p) {
  try {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $z = [IO.Compression.ZipFile]::OpenRead($p)
    try { return [bool](@($z.Entries | Where-Object { $_.FullName -match '(^|/)napcat/NapCatWinBootMain\.exe$' }).Count) } finally { $z.Dispose() }
  } catch { return $false }
}
function Find-NapCatZip {
  foreach ($d in Get-DownloadDirs) {
    $hit = Get-ChildItem -Path $d -Filter 'NapCat.Shell.Windows.Node*.zip' -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Where-Object { Test-NapCatZip $_.FullName } | Select-Object -First 1
    if ($hit) { return $hit.FullName }
  }
  return $null
}
# 有界面时：浏览器打开官网下载链接，安装页上提示一下；每秒看一眼下载文件夹，下好了就接着装。也能自己选文件，或者先跳过。
function Wait-NapCatDownload([bool]$fast) {
  Start-Process (NapCat-Urls $fast)[0]
  Say "  NapCat 要从官网下：已经在浏览器里打开了下载链接，下好 $NapCatName 会自动接着装"
  $script:napPick = $null; $script:napSkip = $false
  Show-NapPanel $true
  $hit = $null
  $until = (Get-Date).AddMinutes(60)
  try {
    while ((Get-Date) -lt $until -and -not $script:napSkip) {
      if ($script:napPick) {
        if (Test-NapCatZip $script:napPick) { $hit = $script:napPick; break }
        Say "  选的不是完整的 $($NapCatName)：$($script:napPick)"; $script:napPick = $null
      }
      $hit = Find-NapCatZip
      if ($hit) { break }
      for ($i = 0; $i -lt 10; $i++) { Start-Sleep -Milliseconds 100; Pump }
    }
  } finally { Show-NapPanel $false }
  if ($hit) { Say "  下好了：$hit" } else { Say '  NapCat 先跳过了' }
  return $hit
}

# 下载：先看 -Cache 里有没有同名文件；再按顺序试每个地址（第一个失败换下一个）
function Get-File([string[]]$urls, [string]$dest, [string]$label) {
  $leaf = Split-Path $dest -Leaf
  if ($Cache -and (Test-Path (Join-Path $Cache $leaf))) {
    Copy-Item (Join-Path $Cache $leaf) $dest -Force
    Say "  用本地已有的 $leaf"
    return
  }
  New-Item -ItemType Directory -Force -Path (Split-Path $dest) | Out-Null
  $last = $null
  foreach ($u in $urls) {
    Say "  下载 $label ← $u"
    $resp = $null; $in = $null; $out = $null
    try {
      # 一块一块读，边读边刷新界面（不用事件回调：回调里碰不到脚本的变量）
      $req = [Net.HttpWebRequest]::Create($u)
      $req.UserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) qqbot-installer'
      $req.Timeout = 30000; $req.ReadWriteTimeout = 60000
      $resp = $req.GetResponse()
      $total = $resp.ContentLength
      $in = $resp.GetResponseStream()
      $out = [IO.File]::Create("$dest.part")
      $buf = New-Object byte[] 262144
      $got = 0; $shown = -1; $tick = [Environment]::TickCount
      while (($n = $in.Read($buf, 0, $buf.Length)) -gt 0) {
        $out.Write($buf, 0, $n); $got += $n
        $pct = if ($total -gt 0) { [int](100 * $got / $total) } else { 0 }
        if ([Environment]::TickCount - $tick -gt 200) {
          $tick = [Environment]::TickCount
          $text = '{0}  {1:N1} / {2:N1} MB' -f $label, ($got / 1MB), ($total / 1MB)
          if ($script:ui) { $script:ui.sub.Text = $text; Pump } elseif ($pct -ge $shown + 20) { $shown = $pct; Write-Host "    $text" }
        }
      }
      $out.Close(); $out = $null
      if ($total -gt 0 -and $got -ne $total) { throw "只下到 $got / $total 字节" }
      Move-Item "$dest.part" $dest -Force
      if ($script:ui) { $script:ui.sub.Text = '' }
      return
    } catch {
      $last = $_
      Say "  这个地址不行：$($_.Exception.Message)"
    } finally {
      if ($out) { $out.Close() }
      if ($in) { $in.Close() }
      if ($resp) { $resp.Close() }
      Remove-Item "$dest.part" -Force -ErrorAction SilentlyContinue
    }
  }
  throw "下载失败：$label（$($last.Exception.Message)）"
}

# 跑一个程序，等它结束（界面不卡）；返回退出码，输出写进日志
function Invoke-Tool([string]$exe, [string[]]$argList, [string]$cwd, [hashtable]$envExtra = @{}, [switch]$Quiet) {
  $saved = @{}
  foreach ($k in $envExtra.Keys) { $saved[$k] = [Environment]::GetEnvironmentVariable($k); [Environment]::SetEnvironmentVariable($k, $envExtra[$k]) }
  $o = [IO.Path]::GetTempFileName(); $e = [IO.Path]::GetTempFileName()
  try {
    $quoted = $argList | ForEach-Object { if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ } }
    $p = Start-Process -FilePath $exe -ArgumentList $quoted -WorkingDirectory $cwd -WindowStyle Hidden -RedirectStandardOutput $o -RedirectStandardError $e -PassThru
    $null = $p.Handle
    while (-not $p.HasExited) { Start-Sleep -Milliseconds 200; Pump }
    $p.WaitForExit()
    $tail = @((Get-Content $o -Encoding UTF8 -ErrorAction SilentlyContinue) + (Get-Content $e -Encoding UTF8 -ErrorAction SilentlyContinue)) | Where-Object { $_ } | Select-Object -Last 6
    if (-not $Quiet) { foreach ($t in $tail) { Say "    $t" } }
    return $p.ExitCode
  } finally {
    Remove-Item $o, $e -Force -ErrorAction SilentlyContinue
    foreach ($k in $saved.Keys) { [Environment]::SetEnvironmentVariable($k, $saved[$k]) }
  }
}

# ── 安装 ─────────────────────────────────────────────────────────────────
# $A：dir mirror name botQQ ownerQQ otherQQ groups deepseekKey features[] phonePin dashscopeKey voiceId resetPersona
function Install-All($A) {
  $dir = $A.dir
  $app = Join-Path $dir 'agent-bridge'
  $tools = Join-Path $dir 'tools'
  $on = @($A.features)
  $mirror = [bool]$A.mirror
  New-Item -ItemType Directory -Force -Path $app, $tools | Out-Null
  $script:logFile = Join-Path $dir 'install.log'
  $results = New-Object System.Collections.Generic.List[object]
  function Mark([string]$what, [bool]$ok, [string]$note = '') { $results.Add([pscustomobject]@{ what = $what; ok = $ok; note = $note }); Say ($(if ($ok) { "✓ $what" } else { "✗ $what  $note" })) }

  Say "安装到 $dir"
  # 1. 程序文件（代码覆盖；data、.env、persona.md 不动）
  Set-Progress 3 '复制程序文件'
  if (Test-Path (Join-Path $payload 'agent-bridge')) {
    Copy-Item (Join-Path $payload 'agent-bridge\*') $app -Recurse -Force
    # 从老版本升级：机器人改跑 packages\ 里的插件版了，老版本那一大套代码用不上了，删掉（只删这些文件，data、.env、persona.md 不碰）
    $oldCode = @('human.mjs', 'config.mjs', 'tts.mjs', 'weather.mjs', 'stickers.mjs', 'pc.mjs', 'imagegen.mjs', 'qqmusic.mjs', 'radio.mjs', 'radio.patch.yml',
      'scene\photo.py', 'scene\gift.py', 'letter\card.py', 'postcard\card.py', 'media\doc_text.py', 'life\life.mjs', 'images\gif_sheet.py',
      'bili\bili.mjs', 'bili\lib.mjs', 'bili\frames.py', 'radio\card.py', 'phone\phone.mjs', 'phone\guard.mjs',
      'sing\paths.py', 'sing\convert.py', 'sing\render.py', 'sing\separate.py', 'sing\finish.py', 'sing\shim\hf_utils.py',
      'chronolife\adapter.mjs', 'chronolife\engine.mjs', 'chronolife\worker.mjs', 'chronolife\manifest.json', 'chronolife\README.md',
      'live\live.py', 'live\phone_live.py', 'live\README.md', 'scripts\zstd-frames.mjs', 'installer\AGENTS.tpl.md')
    $gone = @($oldCode | Where-Object { Test-Path (Join-Path $app $_) })
    foreach ($f in $gone) { Remove-Item (Join-Path $app $f) -Force -ErrorAction SilentlyContinue }
    # 删空了的文件夹也去掉（python 留下的 __pycache__ 一起删；里面还有别的东西就留着）
    foreach ($d in @('sing\shim', 'scene', 'letter', 'postcard', 'media', 'life', 'images', 'bili', 'radio', 'phone', 'sing', 'chronolife', 'live')) {
      $p = Join-Path $app $d
      if (-not (Test-Path $p)) { continue }
      Remove-Item (Join-Path $p '__pycache__') -Recurse -Force -ErrorAction SilentlyContinue
      if (-not (Get-ChildItem $p -Force -ErrorAction SilentlyContinue)) { Remove-Item $p -Force -ErrorAction SilentlyContinue }
    }
    if ($gone.Count) { Say "  老版本的代码用不上了，删掉了 $($gone.Count) 个文件" }
    Mark '程序文件' $true
  } elseif (Test-Path (Join-Path $app 'bridge.mjs')) {
    Mark '程序文件（已经装好了，只改设置）' $true   # 从 agent-bridge\installer 里运行：改功能 / 改 key
  } else { Mark '程序文件' $false "找不到 $payload"; return $results }

  # 2. 配置
  Set-Progress 8 '写配置'
  $envPath = Join-Path $app '.env'
  $old = Read-EnvFile $envPath
  $allowed = @($A.ownerQQ) + @(([string]$A.otherQQ) -split '[,，\s]+' | Where-Object { $_ }) | Select-Object -Unique
  $full = ($on -contains 'bili') -or ($on -contains 'phone') -or ($on -contains 'listen')
  $v = [ordered]@{
    BOT_NAME = $A.name; WAKE_WORDS = $A.name
    ONEBOT_WS = 'ws://127.0.0.1:3001'
    ALLOWED_QQ = ($allowed -join ','); ALLOWED_GROUPS = (([string]$A.groups) -split '[,，\s]+' | Where-Object { $_ }) -join ','
    DSH_HOME = (Join-Path $dir '.dsh-home'); AGENT_CWD = $dir
    DSH_PERMISSION_MODE = $(if ($full) { 'danger-full-access' } else { 'workspace-write' })
    ONEBOT_TOKEN = $(if ($old.ONEBOT_TOKEN) { $old.ONEBOT_TOKEN } else { -join ((1..24) | ForEach-Object { '{0:x}' -f (Get-Random -Maximum 16) }) })
    MEMORY = 'true'; ACK_PRIVATE = 'false'
    FACTS = "$($on -contains 'memory')".ToLower(); FOLLOWUP = "$($on -contains 'memory')".ToLower(); LEARN_STYLE = "$($on -contains 'memory')".ToLower(); JOURNAL = "$($on -contains 'memory')".ToLower()
    PROACTIVE = "$($on -contains 'proactive')".ToLower(); GREETINGS = "$($on -contains 'proactive')".ToLower(); SULK = "$($on -contains 'proactive')".ToLower()
    PROACTIVE_QQ = $A.ownerQQ
    AUTONOMY = "$($on -contains 'autonomy')".ToLower(); REFLECT = "$($on -contains 'autonomy')".ToLower()
    STEAL_STICKERS = "$($on -contains 'stickers')".ToLower()
    RECALL = 'true'; CHASE = "$($on -contains 'proactive')".ToLower(); POKE_SELF = "$($on -contains 'proactive')".ToLower(); EMOTION = 'true'; RHYTHM = 'true'; CURIOUS = "$($on -contains 'memory')".ToLower(); ONLINE_STATUS = 'true'; LONGNICK = "$($on -contains 'memory')".ToLower(); ANNIVERSARY = 'true'; WEATHER = 'true'; MEDIA = 'true'
    MIMIC = "$($on -contains 'mimic')".ToLower()
    PHONE_MONITOR = "$($on -contains 'phone')".ToLower()
    VOICE = "$($on -contains 'voice')".ToLower()
    SING = "$($on -contains 'sing')".ToLower()
    RADIO = "$($on -contains 'radio')".ToLower()
  }
  # key 留空 = 不改（重装时保留原来的）
  if ($A.city) { $v.WEATHER_CITY = $A.city }
  if ($A.deepseekKey) { $v.DEEPSEEK_API_KEY = $A.deepseekKey } elseif (-not $old.DEEPSEEK_API_KEY) { $v.DEEPSEEK_API_KEY = '' }
  if ($on -contains 'phone' -and $A.phonePin) { $v.PHONE_PIN = $A.phonePin }
  if ($on -contains 'voice') {
    if ($A.dashscopeKey) { $v.DASHSCOPE_API_KEY = $A.dashscopeKey }
    if ($A.voiceId) { $v.VOICE_ID = $A.voiceId }
  }
  $qq = Find-QQ
  if ($qq) { $v.QQ_EXE = $qq }
  Update-EnvFile $envPath $v
  $personaPath = Join-Path $app 'persona.md'
  if ($A.resetPersona -or -not (Test-Path $personaPath)) {
    # 只换上名字；<!-- if:voice --> … <!-- end --> 这种条件段留着，机器人按 .env 里开没开那个功能决定用不用（以后在 .env 里打开也生效）
    [IO.File]::WriteAllText($personaPath, ([IO.File]::ReadAllText((Join-Path $app 'persona.default.md'), [Text.Encoding]::UTF8)).Replace('{{NAME}}', $A.name), (New-Object Text.UTF8Encoding($false)))
    Say '  人设：用默认人设（可以直接改 agent-bridge\persona.md）'
  } else { Say '  人设：保留现在的 persona.md' }
  # 模型干活用的说明（AGENTS.md，在安装目录里）由机器人启动时按装了的插件自己写；老版本安装器写的那份路径都不对了，删掉让它重写
  $agentsMd = Join-Path $dir 'AGENTS.md'
  if ((Test-Path $agentsMd) -and (Get-Content $agentsMd -TotalCount 1 -Encoding UTF8) -eq '# 本机 Agent 速查') { Remove-Item $agentsMd -Force }
  Mark '配置（.env / 人设）' $true

  # 2b. 离线包自带的 Node.js 24 和 DSH（runtime.zip）：解到安装目录的 tools\node 和 agent-bridge\node_modules；解过同一份就跳过
  $runtimeMark = Join-Path $tools 'node\runtime.json'
  if ($offline) {
    Set-Progress 10 '解开自带的 Node.js 和 DSH（要几十秒）'
    try {
      $want = Read-ZipText $runtimeZip 'tools/node/runtime.json'
      $have = if (Test-Path $runtimeMark) { [IO.File]::ReadAllText($runtimeMark) } else { '' }
      if ($want -and $want -eq $have -and (Test-Path (Join-Path $app 'node_modules\@deepseek-ai\dsh\lib\bin.js'))) { Say '  自带的 Node.js 和 DSH 已经解开过了' }
      else {
        Remove-Item (Join-Path $app 'node_modules') -Recurse -Force -ErrorAction SilentlyContinue
        Expand-Fast $runtimeZip $dir
        if (-not (Test-Path (Join-Path $tools 'node\node.exe')) -or -not (Test-Path (Join-Path $app 'node_modules\@deepseek-ai\dsh\lib\bin.js'))) { throw '解完没找到 node.exe 或 DSH' }
        Say '  解开了自带的 Node.js 和 DSH'
      }
    } catch { Mark 'Node.js 和 DSH（安装包自带的没解开）' $false $_.Exception.Message; return $results }
  }

  # 3. Node.js：要 24 以上，低了就装 Node 24。DSH 在 22.11 这种旧版上会悄悄跑不起来（没输出也不报错），24 实测能跑。
  # 找哪个 node 跟启动器、守护一样：先 C:\Program Files\nodejs，再 PATH，免得检查的和实际用的不是同一个。
  Set-Progress 12 'Node.js'
  Refresh-Path
  $nodeMin = 24
  function Find-Node {
    if ($A.nodeExe) { return $A.nodeExe }   # 测试用：当成电脑上装的就是这个
    $own = Join-Path $tools 'node\node.exe'   # 离线包自带的，不碰系统里装的
    if (Test-Path $own) { return $own }
    $pf = 'C:\Program Files\nodejs\node.exe'
    if (Test-Path $pf) { return $pf }
    return Find-Exe @('node')
  }
  function Get-NodeVersion([string]$exe) { try { return ((& $exe --version) -replace '^v', '').Trim() } catch { return '' } }
  function Test-NodeNew([string]$v) { return [bool]$v -and [int]($v.Split('.')[0]) -ge $nodeMin }
  $node = Find-Node
  $ver = if ($node) { Get-NodeVersion $node } else { '' }
  if (-not (Test-NodeNew $ver)) {
    try {
      $base = if ($mirror) { 'https://npmmirror.com/mirrors/node' } else { 'https://nodejs.org/dist' }
      $index = (New-Object Net.WebClient).DownloadString("$base/index.json") | ConvertFrom-Json
      $pick = $index | Where-Object { $_.lts -and $_.version -like "v$nodeMin.*" } | Select-Object -First 1
      if (-not $pick) { throw "没找到 Node.js $nodeMin 的长期支持版" }
      $msi = Join-Path $env:TEMP "node-$($pick.version)-x64.msi"
      Get-File @("$base/$($pick.version)/node-$($pick.version)-x64.msi") $msi "Node.js $($pick.version)（约 30MB）"
      Say $(if ($ver) { "  电脑上的 Node.js 是 v$ver，太旧了，换成 $($pick.version)…" } else { '  安装 Node.js…' })
      $code = Invoke-Tool 'msiexec.exe' @('/i', $msi, '/qn', '/norestart') $env:TEMP
      Refresh-Path
      $node = Find-Node
      $now = if ($node) { Get-NodeVersion $node } else { '' }
      if (-not (Test-NodeNew $now)) { throw "装完还是$(if ($now) { " v$now" } else { '找不到 node' })（msiexec 退出码 $code）" }
      Mark "Node.js v$now$(if ($ver) { "（原来的 v$ver 太旧，换了新的）" })" $true
    } catch { Mark 'Node.js' $false $_.Exception.Message; return $results }
  } else { Mark "Node.js v$ver（$(if ($node -like "$tools\*") { '安装包自带' } else { '已经装了' })）" $true }
  $npm = Join-Path (Split-Path $node) 'npm.cmd'

  # 4. DSH 和依赖
  Set-Progress 20 '安装 DSH（约 500MB，会久一点）'
  $npmArgs = @('install', '--omit=dev', '--no-audit', '--no-fund')
  if ($mirror) { $npmArgs += @('--registry', 'https://registry.npmmirror.com') }
  if ($A.skipNpm) { Mark 'DSH（测试：跳过 npm）' $true }
  elseif ((Test-Path $runtimeMark) -and (Test-Path (Join-Path $app 'node_modules\@deepseek-ai\dsh\lib\bin.js'))) { Mark 'DSH（安装包自带）' $true }
  else {
    $code = Invoke-Tool $npm $npmArgs $app
    if ($code -ne 0 -or -not (Test-Path (Join-Path $app 'node_modules\@deepseek-ai\dsh\lib\bin.js'))) { Mark 'DSH' $false "npm 退出码 $code"; return $results }
    Mark 'DSH' $true
  }

  # 5. DSH 配置：第一次用时它会自己初始化 headless；先跑一下让它建好，再写用哪个模型
  Set-Progress 45 '配置 DSH'
  $dshHome = Join-Path $dir '.dsh-home'
  $bin = Join-Path $app 'node_modules\@deepseek-ai\dsh\lib\bin.js'
  if (Test-Path $bin) { $null = Invoke-Tool $node @($bin, '--profile', 'headless', '--dump-config') $dir @{ DSH_HOME = $dshHome } -Quiet }   # 它会把整份配置打出来，不往日志里写
  $prof = Join-Path $dshHome 'profiles\headless'
  New-Item -ItemType Directory -Force -Path $prof | Out-Null
  $patch = @'
# 安装器写的：headless profile 用 DeepSeek 官方 API 的 deepseek-flash
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: deepseek-official
    model: deepseek-flash
    reasoningEffort: high
'@
  [IO.File]::WriteAllText((Join-Path $prof 'cordis.patch.yml'), $patch, (New-Object Text.UTF8Encoding($false)))
  Mark 'DSH 配置' $true

  # 6. NapCat：先找现成下好的；有界面就打开官网下载链接，等你在浏览器里下好；没界面（批量装）直接下
  Set-Progress 50 'NapCat'
  $napApp = Join-Path $tools 'napcat\app'
  if (-not (Test-Path (Join-Path $napApp 'napcat\NapCatWinBootMain.exe'))) {
    try {
      $zip = Find-NapCatZip
      if ($zip) { Say "  找到下好的 NapCat：$zip" }
      elseif ($script:ui) { $zip = Wait-NapCatDownload $mirror }
      else {
        $zip = Join-Path $env:TEMP $NapCatName
        Get-File (NapCat-Urls $mirror) $zip 'NapCat（约 120MB）'
      }
      if (-not $zip) { Mark 'NapCat' $false "还没下：从官网下好 $NapCatName（放在`“下载`”文件夹就行），再运行一次 agent-bridge\installer\修改设置.cmd，会自动找到并配置好" }
      else {
        Set-Progress 55 '解开 NapCat'
        Expand-Fast $zip $napApp
        if (-not (Test-Path (Join-Path $napApp 'napcat\NapCatWinBootMain.exe'))) { throw "解开后没找到 NapCatWinBootMain.exe，下的可能不是 $NapCatName" }
        Mark 'NapCat' $true
      }
    } catch { Mark 'NapCat' $false $_.Exception.Message }
  } else { Mark 'NapCat（已经有了）' $true }
  if (Test-Path (Join-Path $napApp 'napcat\config')) {
    $code = Invoke-Tool $node @((Join-Path $app 'napcat\setup-onebot.mjs'), $A.botQQ) $app @{ ONEBOT_TOKEN = $v.ONEBOT_TOKEN }
    Mark 'NapCat 连接配置' ($code -eq 0)
  }

  # 7. QQ
  if ($qq) { Mark "QQ（$qq）" $true } else { Mark 'QQ' $false '没找到 QQ：去 im.qq.com 下载安装 QQ，装好后启动器会自己找到' }

  # 8. 各功能要的东西
  Set-Progress 62 '功能'
  if ($on -contains 'stickers') {
    $code = Invoke-Tool $node @((Join-Path $app 'scripts\fetch-stickers.mjs')) $app
    Mark '表情包' ($code -eq 0)
  }
  if ($on -contains 'phone') {
    Set-Progress 66 '手机工具 adb'
    try {
      if (-not (Test-Path (Join-Path $tools 'platform-tools\adb.exe'))) {
        $zip = Join-Path $env:TEMP 'platform-tools-latest-windows.zip'
        Get-File @('https://dl.google.com/android/repository/platform-tools-latest-windows.zip') $zip 'adb（约 10MB）'
        Expand-Archive -Path $zip -DestinationPath $tools -Force
      }
      Mark '手机工具 adb' $true
    } catch { Mark '手机工具 adb' $false $_.Exception.Message }
  }
  $needPy = ($on -contains 'listen') -or ($on -contains 'bili')
  if ($needPy) {
    Set-Progress 70 'Python'
    Refresh-Path
    $py = Find-Exe @('python', 'py')
    if ($py -and $py -like '*WindowsApps*') { $py = $null }   # 应用商店的占位 python 不算
    if (-not $py) {
      try {
        $pyExe = Join-Path $env:TEMP 'python-3.11.9-amd64.exe'
        $urls = @('https://www.python.org/ftp/python/3.11.9/python-3.11.9-amd64.exe')
        if ($mirror) { $urls = @('https://npmmirror.com/mirrors/python/3.11.9/python-3.11.9-amd64.exe') + $urls }
        Get-File $urls $pyExe 'Python 3.11（约 25MB）'
        $null = Invoke-Tool $pyExe @('/quiet', 'InstallAllUsers=0', 'PrependPath=1', 'Include_test=0', 'Include_launcher=0') $env:TEMP
        Refresh-Path
        $py = Find-Exe @('python')
        if (-not $py) { $py = Join-Path $env:LOCALAPPDATA 'Programs\Python\Python311\python.exe' }
        Mark 'Python 3.11' (Test-Path $py)
      } catch { Mark 'Python' $false $_.Exception.Message; $py = $null }
    } else { Mark "Python（已经装了：$py）" $true }
    if ($py) {
      Set-Progress 76 'Python 库'
      $pkgs = @('av', 'pillow', 'numpy')
      if ($on -contains 'listen') { $pkgs += @('faster-whisper', 'soundcard') }
      $pipArgs = @('-m', 'pip', 'install', '--user', '--disable-pip-version-check') + $pkgs
      if ($mirror) { $pipArgs += @('-i', 'https://pypi.tuna.tsinghua.edu.cn/simple') }
      $code = Invoke-Tool $py $pipArgs $dir
      Mark "Python 库（$($pkgs -join ' ')）" ($code -eq 0)
    }
    if ($on -contains 'listen') {
      Set-Progress 85 '语音识别模型（约 145MB）'
      $code = Invoke-Tool $node @((Join-Path $app 'scripts\fetch-whisper.mjs'), 'base') $app
      Mark '语音识别模型 Whisper base' ($code -eq 0)
    }
  }
  if ($on -contains 'sing') { Say '  唱歌：先另外装好 Seed-VC，再在 agent-bridge\.env 里填 SEEDVC_RUNTIME，用 sing\learn.mjs 学歌（见 使用说明.md）' }

  # 9. 桌面快捷方式
  Set-Progress 95 '桌面快捷方式'
  if ($A.noShortcuts) { Mark '桌面快捷方式（测试：跳过）' $true; Set-Progress 100 '装好了'; return $results }
  try {
    $ws = New-Object -ComObject WScript.Shell
    $desk = [Environment]::GetFolderPath('Desktop')
    foreach ($s in @(@{ n = $A.name; f = 'launch.vbs' }, @{ n = "$($A.name)状态"; f = 'status.vbs' })) {
      $lnk = $ws.CreateShortcut((Join-Path $desk "$($s.n).lnk"))
      $lnk.TargetPath = Join-Path $app $s.f
      $lnk.WorkingDirectory = $app
      $lnk.Save()
    }
    Mark "桌面快捷方式（$($A.name) / $($A.name)状态）" $true
  } catch { Mark '桌面快捷方式' $false $_.Exception.Message }
  Set-Progress 100 '装好了'
  return $results
}

# ── 不弹窗模式 ───────────────────────────────────────────────────────────
if ($unattended) {
  $A = Get-Content $Answers -Raw -Encoding UTF8 | ConvertFrom-Json
  $r = Install-All $A
  $bad = @($r | Where-Object { -not $_.ok })
  Write-Host ''
  Write-Host ('结果：{0} 项成功，{1} 项失败' -f (@($r).Count - $bad.Count), $bad.Count)
  exit $(if ($bad.Count) { 1 } else { 0 })
}

# ── 界面 ─────────────────────────────────────────────────────────────────
# 左边一条渐变色的步骤栏（标志 + 六步，走到哪亮哪），右边白底内容；输入框、功能卡片、进度条都是自己画的圆角。
# 坐标都按 96 DPI 写：控件由 WinForms 自动放大，自己画的部分按左栏的实际宽度算放大倍数（Get-Scale）。
# 事件里用到的颜色、字体都写成 $script:…：安装途中刷新界面时，事件是在 Install-All 里面触发的，不加前缀会读到同名的局部变量。
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -Namespace Win -Name Dpi -MemberDefinition '[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetProcessDPIAware();'
[void][Win.Dpi]::SetProcessDPIAware()
[System.Windows.Forms.Application]::EnableVisualStyles()

function Rgb([int]$r, [int]$g, [int]$b, [int]$a = 255) { [System.Drawing.Color]::FromArgb($a, $r, $g, $b) }
$cPaper = Rgb 255 255 255; $cInk = Rgb 24 28 37; $cLabel = Rgb 55 65 81; $cGray = Rgb 107 114 128
$cLine = Rgb 226 229 236; $cSoft = Rgb 247 248 250; $cTrack = Rgb 229 231 235
$cBlue = Rgb 37 99 235; $cBlueDark = Rgb 29 78 216; $cBlueSoft = Rgb 239 245 255
$cGreen = Rgb 22 163 74; $cRed = Rgb 220 38 38
$cAmber = Rgb 255 248 230; $cAmberEdge = Rgb 251 224 168; $cAmberLine = Rgb 245 158 11; $cAmberTitle = Rgb 180 83 9; $cAmberInk = Rgb 120 53 15
$fsReg = [System.Drawing.FontStyle]::Regular; $fsBold = [System.Drawing.FontStyle]::Bold
$face = 'Microsoft YaHei UI'
$SW, $CW, $CH = 230, 650, 530   # 左栏宽，内容区宽、高（下面还有 70 高的按钮栏）

# 字体：-Px 给自己画的部分用（按像素算，跟着 Get-Scale 一起放大）；不带的给控件用（按磅算，系统自己放大）
function New-Font([float]$pt, [switch]$Bold, [switch]$Px) {
  $style = if ($Bold) { $fsBold } else { $fsReg }
  if ($Px) { return New-Object System.Drawing.Font($face, [float]($pt * 4 / 3), $style, [System.Drawing.GraphicsUnit]::Pixel) }
  return New-Object System.Drawing.Font($face, $pt, $style)
}
$fBrand = New-Font 13 -Bold -Px; $fBrandSub = New-Font 9 -Px; $fStep = New-Font 10.5 -Px; $fStepNow = New-Font 10.5 -Bold -Px
$fNum = New-Font 9 -Bold -Px; $fBadge = New-Font 8 -Px; $fTiny = New-Font 8 -Px

function New-RoundPath([float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  [float]$d = [Math]::Max(1, [Math]::Min($r * 2, [Math]::Min($w, $h)))
  $p.AddArc($x, $y, $d, $d, [float]180, [float]90); $p.AddArc([float]($x + $w - $d), $y, $d, $d, [float]270, [float]90)
  $p.AddArc([float]($x + $w - $d), [float]($y + $h - $d), $d, $d, [float]0, [float]90); $p.AddArc($x, [float]($y + $h - $d), $d, $d, [float]90, [float]90)
  $p.CloseFigure(); return $p
}
function Get-Scale { $w = $script:side.Width; if ($w -gt 0) { $w / $script:SW } else { 1.0 } }
function Px([float]$v) { [int][Math]::Round($v * (Get-Scale)) }
# 自己画之前：开抗锯齿、按放大倍数缩放；返回按 96 DPI 算的宽和高
function Start-Paint($s, $e) {
  $g = $e.Graphics
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  $k = Get-Scale
  $g.ScaleTransform([float]$k, [float]$k)
  return @(($s.Width / $k), ($s.Height / $k))
}
function Set-DoubleBuffer($c) { $c.GetType().GetProperty('DoubleBuffered', [System.Reflection.BindingFlags]'Instance,NonPublic').SetValue($c, $true, $null) }
# 圆角卡片：底色和边框画在面板自己身上（面板本身透明），里面的字也设成透明，就能透出卡片的底色；accent 是左边一条色带
function Add-CardPaint($panel, $fill, $border, [float]$radius = 10, $accent = $null) {
  $panel.BackColor = [System.Drawing.Color]::Transparent
  $panel.Tag = @{ fill = $fill; border = $border; radius = $radius; accent = $accent }
  $panel.Add_Paint({
    param($s, $e)
    $w, $h = Start-Paint $s $e
    $g = $e.Graphics; $t = $s.Tag
    $path = New-RoundPath 0.5 0.5 ($w - 1.5) ($h - 1.5) $t.radius
    $br = New-Object System.Drawing.SolidBrush($t.fill); $g.FillPath($br, $path); $br.Dispose()
    if ($t.accent) {
      $st = $g.Save(); $g.SetClip($path, [System.Drawing.Drawing2D.CombineMode]::Intersect)
      $ab = New-Object System.Drawing.SolidBrush($t.accent); $g.FillRectangle($ab, [float]0, [float]0, [float]4, [float]$h); $ab.Dispose()
      $g.Restore($st)
    }
    if ($t.border) { $pen = New-Object System.Drawing.Pen($t.border, [float]1); $g.DrawPath($pen, $path); $pen.Dispose() }
    $path.Dispose()
  })
}
# 标志：蓝紫渐变的圆角方块 + 白色对话气泡
function New-Logo([int]$n) {
  $bmp = New-Object System.Drawing.Bitmap($n, $n)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $br = New-Object System.Drawing.Drawing2D.LinearGradientBrush((New-Object System.Drawing.RectangleF(0, 0, $n, $n)), (Rgb 96 165 250), (Rgb 167 139 250), [float]45)
  $g.FillPath($br, (New-RoundPath 0 0 ($n - 1) ($n - 1) ($n * 0.26))); $br.Dispose()
  [float]$bw = $n * 0.62; [float]$bh = $n * 0.44; [float]$bx = ($n - $bw) / 2; [float]$by = $n * 0.2
  $g.FillPath([System.Drawing.Brushes]::White, (New-RoundPath $bx $by $bw $bh ($bh * 0.5)))
  [System.Drawing.PointF[]]$tail = @(
    (New-Object System.Drawing.PointF([float]($bx + $bw * 0.24), [float]($by + $bh - 3))),
    (New-Object System.Drawing.PointF([float]($bx + $bw * 0.16), [float]($by + $bh + $n * 0.16))),
    (New-Object System.Drawing.PointF([float]($bx + $bw * 0.48), [float]($by + $bh - 3))))
  $g.FillPolygon([System.Drawing.Brushes]::White, $tail)
  [float]$dot = [Math]::Max(2, $n * 0.085)
  $db = New-Object System.Drawing.SolidBrush((Rgb 99 102 241))
  foreach ($j in 0..2) { $g.FillEllipse($db, [float]($bx + $bw * (0.28 + 0.22 * $j) - $dot / 2), [float]($by + $bh / 2 - $dot / 2), $dot, $dot) }
  $db.Dispose(); $g.Dispose()
  return $bmp
}
$logo = New-Logo 96

$form = New-Object System.Windows.Forms.Form
# 先挂起布局，等所有控件都建好了再恢复：恢复的那一下 WinForms 才会按系统缩放（125%、150%…）把它们一起放大。
# 不挂起的话，设 AutoScaleMode 时窗口里还是空的，后面加的控件都不会放大，字却跟着系统变大，就挤成一团。
$form.SuspendLayout()
$form.AutoScaleMode = 'Dpi'
$form.AutoScaleDimensions = New-Object System.Drawing.SizeF(96, 96)
$form.Text = 'QQ 伙伴 · 安装'
$form.ClientSize = New-Object System.Drawing.Size(($SW + $CW), ($CH + 70))
$form.FormBorderStyle = 'FixedSingle'
$form.MaximizeBox = $false
$form.StartPosition = 'CenterScreen'
$form.BackColor = $cPaper
$form.Font = New-Font 9.5
try { $form.Icon = [System.Drawing.Icon]::FromHandle((New-Logo 32).GetHicon()) } catch {}

function New-Label([string]$text, [int]$x, [int]$y, [float]$size = 9.5, $style = $fsReg, $color = $cInk, [int]$w = 570) {
  $l = New-Object System.Windows.Forms.Label
  $l.Text = $text; $l.Location = New-Object System.Drawing.Point($x, $y); $l.ForeColor = $color; $l.BackColor = [System.Drawing.Color]::Transparent
  $l.Font = New-Object System.Drawing.Font($face, $size, $style)
  $l.MaximumSize = New-Object System.Drawing.Size($w, 0); $l.AutoSize = $true
  return $l
}
function New-Link([string]$text, [int]$x, [int]$y) {
  $l = New-Object System.Windows.Forms.LinkLabel
  $l.Text = $text; $l.AutoSize = $true; $l.Location = New-Object System.Drawing.Point($x, $y); $l.Font = New-Font 9
  $l.BackColor = [System.Drawing.Color]::Transparent; $l.LinkColor = $cBlue; $l.ActiveLinkColor = $cBlueDark; $l.LinkBehavior = 'HoverUnderline'
  return $l
}
function New-Btn([string]$text, [int]$x, [int]$y, [int]$w, [int]$hgt = 38, [switch]$Primary) {
  $b = New-Object System.Windows.Forms.Button
  $b.Text = $text; $b.Location = New-Object System.Drawing.Point($x, $y); $b.Size = New-Object System.Drawing.Size($w, $hgt)
  $b.FlatStyle = 'Flat'; $b.UseVisualStyleBackColor = $false; $b.Cursor = [System.Windows.Forms.Cursors]::Hand
  if ($Primary) {
    $b.BackColor = $cBlue; $b.ForeColor = $cPaper; $b.Font = New-Font 10 -Bold
    $b.FlatAppearance.BorderSize = 0; $b.FlatAppearance.MouseOverBackColor = $cBlueDark; $b.FlatAppearance.MouseDownBackColor = $cBlueDark
  } else {
    $b.BackColor = $cPaper; $b.ForeColor = $cInk; $b.Font = New-Font 10
    $b.FlatAppearance.BorderColor = $cLine; $b.FlatAppearance.BorderSize = 1; $b.FlatAppearance.MouseOverBackColor = $cSoft; $b.FlatAppearance.MouseDownBackColor = $cLine
  }
  return $b
}
function New-Page {
  $p = New-Object System.Windows.Forms.Panel
  $p.Location = New-Object System.Drawing.Point($SW, 0); $p.Size = New-Object System.Drawing.Size($CW, $CH); $p.BackColor = $cPaper; $p.Visible = $false
  $form.Controls.Add($p); return $p
}
function New-Card($p, [int]$x, [int]$y, [int]$w, [int]$h, $fill, $border, [float]$radius = 10, $accent = $null) {
  $c = New-Object System.Windows.Forms.Panel
  $c.Location = New-Object System.Drawing.Point($x, $y); $c.Size = New-Object System.Drawing.Size($w, $h)
  Add-CardPaint $c $fill $border $radius $accent
  $p.Controls.Add($c); return $c
}
function Add-Title($p, [string]$title, [string]$sub = '') {
  $p.Controls.Add((New-Label $title 40 30 17 $fsBold))
  if ($sub) { $p.Controls.Add((New-Label $sub 42 74 9.5 $fsReg $cGray 560)) }
}
function Add-Field($p, [string]$text, [int]$x, [int]$y) { $p.Controls.Add((New-Label $text $x $y 9.5 $fsBold $cLabel)) }
function Add-Hint($p, [string]$text, [int]$x, [int]$y, [int]$w = 560) { $l = New-Label $text $x $y 8.5 $fsReg $cGray $w; $p.Controls.Add($l); return $l }
# 输入框：圆角细边，点进去边框变蓝；返回里面的 TextBox
function New-Input($p, [int]$x, [int]$y, [int]$w, [string]$text = '', [switch]$Secret) {
  $box = New-Object System.Windows.Forms.Panel
  $box.Location = New-Object System.Drawing.Point($x, $y); $box.Size = New-Object System.Drawing.Size($w, 36)
  $box.BackColor = [System.Drawing.Color]::Transparent; $box.Cursor = [System.Windows.Forms.Cursors]::IBeam
  $box.Tag = @{ focus = $false }
  # 里面的控件都用坐标摆，不用 Padding + Dock：系统缩放时 Padding 不跟着放大，位置和大小会
  $t = New-Object System.Windows.Forms.TextBox
  $t.BorderStyle = 'None'; $t.Location = New-Object System.Drawing.Point(11, 8); $t.Width = $w - 22; $t.Font = New-Font 10.5; $t.Text = $text; $t.BackColor = $cPaper; $t.ForeColor = $cInk
  if ($Secret) { $t.UseSystemPasswordChar = $true }
  $box.Controls.Add($t)
  $box.Add_Paint({
    param($s, $e)
    $w, $h = Start-Paint $s $e
    $on = $s.Tag.focus
    $path = New-RoundPath 1 1 ($w - 2.5) ($h - 2.5) 7
    $br = New-Object System.Drawing.SolidBrush($script:cPaper); $e.Graphics.FillPath($br, $path); $br.Dispose()
    $pen = New-Object System.Drawing.Pen($(if ($on) { $script:cBlue } else { $script:cLine }), [float]$(if ($on) { 1.6 } else { 1 }))
    $e.Graphics.DrawPath($pen, $path); $pen.Dispose(); $path.Dispose()
  })
  $t.Add_Enter({ $this.Parent.Tag.focus = $true; $this.Parent.Invalidate() })
  $t.Add_Leave({ $this.Parent.Tag.focus = $false; $this.Parent.Invalidate() })
  $box.Add_Click({ [void]$this.Controls[0].Focus() })
  $p.Controls.Add($box)
  return $t
}

# ── 左边的步骤栏 ──
$STEPS = @('安装位置', '基本设置', '选功能', '补充信息', '安装', '完成')
$side = New-Object System.Windows.Forms.Panel
$side.Location = New-Object System.Drawing.Point(0, 0); $side.Size = New-Object System.Drawing.Size($SW, ($CH + 70))
Set-DoubleBuffer $side
$form.Controls.Add($side)
$side.Add_Paint({
  param($s, $e)
  $w, $h = Start-Paint $s $e
  $g = $e.Graphics
  $bg = New-Object System.Drawing.Drawing2D.LinearGradientBrush((New-Object System.Drawing.RectangleF(0, 0, $w, $h)), (Rgb 30 64 175), (Rgb 91 33 182), [float]90)
  $g.FillRectangle($bg, [float]0, [float]0, [float]$w, [float]$h); $bg.Dispose()
  $g.DrawImage($script:logo, [float]26, [float]30, [float]44, [float]44)
  $g.DrawString('QQ 伙伴', $script:fBrand, [System.Drawing.Brushes]::White, [float]80, [float]29)
  $faint = New-Object System.Drawing.SolidBrush((Rgb 255 255 255 185))
  $g.DrawString($(if ($script:offline) { '安装向导 · 离线包' } else { '安装向导' }), $script:fBrandSub, $faint, [float]81, [float]54)
  $dim = Rgb 255 255 255 140
  $mid = New-Object System.Drawing.StringFormat; $mid.Alignment = 'Center'; $mid.LineAlignment = 'Center'
  $left = New-Object System.Drawing.StringFormat; $left.LineAlignment = 'Center'
  $atEnd = $script:page -eq ($script:STEPS.Count - 1)
  for ($i = 0; $i -lt $script:STEPS.Count; $i++) {
    $y = 124 + $i * 50
    $now = $i -eq $script:page
    $done = ($i -lt $script:page) -or $atEnd
    if ($now) { $hb = New-Object System.Drawing.SolidBrush((Rgb 255 255 255 34)); $hp = New-RoundPath 14 ($y - 9) ($w - 28) 42 10; $g.FillPath($hb, $hp); $hp.Dispose(); $hb.Dispose() }
    $dot = New-Object System.Drawing.RectangleF(28, $y, 24, 24)
    if ($now -or $done) { $g.FillEllipse([System.Drawing.Brushes]::White, $dot) } else { $pen = New-Object System.Drawing.Pen($dim, [float]1.4); $g.DrawEllipse($pen, $dot); $pen.Dispose() }
    if ($done) {
      $pen = New-Object System.Drawing.Pen($script:cBlue, [float]2.2); $pen.StartCap = 'Round'; $pen.EndCap = 'Round'; $pen.LineJoin = 'Round'
      [System.Drawing.PointF[]]$ck = @((New-Object System.Drawing.PointF(34.5, ($y + 12.5))), (New-Object System.Drawing.PointF(38.5, ($y + 16.5))), (New-Object System.Drawing.PointF(45.5, ($y + 8.5))))
      $g.DrawLines($pen, $ck); $pen.Dispose()
    } else {
      $nb = New-Object System.Drawing.SolidBrush($(if ($now) { $script:cBlue } else { $dim }))
      $g.DrawString([string]($i + 1), $script:fNum, $nb, $dot, $mid); $nb.Dispose()
    }
    $tb = New-Object System.Drawing.SolidBrush($(if ($now -or $done) { [System.Drawing.Color]::White } else { $dim }))
    $g.DrawString($script:STEPS[$i], $(if ($now) { $script:fStepNow } else { $script:fStep }), $tb, (New-Object System.Drawing.RectangleF(64, $y, ($w - 80), 24)), $left); $tb.Dispose()
  }
  $g.DrawString('qq-companion-deepseek', $script:fTiny, $faint, [float]26, [float]($h - 34))
  $faint.Dispose(); $mid.Dispose(); $left.Dispose()
})

# 从已装好的 agent-bridge\installer 里运行时，默认就是那一套
$defaultDir = if (-not (Test-Path $payload) -and (Test-Path (Join-Path (Split-Path $here) 'bridge.mjs'))) { Split-Path (Split-Path $here) } else { Join-Path $env:USERPROFILE 'QQBot' }
$old = @{}

# 页 1：装到哪
$p1 = New-Page
Add-Title $p1 '装一个 QQ 伙伴' $(if ($offline) { '它用一个 QQ 小号陪你聊天：有记性、有情绪、会主动找你。这是离线包，Node.js 和 DSH 已经带在里面，只有 NapCat 要在装的时候从它的官网下。' } else { '它用一个 QQ 小号陪你聊天：有记性、有情绪、会主动找你。装的时候会在线下载 Node.js、DSH 和 NapCat（QQ 协议端）。' })
Add-Field $p1 '装到哪' 40 140
$tDir = New-Input $p1 40 164 468 $defaultDir
$bBrowse = New-Btn '选…' 518 163 92; $p1.Controls.Add($bBrowse)
$bBrowse.Add_Click({ $d = New-Object System.Windows.Forms.FolderBrowserDialog; if ($d.ShowDialog() -eq 'OK') { $tDir.Text = Join-Path $d.SelectedPath 'QQBot' } })
[void](Add-Hint $p1 '路径里最好别有空格。装过的话选同一个目录：聊天记录和人设都会保留，key 不重填就沿用。' 42 206)
$cMirror = New-Object System.Windows.Forms.CheckBox; $cMirror.Text = '用国内镜像下载（在国内建议勾上）'; $cMirror.Checked = $true; $cMirror.AutoSize = $true
$cMirror.Location = New-Object System.Drawing.Point(42, 242); $cMirror.Font = New-Font 9.5; $cMirror.BackColor = [System.Drawing.Color]::Transparent; $p1.Controls.Add($cMirror)
$prep = New-Card $p1 40 288 570 74 $cSoft $cLine 10
$prep.Controls.Add((New-Label '要准备的' 18 13 9.5 $fsBold))
$prep.Controls.Add((New-Label '一个给它用的 QQ 小号　·　一个 DeepSeek API Key　·　电脑上装好 QQ' 18 40 9 $fsReg $cLabel 534))
$warn = New-Card $p1 40 376 570 90 $cAmber $cAmberEdge 10 $cAmberLine
$warn.Controls.Add((New-Label '提醒' 20 13 9.5 $fsBold $cAmberTitle))
$warn.Controls.Add((New-Label 'NapCat 是第三方 QQ 协议端，不是腾讯官方的机器人。请用不常用的小号，别群发、别刷屏，主号有被冻结的风险。' 20 40 9 $fsReg $cAmberInk 530))

# 页 2：名字、QQ、key（两列）
$p2 = New-Page
Add-Title $p2 '基本设置' '以后想改，运行一次 agent-bridge\installer 里的“修改设置”就行。'
Add-Field $p2 '它叫什么' 40 106;          $tName = New-Input $p2 40 130 270 '小鱼'
Add-Field $p2 '你在哪个城市' 340 106;     $tCity = New-Input $p2 340 130 270;   [void](Add-Hint $p2 '看天气用，可以不填' 342 170 268)
Add-Field $p2 '机器人用的 QQ 号' 40 196;  $tBot = New-Input $p2 40 220 270;     [void](Add-Hint $p2 '小号，等下用它扫码登录' 42 260 268)
Add-Field $p2 '你的 QQ 号' 340 196;       $tOwner = New-Input $p2 340 220 270;  [void](Add-Hint $p2 '它会主动找这个号' 342 260 268)
Add-Field $p2 '还有谁能找它聊' 40 286;    $tOther = New-Input $p2 40 310 270;   [void](Add-Hint $p2 'QQ 号，逗号隔开；可以不填' 42 350 268)
Add-Field $p2 '在哪些群里 @ 它' 340 286;  $tGroups = New-Input $p2 340 310 270; [void](Add-Hint $p2 '群号，逗号隔开；不填就只私聊' 342 350 268)
Add-Field $p2 'DeepSeek API Key' 40 376
$lnk = New-Link '去 platform.deepseek.com 申请' 310 378; $lnk.AutoSize = $false; $lnk.Size = New-Object System.Drawing.Size(300, 20); $lnk.TextAlign = 'TopRight'; $lnk.TabStop = $false; $p2.Controls.Add($lnk)
$lnk.Add_LinkClicked({ Start-Process 'https://platform.deepseek.com/api_keys' })
$tKey = New-Input $p2 40 400 570 '' -Secret
$lKeyKeep = Add-Hint $p2 '' 42 440
$cReset = New-Object System.Windows.Forms.CheckBox; $cReset.Text = '把人设换成默认人设（会覆盖现在的 persona.md）'; $cReset.AutoSize = $true
$cReset.Location = New-Object System.Drawing.Point(42, 470); $cReset.Visible = $false; $cReset.Font = New-Font 9.5; $cReset.BackColor = [System.Drawing.Color]::Transparent; $p2.Controls.Add($cReset)

# 页 3：功能。两列卡片，勾上整张变浅蓝；右上角标要额外下载多少；鼠标停上去看完整说明
$p3 = New-Page
Add-Title $p3 '要哪些本事' '聊天、看图、打字像真人这些一直都有；下面的随便勾，以后还能改。'
$checks = @{}
$tip = New-Object System.Windows.Forms.ToolTip; $tip.AutoPopDelay = 20000; $tip.InitialDelay = 400
$badgeBack = New-Object System.Drawing.SolidBrush((Rgb 236 239 244)); $badgeInk = New-Object System.Drawing.SolidBrush($cGray)
$i = 0
foreach ($f in $Features) {
  $card = New-Object System.Windows.Forms.Panel
  $card.Location = New-Object System.Drawing.Point((40 + ($i % 2) * 291), [int](112 + [Math]::Floor($i / 2) * 66)); $card.Size = New-Object System.Drawing.Size(279, 58)
  $card.BackColor = [System.Drawing.Color]::Transparent; $card.Cursor = [System.Windows.Forms.Cursors]::Hand
  Set-DoubleBuffer $card
  $c = New-Object System.Windows.Forms.CheckBox
  $c.Text = $f.name; $c.Checked = $f.def; $c.AutoSize = $true; $c.Location = New-Object System.Drawing.Point(12, 7)
  $c.Font = New-Font 10 -Bold; $c.ForeColor = $cInk; $c.BackColor = [System.Drawing.Color]::Transparent; $c.Cursor = [System.Windows.Forms.Cursors]::Hand
  $d = New-Label $f.short 31 33 8.5 $fsReg $cGray 236; $d.Cursor = [System.Windows.Forms.Cursors]::Hand
  $card.Controls.Add($c); $card.Controls.Add($d)
  $card.Tag = @{ check = $c; mb = $f.mb }; $c.Tag = $card; $d.Tag = $c
  $card.Add_Paint({
    param($s, $e)
    $w, $h = Start-Paint $s $e
    $g = $e.Graphics
    $on = $s.Tag.check.Checked
    $path = New-RoundPath 0.5 0.5 ($w - 1.5) ($h - 1.5) 10
    $fill = New-Object System.Drawing.SolidBrush($(if ($on) { $script:cBlueSoft } else { $script:cPaper })); $g.FillPath($fill, $path); $fill.Dispose()
    $pen = New-Object System.Drawing.Pen($(if ($on) { $script:cBlue } else { $script:cLine }), [float]$(if ($on) { 1.5 } else { 1 })); $g.DrawPath($pen, $path); $pen.Dispose(); $path.Dispose()
    if ($s.Tag.mb -gt 0) {
      $txt = "+$($s.Tag.mb)MB"; $sz = $g.MeasureString($txt, $script:fBadge)
      [float]$bw = $sz.Width + 8; [float]$bx = $w - $bw - 10
      $bp = New-RoundPath $bx 9 $bw 19 9.5
      if ($on) { $g.FillPath([System.Drawing.Brushes]::White, $bp) } else { $g.FillPath($script:badgeBack, $bp) }
      $bp.Dispose()
      $g.DrawString($txt, $script:fBadge, $script:badgeInk, [float]($bx + 4), [float]11.5)
    }
  })
  $c.Add_CheckedChanged({ $this.Tag.Invalidate($true); Update-Size })
  $d.Add_Click({ $this.Tag.Checked = -not $this.Tag.Checked })
  $card.Add_Click({ $this.Tag.check.Checked = -not $this.Tag.check.Checked })
  foreach ($x in @($card, $c, $d)) { $tip.SetToolTip($x, $f.desc) }
  $checks[$f.id] = $c
  $p3.Controls.Add($card)
  $i++
}
# 空出来的格子放一句提醒
$note = New-Card $p3 (40 + ($i % 2) * 291) ([int](112 + [Math]::Floor($i / 2) * 66)) 279 58 $cSoft $null 10
$note.Controls.Add((New-Label '勾了刷 B站、手机控制或听声音，它就能在这台电脑上随意执行命令。' 14 11 8.5 $fsReg $cGray 252))

# 页 4：功能要的额外信息（手机 PIN、语音 key）
$p4 = New-Page
Add-Title $p4 '再填几项'
$l4Sub = New-Label '你勾的功能还要一点信息。' 42 74 9.5 $fsReg $cGray 560; $p4.Controls.Add($l4Sub)
$gPhone = New-Card $p4 40 116 570 124 $cSoft $cLine 12
$gPhone.Controls.Add((New-Label '手机控制' 20 16 10.5 $fsBold))
Add-Field $gPhone '锁屏 PIN' 22 56; $tPin = New-Input $gPhone 140 48 250 '' -Secret
[void](Add-Hint $gPhone '手机锁了它能自己解开；不填就让你手动解。手机要打开 USB 调试。' 22 94 530)
$gVoice = New-Card $p4 40 256 570 190 $cSoft $cLine 12
$gVoice.Controls.Add((New-Label '发语音' 20 16 10.5 $fsBold))
Add-Field $gVoice '百炼 API Key' 22 56; $tDash = New-Input $gVoice 140 48 410 '' -Secret
Add-Field $gVoice '音色 ID' 22 102; $tVoice = New-Input $gVoice 140 94 410
[void](Add-Hint $gVoice '在阿里云百炼的语音合成里复刻一个音色（只用本人同意的声音），或者用“声音设计”按文字描述做一个，把 cosyvoice-… 开头的音色 ID 填这里。' 22 140 530)
$lNothing = New-Label '勾的功能不用再填什么，直接点“开始安装”就行。' 42 74 9.5 $fsReg $cGray 560; $p4.Controls.Add($lNothing)

# 页 5：安装中
$p5 = New-Page
Add-Title $p5 '正在安装' '装好之前别关这个窗口；中途断了，再运行一次会接着装。'
$lStep = New-Label '' 42 110 10.5 $fsReg $cInk 460; $p5.Controls.Add($lStep)
$lPct = New-Label '' 510 110 10.5 $fsBold $cBlue; $lPct.AutoSize = $false; $lPct.MaximumSize = [System.Drawing.Size]::Empty; $lPct.Size = New-Object System.Drawing.Size(100, 22); $lPct.TextAlign = 'TopRight'; $p5.Controls.Add($lPct)
$bar = New-Object System.Windows.Forms.Panel; $bar.Location = New-Object System.Drawing.Point(40, 138); $bar.Size = New-Object System.Drawing.Size(570, 10)
$bar.BackColor = [System.Drawing.Color]::Transparent; $bar.Tag = @{ pct = 0 }; Set-DoubleBuffer $bar
$bar.Add_Paint({
  param($s, $e)
  $w, $h = Start-Paint $s $e
  $g = $e.Graphics
  $track = New-RoundPath 0 0 ($w - 0.5) ($h - 0.5) 5
  $tb = New-Object System.Drawing.SolidBrush($script:cTrack); $g.FillPath($tb, $track); $tb.Dispose(); $track.Dispose()
  [float]$fw = ($w - 0.5) * [double]$s.Tag.pct / 100
  if ($fw -ge $h) {
    $fill = New-RoundPath 0 0 $fw ($h - 0.5) 5
    $fb = New-Object System.Drawing.Drawing2D.LinearGradientBrush((New-Object System.Drawing.RectangleF(0, 0, ($fw + 1), $h)), (Rgb 59 130 246), (Rgb 124 58 237), [float]0)
    $g.FillPath($fb, $fill); $fb.Dispose(); $fill.Dispose()
  }
})
$p5.Controls.Add($bar)
$lSub = New-Label '' 42 156 9 $fsReg $cGray; $p5.Controls.Add($lSub)
$logBox = New-Card $p5 40 182 570 326 $cSoft $cLine 10
$tLog = New-Object System.Windows.Forms.TextBox; $tLog.Multiline = $true; $tLog.ReadOnly = $true; $tLog.ScrollBars = 'Vertical'; $tLog.BorderStyle = 'None'
$tLog.Location = New-Object System.Drawing.Point(14, 12); $tLog.Size = New-Object System.Drawing.Size(552, 304); $tLog.Anchor = 'Top, Bottom, Left, Right'   # 露出 NapCat 提示时日志框变矮，跟着缩
$tLog.Font = New-Font 9; $tLog.BackColor = $cSoft; $tLog.ForeColor = $cLabel
$logBox.Controls.Add($tLog)
# NapCat 要自己从官网下的时候，安装页上多出来的提示（平时藏着）
$pNap = New-Card $p5 40 182 570 120 $cAmber $cAmberEdge 10 $cAmberLine; $pNap.Visible = $false; $pNap.BringToFront()
$pNap.Controls.Add((New-Label "NapCat 要从它的官网下（它不许别的软件转发）。已经在浏览器里打开了下载链接，下好 $NapCatName 会自动接着装，不用管这个窗口。" 18 12 9.5 $fsReg $cAmberInk 536))
$aNap = New-Link '下载没开始？打开 NapCat 官网' 18 70; $pNap.Controls.Add($aNap)
$aNap.Add_LinkClicked({ Start-Process 'https://github.com/NapNeko/NapCatQQ/releases/latest' })
$aNapFast = New-Link 'GitHub 太慢？用国内加速链接下' 18 92; $pNap.Controls.Add($aNapFast)
$aNapFast.Add_LinkClicked({ Start-Process (NapCat-Urls $true)[0] })
$bNapPick = New-Btn '下好了，自己选文件' 300 72 150 34; $pNap.Controls.Add($bNapPick)
$bNapPick.Add_Click({
  $dlg = New-Object System.Windows.Forms.OpenFileDialog; $dlg.Title = "选 $NapCatName"; $dlg.Filter = 'NapCat 安装包|NapCat*.zip|zip 文件|*.zip'
  if ($dlg.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $script:napPick = $dlg.FileName }
})
$bNapSkip = New-Btn '先跳过' 460 72 92 34; $pNap.Controls.Add($bNapSkip)
$bNapSkip.Add_Click({ $script:napSkip = $true })
function Show-NapPanel([bool]$on) {
  $script:pNap.Visible = $on
  if ($on) { $script:logBox.Top = Px 314; $script:logBox.Height = Px 194 } else { $script:logBox.Top = Px 182; $script:logBox.Height = Px 326 }
  $script:logBox.Invalidate(); Pump
}

# 页 6：完成（都成了是绿色对勾；有几项没成是黄色感叹号；核心没装上是红色）
$p6 = New-Page
$script:doneState = 'ok'
$doneIcon = New-Object System.Windows.Forms.Panel; $doneIcon.Location = New-Object System.Drawing.Point(40, 30); $doneIcon.Size = New-Object System.Drawing.Size(52, 52); $doneIcon.BackColor = [System.Drawing.Color]::Transparent
$doneIcon.Add_Paint({
  param($s, $e)
  $w, $h = Start-Paint $s $e
  $g = $e.Graphics
  $col = switch ($script:doneState) { 'fail' { $script:cRed } 'warn' { $script:cAmberLine } default { $script:cGreen } }
  $b = New-Object System.Drawing.SolidBrush($col); $g.FillEllipse($b, [float]1, [float]1, [float]($w - 2), [float]($h - 2)); $b.Dispose()
  $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::White, [float]4); $pen.StartCap = 'Round'; $pen.EndCap = 'Round'; $pen.LineJoin = 'Round'
  if ($script:doneState -eq 'ok') {
    [System.Drawing.PointF[]]$pts = @((New-Object System.Drawing.PointF(15.5, 27)), (New-Object System.Drawing.PointF(23, 34.5)), (New-Object System.Drawing.PointF(37, 18.5)))
    $g.DrawLines($pen, $pts)
  } else {
    $g.DrawLine($pen, [float]26, [float]14, [float]26, [float]29)
    $g.FillEllipse([System.Drawing.Brushes]::White, [float]23.5, [float]34, [float]5, [float]5)
  }
  $pen.Dispose()
})
$p6.Controls.Add($doneIcon)
$lDone = New-Label '装好了' 106 38 17 $fsBold; $p6.Controls.Add($lDone)
# 两张卡片：上面每一项的结果，下面“接下来”怎么用；字多了（路径很长、失败原因很长）各自出滚动条
# 卡片的宽高要传设计时的数：控件一加进窗口就按系统缩放放大了，这时再读 $card.Width 就是放大后的，会被放大两次
function New-ScrollText($card, [int]$w, [int]$h, [int]$top, $back, [float]$size, $color) {
  $sc = New-Object System.Windows.Forms.Panel; $sc.AutoScroll = $true; $sc.BackColor = $back
  $sc.Location = New-Object System.Drawing.Point(20, $top); $sc.Size = New-Object System.Drawing.Size(($w - 26), ($h - $top - 10))
  $l = New-Label '' 0 0 $size $fsReg $color 518; $l.BackColor = $back
  $sc.Controls.Add($l); $card.Controls.Add($sc); return $l
}
$doneCard = New-Card $p6 40 104 570 232 $cSoft $cLine 12
$lDoneText = New-ScrollText $doneCard 570 232 14 $cSoft 9.5 $cInk
$nextCard = New-Card $p6 40 348 570 160 $cBlueSoft (Rgb 191 219 254) 12 $cBlue
$nextCard.Controls.Add((New-Label '接下来' 20 14 9.5 $fsBold $cBlueDark))
$lNext = New-ScrollText $nextCard 570 160 40 $cBlueSoft 9 $cLabel

# ── 底部按钮栏 ──
$foot = New-Object System.Windows.Forms.Panel; $foot.Location = New-Object System.Drawing.Point($SW, $CH); $foot.Size = New-Object System.Drawing.Size($CW, 70); $foot.BackColor = $cPaper
$foot.Add_Paint({ param($s, $e) $w, $h = Start-Paint $s $e; $pen = New-Object System.Drawing.Pen($script:cLine, [float]1); $e.Graphics.DrawLine($pen, [float]0, [float]0.5, [float]$w, [float]0.5); $pen.Dispose() })
$form.Controls.Add($foot)
$sizeBox = New-Object System.Windows.Forms.Panel; $sizeBox.Location = New-Object System.Drawing.Point(40, 13); $sizeBox.Size = New-Object System.Drawing.Size(320, 46); $sizeBox.BackColor = $cPaper; $foot.Controls.Add($sizeBox)
$lSize = New-Label '' 0 0 10 $fsBold $cInk 320; $sizeBox.Controls.Add($lSize)
$lSize2 = New-Label '' 1 24 8.5 $fsReg $cGray 320; $sizeBox.Controls.Add($lSize2)
$bBack = New-Btn '上一步' ($CW - 40 - 128 - 10 - 100) 16 100; $foot.Controls.Add($bBack)
$bNext = New-Btn '下一步' ($CW - 40 - 128) 16 128 -Primary; $foot.Controls.Add($bNext)
$form.AcceptButton = $bNext
function Update-Size {
  $mb = $CoreMB; foreach ($f in $Features) { if ($checks[$f.id].Checked) { $mb += $f.mb } }
  $lSize.Text = "大约要下载 $mb MB"
  $lSize2.Text = $(if ($offline) { '主要是 NapCat；Node.js 和 DSH 包里自带' } else { '已经装了的会跳过' })
}
Update-Size
$form.ResumeLayout($false)   # 这里按系统缩放放大全部控件

$pages = @($p1, $p2, $p3, $p4, $p5, $p6)
$script:page = 0
# 截图模式用：截屏幕上这个窗口（跟用户看到的一样）
function Save-Shot([string]$name) {
  New-Item -ItemType Directory -Force -Path $Shot | Out-Null
  $form.Refresh(); [System.Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 150
  $b = $form.Bounds
  $bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
  $g.Dispose(); $bmp.Save((Join-Path $Shot $name)); $bmp.Dispose()
}
function Show-Page([int]$i, [string]$tag = '') {
  $script:page = $i
  for ($k = 0; $k -lt $pages.Count; $k++) { $pages[$k].Visible = ($k -eq $i) }
  $bBack.Visible = ($i -ge 1 -and $i -le 3)
  $sizeBox.Visible = ($i -eq 2)
  $bNext.Enabled = ($i -ne 4)
  $bNext.BackColor = if ($bNext.Enabled) { $script:cBlue } else { Rgb 191 203 222 }
  $bNext.Text = switch ($i) { 3 { '开始安装' } 4 { '安装中…' } 5 { if ($script:doneState -eq 'fail') { '关闭' } else { '启动它' } } default { '下一步' } }
  if ($i -eq 3) {
    $gPhone.Visible = $checks['phone'].Checked
    $gVoice.Visible = $checks['voice'].Checked
    $gVoice.Top = Px $(if ($gPhone.Visible) { 256 } else { 116 })
    $lNothing.Visible = -not ($gPhone.Visible -or $gVoice.Visible)
    $l4Sub.Visible = -not $lNothing.Visible
  }
  $side.Invalidate()
  if ($Shot -and $form.Visible) { Save-Shot "page$($i + 1)$tag.png" }   # 窗口还没出来时截不到
}
function Fail([string]$m) { [void][System.Windows.Forms.MessageBox]::Show($form, $m, '还差一点', 'OK', 'Warning') }
# 装完：按结果换图标和标题，列出每一项
function Show-Done($r, $A, [string]$tag = '') {
  $bad = @($r | Where-Object { -not $_.ok })
  $core = @($bad | Where-Object { $_.what -match 'Node|DSH|程序文件' })
  $script:doneState = if ($core) { 'fail' } elseif ($bad) { 'warn' } else { 'ok' }
  $lDone.Text = $(if ($core) { '没装完' } elseif ($bad) { '装好了（有几项没成）' } else { '装好了' })
  $lines = @()
  foreach ($x in $r) { $lines += $(if ($x.ok) { "✓ $($x.what)" } else { "✗ $($x.what)：$($x.note)" }) }
  $lDoneText.Text = $lines -join "`r`n"
  $next = @()
  if (-not $core) {
    $next += "桌面上有两个快捷方式：「$($A.name)」启动（第一次要用手机 QQ 扫码登录机器人那个号），「$($A.name)状态」看它在不在线。"
    $next += "人设在 $($A.dir)\agent-bridge\persona.md，随便改；改完在启动器里选「只重启 bridge」。"
  } else { $next += '核心部分没装上，看看日志，把问题解决后再运行一次安装（会接着装）。' }
  $next += '安装日志：' + (Join-Path $A.dir 'install.log')
  $lNext.Text = $next -join "`r`n"
  $doneIcon.Invalidate()
  Show-Page 5 $tag
}

# 已经装过：读出原来的设置填上
function Load-Existing {
  $envPath = Join-Path $tDir.Text 'agent-bridge\.env'
  $script:old = Read-EnvFile $envPath
  if (-not $script:old.Count) { $lKeyKeep.Text = ''; $cReset.Visible = $false; return }
  if ($old.BOT_NAME) { $tName.Text = $old.BOT_NAME }
  $q = @($old.ALLOWED_QQ -split ',' | Where-Object { $_ })
  if ($old.PROACTIVE_QQ) { $tOwner.Text = $old.PROACTIVE_QQ; $tOther.Text = (@($q | Where-Object { $_ -ne $old.PROACTIVE_QQ }) -join ',') }
  $tGroups.Text = $old.ALLOWED_GROUPS
  $tCity.Text = $old.WEATHER_CITY
  $lKeyKeep.Text = $(if ($old.DEEPSEEK_API_KEY) { '已经填过，不改就留空' } else { '' })
  $cReset.Visible = $true
  $map = @{ memory = 'FACTS'; proactive = 'PROACTIVE'; autonomy = 'AUTONOMY'; stickers = 'STEAL_STICKERS'; mimic = 'MIMIC'; phone = 'PHONE_MONITOR'; voice = 'VOICE'; sing = 'SING'; radio = 'RADIO' }
  foreach ($k in $map.Keys) { if ($old.ContainsKey($map[$k])) { $checks[$k].Checked = ($old[$map[$k]] -eq 'true') } }
  $tVoice.Text = $old.VOICE_ID
}

$bBack.Add_Click({ if ($script:page -gt 0) { Show-Page ($script:page - 1) } })
$bNext.Add_Click({
  switch ($script:page) {
    0 {
      if (-not $tDir.Text.Trim()) { Fail '选一个安装位置'; return }
      Load-Existing; Show-Page 1
    }
    1 {
      if (-not $tName.Text.Trim()) { Fail '给它起个名字'; return }
      if ($tBot.Text -notmatch '^\d{5,12}$') { Fail '机器人用的 QQ 号要填数字'; return }
      if ($tOwner.Text -notmatch '^\d{5,12}$') { Fail '你的 QQ 号要填数字'; return }
      if (-not $tKey.Text.Trim() -and -not $old.DEEPSEEK_API_KEY) { Fail '要填 DeepSeek API Key，它才能说话'; return }
      Show-Page 2
    }
    2 { Show-Page 3 }
    3 {
      if ($checks['voice'].Checked -and ((-not $tDash.Text.Trim() -and -not $old.DASHSCOPE_API_KEY) -or -not $tVoice.Text.Trim())) { Fail '发语音要填百炼 API Key 和音色 ID（不想填就回去把「发语音」去掉）'; return }
      Show-Page 4
      $A = [pscustomobject]@{
        dir = $tDir.Text.Trim(); mirror = $cMirror.Checked; name = $tName.Text.Trim(); botQQ = $tBot.Text.Trim(); ownerQQ = $tOwner.Text.Trim()
        otherQQ = $tOther.Text; groups = $tGroups.Text; city = $tCity.Text.Trim(); deepseekKey = $tKey.Text.Trim()
        features = @($Features | Where-Object { $checks[$_.id].Checked } | ForEach-Object { $_.id })
        phonePin = $tPin.Text.Trim(); dashscopeKey = $tDash.Text.Trim(); voiceId = $tVoice.Text.Trim(); resetPersona = $cReset.Checked
      }
      if ($script:testA) { foreach ($k in 'skipNpm', 'noShortcuts', 'nodeExe', 'downloadsDir') { if ($script:testA.$k) { $A | Add-Member -NotePropertyName $k -NotePropertyValue $script:testA.$k } } }   # 测试用的开关带过去
      $script:ui = @{ log = $tLog; bar = $bar; step = $lStep; sub = $lSub; pct = $lPct }
      $script:installed = $A
      try { $r = Install-All $A } catch { Say "出错了：$($_.Exception.Message)"; $r = @([pscustomobject]@{ what = '安装'; ok = $false; note = $_.Exception.Message }) }
      Show-Done $r $A
    }
    5 {
      if ($bNext.Text -eq '启动它') { Start-Process (Join-Path $script:installed.dir 'agent-bridge\launch.vbs') }
      $form.Close()
    }
  }
})

Show-Page 0
$form.Add_Shown({ $tDir.Select($tDir.Text.Length, 0) })   # 别一打开就全选着路径
if ($Shot) {
  # 截图模式：依次显示每页（不真的安装），截完就关。截的是屏幕上的窗口，所以先放到最前面
  $form.TopMost = $true
  $form.Add_Shown({
    Start-Sleep -Milliseconds 600
    if ($Answers) {
      # 按答案在界面上填好、一页页点下去，真装一次（测有界面的安装流程，顺便截每一步）
      $script:testA = $T = Get-Content $Answers -Raw -Encoding UTF8 | ConvertFrom-Json
      $tDir.Text = $T.dir; $cMirror.Checked = [bool]$T.mirror; Show-Page 0; $bNext.PerformClick()
      $tName.Text = $T.name; $tBot.Text = $T.botQQ; $tOwner.Text = $T.ownerQQ; $tOther.Text = [string]$T.otherQQ; $tGroups.Text = [string]$T.groups; $tCity.Text = [string]$T.city
      $tKey.Text = $(if ($T.deepseekKey) { $T.deepseekKey } else { 'sk-test' }); $bNext.PerformClick()
      foreach ($f in $Features) { $checks[$f.id].Checked = @($T.features) -contains $f.id }
      $bNext.PerformClick()
      $tPin.Text = [string]$T.phonePin; $tDash.Text = [string]$T.dashscopeKey; $tVoice.Text = [string]$T.voiceId
      $bNext.PerformClick()   # 开始安装，装完停在完成页
      $form.Close(); return
    }
    foreach ($i in 0..2) { Show-Page $i }
    Show-Page 3 '-empty'
    $checks['phone'].Checked = $true; $checks['voice'].Checked = $true; Show-Page 3
    $script:ui = @{ log = $tLog; bar = $bar; step = $lStep; sub = $lSub; pct = $lPct }
    Show-Page 4
    foreach ($m in @('安装到 C:\QQBot', '✓ 程序文件', '✓ 配置（.env / 人设）', '  解开了自带的 Node.js 和 DSH', '✓ Node.js v24.14.1（安装包自带）', '✓ DSH（安装包自带）', '✓ DSH 配置')) { Say $m }
    Set-Progress 50 'NapCat'; Save-Shot 'page5.png'
    Say "  NapCat 要从官网下：已经在浏览器里打开了下载链接，下好 $NapCatName 会自动接着装"
    Show-NapPanel $true; Save-Shot 'page5-napcat.png'; Show-NapPanel $false
    $demo = [pscustomobject]@{ name = '小鱼'; dir = 'C:\QQBot' }
    $okList = @('程序文件', '配置（.env / 人设）', 'Node.js v24.14.1（安装包自带）', 'DSH（安装包自带）', 'DSH 配置', 'NapCat', 'NapCat 连接配置', 'QQ（C:\Program Files\Tencent\QQNT\QQ.exe）', '表情包', '桌面快捷方式（小鱼 / 小鱼状态）')
    Show-Done @($okList | ForEach-Object { [pscustomobject]@{ what = $_; ok = $true; note = '' } }) $demo
    $someBad = @($okList | ForEach-Object { [pscustomobject]@{ what = $_; ok = ($_ -notlike 'NapCat*'); note = $(if ($_ -eq 'NapCat') { "还没下：从官网下好 $NapCatName（放在`“下载`”文件夹就行），再运行一次 agent-bridge\installer\修改设置.cmd，会自动找到并配置好" } else { '' }) } } | Where-Object { $_.what -ne 'NapCat 连接配置' })
    Show-Done $someBad $demo '-warn'
    $form.Close()
  })
}
[void]$form.ShowDialog()
