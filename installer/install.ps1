# QQ 机器人一键安装：选位置 → 填名字/QQ/key → 勾功能 → 自动装好 → 桌面快捷方式。
# 只带代码；Node.js、DSH、NapCat 和各功能要的东西安装时在线下载（可选国内镜像）。
#   -Answers <json>   不弹窗，按 json 里的答案装（测试 / 批量用）
#   -Cache <dir>      先在这个目录里找已经下好的文件（按文件名），找不到再下载
#   -Shot <dir>       每个页面截一张图（检查界面用）
#   -NoElevate        不请求管理员（测试用；装 Node.js 时会失败）
param([string]$Answers = '', [string]$Cache = '', [string]$Shot = '', [switch]$NoElevate)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$here    = $PSScriptRoot
$payload = Join-Path (Split-Path $here) 'payload'
$unattended = [bool]$Answers

function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}
if (-not $unattended -and -not $NoElevate -and -not (Test-Admin)) {
  $a = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-File', "`"$PSCommandPath`"")
  if ($Cache) { $a += @('-Cache', "`"$Cache`"") }
  if ($Shot) { $a += @('-Shot', "`"$Shot`"") }
  Start-Process powershell -Verb RunAs -ArgumentList $a
  exit
}

# ── 功能清单 ─────────────────────────────────────────────────────────────
# id、名字、说明、默认勾不勾、要下载多少
$Features = @(
  @{ id = 'memory';    name = '记性、日记和回访';      def = $true;  mb = 0;   desc = '记住聊过的事，每天睡前写日记当长期记忆；过两天自然地问一句；会学对方的口头禅' }
  @{ id = 'proactive'; name = '主动找你';             def = $true;  mb = 0;   desc = '早安晚安、好久没聊冒个泡；被冷落了会有点小情绪' }
  @{ id = 'autonomy';  name = '自己找事做，慢慢长出性格'; def = $true; mb = 0; desc = '没人理它时自己找点事干，睡前回想，慢慢有自己的喜好' }
  @{ id = 'stickers';  name = '表情包';               def = $true;  mb = 1;   desc = '会发表情图、会收你发的表情包（下载一套 Twemoji 默认表情）' }
  @{ id = 'mimic';     name = '学某个人说话';          def = $true;  mb = 0;   desc = '把一段聊天记录合并转发给它，它会慢慢学那个人的说话方式' }
  @{ id = 'bili';      name = '刷 B站';               def = $true;  mb = 0;   desc = '自己刷热门、看视频的弹幕热评和画面（要允许它在电脑上执行命令）' }
  @{ id = 'phone';     name = '手机控制';              def = $false; mb = 10;  desc = '用 USB 调试控制安卓手机：截图、点、打字（下载 adb）' }
  @{ id = 'listen';    name = '听声音 / 看直播';        def = $false; mb = 450; desc = '本地 Whisper 把声音转成文字（下载 Python、语音识别库和模型）' }
  @{ id = 'voice';     name = '发语音';               def = $false; mb = 0;   desc = '用阿里云百炼 CosyVoice 发语音（要填百炼 API Key 和音色 ID）' }
  @{ id = 'sing';      name = '唱歌';                 def = $false; mb = 0;   desc = '发提前转好的歌（要另外装 Seed-VC 并用声音训练，安装包不带模型）' }
  @{ id = 'radio';     name = '深夜电台';             def = $true;  mb = 0;   desc = '说“开台”她就录一期两三分钟的语音节目，配节目卡和一首歌（没开发语音就发文字版）' }
)
$CoreMB = 30 + 500 + 125   # Node.js（没装才下）+ DSH + NapCat

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
# 模板：{{NAME}} 换名字；<!-- if:x --> … <!-- end --> 只保留勾了的功能（可以嵌套）
function Expand-Template([string]$text, [string]$name, $on) {
  $re = [regex]'(?s)<!-- if:(\w+) -->\r?\n?((?:(?!<!-- if:).)*?)<!-- end -->\r?\n?'
  while ($re.IsMatch($text)) {
    $text = $re.Replace($text, { param($m) if ($on -contains $m.Groups[1].Value) { $m.Groups[2].Value } else { '' } }, 1)
  }
  $text = [regex]::Replace($text, '(\r?\n){3,}', "`r`n`r`n")
  return $text.Replace('{{NAME}}', $name)
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
  if ($script:ui) { $script:ui.bar.Value = [Math]::Max(0, [Math]::Min(100, $pct)); $script:ui.step.Text = $what; Pump }
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
function Invoke-Tool([string]$exe, [string[]]$argList, [string]$cwd, [hashtable]$envExtra = @{}) {
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
    foreach ($t in $tail) { Say "    $t" }
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
    [IO.File]::WriteAllText($personaPath, (Expand-Template ([IO.File]::ReadAllText((Join-Path $app 'persona.default.md'), [Text.Encoding]::UTF8)) $A.name $on), (New-Object Text.UTF8Encoding($false)))
    Say '  人设：用默认人设（可以直接改 agent-bridge\persona.md）'
  } else { Say '  人设：保留现在的 persona.md' }
  [IO.File]::WriteAllText((Join-Path $dir 'AGENTS.md'), (Expand-Template ([IO.File]::ReadAllText((Join-Path $app 'installer\AGENTS.tpl.md'), [Text.Encoding]::UTF8)) $A.name $on), (New-Object Text.UTF8Encoding($false)))
  Mark '配置（.env / 人设 / AGENTS.md）' $true

  # 3. Node.js：要 24 以上，低了就装 Node 24。DSH 在 22.11 这种旧版上会悄悄跑不起来（没输出也不报错），24 实测能跑。
  # 找哪个 node 跟启动器、守护一样：先 C:\Program Files\nodejs，再 PATH，免得检查的和实际用的不是同一个。
  Set-Progress 12 'Node.js'
  Refresh-Path
  $nodeMin = 24
  function Find-Node {
    if ($A.nodeExe) { return $A.nodeExe }   # 测试用：当成电脑上装的就是这个
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
  } else { Mark "Node.js v$ver（已经装了）" $true }
  $npm = Join-Path (Split-Path $node) 'npm.cmd'

  # 4. DSH 和依赖
  Set-Progress 20 '安装 DSH（约 500MB，会久一点）'
  $npmArgs = @('install', '--omit=dev', '--no-audit', '--no-fund')
  if ($mirror) { $npmArgs += @('--registry', 'https://registry.npmmirror.com') }
  if ($A.skipNpm) { Mark 'DSH（测试：跳过 npm）' $true }
  else {
    $code = Invoke-Tool $npm $npmArgs $app
    if ($code -ne 0 -or -not (Test-Path (Join-Path $app 'node_modules\@deepseek-ai\dsh\lib\bin.js'))) { Mark 'DSH' $false "npm 退出码 $code"; return $results }
    Mark 'DSH' $true
  }

  # 5. DSH 配置：第一次用时它会自己初始化 headless；先跑一下让它建好，再写用哪个模型
  Set-Progress 45 '配置 DSH'
  $dshHome = Join-Path $dir '.dsh-home'
  $bin = Join-Path $app 'node_modules\@deepseek-ai\dsh\lib\bin.js'
  if (Test-Path $bin) { $null = Invoke-Tool $node @($bin, '--profile', 'headless', '--dump-config') $dir @{ DSH_HOME = $dshHome } }
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

  # 6. NapCat
  Set-Progress 50 'NapCat（约 125MB）'
  $napApp = Join-Path $tools 'napcat\app'
  if (-not (Test-Path (Join-Path $napApp 'napcat\NapCatWinBootMain.exe'))) {
    try {
      $zip = Join-Path $env:TEMP 'NapCat.Shell.Windows.Node.zip'
      $urls = @()
      try {
        $wc = New-Object Net.WebClient; $wc.Headers.Add('User-Agent', 'qqbot-installer'); $wc.Encoding = [Text.Encoding]::UTF8
        $rel = $wc.DownloadString('https://api.github.com/repos/NapNeko/NapCatQQ/releases/latest') | ConvertFrom-Json
        $asset = $rel.assets | Where-Object { $_.name -eq 'NapCat.Shell.Windows.Node.zip' } | Select-Object -First 1
        if ($asset) { $urls += $asset.browser_download_url }
      } catch { Say '  GitHub 接口连不上，用固定版本 v4.18.41' }
      if (-not $urls) { $urls += 'https://github.com/NapNeko/NapCatQQ/releases/download/v4.18.41/NapCat.Shell.Windows.Node.zip' }
      if ($mirror) { $urls = @($urls | ForEach-Object { "https://ghfast.top/$_" }) + $urls }
      Get-File $urls $zip 'NapCat'
      New-Item -ItemType Directory -Force -Path $napApp | Out-Null
      Expand-Archive -Path $zip -DestinationPath $napApp -Force
      Mark 'NapCat' $true
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
  if ($on -contains 'sing') { Say '  唱歌：先另外装好 Seed-VC，再在 agent-bridge\.env 里填 SEEDVC_RUNTIME，用 sing\render.py 转歌（见 README）' }

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
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -Namespace Win -Name Dpi -MemberDefinition '[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetProcessDPIAware();'
[void][Win.Dpi]::SetProcessDPIAware()
[System.Windows.Forms.Application]::EnableVisualStyles()

$paper = [System.Drawing.Color]::FromArgb(250, 250, 251)
$ink   = [System.Drawing.Color]::FromArgb(31, 35, 40)
$gray  = [System.Drawing.Color]::FromArgb(110, 118, 129)
$blue  = [System.Drawing.Color]::FromArgb(9, 105, 218)
$red   = [System.Drawing.Color]::FromArgb(207, 34, 46)
$face  = 'Microsoft YaHei UI'

$form = New-Object System.Windows.Forms.Form
$form.AutoScaleDimensions = New-Object System.Drawing.SizeF(96, 96)
$form.AutoScaleMode = 'Dpi'
$form.Text = 'QQ 机器人 · 安装'
$form.ClientSize = New-Object System.Drawing.Size(640, 560)
$form.FormBorderStyle = 'FixedSingle'
$form.MaximizeBox = $false
$form.StartPosition = 'CenterScreen'
$form.BackColor = $paper
$form.Font = New-Object System.Drawing.Font($face, 9.5)

function New-Label([string]$text, [int]$x, [int]$y, [float]$size = 9.5, $style = [System.Drawing.FontStyle]::Regular, $color = $ink, [int]$w = 580) {
  $l = New-Object System.Windows.Forms.Label
  $l.Text = $text; $l.Location = New-Object System.Drawing.Point($x, $y); $l.ForeColor = $color
  $l.Font = New-Object System.Drawing.Font($face, $size, $style)
  $l.MaximumSize = New-Object System.Drawing.Size($w, 0); $l.AutoSize = $true
  return $l
}
function New-Box([int]$x, [int]$y, [int]$w = 300, [string]$text = '', [switch]$Secret) {
  $t = New-Object System.Windows.Forms.TextBox
  $t.Location = New-Object System.Drawing.Point($x, $y); $t.Width = $w; $t.Text = $text
  if ($Secret) { $t.UseSystemPasswordChar = $true }
  return $t
}
function New-Page { $p = New-Object System.Windows.Forms.Panel; $p.Location = New-Object System.Drawing.Point(0, 0); $p.Size = New-Object System.Drawing.Size(640, 500); $p.Visible = $false; $form.Controls.Add($p); return $p }

# 从已装好的 agent-bridge\installer 里运行时，默认就是那一套
$defaultDir = if (-not (Test-Path $payload) -and (Test-Path (Join-Path (Split-Path $here) 'bridge.mjs'))) { Split-Path (Split-Path $here) } else { Join-Path $env:USERPROFILE 'QQBot' }
$old = @{}

# 页 1：位置
$p1 = New-Page
$p1.Controls.Add((New-Label '装一个 QQ 机器人' 32 28 15 ([System.Drawing.FontStyle]::Bold)))
$p1.Controls.Add((New-Label '它会用一个 QQ 小号跟你聊天：有记性、有情绪、会主动找你；你可以勾选要哪些本事。安装时会在线下载 Node.js、DSH、NapCat（QQ 协议端）和你勾的功能要的东西。' 32 68 9.5 ([System.Drawing.FontStyle]::Regular) $gray))
$p1.Controls.Add((New-Label '装到哪' 32 140))
$tDir = New-Box 32 164 470 $defaultDir; $p1.Controls.Add($tDir)
$bBrowse = New-Object System.Windows.Forms.Button; $bBrowse.Text = '选…'; $bBrowse.Location = New-Object System.Drawing.Point(510, 162); $bBrowse.Width = 70; $p1.Controls.Add($bBrowse)
$bBrowse.Add_Click({ $d = New-Object System.Windows.Forms.FolderBrowserDialog; if ($d.ShowDialog() -eq 'OK') { $tDir.Text = Join-Path $d.SelectedPath 'QQBot' } })
$p1.Controls.Add((New-Label '路径里最好别有空格。已经装过的话选同一个目录：会保留聊天记录和人设，key 不重填就沿用。' 32 194 9 ([System.Drawing.FontStyle]::Regular) $gray))
$cMirror = New-Object System.Windows.Forms.CheckBox; $cMirror.Text = '用国内镜像下载（在国内建议勾上）'; $cMirror.Checked = $true; $cMirror.AutoSize = $true
$cMirror.Location = New-Object System.Drawing.Point(32, 240); $p1.Controls.Add($cMirror)
$p1.Controls.Add((New-Label '提醒：NapCat 是第三方 QQ 协议端，不是腾讯官方的机器人。请用不常用的小号，别群发、别刷屏，主号有被冻结的风险。' 32 290 9 ([System.Drawing.FontStyle]::Regular) $red))

# 页 2：名字、QQ、key
$p2 = New-Page
$p2.Controls.Add((New-Label '基本设置' 32 28 15 ([System.Drawing.FontStyle]::Bold)))
$y = 72
$p2.Controls.Add((New-Label '它叫什么' 32 $y)); $tName = New-Box 200 ($y - 3) 200 '小鱼'; $p2.Controls.Add($tName); $y += 40
$p2.Controls.Add((New-Label '机器人用的 QQ 号' 32 $y)); $tBot = New-Box 200 ($y - 3) 200; $p2.Controls.Add($tBot)
$p2.Controls.Add((New-Label '（小号，等下扫码登录它）' 410 $y 9 ([System.Drawing.FontStyle]::Regular) $gray 200)); $y += 40
$p2.Controls.Add((New-Label '你的 QQ 号' 32 $y)); $tOwner = New-Box 200 ($y - 3) 200; $p2.Controls.Add($tOwner)
$p2.Controls.Add((New-Label '（它会主动找这个号）' 410 $y 9 ([System.Drawing.FontStyle]::Regular) $gray 200)); $y += 40
$p2.Controls.Add((New-Label '还有谁能找它聊' 32 $y)); $tOther = New-Box 200 ($y - 3) 380; $p2.Controls.Add($tOther); $y += 26
$p2.Controls.Add((New-Label 'QQ 号，逗号隔开；可以不填' 200 $y 9 ([System.Drawing.FontStyle]::Regular) $gray 380)); $y += 32
$p2.Controls.Add((New-Label '在哪些群里 @ 它' 32 $y)); $tGroups = New-Box 200 ($y - 3) 380; $p2.Controls.Add($tGroups); $y += 26
$p2.Controls.Add((New-Label '群号，逗号隔开；不填就只私聊' 200 $y 9 ([System.Drawing.FontStyle]::Regular) $gray 380)); $y += 32
$p2.Controls.Add((New-Label '你在哪个城市' 32 $y)); $tCity = New-Box 200 ($y - 3) 200; $p2.Controls.Add($tCity)
$p2.Controls.Add((New-Label '（看天气用，可以不填）' 410 $y 9 ([System.Drawing.FontStyle]::Regular) $gray 200)); $y += 40
$p2.Controls.Add((New-Label 'DeepSeek API Key' 32 $y)); $tKey = New-Box 200 ($y - 3) 380 '' -Secret; $p2.Controls.Add($tKey); $y += 26
$lnk = New-Object System.Windows.Forms.LinkLabel; $lnk.Text = '去 platform.deepseek.com 申请'; $lnk.AutoSize = $true; $lnk.Location = New-Object System.Drawing.Point(200, $y); $p2.Controls.Add($lnk)
$lnk.Add_LinkClicked({ Start-Process 'https://platform.deepseek.com/api_keys' })
$lKeyKeep = New-Label '' 400 $y 9 ([System.Drawing.FontStyle]::Regular) $gray 200; $p2.Controls.Add($lKeyKeep); $y += 40
$cReset = New-Object System.Windows.Forms.CheckBox; $cReset.Text = '把人设换成默认人设（会覆盖现在的 persona.md）'; $cReset.AutoSize = $true; $cReset.Location = New-Object System.Drawing.Point(32, $y); $cReset.Visible = $false; $p2.Controls.Add($cReset)

# 页 3：功能
$p3 = New-Page
$p3.Controls.Add((New-Label '要哪些本事' 32 28 15 ([System.Drawing.FontStyle]::Bold)))
$p3.Controls.Add((New-Label '聊天、看图、记住你、熟了更随便、连发合并、像人一样打字这些基本的一直都有。下面的随便勾，以后想改再运行一次安装就行。' 32 64 9 ([System.Drawing.FontStyle]::Regular) $gray))
$checks = @{}
$y = 100
foreach ($f in $Features) {
  $c = New-Object System.Windows.Forms.CheckBox
  $c.Text = $f.name; $c.Checked = $f.def; $c.AutoSize = $true; $c.Location = New-Object System.Drawing.Point(32, $y)
  $c.Font = New-Object System.Drawing.Font($face, 9.5, [System.Drawing.FontStyle]::Bold)
  $p3.Controls.Add($c); $checks[$f.id] = $c
  $p3.Controls.Add((New-Label $f.desc 230 ($y + 2) 9 ([System.Drawing.FontStyle]::Regular) $gray 380))
  $y += 34
}
$lSize = New-Label '' 32 ($y + 4) 9 ([System.Drawing.FontStyle]::Regular) $blue; $p3.Controls.Add($lSize)
function Update-Size {
  $mb = $CoreMB; foreach ($f in $Features) { if ($checks[$f.id].Checked) { $mb += $f.mb } }
  $lSize.Text = "大约要下载 $mb MB（已经装了的会跳过）"
}
foreach ($c in $checks.Values) { $c.Add_CheckedChanged({ Update-Size }) }
Update-Size

# 页 4：功能要的额外信息（手机 PIN、语音 key）
$p4 = New-Page
$p4.Controls.Add((New-Label '再填几项' 32 28 15 ([System.Drawing.FontStyle]::Bold)))
$gPhone = New-Object System.Windows.Forms.Panel; $gPhone.Location = New-Object System.Drawing.Point(0, 70); $gPhone.Size = New-Object System.Drawing.Size(640, 90); $p4.Controls.Add($gPhone)
$gPhone.Controls.Add((New-Label '手机锁屏 PIN' 32 6)); $tPin = New-Box 200 3 200 '' -Secret; $gPhone.Controls.Add($tPin)
$gPhone.Controls.Add((New-Label '手机锁了它能自己解开；不填就让你手动解。手机要打开 USB 调试。' 200 32 9 ([System.Drawing.FontStyle]::Regular) $gray 400))
$gVoice = New-Object System.Windows.Forms.Panel; $gVoice.Location = New-Object System.Drawing.Point(0, 170); $gVoice.Size = New-Object System.Drawing.Size(640, 150); $p4.Controls.Add($gVoice)
$gVoice.Controls.Add((New-Label '百炼 API Key' 32 6)); $tDash = New-Box 200 3 380 '' -Secret; $gVoice.Controls.Add($tDash)
$gVoice.Controls.Add((New-Label '音色 ID' 32 46)); $tVoice = New-Box 200 43 380; $gVoice.Controls.Add($tVoice)
$gVoice.Controls.Add((New-Label '在阿里云百炼的语音合成里复刻一个音色（只用本人同意的声音），把 cosyvoice-… 开头的音色 ID 填这里。' 200 72 9 ([System.Drawing.FontStyle]::Regular) $gray 400))
$lNothing = New-Label '勾的功能不需要额外填什么，直接下一步。' 32 72 9.5 ([System.Drawing.FontStyle]::Regular) $gray; $p4.Controls.Add($lNothing)

# 页 5：安装中
$p5 = New-Page
$p5.Controls.Add((New-Label '正在安装' 32 28 15 ([System.Drawing.FontStyle]::Bold)))
$lStep = New-Label '' 32 68; $p5.Controls.Add($lStep)
$bar = New-Object System.Windows.Forms.ProgressBar; $bar.Location = New-Object System.Drawing.Point(32, 96); $bar.Size = New-Object System.Drawing.Size(576, 18); $p5.Controls.Add($bar)
$lSub = New-Label '' 32 120 9 ([System.Drawing.FontStyle]::Regular) $gray; $p5.Controls.Add($lSub)
$tLog = New-Object System.Windows.Forms.TextBox; $tLog.Multiline = $true; $tLog.ReadOnly = $true; $tLog.ScrollBars = 'Vertical'
$tLog.Location = New-Object System.Drawing.Point(32, 148); $tLog.Size = New-Object System.Drawing.Size(576, 330); $tLog.Font = New-Object System.Drawing.Font('Consolas', 9); $tLog.BackColor = [System.Drawing.Color]::White
$p5.Controls.Add($tLog)

# 页 6：完成
$p6 = New-Page
$lDone = New-Label '装好了' 32 28 15 ([System.Drawing.FontStyle]::Bold); $p6.Controls.Add($lDone)
$lDoneText = New-Label '' 32 70 9.5 ([System.Drawing.FontStyle]::Regular) $ink 576; $p6.Controls.Add($lDoneText)

# 底部按钮
$bBack = New-Object System.Windows.Forms.Button; $bBack.Text = '上一步'; $bBack.Location = New-Object System.Drawing.Point(380, 512); $bBack.Size = New-Object System.Drawing.Size(110, 32); $form.Controls.Add($bBack)
$bNext = New-Object System.Windows.Forms.Button; $bNext.Text = '下一步'; $bNext.Location = New-Object System.Drawing.Point(500, 512); $bNext.Size = New-Object System.Drawing.Size(110, 32); $form.Controls.Add($bNext)
$form.AcceptButton = $bNext

$pages = @($p1, $p2, $p3, $p4, $p5, $p6)
$script:page = 0
function Show-Page([int]$i) {
  $script:page = $i
  for ($k = 0; $k -lt $pages.Count; $k++) { $pages[$k].Visible = ($k -eq $i) }
  $bBack.Visible = ($i -ge 1 -and $i -le 3)
  $bNext.Enabled = $true
  $bNext.Text = switch ($i) { 3 { '开始安装' } 4 { '安装中…' } 5 { '启动它' } default { '下一步' } }
  if ($i -eq 4) { $bNext.Enabled = $false }
  if ($i -eq 3) {
    $gPhone.Visible = $checks['phone'].Checked
    $gVoice.Visible = $checks['voice'].Checked
    $gVoice.Top = if ($gPhone.Visible) { 170 } else { 70 }
    $lNothing.Visible = -not ($gPhone.Visible -or $gVoice.Visible)
  }
  if ($Shot) { New-Item -ItemType Directory -Force -Path $Shot | Out-Null; Pump; $bmp = New-Object System.Drawing.Bitmap($form.Width, $form.Height); $form.DrawToBitmap($bmp, (New-Object System.Drawing.Rectangle(0, 0, $form.Width, $form.Height))); $bmp.Save((Join-Path $Shot "page$($i + 1).png")); $bmp.Dispose() }
}
function Fail([string]$m) { [void][System.Windows.Forms.MessageBox]::Show($form, $m, '还差一点', 'OK', 'Warning') }

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
      $script:ui = @{ log = $tLog; bar = $bar; step = $lStep; sub = $lSub }
      $script:installed = $A
      try { $r = Install-All $A } catch { Say "出错了：$($_.Exception.Message)"; $r = @([pscustomobject]@{ what = '安装'; ok = $false; note = $_.Exception.Message }) }
      $bad = @($r | Where-Object { -not $_.ok })
      $core = @($bad | Where-Object { $_.what -match 'Node|DSH|程序文件' })
      $lDone.Text = $(if ($core) { '没装完' } elseif ($bad) { '装好了（有几项没成）' } else { '装好了' })
      $lines = @()
      foreach ($x in $r) { $lines += $(if ($x.ok) { "✓ $($x.what)" } else { "✗ $($x.what)：$($x.note)" }) }
      $lines += ''
      if (-not $core) {
        $lines += "桌面上有两个快捷方式：「$($A.name)」启动（第一次要用手机 QQ 扫码登录机器人那个号），「$($A.name)状态」看它在不在线。"
        $lines += "人设在 $($A.dir)\agent-bridge\persona.md，随便改；改完在启动器里选「只重启 bridge」。"
        $lines += '安装日志：' + (Join-Path $A.dir 'install.log')
      } else { $lines += '核心部分没装上，看看日志，把问题解决后再运行一次安装（会接着装）。' }
      $lDoneText.Text = $lines -join "`r`n"
      Show-Page 5
      if ($core) { $bNext.Text = '关闭' }
    }
    5 {
      if ($bNext.Text -eq '启动它') { Start-Process (Join-Path $script:installed.dir 'agent-bridge\launch.vbs') }
      $form.Close()
    }
  }
})

Show-Page 0
if ($Shot) {
  # 截图模式：依次显示每页（不真的安装），截完就关
  $form.Add_Shown({
    foreach ($i in 0..3) { Show-Page $i; Start-Sleep -Milliseconds 200 }
    $checks['phone'].Checked = $true; $checks['voice'].Checked = $true; Show-Page 3
    $script:ui = @{ log = $tLog; bar = $bar; step = $lStep; sub = $lSub }
    Show-Page 4; $lStep.Text = '安装 DSH（约 500MB，会久一点）'; $bar.Value = 35; Say '✓ 程序文件'; Say '✓ Node.js v22（已经装了）'; Show-Page 4
    $lDoneText.Text = "✓ 程序文件`r`n✓ Node.js`r`n✓ DSH`r`n`r`n桌面上有两个快捷方式：…"; Show-Page 5
    $form.Close()
  })
}
[void]$form.ShowDialog()
