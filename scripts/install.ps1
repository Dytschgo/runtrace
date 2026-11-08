# Builds Runtrace from this checkout and installs it into a folder of its own (bin, config, data, logs).
# Most people should use the release installer instead (see README). Existing settings and data are kept.
param([string]$Destination = "$env:LOCALAPPDATA\Runtrace-dev")
$ErrorActionPreference = 'Stop'
$sourceRoot = [System.IO.Path]::GetFullPath("$PSScriptRoot/..")
$root = [System.IO.Path]::GetFullPath($Destination)
Push-Location $sourceRoot
try {
  Push-Location dashboard
  try { npm ci; npm run build; if ($LASTEXITCODE -ne 0) { throw 'Dashboard build failed' } } finally { Pop-Location }
  cargo build --release --workspace --locked
  if ($LASTEXITCODE -ne 0) { throw 'Release build failed' }
  New-Item -ItemType Directory -Force -Path "$root/bin", "$root/config", "$root/data", "$root/logs" | Out-Null
  $config = "$root\config\default.toml"
  if (Test-Path "$root\bin\runtrace.exe") { & "$root\bin\runtrace.exe" stop --config $config | Out-Null }
  Copy-Item -LiteralPath target/release/runtrace.exe -Destination "$root/bin/runtrace.exe" -Force
  Copy-Item -LiteralPath scripts/start.ps1, scripts/stop.ps1, scripts/runtrace.cmd -Destination $root -Force
  if (-not (Test-Path $config)) {
    $d = $root.Replace('\', '/')
    (Get-Content config/default.toml -Raw).Replace('./data/t3-usage.duckdb', "$d/data/t3-usage.duckdb").Replace('./data/archive', "$d/data/archive") | Set-Content -LiteralPath $config -Encoding utf8
  }
  & "$root\bin\runtrace.exe" start --config $config
  if ($LASTEXITCODE -ne 0) { throw 'Runtrace did not start; the data folder is untouched.' }
} finally { Pop-Location }
