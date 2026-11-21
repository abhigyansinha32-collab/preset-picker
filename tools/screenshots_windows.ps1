# Walk through the real installer on a clean Windows machine and screenshot every page.
# Usage (CI): pwsh tools/screenshots_windows.ps1 -Installer PresetPicker-Setup-x64.exe -Out shots
param([Parameter(Mandatory)][string]$Installer, [string]$Out = "shots")
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
New-Item -ItemType Directory -Force $Out | Out-Null

function Shot($name) {
    $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $bmp = [System.Drawing.Bitmap]::new($b.Width, $b.Height)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
    $bmp.Save((Join-Path $Out "$name.png"), [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
    Write-Host "shot $name"
}

$shell = New-Object -ComObject WScript.Shell
function Press($keys) {
    # The installer's windows are titled "Setup - Preset Picker" / "Select Setup Install Mode".
    foreach ($t in "Select Setup Install Mode", "Setup - Preset Picker") { if ($shell.AppActivate($t)) { break } }
    Start-Sleep -Milliseconds 400
    [System.Windows.Forms.SendKeys]::SendWait($keys)
}

# Clean desktop look: minimise everything else first.
(New-Object -ComObject Shell.Application).MinimizeAll()
Start-Sleep 2

$p = Start-Process (Resolve-Path $Installer) -PassThru
Start-Sleep 6
Shot "win-1-install-mode"           # "Install for me only / all users"
Press "{ENTER}"; Start-Sleep 4
Shot "win-2-destination"
Press "{ENTER}"; Start-Sleep 3
Shot "win-3-tasks"                  # desktop icon option
Press "{ENTER}"; Start-Sleep 3
Shot "win-4-ready"
Press "{ENTER}"; Start-Sleep 25     # installing
Shot "win-5-finished"               # "Launch Preset Picker" is ticked
Press "{ENTER}"; Start-Sleep 25     # the app opens
Shot "win-6-first-launch"

Get-Process "Preset Picker" -ErrorAction SilentlyContinue | Stop-Process -Force
