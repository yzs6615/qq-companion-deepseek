# Bridge guard: keeps bridge.mjs running. If it stops unexpectedly (crash, killed in Task Manager...)
# it is started again after a short back-off, and every event is written to data\bridge.log as “守护：…”.
# The launcher starts this guard instead of node directly, and stops the guard FIRST when it restarts
# the bridge on purpose, so intentional restarts never race with the guard.
#   -Script <file>   what to run with node (default bridge.mjs; tests pass a fake)
#   Stop for good:   create data\bridge.stop (the guard exits instead of restarting)
param([string]$Script = 'bridge.mjs', [string]$Node = '')

$ErrorActionPreference = 'Continue'
$root     = $PSScriptRoot
$data     = if ($env:BRIDGE_DATA) { $env:BRIDGE_DATA } else { Join-Path $root 'data' }
$log      = Join-Path $data 'bridge.log'
$errLog   = Join-Path $data 'bridge.stderr.log'
$stopFlag = Join-Path $data 'bridge.stop'
$ownNode  = Join-Path $root '..\tools\node\node.exe'   # 离线安装包自带的
if (-not $Node) { $Node = if (Test-Path $ownNode) { (Resolve-Path $ownNode).Path } elseif (Test-Path 'C:\Program Files\nodejs\node.exe') { 'C:\Program Files\nodejs\node.exe' } else { (Get-Command node).Source } }
New-Item -ItemType Directory -Force -Path $data | Out-Null

# Same line format as bridge.mjs: [UTC ISO time] message, UTF-8 without BOM.
$utf8 = New-Object Text.UTF8Encoding($false)
function Say([string]$m) {
  $line = '[{0}] 守护：{1}' -f [DateTime]::UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'"), $m
  for ($i = 0; $i -lt 10; $i++) {
    try { [IO.File]::AppendAllText($log, $line + "`n", $utf8); return } catch { Start-Sleep -Milliseconds 50 }
  }
}

# One guard per data folder.
$sha = [Security.Cryptography.SHA1]::Create()
$tag = ([BitConverter]::ToString($sha.ComputeHash($utf8.GetBytes($data.ToLower()))) -replace '-', '').Substring(0, 12)
$mutex = New-Object Threading.Mutex($false, "Local\QQBotBridgeGuard-$tag")
if (-not $mutex.WaitOne(0)) { exit }

Remove-Item $stopFlag -Force -ErrorAction SilentlyContinue
$fails = 0
$first = $true
while ($true) {
  if (Test-Path $stopFlag) { Say '收到停止标记（data\bridge.stop），不再拉起 bridge'; break }
  $started = Get-Date
  try {
    $p = Start-Process -FilePath $Node -ArgumentList "`"$Script`"" -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardError $errLog -PassThru
    $null = $p.Handle   # keep the handle so ExitCode is readable after the process ends
  } catch {
    Say "启动 bridge 失败：$($_.Exception.Message)，60 秒后再试"
    Start-Sleep -Seconds 60
    continue
  }
  Say ($(if ($first) { "开始守护 bridge（PID $($p.Id)）" } else { "已重新拉起 bridge（PID $($p.Id)）" }))
  $first = $false
  $p.WaitForExit()
  if (Test-Path $stopFlag) { Say '收到停止标记（data\bridge.stop），不再拉起 bridge'; break }

  # 退出码 3：已经有别的 bridge 在跑（不是这个守护拉起的），等它停了再接手，不算崩溃，也不刷日志
  if ($p.ExitCode -eq 3) {
    if (-not $waiting) { Say '已经有一个 bridge 在跑（不是我拉起的），等它停了再接手' }
    $waiting = $true
    Start-Sleep -Seconds 30
    continue
  }
  $waiting = $false
  $alive = [int]((Get-Date) - $started).TotalSeconds
  # 很快又挂的话越等越久，免得崩溃时疯狂重启：3s → 10s → 30s → 60s → 5min
  if ($alive -lt 60) { $fails++ } else { $fails = 0 }
  $wait = @(3, 10, 30, 60, 300)[[Math]::Min([Math]::Max($fails - 1, 0), 4)]
  $tail = ''
  try { $tail = ((Get-Content $errLog -Tail 4 -Encoding UTF8 -ErrorAction Stop) | Where-Object { $_.Trim() }) -join ' | ' } catch {}
  if ($tail.Length -gt 300) { $tail = $tail.Substring($tail.Length - 300) }
  Say ("bridge 意外停了（退出码 $($p.ExitCode)，跑了 $alive 秒）" + $(if ($tail) { "，最后的报错：$tail" } else { '，没有留下报错（可能是被结束进程）' }) + "，$wait 秒后重新拉起")
  Start-Sleep -Seconds $wait
}
$mutex.ReleaseMutex()
