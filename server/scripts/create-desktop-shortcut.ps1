# Creates a desktop shortcut to launch the Aether MCP GUI
# Run: powershell -ExecutionPolicy Bypass -File create-desktop-shortcut.ps1

$desktop = [Environment]::GetFolderPath("Desktop")
$shortcutPath = Join-Path $desktop "Aether MCP.lnk"
$targetPath = Join-Path $PSScriptRoot "start-gui.bat"

$WshShell = New-Object -ComObject WScript.Shell
$Shortcut = $WshShell.CreateShortcut($shortcutPath)
$Shortcut.TargetPath = "powershell.exe"
$Shortcut.Arguments = "-ExecutionPolicy Bypass -WindowStyle Normal -NoProfile -File `"$PSScriptRoot\aether-gui.ps1`""
$Shortcut.WorkingDirectory = Split-Path $PSScriptRoot -Parent
$Shortcut.Description = "Aether MCP - Browser Automation Server"
$Shortcut.Save()

Write-Host "Desktop shortcut created: $shortcutPath"
