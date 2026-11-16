# Launch the built app the way a user gets it: every file marked "downloaded from the internet"
# (as Explorer does when unzipping), then check its window backend loads.
# Usage: pwsh tools/smoke_windows.ps1 [-SkipUnblock]
param([switch]$SkipUnblock)
$ErrorActionPreference = "Stop"

$app = Resolve-Path "dist/Preset Picker"
Get-ChildItem $app -Recurse -File | ForEach-Object {
    Set-Content -LiteralPath $_.FullName -Stream Zone.Identifier -Value "[ZoneTransfer]`r`nZoneId=3"
}

$result = Join-Path $env:RUNNER_TEMP "smoke.txt"
Remove-Item $result -ErrorAction SilentlyContinue
$env:PRESETPICKER_SMOKE = $result
if ($SkipUnblock) { $env:PRESETPICKER_SKIP_UNBLOCK = "1" } else { Remove-Item Env:PRESETPICKER_SKIP_UNBLOCK -ErrorAction SilentlyContinue }

# CreateProcess directly (not ShellExecute): a marked .exe started via the shell shows the
# "Open File - Security Warning" prompt, which nobody can click on a CI runner.
$psi = [System.Diagnostics.ProcessStartInfo]::new((Join-Path $app "Preset Picker.exe"))
$psi.UseShellExecute = $false
$p = [System.Diagnostics.Process]::Start($psi)
if (-not $p.WaitForExit(120000)) {
    # Kill the whole tree (and any crash dialog) so nothing keeps the CI step open.
    taskkill /PID $p.Id /T /F | Out-Null
    Get-Process WerFault -ErrorAction SilentlyContinue | Stop-Process -Force
    throw "App did not exit within 2 minutes"
}

$text = if (Test-Path $result) { Get-Content $result -Raw } else { "no result written (exit code $($p.ExitCode))" }
Write-Host "Smoke test: $text"
if ($text -ne "OK") { exit 1 }
