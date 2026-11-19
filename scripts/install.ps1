# Builds Runtrace from this checkout and installs it into a folder of its own (bin, config, data, logs).
# Most people should use the release installer instead (see README). Existing settings and data are kept.
param([string]$Destination = "$env:LOCALAPPDATA\Runtrace-dev")
$ErrorActionPreference = 'Stop'
$sourceRoot = [System.IO.Path]::GetFullPath("$PSScriptRoot/..")
$root = [System.IO.Path]::GetFullPath($Destination)
$cargoTarget = if ($env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR } else { 'target' }
if (-not [IO.Path]::IsPathRooted($cargoTarget)) { $cargoTarget = Join-Path $sourceRoot $cargoTarget }
$cargoTarget = [IO.Path]::GetFullPath($cargoTarget)
$releaseRoot = Join-Path $cargoTarget 'release'
Push-Location $sourceRoot
try {
  Push-Location dashboard
  try {
    npm ci
    if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed; stop any development/preview processes using this checkout and retry.' }
    npm run build
    if ($LASTEXITCODE -ne 0) { throw 'Dashboard build failed' }
  } finally { Pop-Location }
  cargo build --release --workspace --locked
  if ($LASTEXITCODE -ne 0) { throw 'Release build failed' }
  New-Item -ItemType Directory -Force -Path "$root/bin", "$root/config", "$root/data", "$root/logs" | Out-Null
  $config = "$root\config\default.toml"
  if (Test-Path "$root\bin\runtrace.exe") { & "$root\bin\runtrace.exe" stop --config $config | Out-Null }
  Copy-Item -LiteralPath (Join-Path $releaseRoot 'runtrace.exe') -Destination "$root/bin/runtrace.exe" -Force
  # Local builds may use an external DuckDB runtime; bundled release builds do not need it.
  if (Test-Path -LiteralPath (Join-Path $releaseRoot 'duckdb.dll') -PathType Leaf) {
    Copy-Item -LiteralPath (Join-Path $releaseRoot 'duckdb.dll') -Destination "$root/bin/duckdb.dll" -Force
  }
  Copy-Item -LiteralPath scripts/start.ps1, scripts/stop.ps1, scripts/runtrace.cmd -Destination $root -Force
  if (-not (Test-Path $config)) {
    $d = $root.Replace('\', '/')
    (Get-Content config/default.toml -Raw).Replace('./data/t3-usage.duckdb', "$d/data/t3-usage.duckdb").Replace('./data/archive', "$d/data/archive") | Set-Content -LiteralPath $config -Encoding utf8
  }
  & "$root\bin\runtrace.exe" start --config $config
  if ($LASTEXITCODE -ne 0) { throw 'Runtrace did not start; the data folder is untouched.' }
} finally { Pop-Location }
