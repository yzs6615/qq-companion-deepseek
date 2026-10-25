' Double-click entry for the bridge status window (ASCII only: wscript reads this in the
' ANSI code page). No console flash and no admin prompt - the window only reads.
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
Set sh = CreateObject("Shell.Application")
sh.ShellExecute "powershell.exe", "-NoProfile -ExecutionPolicy Bypass -STA -WindowStyle Hidden -File """ & dir & "\status.ps1""", dir, "open", 0
