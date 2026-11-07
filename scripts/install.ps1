param([string]$Destination = 'D:/Code/Runtrace')
$ErrorActionPreference = 'Stop'
$sourceRoot = [System.IO.Path]::GetFullPath("$PSScriptRoot/..")
$runtimeRoot = [System.IO.Path]::GetFullPath($Destination)
if ($runtimeRoot -ne 'D:\Code\Runtrace') { throw 'This installer is scoped to the requested D:\Code\Runtrace installation.' }
Push-Location $sourceRoot
try {
  cargo build --release --workspace --locked
  if ($LASTEXITCODE -ne 0) { throw 'Release build failed' }
  Push-Location dashboard
  try { npm ci; npm run build; if ($LASTEXITCODE -ne 0) { throw 'Dashboard build failed' } } finally { Pop-Location }
  New-Item -ItemType Directory -Force -Path "$runtimeRoot/bin", "$runtimeRoot/config", "$runtimeRoot/dashboard", "$runtimeRoot/data", "$runtimeRoot/logs" | Out-Null
  $running = Get-Process t3ui -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq "$runtimeRoot\bin\t3ui.exe" }
  if ($running) { throw 'Stop the production instance with stop.ps1 before replacing its binary. Data remains untouched.' }
  Copy-Item -LiteralPath target/release/t3ui.exe -Destination "$runtimeRoot/bin/t3ui.exe" -Force
  $runtimeDll = Get-ChildItem target/release/build/libduckdb-sys*/out/duckdb.dll | Select-Object -First 1
  if (-not $runtimeDll) { throw 'DuckDB runtime DLL was not found' }
  Copy-Item -LiteralPath $runtimeDll.FullName -Destination "$runtimeRoot/bin/duckdb.dll" -Force
  Copy-Item -LiteralPath dashboard/dist -Destination "$runtimeRoot/dashboard" -Recurse -Force
  Copy-Item -LiteralPath scripts/start.ps1,scripts/stop.ps1 -Destination $runtimeRoot -Force
  Copy-Item -LiteralPath scripts/t3ui.cmd -Destination "$runtimeRoot/t3ui.cmd" -Force
  Copy-Item -LiteralPath README.md -Destination "$runtimeRoot/README.md" -Force
  Copy-Item -LiteralPath docs -Destination $runtimeRoot -Recurse -Force
  if (-not (Test-Path "$runtimeRoot/config/default.toml")) {
    $configText = (Get-Content config/default.toml -Raw).Replace('./data/t3-usage.duckdb','D:/Code/Runtrace/data/t3-usage.duckdb').Replace('./data/archive','D:/Code/Runtrace/data/archive').Replace('assets_path = "dashboard/dist"','assets_path = "D:/Code/Runtrace/dashboard/dist"')
    Set-Content -LiteralPath "$runtimeRoot/config/default.toml" -Value $configText -Encoding utf8
  }
  $previousConfig = $env:T3UI_CONFIG
  try {
    $env:T3UI_CONFIG = "$runtimeRoot/config/default.toml"
    & "$runtimeRoot/bin/t3ui.exe" init
    if ($LASTEXITCODE -ne 0) { throw 'Runtime initialization or migration failed; inspect the preserved database backup before retrying.' }
  } finally { $env:T3UI_CONFIG = $previousConfig }
  Write-Output "Installed release to $runtimeRoot. Existing configuration and data preserved. Run ./start.ps1 from that directory."
} finally { Pop-Location }
