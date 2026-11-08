$ErrorActionPreference = 'Stop'
$runtimeRoot = [System.IO.Path]::GetFullPath($PSScriptRoot)
if ($runtimeRoot -ne 'D:\Code\Runtrace') { throw 'Run the installed D:\Code\Runtrace\start.ps1' }
$existing = Get-Process t3ui -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq "$runtimeRoot\bin\t3ui.exe" }
if ($existing) { Write-Output "Runtrace already running (PID $($existing.Id)). http://127.0.0.1:4310"; exit 0 }
$env:T3UI_CONFIG = "$runtimeRoot/config/default.toml"
if (-not $env:RUST_LOG) { $env:RUST_LOG = 't3ui=info,t3ui_core=info' }
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
# One-time database updates run here, in the foreground and with no time limit, so they never count against the readiness wait below.
Write-Output 'Checking the database...'
$previousPreference = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
$migrateLog = "$runtimeRoot/logs/migrate-$stamp.log"
& "$runtimeRoot/bin/t3ui.exe" migrate 2>&1 | ForEach-Object {
  # PowerShell wraps the program's stderr lines (its progress) as error records; keep them as plain text.
  # Windows PowerShell keeps the text in TargetObject, PowerShell 7 in the exception message, and an empty line in neither.
  $line = if ($_ -isnot [System.Management.Automation.ErrorRecord]) { "$_" }
    elseif ($_.TargetObject) { "$($_.TargetObject)" }
    elseif ($_.Exception.Message -ne 'System.Management.Automation.RemoteException') { $_.Exception.Message }
    else { '' }
  Add-Content -LiteralPath $migrateLog -Value $line -Encoding utf8
  $line
}
$migrateExit = $LASTEXITCODE
$ErrorActionPreference = $previousPreference
if ($migrateExit -ne 0) { throw "The database update failed, so Runtrace was not started. Inspect $migrateLog" }
$process = Start-Process -FilePath "$runtimeRoot/bin/t3ui.exe" -ArgumentList 'serve' -WorkingDirectory $runtimeRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput "$runtimeRoot/logs/server-$stamp.log" -RedirectStandardError "$runtimeRoot/logs/server-$stamp.err.log"
Set-Content -LiteralPath "$runtimeRoot/server.pid" -Value $process.Id
$configText = Get-Content "$runtimeRoot/config/default.toml" -Raw
$portMatch = [regex]::Match($configText, '(?m)^port\s*=\s*(\d+)')
$port = if ($portMatch.Success) { [int]$portMatch.Groups[1].Value } else { 4310 }
$deadline = [DateTime]::UtcNow.AddSeconds(20)
$ready = $false
while ([DateTime]::UtcNow -lt $deadline) {
  $process.Refresh()
  if ($process.HasExited) { break }
  try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/health/ready" -TimeoutSec 1
    if ($health.ready -and $health.pid -eq $process.Id) { $ready = $true; break }
  } catch { }
  Start-Sleep -Milliseconds 200
}
if (-not $ready) {
  $process.Refresh()
  if (-not $process.HasExited) { Stop-Process -Id $process.Id }
  Remove-Item -LiteralPath "$runtimeRoot/server.pid" -ErrorAction SilentlyContinue
  throw "Runtrace did not become ready. Inspect $runtimeRoot/logs/server-$stamp.err.log"
}
Write-Output "Runtrace ready (PID $($process.Id)). http://127.0.0.1:$port; logs: $runtimeRoot/logs"
