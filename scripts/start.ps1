$ErrorActionPreference = 'Stop'
$runtimeRoot = [System.IO.Path]::GetFullPath($PSScriptRoot)
if ($runtimeRoot -ne 'D:\Code\Runtrace') { throw 'Run the installed D:\Code\Runtrace\start.ps1' }
$existing = Get-Process t3ui -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq "$runtimeRoot\bin\t3ui.exe" }
if ($existing) { Write-Output "Runtrace already running (PID $($existing.Id)). http://127.0.0.1:4310"; exit 0 }
$env:T3UI_CONFIG = "$runtimeRoot/config/default.toml"
if (-not $env:RUST_LOG) { $env:RUST_LOG = 't3ui=info,t3ui_core=info' }
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
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
