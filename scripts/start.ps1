# Starts an install folder made by scripts/install.ps1 (bin, config, data, logs side by side).
# `runtrace start` brings the database up to date first, so a slow one-time update never races the readiness wait.
$ErrorActionPreference = 'Stop'
$root = [System.IO.Path]::GetFullPath($PSScriptRoot)
& "$root\bin\runtrace.exe" start --config "$root\config\default.toml" @args
exit $LASTEXITCODE
