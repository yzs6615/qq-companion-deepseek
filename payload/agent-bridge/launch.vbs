' Desktop entry point for the QQ bot launcher (ASCII only on purpose: wscript reads
' this file in the ANSI code page). Asks for admin once (UAC) and runs launch.ps1
' with no console window at all, so the only thing on screen is the launcher window.
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
Set sh = CreateObject("Shell.Application")
sh.ShellExecute "powershell.exe", "-NoProfile -ExecutionPolicy Bypass -STA -WindowStyle Hidden -File """ & dir & "\launch.ps1""", dir, "runas", 0
