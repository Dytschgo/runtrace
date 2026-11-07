$ErrorActionPreference = 'Stop'
$runtimeRoot = [System.IO.Path]::GetFullPath($PSScriptRoot)
if ($runtimeRoot -ne 'D:\Code\Runtrace') { throw 'Run the installed D:\Code\Runtrace\stop.ps1' }
$owned = Get-Process t3ui -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq "$runtimeRoot\bin\t3ui.exe" }
if ($owned) {
  foreach ($process in $owned) {
    Stop-Process -Id $process.Id
    if (-not $process.WaitForExit(10000)) { throw "Runtrace PID $($process.Id) did not exit; binary replacement has been stopped." }
  }
  Write-Output 'Stopped Runtrace. DuckDB recovers committed transactions at next startup.'
} else { Write-Output 'Runtrace is stopped.' }
if (Test-Path "$runtimeRoot/server.pid") { Remove-Item -LiteralPath "$runtimeRoot/server.pid" }
