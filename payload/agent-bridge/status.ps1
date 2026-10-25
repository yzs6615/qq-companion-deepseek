# Bridge status window: is the bot running, connected, and healthy?
# Reads only connection / process info and the SYSTEM lines of data\bridge.log.
# It never reads or shows conversation content (the "->" / "<-" chat lines are only counted).
#   (no args)      small window, refreshes every 8 s
#   -Text          print the same report in the console and exit
#   -Shot <file>   save a screenshot of the window to <file> and exit (for checking the layout)
param([switch]$Text, [string]$Shot = '')

$ErrorActionPreference = 'Stop'
$root      = $PSScriptRoot
$data      = Join-Path $root 'data'
$bridgeLog = Join-Path $data 'bridge.log'
$excerpt   = Join-Path $data 'status-system-log.txt'

# ── data ──────────────────────────────────────────────────────────────────
function Read-Tail([string]$path, [int]$maxBytes = 600KB) {   # last lines of a file another process is writing
  try {
    $fs = New-Object IO.FileStream($path, 'Open', 'Read', 'ReadWrite,Delete')
    try {
      $skipFirst = $false
      if ($fs.Length -gt $maxBytes) { [void]$fs.Seek($fs.Length - $maxBytes, 'Begin'); $skipFirst = $true }
      $lines = (New-Object IO.StreamReader($fs, [Text.Encoding]::UTF8)).ReadToEnd() -split "`r?`n"
      if ($skipFirst -and $lines.Count) { $lines = $lines[1..($lines.Count - 1)] }
      return , @($lines | Where-Object { $_ })
    } finally { $fs.Dispose() }
  } catch { return , @() }
}
function Get-EnvValueS([string]$name, [string]$default = '') {   # reads agent-bridge\.env (UTF-8)
  try {
    $m = [regex]::Match([IO.File]::ReadAllText((Join-Path $root '.env'), [Text.Encoding]::UTF8), "(?m)^\s*$name\s*=\s*(.*?)\s*$")
    if ($m.Success -and $m.Groups[1].Value) { return $m.Groups[1].Value.Trim('"', "'") }
  } catch {}
  return $default
}
function Get-OnebotPort {
  try {
    $m = [regex]::Match([IO.File]::ReadAllText((Join-Path $root '.env')), '(?m)^\s*ONEBOT_WS\s*=\s*\S*?:(\d+)')
    if ($m.Success) { return [int]$m.Groups[1].Value }
  } catch {}
  return 3001
}
function ConvertTo-Local([string]$iso) {
  try { return [DateTime]::Parse($iso, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind).ToLocalTime() } catch { return $null }
}
function Format-Span([TimeSpan]$s) {
  if ($s.TotalMinutes -lt 1) { return '不到 1 分钟' }
  if ($s.TotalHours -lt 1) { return ('{0} 分钟' -f [int]$s.TotalMinutes) }
  if ($s.TotalDays -lt 1) { return ('{0} 小时 {1} 分钟' -f [int]$s.TotalHours, $s.Minutes) }
  return ('{0} 天 {1} 小时' -f [int]$s.TotalDays, $s.Hours)
}

# Only these kinds of log lines are ever shown. Anything that could carry message text
# (chat lines, proactive/autonomy/chime texts, follow-up texts) is not on the list.
$systemLine = '^(守护：|OneBot|机器人 QQ|连接 OneBot|DSH:|工作目录|白名单|回访: |主动消息: |自主活动: |自主活动开始|自主活动骰子|人设已加载|早安骰子|晚安骰子|事实提炼 |熟悉度已按历史记录补齐|综合分已调到|CLOSENESS_SET|收藏表情|心情：|戳你：|等你回：|在线状态|个签：|撤回：|天气：|收到视频|收到文件|日记：|日记: |唱歌：|唱歌发送失败|语音：|语音发送失败|学说话：|收到合并转发|取合并转发失败|反思完成|反思：|人设成长: |未捕获异常|未处理拒绝|任务失败|处理失败|发送回复失败|会话 \S+ 不可用|主动私聊失败|回访失败|插嘴失败|表情回应失败|撤回失败|戳回去失败|补话失败|图片 \d+ 下载失败|GIF 拆帧失败|事实写入失败|记忆写入失败|主动消息生成失败|自主活动失败|事实提炼失败|忽略未授权私聊)'
$errorLine  = '未捕获异常|未处理拒绝|任务失败|处理失败|发送回复失败'

function Get-Report {
  $rows = New-Object System.Collections.ArrayList
  function Add-Row($name, $value, $level) { [void]$rows.Add([pscustomobject]@{ Name = $name; Value = $value; Level = $level }) }

  # 1+2: is the bridge connected to NapCat, and which process is it?
  $port = Get-OnebotPort
  $proc = $null
  foreach ($c in @(Get-NetTCPConnection -RemotePort $port -State Established -ErrorAction SilentlyContinue)) {
    $p = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
    if ($p -and $p.ProcessName -eq 'node') { $proc = $p; break }
  }
  if ($proc) {
    Add-Row '连接 NapCat' ('已连接  ·  端口 {0}  ·  PID {1}' -f $port, $proc.Id) 'ok'
    $up = (Get-Date) - $proc.StartTime
    Add-Row 'bridge 进程' ('已运行 {0}  ·  启动于 {1:MM-dd HH:mm}  ·  内存 {2} MB' -f (Format-Span $up), $proc.StartTime, [int]($proc.WorkingSet64 / 1MB)) 'ok'
  } else {
    Add-Row '连接 NapCat' ('没连上（端口 {0}）：bridge 没在运行，或 NapCat 没登录' -f $port) 'bad'
    Add-Row 'bridge 进程' '没找到连着 NapCat 的 bridge 进程' 'bad'
  }

  # 3: NapCat / QQ
  $nc = @(Get-Process NapCatWinBootMain -ErrorAction SilentlyContinue).Count
  $qq = @(Get-Process QQ -ErrorAction SilentlyContinue).Count
  Add-Row 'NapCat / QQ' ('NapCat {0} 个  ·  QQ 进程 {1} 个' -f $nc, $qq) $(if ($nc -gt 0 -and $qq -gt 0) { 'ok' } else { 'bad' })

  # guard: bridge-guard.ps1 holds a named mutex per data folder (it runs elevated, so its
  # command line is invisible from here; the mutex is not)
  $u8 = New-Object Text.UTF8Encoding($false)
  $tag = ([BitConverter]::ToString([Security.Cryptography.SHA1]::Create().ComputeHash($u8.GetBytes($data.ToLower()))) -replace '-', '').Substring(0, 12)
  $guardOn = $false
  try {
    $mx = $null
    $guardOn = [Threading.Mutex]::TryOpenExisting("Local\XiaoyuganBridgeGuard-$tag", [ref]$mx)
    if ($mx) { $mx.Dispose() }
  } catch [UnauthorizedAccessException] { $guardOn = $true } catch {}

  # 4-6: from the log. Chat lines are matched but never kept or printed.
  $lines = Read-Tail $bridgeLog
  if (-not $lines.Count) {
    Add-Row '收发统计' '读不到 data\bridge.log' 'warn'
    Add-Row '报错 / 掉线' '读不到 data\bridge.log' 'warn'
    Add-Row '已开功能' '读不到 data\bridge.log' 'info'
  } else {
    $start = 0
    for ($i = $lines.Count - 1; $i -ge 0; $i--) { if ($lines[$i] -match '^\[[^\]]+\] DSH: ') { $start = $i; break } }
    $cut = (Get-Date).ToUniversalTime().AddHours(-24).ToString('yyyy-MM-ddTHH:mm:ss')
    $in = 0; $out = 0; $lastIn = ''; $lastOut = ''
    $errs = 0; $drops = 0; $lastBad = ''
    $features = New-Object System.Collections.ArrayList
    $restarts = 0; $lastRestart = ''
    for ($i = 0; $i -lt $lines.Count; $i++) {
      $m = [regex]::Match($lines[$i], '^\[([^\]]+)\] (.*)$')
      if (-not $m.Success) { continue }
      $t = $m.Groups[1].Value; $msg = $m.Groups[2].Value
      if ($msg.StartsWith('守护：已重新拉起')) { if ($t -ge $cut) { $restarts++ }; $lastRestart = $t; continue }
      if ($msg.StartsWith('→ ')) { if ($t -ge $cut) { $in++ }; $lastIn = $t; continue }
      if ($msg.StartsWith('← ')) { if ($t -ge $cut) { $out++ }; $lastOut = $t; continue }
      if ($i -lt $start) { continue }
      if ($msg -match $errorLine) { $errs++; $lastBad = $t }
      elseif ($msg.StartsWith('OneBot 断开')) { $drops++; $lastBad = $t }
      elseif ($msg.StartsWith('回访: ')) { [void]$features.Add('回访') }
      elseif ($msg.StartsWith('主动消息: ')) { [void]$features.Add('主动消息') }
      elseif ($msg.StartsWith('自主活动: ')) { [void]$features.Add('自主活动') }
      elseif ($msg.StartsWith('人设成长: ')) { [void]$features.Add('人设成长') }
    }
    $now = Get-Date
    $li = if ($lastIn) { ConvertTo-Local $lastIn } else { $null }
    $lo = if ($lastOut) { ConvertTo-Local $lastOut } else { $null }
    Add-Row '近 24 小时' ('收到 {0} 条  ·  回复 {1} 条' -f $in, $out) 'ok'
    if ($li) {
      $last = '{0:MM-dd HH:mm}（{1}前）' -f $li, (Format-Span ($now - $li))
      $stuck = (-not $lo -or $li -gt $lo) -and ($now - $li).TotalMinutes -gt 8
      Add-Row '最近一条消息' ($last + $(if ($stuck) { '  ·  还没回' } else { '' })) $(if ($stuck) { 'warn' } else { 'ok' })
    } else { Add-Row '最近一条消息' '日志里还没有消息' 'info' }

    if ($errs -eq 0 -and $drops -eq 0) {
      Add-Row '报错 / 掉线' '自上次启动以来：0 条报错，0 次掉线' 'ok'
    } else {
      $lb = ConvertTo-Local $lastBad
      Add-Row '报错 / 掉线' ('自上次启动以来：{0} 条报错，{1} 次掉线重连  ·  最近 {2:HH:mm}' -f $errs, $drops, $lb) 'warn'
    }
    if ($guardOn) {
      $gv = '在守着：bridge 意外停了会自动拉起'
      if ($restarts) { $gv += '  ·  近 24 小时拉起过 {0} 次（最近 {1:HH:mm}）' -f $restarts, (ConvertTo-Local $lastRestart) }
      Add-Row '守护' $gv $(if ($restarts) { 'warn' } else { 'ok' })
    } else {
      Add-Row '守护' '没在守：bridge 停了不会自动拉起（用启动器重启一次就会带上）' 'warn'
    }
    Add-Row '已开功能' $(if ($features.Count) { ($features -join '  ·  ') } else { '主动功能都没开（回访 / 主动消息 / 自主活动）' }) 'info'
  }

  $rank = @{ ok = 0; info = 0; warn = 1; bad = 2 }
  $worst = ($rows | ForEach-Object { $rank[$_.Level] } | Measure-Object -Maximum).Maximum
  $level = @('ok', 'warn', 'bad')[$worst]
  $head = switch ($level) { 'ok' { '运行正常' } 'warn' { '在运行，有点小状况' } default { if ($proc) { 'NapCat / QQ 有问题' } else { '没连上，机器人不在线' } } }
  return [pscustomobject]@{ Level = $level; Headline = $head; Rows = @($rows); At = Get-Date }
}

# Last system lines only, with local times. Written to a file and opened in Notepad.
function Get-SystemLog([int]$count = 80) {
  $out = New-Object System.Collections.ArrayList
  foreach ($l in (Read-Tail $bridgeLog 1MB)) {
    $m = [regex]::Match($l, '^\[([^\]]+)\] (.*)$')
    if (-not $m.Success -or $m.Groups[2].Value -notmatch $systemLine) { continue }
    $t = ConvertTo-Local $m.Groups[1].Value
    [void]$out.Add(('{0:MM-dd HH:mm:ss}  {1}' -f $t, $m.Groups[2].Value))
  }
  return @($out | Select-Object -Last $count)
}

# ── text mode ─────────────────────────────────────────────────────────────
if ($Text) {
  $r = Get-Report
  Write-Output ('[{0}] {1}' -f $r.Level.ToUpper(), $r.Headline)
  foreach ($row in $r.Rows) { Write-Output ('  {0,-6} {1,-12} {2}' -f $row.Level, $row.Name, $row.Value) }
  Write-Output ''
  Write-Output 'Recent system log lines (chat lines are never shown):'
  Get-SystemLog 12 | ForEach-Object { Write-Output "  $_" }
  exit
}

# ── window ────────────────────────────────────────────────────────────────
if (-not $Shot) {   # one window at a time
  $script:mutex = New-Object Threading.Mutex($false, 'Local\XiaoyuganStatusWindow')
  if (-not $script:mutex.WaitOne(0)) { exit }
}
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -Namespace Win -Name Dpi -MemberDefinition '[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetProcessDPIAware();'
[void][Win.Dpi]::SetProcessDPIAware()
[System.Windows.Forms.Application]::EnableVisualStyles()

$paper = [System.Drawing.Color]::FromArgb(250, 250, 251)
$ink   = [System.Drawing.Color]::FromArgb(31, 35, 40)
$gray  = [System.Drawing.Color]::FromArgb(110, 118, 129)
$dots  = @{
  ok   = [System.Drawing.Color]::FromArgb(26, 170, 98)
  warn = [System.Drawing.Color]::FromArgb(230, 162, 0)
  bad  = [System.Drawing.Color]::FromArgb(207, 34, 46)
  info = [System.Drawing.Color]::FromArgb(160, 167, 176)
}
$face = 'Microsoft YaHei UI'

$form = New-Object System.Windows.Forms.Form
$form.AutoScaleDimensions = New-Object System.Drawing.SizeF(96, 96)
$form.AutoScaleMode = 'Dpi'
$form.Text = ((Get-EnvValueS 'BOT_NAME' '小鱼') + ' · 状态')
$form.ClientSize = New-Object System.Drawing.Size(440, 584)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedSingle'
$form.MaximizeBox = $false
$form.BackColor = $paper
try { $qqIcon = Get-EnvValueS 'QQ_EXE'; if ($qqIcon -and (Test-Path $qqIcon)) { $form.Icon = [System.Drawing.Icon]::ExtractAssociatedIcon($qqIcon) } } catch {}

function New-Label($x, $y, $w, $h, $size, $style, $color, $align = 'MiddleLeft') {
  $l = New-Object System.Windows.Forms.Label
  $l.Location = New-Object System.Drawing.Point($x, $y)
  $l.Size = New-Object System.Drawing.Size($w, $h)
  $l.Font = New-Object System.Drawing.Font($face, $size, $style)
  $l.ForeColor = $color
  $l.TextAlign = $align
  $form.Controls.Add($l)
  return $l
}
function New-Dot($x, $y, $d) {
  $p = New-Object System.Windows.Forms.Label
  $p.Location = New-Object System.Drawing.Point($x, $y)
  $p.Size = New-Object System.Drawing.Size($d, $d)
  $p.BackColor = $dots.info
  $form.Controls.Add($p)
  return $p
}
$regular = [System.Drawing.FontStyle]::Regular
$bold = [System.Drawing.FontStyle]::Bold

$headDot  = New-Dot 24 24 20
$headText = New-Label 56 16 260 36 14 $bold $ink
$stamp    = New-Label 300 22 116 24 8.5 $regular $gray 'MiddleRight'

$rowDots = @(); $rowNames = @(); $rowVals = @()
for ($i = 0; $i -lt 8; $i++) {
  $y = 74 + $i * 56
  $rowDots  += New-Dot 24 ($y + 6) 10
  $rowNames += New-Label 44 $y 380 22 9 $regular $gray
  $rowVals  += New-Label 44 ($y + 22) 380 26 10 $regular $ink 'TopLeft'
}

function New-Button($text, $x, $w) {
  $b = New-Object System.Windows.Forms.Button
  $b.Text = $text
  $b.Font = New-Object System.Drawing.Font($face, 9.5)
  $b.Location = New-Object System.Drawing.Point($x, 538)
  $b.Size = New-Object System.Drawing.Size($w, 34)
  $form.Controls.Add($b)
  return $b
}
$btnRefresh = New-Button '刷新' 24 100
$btnLog     = New-Button '看系统日志' 136 130
$btnFeat    = New-Button '功能与机制' 278 138

function Update-Ui {
  try {
    $r = Get-Report
    $headDot.BackColor = $dots[$r.Level]
    $headText.Text = $r.Headline
    $stamp.Text = '更新于 {0:HH:mm:ss}' -f $r.At
    for ($i = 0; $i -lt 8; $i++) {
      if ($i -lt $r.Rows.Count) {
        $rowDots[$i].BackColor = $dots[$r.Rows[$i].Level]
        $rowNames[$i].Text = $r.Rows[$i].Name
        $rowVals[$i].Text = $r.Rows[$i].Value
      } else {
        $rowDots[$i].BackColor = $paper; $rowNames[$i].Text = ''; $rowVals[$i].Text = ''
      }
    }
  } catch {
    $headDot.BackColor = $dots.warn
    $headText.Text = '检查出错了'
    $rowVals[0].Text = $_.Exception.Message
  }
}
$btnFeat.Add_Click({
  $ownNode = Join-Path $root '..\tools\node\node.exe'   # 离线安装包自带的
  $node = if (Test-Path $ownNode) { (Resolve-Path $ownNode).Path } elseif (Test-Path 'C:\Program Files\nodejs\node.exe') { 'C:\Program Files\nodejs\node.exe' } else { 'node' }
  Start-Process -FilePath $node -ArgumentList "`"$(Join-Path $root 'scripts\features.mjs')`"" -WorkingDirectory $root -WindowStyle Hidden
})
$btnRefresh.Add_Click({ $btnRefresh.Enabled = $false; Update-Ui; $btnRefresh.Enabled = $true })
$btnLog.Add_Click({
  $text = @('# bridge.log 里的系统行（不含对话内容），时间是本地时间', '') + (Get-SystemLog 80)
  [IO.File]::WriteAllLines($excerpt, $text, (New-Object Text.UTF8Encoding($true)))
  Start-Process notepad.exe -ArgumentList "`"$excerpt`""
})

if ($Shot) {
  $form.Show(); [System.Windows.Forms.Application]::DoEvents()
  Update-Ui; [System.Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 200; [System.Windows.Forms.Application]::DoEvents()
  $bmp = New-Object System.Drawing.Bitmap($form.Width, $form.Height)
  $form.DrawToBitmap($bmp, (New-Object System.Drawing.Rectangle(0, 0, $form.Width, $form.Height)))
  $bmp.Save($Shot, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose(); $form.Close(); $form.Dispose()
  exit
}

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 8000
$timer.Add_Tick({ Update-Ui })
$form.Add_Shown({ Update-Ui; $timer.Start() })
[void]$form.ShowDialog()
$timer.Stop(); $form.Dispose()
