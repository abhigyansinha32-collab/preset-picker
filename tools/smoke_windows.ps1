# Launch the built app the way a user gets it and check its window backend loads.
#   pwsh tools/smoke_windows.ps1 [-SkipUnblock]   unzipped copy: every file marked "downloaded
#                                                 from the internet", as Explorer does
#   pwsh tools/smoke_windows.ps1 -Installer <exe> install with the setup (itself marked as
#                                                 downloaded), then launch the installed app
param([switch]$SkipUnblock, [string]$Installer)
$ErrorActionPreference = "Stop"

function Mark-Downloaded($path) {
    Set-Content -LiteralPath $path -Stream Zone.Identifier -Value "[ZoneTransfer]`r`nZoneId=3"
}

# CreateProcess directly (not ShellExecute): a marked .exe started via the shell shows the
# "Open File - Security Warning" prompt, which nobody can click on a CI runner.
function Run-Exe($exe, $arguments = "", $timeoutMs = 120000) {
    $psi = [System.Diagnostics.ProcessStartInfo]::new($exe, $arguments)
    $psi.UseShellExecute = $false
    $p = [System.Diagnostics.Process]::Start($psi)
    if (-not $p.WaitForExit($timeoutMs)) {
        # Kill the whole tree (and any crash dialog) so nothing keeps the CI step open.
        taskkill /PID $p.Id /T /F | Out-Null
        Get-Process WerFault -ErrorAction SilentlyContinue | Stop-Process -Force
        throw "$exe did not exit within $($timeoutMs / 1000) s"
    }
    $p.ExitCode
}

if ($Installer) {
    $setup = Resolve-Path $Installer
    Mark-Downloaded $setup
    $dir = Join-Path $env:RUNNER_TEMP "PresetPickerInstall"
    $code = Run-Exe $setup "/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /CURRENTUSER /DIR=`"$dir`"" 300000
    if ($code -ne 0) { throw "Installer exited with code $code" }
    $app = $dir
    Write-Host "Installed to $dir"
} else {
    $app = Resolve-Path "dist/Preset Picker"
    Get-ChildItem $app -Recurse -File | ForEach-Object { Mark-Downloaded $_.FullName }
}

$result = Join-Path $env:RUNNER_TEMP "smoke.txt"
Remove-Item $result -ErrorAction SilentlyContinue
$env:PRESETPICKER_SMOKE = $result
if ($SkipUnblock) { $env:PRESETPICKER_SKIP_UNBLOCK = "1" } else { Remove-Item Env:PRESETPICKER_SKIP_UNBLOCK -ErrorAction SilentlyContinue }

$code = Run-Exe (Join-Path $app "Preset Picker.exe")
$text = if (Test-Path $result) { Get-Content $result -Raw } else { "no result written (exit code $code)" }
Write-Host "Smoke test: $text"
if ($text -ne "OK") { exit 1 }

if ($Installer) {
    $code = Run-Exe (Join-Path $app "unins000.exe") "/VERYSILENT /SUPPRESSMSGBOXES /NORESTART" 300000
    Write-Host "Uninstaller exited with code $code"
}
