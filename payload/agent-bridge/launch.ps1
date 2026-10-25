# One-click launcher for the QQ bot (NapCat + bridge).
# Shows ONE small window (status + login QR); everything else runs hidden.
# If NapCat is already online the window asks: restart only the bridge (no QR) or everything.
#   -Mode auto|bridge|full   auto (default) asks when NapCat is online; bridge / full skip the question
#   -Demo                    fake the whole flow (nothing is killed or started) to preview the window
#   -Shot <dir>              save a screenshot of each stage into <dir> (for checking the window)
param([ValidateSet('auto', 'bridge', 'full')][string]$Mode = 'auto', [switch]$Demo, [string]$Shot = '')

$ErrorActionPreference = 'Stop'
$root      = $PSScriptRoot
$data      = Join-Path $root 'data'
function Get-EnvValue([string]$name, [string]$default = '') {   # reads agent-bridge\.env (UTF-8)
  try {
    $m = [regex]::Match([IO.File]::ReadAllText((Join-Path $root '.env'), [Text.Encoding]::UTF8), "(?m)^\s*$name\s*=\s*(.*?)\s*$")
    if ($m.Success -and $m.Groups[1].Value) { return $m.Groups[1].Value.Trim('"', "'") }
  } catch {}
  return $default
}
function Find-QQ {   # .env QQ_EXE, else the uninstall entry QQ's installer writes
  $p = Get-EnvValue 'QQ_EXE'
  if ($p -and (Test-Path $p)) { return $p }
  foreach ($k in 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\QQ', 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\QQ', 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\QQ') {
    try {
      $u = (Get-ItemProperty $k -ErrorAction Stop).UninstallString.Trim('"')
      $exe = Join-Path (Split-Path $u) 'QQ.exe'
      if (Test-Path $exe) { return $exe }
    } catch {}
  }
  return 'C:\Program Files\Tencent\QQNT\QQ.exe'
}
$botName   = Get-EnvValue 'BOT_NAME' '小鱼'
$napcat    = (Resolve-Path (Get-EnvValue 'NAPCAT_DIR' (Join-Path $root '..\tools\napcat\app\napcat'))).Path
$qq        = Find-QQ
$boot      = Join-Path $napcat 'NapCatWinBootMain.exe'
$hook      = Join-Path $napcat 'NapCatWinBootHook.dll'
$node      = if (Test-Path 'C:\Program Files\nodejs\node.exe') { 'C:\Program Files\nodejs\node.exe' } else { (Get-Command node).Source }
$out       = Join-Path $data 'napcat.out'
$err       = Join-Path $data 'napcat.err'
$qrCopy    = Join-Path $data 'login-qr.png'
$qrSrc     = Join-Path $napcat 'cache\qrcode.png'
$bridgeLog = Join-Path $data 'bridge.log'
$log       = Join-Path $data 'launch.log'

New-Item -ItemType Directory -Force -Path $data | Out-Null
if ((Test-Path $log) -and (Get-Item $log).Length -gt 200KB) { Remove-Item $log -Force }
function Log([string]$m) {
  $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m
  for ($i = 0; $i -lt 10; $i++) {   # 别人正在读 launch.log 时可能写不进去：重试，别把这一行丢了
    try { Add-Content -Path $log -Value $line -Encoding UTF8 -ErrorAction Stop; return } catch { Start-Sleep -Milliseconds 50 }
  }
}

function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}
# launch.vbs already asks for admin without flashing a console; this is the fallback
# for running the .ps1 directly.
if (-not $Demo -and -not (Test-Admin)) {
  Start-Process powershell -Verb RunAs -WindowStyle Hidden -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-File', "`"$PSCommandPath`""
  exit
}

# ── window ────────────────────────────────────────────────────────────────
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -Namespace Win -Name Dpi -MemberDefinition '[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetProcessDPIAware();'
[void][Win.Dpi]::SetProcessDPIAware()   # crisp text and QR on scaled displays
[System.Windows.Forms.Application]::EnableVisualStyles()

$paper = [System.Drawing.Color]::FromArgb(250, 250, 251)
$ink   = [System.Drawing.Color]::FromArgb(31, 35, 40)
$gray  = [System.Drawing.Color]::FromArgb(110, 118, 129)
$green = [System.Drawing.Color]::FromArgb(26, 170, 98)
$red   = [System.Drawing.Color]::FromArgb(207, 34, 46)
$face  = 'Microsoft YaHei UI'

$form = New-Object System.Windows.Forms.Form
$form.AutoScaleDimensions = New-Object System.Drawing.SizeF(96, 96)
$form.AutoScaleMode = 'Dpi'
$form.Text = $botName
$form.ClientSize = New-Object System.Drawing.Size(340, 460)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedSingle'
$form.MaximizeBox = $false
$form.TopMost = $true
$form.BackColor = $paper
try { $form.Icon = [System.Drawing.Icon]::ExtractAssociatedIcon($qq) } catch {}

function New-Label($text, $y, $h, $size, $style, $color) {
  $l = New-Object System.Windows.Forms.Label
  $l.Text = $text
  $l.Location = New-Object System.Drawing.Point(20, $y)
  $l.Size = New-Object System.Drawing.Size(300, $h)
  $l.TextAlign = 'MiddleCenter'
  $l.Font = New-Object System.Drawing.Font($face, $size, $style)
  $l.ForeColor = $color
  $form.Controls.Add($l)
  return $l
}
$title  = New-Label ($botName + ' · QQ 机器人') 18 32 13 ([System.Drawing.FontStyle]::Bold) $ink
$status = New-Label '' 56 48 10.5 ([System.Drawing.FontStyle]::Regular) $ink
$hint   = New-Label '' 424 24 9 ([System.Drawing.FontStyle]::Regular) $gray

$pic = New-Object System.Windows.Forms.PictureBox
$pic.Location = New-Object System.Drawing.Point(20, 112)
$pic.Size = New-Object System.Drawing.Size(300, 300)
$pic.SizeMode = 'CenterImage'
$pic.BackColor = [System.Drawing.Color]::White
$pic.Visible = $false
$form.Controls.Add($pic)

$bar = New-Object System.Windows.Forms.ProgressBar
$bar.Style = 'Marquee'
$bar.MarqueeAnimationSpeed = 30
$bar.Location = New-Object System.Drawing.Point(60, 230)
$bar.Size = New-Object System.Drawing.Size(220, 8)
$form.Controls.Add($bar)

$logBtn = New-Object System.Windows.Forms.Button
$logBtn.Text = '看日志'
$logBtn.Font = New-Object System.Drawing.Font($face, 9.5)
$logBtn.Location = New-Object System.Drawing.Point(120, 366)
$logBtn.Size = New-Object System.Drawing.Size(100, 32)
$logBtn.Visible = $false
$logBtn.Add_Click({ Start-Process notepad.exe -ArgumentList "`"$log`"" })
$form.Controls.Add($logBtn)

function New-ChoiceButton($text, $y, $primary) {
  $b = New-Object System.Windows.Forms.Button
  $b.Text = $text
  $b.Font = New-Object System.Drawing.Font($face, 10.5)
  $b.Location = New-Object System.Drawing.Point(50, $y)
  $b.Size = New-Object System.Drawing.Size(240, 46)
  $b.FlatStyle = 'Flat'
  $b.Cursor = 'Hand'
  if ($primary) { $b.BackColor = $green; $b.ForeColor = [System.Drawing.Color]::White; $b.FlatAppearance.BorderSize = 0 }
  else { $b.BackColor = [System.Drawing.Color]::White; $b.ForeColor = $ink; $b.FlatAppearance.BorderColor = [System.Drawing.Color]::FromArgb(208, 215, 222) }
  $b.Visible = $false
  $form.Controls.Add($b)
  return $b
}
$btnBridge = New-ChoiceButton '只重启 bridge（不用扫码）' 150 $true
$btnFull   = New-ChoiceButton '完整重启（重新扫码）' 206 $false
$script:choice = $null
$btnBridge.Add_Click({ $script:choice = 'bridge' })
$btnFull.Add_Click({ $script:choice = 'full' })
$form.AcceptButton = $btnBridge   # Enter = the quick one

# “功能与机制”页：机器人自己不再聊它的机制，要查就点这里（浏览器里打开，不打断启动流程）
function Open-Features {
  try {
    $page = Join-Path $data 'features.html'
    Start-Process -FilePath $node -ArgumentList "`"$(Join-Path $root 'scripts\features.mjs')`"", '--no-open', '--out', "`"$page`"" -WorkingDirectory $root -WindowStyle Hidden -Wait
    Start-Process explorer.exe -ArgumentList "`"$page`""   # 经 explorer 打开：浏览器不会跟着变成管理员权限
  } catch { Log "features page failed: $($_.Exception.Message)" }
}
$featLink = New-Object System.Windows.Forms.LinkLabel
$featLink.Text = '功能与机制'
$featLink.Font = New-Object System.Drawing.Font($face, 8.5)
$featLink.Location = New-Object System.Drawing.Point(240, 2)
$featLink.Size = New-Object System.Drawing.Size(94, 18)
$featLink.TextAlign = 'MiddleRight'
$featLink.LinkColor = $gray
$featLink.ActiveLinkColor = $green
$featLink.Add_LinkClicked({ Open-Features })
$form.Controls.Add($featLink)
$featLink.BringToFront()
# 日记网页：选日期看那天的日记和聊天（含聊天内容，只在本机打开）
function Open-Journal {
  try {
    $page = Join-Path $data 'journal.html'
    Start-Process -FilePath $node -ArgumentList "`"$(Join-Path $root 'scripts\journal-view.mjs')`"", '--no-open', '--out', "`"$page`"" -WorkingDirectory $root -WindowStyle Hidden -Wait
    Start-Process explorer.exe -ArgumentList "`"$page`""
  } catch { Log "journal page failed: $($_.Exception.Message)" }
}
$diaryLink = New-Object System.Windows.Forms.LinkLabel
$diaryLink.Text = '日记'
$diaryLink.Font = New-Object System.Drawing.Font($face, 8.5)
$diaryLink.Location = New-Object System.Drawing.Point(196, 2)
$diaryLink.Size = New-Object System.Drawing.Size(44, 18)
$diaryLink.TextAlign = 'MiddleRight'
$diaryLink.LinkColor = $gray
$diaryLink.ActiveLinkColor = $green
$diaryLink.Add_LinkClicked({ Open-Journal })
$form.Controls.Add($diaryLink)
$diaryLink.BringToFront()
$btnFeat = New-ChoiceButton '看功能与机制' 262 $false
$btnFeat.Add_Click({ Open-Features })
$btnDiary = New-ChoiceButton '看日记' 262 $false
$btnDiary.Add_Click({ Open-Journal })
$btnClose = New-ChoiceButton '关闭' 398 $false
$btnClose.Add_Click({ $form.Close() })

$script:closed = $false
$form.Add_FormClosed({ $script:closed = $true })

function Pump { [System.Windows.Forms.Application]::DoEvents() }
function Wait-UI([int]$ms) {
  $end = [DateTime]::UtcNow.AddMilliseconds($ms)
  while ([DateTime]::UtcNow -lt $end -and -not $script:closed) { Pump; Start-Sleep -Milliseconds 40 }
}
function Set-Status([string]$text, $color = $ink) {
  if ($script:closed) { return }
  $status.Text = $text
  $status.ForeColor = $color
  Pump
}
function Set-Hint([string]$text) { if (-not $script:closed) { $hint.Text = $text; Pump } }

function Scale-Image($src, [int]$box) {
  $max = [Math]::Max($src.Width, $src.Height)
  $scale = $box / $max
  if ($scale -ge 1) {   # QR: whole-number upscale, no blur
    $f = [int][Math]::Floor($scale)
    $w = $src.Width * $f; $h = $src.Height * $f; $mode = 'NearestNeighbor'
  } else {
    $w = [int][Math]::Round($src.Width * $scale); $h = [int][Math]::Round($src.Height * $scale); $mode = 'HighQualityBicubic'
  }
  $bmp = New-Object System.Drawing.Bitmap($w, $h)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = $mode
  $g.PixelOffsetMode = 'Half'
  $g.DrawImage($src, 0, 0, $w, $h)
  $g.Dispose()
  return $bmp
}
function Show-Picture($img, $back) {
  if ($script:closed) { return }
  $old = $pic.Image
  $pic.BackColor = $back
  $pic.Image = $img
  if ($old) { $old.Dispose() }
  $pic.Visible = $true
  $bar.Visible = $false
  Pump
}
function Show-Qr([string]$path) {
  $bytes = [IO.File]::ReadAllBytes($path)
  $ms = New-Object IO.MemoryStream(, $bytes)
  $src = [System.Drawing.Image]::FromStream($ms)
  try { Show-Picture (Scale-Image $src $pic.ClientSize.Width) ([System.Drawing.Color]::White) }
  finally { $src.Dispose(); $ms.Dispose() }
}
function Show-Waiting {
  if ($script:closed) { return }
  $pic.Visible = $false
  $bar.Visible = $true
  Pump
}
function Show-Badge($ok) {   # big green check / red cross
  $n = $pic.ClientSize.Width
  $bmp = New-Object System.Drawing.Bitmap($n, $n)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.Clear($paper)
  $d = [int]($n * 0.5); $o = [int](($n - $d) / 2)
  $color = if ($ok) { $green } else { $red }
  $g.FillEllipse((New-Object System.Drawing.SolidBrush($color)), $o, $o, $d, $d)
  $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::White, [single]($d * 0.09))
  $pen.StartCap = 'Round'; $pen.EndCap = 'Round'; $pen.LineJoin = 'Round'
  function Pt($x, $y) { New-Object System.Drawing.PointF([single]($o + $d * $x), [single]($o + $d * $y)) }
  if ($ok) { $g.DrawLines($pen, [System.Drawing.PointF[]]@((Pt 0.27 0.52), (Pt 0.44 0.69), (Pt 0.74 0.33))) }
  else {
    $g.DrawLine($pen, (Pt 0.32 0.32), (Pt 0.68 0.68))
    $g.DrawLine($pen, (Pt 0.68 0.32), (Pt 0.32 0.68))
  }
  $g.Dispose()
  Show-Picture $bmp $paper
}
function Save-Shot([string]$name) {
  if (-not $Shot -or $script:closed) { return }
  New-Item -ItemType Directory -Force -Path $Shot | Out-Null
  Pump; Start-Sleep -Milliseconds 150; Pump
  $bmp = New-Object System.Drawing.Bitmap($form.Width, $form.Height)
  $form.DrawToBitmap($bmp, (New-Object System.Drawing.Rectangle(0, 0, $form.Width, $form.Height)))
  $bmp.Save((Join-Path $Shot "$name.png"), [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
}

function Read-Shared([string]$path, [long]$from = 0) {   # tail of a file another process is writing
  try {
    $fs = New-Object IO.FileStream($path, 'Open', 'Read', 'ReadWrite,Delete')
    try {
      if ($from -gt 0) {
        if ($from -ge $fs.Length) { return '' }
        [void]$fs.Seek($from, 'Begin')
      }
      return (New-Object IO.StreamReader($fs, [Text.Encoding]::UTF8)).ReadToEnd()
    } finally { $fs.Dispose() }
  } catch { return '' }
}

# ── helpers for the real flow ────────────────────────────────────────────
$onlineRe = '机器人 QQ|OneBot 已连接'   # bridge.log lines that mean "connected to NapCat"

function Test-Port([int]$port) {
  try {
    $c = New-Object Net.Sockets.TcpClient
    $r = $c.BeginConnect('127.0.0.1', $port, $null, $null)
    $ok = $r.AsyncWaitHandle.WaitOne(600) -and $c.Connected
    $c.Close()
    return [bool]$ok
  } catch { return $false }
}
function Get-OnebotPort {
  $m = [regex]::Match((Read-Shared (Join-Path $root '.env')), '(?m)^\s*ONEBOT_WS\s*=\s*\S*?:(\d+)')
  if ($m.Success) { return [int]$m.Groups[1].Value }
  return 3001
}
function Test-NapCatUp { return (Test-Port (Get-OnebotPort)) }   # the OneBot server only listens once QQ is logged in

function Get-NodeProcs([string]$pattern) {
  # The comma keeps the array an array (a lone CimInstance would lose .Count and an empty result would vanish).
  return , @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -match $pattern })
}
function Stop-Bridge {
  # 先停守护（bridge-guard.ps1），再停 bridge：不然守护会以为 bridge 意外停了，又把它拉起来
  $guards = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -match 'bridge-guard\.ps1' })
  foreach ($g in $guards) { Stop-Process -Id $g.ProcessId -Force -ErrorAction SilentlyContinue }
  if ($guards.Count) { Log "stopped $($guards.Count) guard(s)"; Start-Sleep -Milliseconds 300 }
  $procs = Get-NodeProcs 'bridge\.mjs'
  foreach ($p in $procs) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
  return $procs.Count
}

$bridgeStarted = $false
function Start-Bridge {
  if ($script:bridgeStarted) { return }
  Log 'starting bridge (via guard)'
  # 交给守护去启动：bridge 以后意外停了，守护会自动拉起来并记日志
  $guard = Join-Path $root 'bridge-guard.ps1'
  Start-Process -FilePath powershell.exe -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', "`"$guard`"" -WorkingDirectory $root -WindowStyle Hidden | Out-Null
  $script:bridgeStarted = $true
}

# 上线后窗口留着，当个小面板用：能点“功能与机制”，自己点关闭才关。机器人在后台跑，跟窗口开不开无关。
function Show-OnlinePanel {
  $pic.Height = 230    # 勾往上收一点，下面放按钮，互不遮挡
  $hint.Visible = $false
  Show-Badge $true
  Set-Status ($botName + '上线了' + [Environment]::NewLine + '关掉窗口它也会在后台继续跑') $green
  # “看功能与机制”和“看日记”并排，各占一半
  $btnFeat.Top = 352; $btnFeat.Height = 38; $btnFeat.Width = 117; $btnFeat.Text = '功能与机制'; $btnFeat.Visible = $true; $btnFeat.BringToFront()
  $btnDiary.Top = 352; $btnDiary.Height = 38; $btnDiary.Left = 173; $btnDiary.Width = 117; $btnDiary.Visible = $true; $btnDiary.BringToFront()
  $btnClose.Top = 398; $btnClose.Height = 38; $btnClose.Visible = $true; $btnClose.BringToFront()
  $form.AcceptButton = $btnClose
  Pump
}
function Complete-Online {
  Log 'online'
  Show-OnlinePanel; Save-Shot 'real-4-online'
  while (-not $script:closed) { Wait-UI 300 }
}
function Show-Failure([string]$message, [string]$tip) {
  Show-Badge $false; Set-Status $message $red; Set-Hint $tip
  $logBtn.Visible = $true; Pump
  while (-not $script:closed) { Wait-UI 300 }
}

# NapCat is already online: ask what to restart. Returns 'bridge' | 'full' | $null (window closed).
function Ask-Mode {
  $running = (Get-NodeProcs 'bridge\.mjs').Count -gt 0
  $btnBridge.Text = if ($running) { '只重启 bridge（不用扫码）' } else { '只启动 bridge（不用扫码）' }
  Set-Status ($botName + '已经在线' + [Environment]::NewLine + 'bridge ' + $(if ($running) { '运行中' } else { '没在运行' }))
  Set-Hint '改了代码或人设之后，选第一个就行'
  $script:choice = $null
  $bar.Visible = $false; $btnBridge.Visible = $true; $btnFull.Visible = $true; $btnFeat.Visible = $true; Pump
  Save-Shot 'real-1-choice'
  while (-not $script:choice -and -not $script:closed) { Wait-UI 100 }
  $btnBridge.Visible = $false; $btnFull.Visible = $false; $btnFeat.Visible = $false; $bar.Visible = $true; Pump
  return $script:choice
}

# Restart only the bridge. QQ and NapCat stay logged in, no QR.
function Invoke-BridgeOnly {
  Log 'bridge-only restart'
  Set-Hint '不动 QQ 和 NapCat，不用扫码'
  # Don't cut off a reply that is being written: wait (up to 60s) for running agent calls.
  $until = (Get-Date).AddSeconds(60)
  while (-not $script:closed -and (Get-Date) -lt $until) {
    $busy = (Get-NodeProcs 'profile headless').Count
    if (-not $busy) { break }
    Set-Status "有 $busy 个对话/任务正在跑，等它们说完再重启…"
    Wait-UI 2000
  }
  if ($script:closed) { return }
  Set-Status '正在重启 bridge…'
  Log "stopped $(Stop-Bridge) old bridge process(es)"
  Wait-UI 1200
  $logStart = if (Test-Path $bridgeLog) { (Get-Item $bridgeLog).Length } else { 0 }
  Start-Bridge
  $until = (Get-Date).AddSeconds(45)
  $online = $false
  while (-not $script:closed -and -not $online -and (Get-Date) -lt $until) {
    if ((Read-Shared $bridgeLog $logStart) -match $onlineRe) { $online = $true }
    Wait-UI 500
  }
  if ($online) { Complete-Online }
  elseif (-not $script:closed) {
    Log 'bridge-only: no NapCat connection within 45s'
    Show-Failure 'bridge 起来了，但没连上 NapCat' '可能 NapCat 掉线了，关掉窗口选「完整重启」'
  }
}

# Restart QQ + NapCat + bridge, show the login QR in this window.
function Invoke-FullLaunch {
  Log 'full launch'
  Set-Status '正在关闭旧的 QQ…'; Set-Hint '全程自动，不用再点别的'
  Get-Process QQ, NapCatWinBootMain -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  [void](Stop-Bridge)
  Wait-UI 2000

  Set-Status '正在启动 NapCat…'
  $env:NAPCAT_PATCH_PACKAGE = Join-Path $napcat 'qqnt.json'
  $env:NAPCAT_LOAD_PATH     = Join-Path $napcat 'loadNapCat.js'
  $env:NAPCAT_INJECT_PATH   = $hook
  $env:NAPCAT_LAUNCHER_PATH = $boot
  $env:NAPCAT_MAIN_PATH     = Join-Path $napcat 'napcat.mjs'
  # Only trust a QR written after this launch, never a stale one.
  Remove-Item $out, $err, $qrCopy, $qrSrc -Force -ErrorAction SilentlyContinue
  $started = Get-Date
  $logStart = if (Test-Path $bridgeLog) { (Get-Item $bridgeLog).Length } else { 0 }
  $proc = Start-Process -FilePath $boot -ArgumentList "`"$qq`"", "`"$hook`"" -WorkingDirectory $napcat `
    -RedirectStandardOutput $out -RedirectStandardError $err -WindowStyle Hidden -PassThru
  Log "NapCat started, PID $($proc.Id)"
  Set-Status '正在等待登录二维码…'

  $deadline = (Get-Date).AddMinutes(4)
  $qrStamp = [DateTime]::MinValue
  $ready = $false; $online = $false; $urlTried = $false; $scanSeen = 0
  while (-not $script:closed -and -not $online -and (Get-Date) -lt $deadline) {
    $text = Read-Shared $out

    if (-not $ready -and $text -match 'WebSocket Server\] Server Started') {
      $ready = $true
      Log 'login done (OneBot server up)'
      Show-Waiting; Set-Status '登录成功，正在启动机器人…'; Set-Hint ''
      Start-Bridge
    }

    if (-not $ready) {
      if (Test-Path $qrSrc) {
        $stamp = (Get-Item $qrSrc).LastWriteTime
        if ($stamp -gt $started -and $stamp -ne $qrStamp) {
          try {
            Show-Qr $qrSrc
            Copy-Item $qrSrc $qrCopy -Force
            $qrStamp = $stamp
            Set-Status '用手机 QQ 扫一扫登录'; Set-Hint '二维码过期会自动刷新'
            Log 'QR shown'; Save-Shot 'real-2-qr'
          } catch { }   # file still being written; try again next tick
        }
      } elseif (-not $urlTried -and ((Get-Date) - $started).TotalSeconds -gt 20) {
        # No image from NapCat: build one from the login URL it printed.
        $m = [regex]::Match($text, '二维码解码URL[:：]\s*(https?://[^\s"''<>]+)')
        if ($m.Success) {
          $urlTried = $true
          try {
            & $node (Join-Path $root 'scripts\qr.mjs') $m.Groups[1].Value.TrimEnd('.', ',', ';', ')', ']') $qrCopy | Out-Null
            Show-Qr $qrCopy
            Set-Status '用手机 QQ 扫一扫登录'; Set-Hint '二维码过期请重新点启动'
            Log 'QR built from URL'
          } catch { Log "QR from URL failed: $($_.Exception.Message)" }
        }
      }
      $scans = ([regex]::Matches($text, '二维码已被扫描')).Count
      if ($scans -gt $scanSeen) {   # a new scan event (the log keeps old ones, so count them)
        $scanSeen = $scans
        Show-Waiting; Set-Status '已扫码，请在手机上点「确认登录」'; Set-Hint ''; Save-Shot 'real-3-scanned'
      }
    }

    if ($script:bridgeStarted -and (Read-Shared $bridgeLog $logStart) -match $onlineRe) { $online = $true }
    Wait-UI 700
  }

  if ($online) { Complete-Online }
  elseif ($script:closed) {
    Start-Bridge   # window closed early: still bring the bot up, it reconnects by itself
    Log 'window closed before online'
  } else {
    Start-Bridge
    Log 'timeout waiting for login'
    Show-Failure '没等到登录成功' '二维码可能过期了，关掉重新点一次启动'
  }
}

# ── demo: preview the window without touching anything ───────────────────
if ($Demo) {
  $form.Show(); $form.Activate(); Pump
  Set-Status ($botName + '已经在线' + [Environment]::NewLine + 'bridge 运行中'); Set-Hint '改了代码或人设之后，选第一个就行'
  $bar.Visible = $false; $btnBridge.Visible = $true; $btnFull.Visible = $true; $btnFeat.Visible = $true; Pump; Save-Shot '0-choice'; Wait-UI 1200
  $btnBridge.PerformClick()   # exercise the click handler
  if ($script:choice -ne 'bridge') { Write-Error 'choice handler broken' }
  $btnBridge.Visible = $false; $btnFull.Visible = $false; $btnFeat.Visible = $false; $bar.Visible = $true
  Set-Status '正在关闭旧的 QQ…'; Set-Hint '全程自动，不用再点别的'; Save-Shot '1-start'; Wait-UI 1200
  Set-Status '正在等待登录二维码…'; Wait-UI 1200
  if (Test-Path $qrCopy) { Show-Qr $qrCopy }
  Set-Status '用手机 QQ 扫一扫登录'; Set-Hint '二维码过期会自动刷新'; Save-Shot '2-qr'; Wait-UI 2500
  Show-Waiting; Set-Status '已扫码，请在手机上点「确认登录」'; Save-Shot '3-scanned'; Wait-UI 1800
  Set-Status '登录成功，正在启动机器人…'; Wait-UI 1500
  Show-OnlinePanel; Save-Shot '4-online'; Wait-UI 2000
  $btnFeat.Visible = $false; $btnClose.Visible = $false; $pic.Height = 300; $hint.Visible = $true
  Show-Badge $false; Set-Status '没等到登录成功' $red; Set-Hint '二维码可能过期了，关掉重新点一次启动'; $logBtn.Visible = $true; Save-Shot '5-failed'; Wait-UI 1500
  $form.Close(); $form.Dispose()
  exit
}

# ── real launch ──────────────────────────────────────────────────────────
$form.Show(); $form.Activate(); Pump
try {
  Log "--- launch (mode $Mode) ---"
  $todo = $Mode
  if ($todo -ne 'full') {
    Set-Status '正在检查…'
    if (Test-NapCatUp) {
      if ($todo -eq 'auto') { $todo = Ask-Mode }
    } else {
      if ($todo -eq 'bridge') { Log 'bridge-only requested but NapCat is not online -> full launch' }
      $todo = 'full'
    }
  }
  if ($todo -eq 'bridge') { Invoke-BridgeOnly }
  elseif ($todo -eq 'full') { Invoke-FullLaunch }
  else { Log 'window closed on the choice screen (nothing restarted)' }
}
catch {
  Log "ERROR: $($_ | Out-String)"
  if (-not $script:closed) { Show-Failure "出错了：$($_.Exception.Message)" '详情在 data\launch.log' }
}
finally {
  if (-not $form.IsDisposed) { $form.Dispose() }
}
