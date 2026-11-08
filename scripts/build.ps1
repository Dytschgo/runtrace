# Development build: the dashboard first, so the program embeds it, then the Rust workspace.
$ErrorActionPreference = 'Stop'
Push-Location "$PSScriptRoot/.."
try {
  Push-Location dashboard
  try { npm ci; npm run build; if ($LASTEXITCODE -ne 0) { throw 'Dashboard build failed' } } finally { Pop-Location }
  cargo build --workspace
  if ($LASTEXITCODE -ne 0) { throw 'Rust build failed' }
} finally { Pop-Location }
