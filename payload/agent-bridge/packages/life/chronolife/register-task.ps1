# 只维护虚拟状态，不启动QQ，不调用模型。使用-Remove可撤销。
param([switch]$Remove)
$ErrorActionPreference = 'Stop'
$taskName = 'Companion-ChronoLife-Tick'
if ($Remove) { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue; exit }
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskScript = Join-Path $PSScriptRoot 'run-tick.ps1'
$taskAction = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}"' -f $taskScript) -WorkingDirectory $taskRoot
$taskUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$taskTriggers = @((New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(30) -RepetitionInterval (New-TimeSpan -Minutes 30)), (New-ScheduledTaskTrigger -AtLogOn -User $taskUser))
$taskSettings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 2) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$taskPrincipal = New-ScheduledTaskPrincipal -UserId $taskUser -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $taskName -Action $taskAction -Trigger $taskTriggers -Settings $taskSettings -Principal $taskPrincipal -Description '每30分钟推进她的虚拟生活；无模型、无QQ发送、无端口' -Force | Select-Object TaskName,State
