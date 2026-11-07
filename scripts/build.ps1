$ErrorActionPreference = 'Stop'
Push-Location "$PSScriptRoot/.."
try {
  cargo build --workspace
  if ($LASTEXITCODE -ne 0) { throw 'Rust build failed' }
  $duckRuntime = Get-ChildItem target/debug/build/libduckdb-sys*/out/duckdb.dll | Select-Object -First 1
  if ($duckRuntime) { Copy-Item -LiteralPath $duckRuntime.FullName -Destination target/debug/duckdb.dll }
  Push-Location dashboard
  try { npm ci; npm run build; if ($LASTEXITCODE -ne 0) { throw 'Dashboard build failed' } } finally { Pop-Location }
} finally { Pop-Location }
