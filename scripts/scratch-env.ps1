param(
  [ValidatePattern('^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$')]
  [string]$Task = 'local'
)

# Dot-source before invoking project tools; use a distinct task name per agent.
$scratchRoot = "D:\Scratch\Runtrace\$Task"
$env:TMP = Join-Path $scratchRoot 'tmp'
$env:TEMP = $env:TMP
$env:CARGO_TARGET_DIR = Join-Path $scratchRoot 'cargo-target'
$env:CARGO_HOME = Join-Path $scratchRoot 'cargo-home'
$env:npm_config_cache = Join-Path $scratchRoot 'npm-cache'
$env:PLAYWRIGHT_BROWSERS_PATH = Join-Path $scratchRoot 'playwright'
foreach ($scratchPath in @($env:TMP, $env:CARGO_TARGET_DIR, $env:CARGO_HOME, $env:npm_config_cache, $env:PLAYWRIGHT_BROWSERS_PATH)) {
  New-Item -ItemType Directory -Path $scratchPath -Force -ErrorAction Stop | Out-Null
}
if ((Get-PSDrive C -ErrorAction Stop).Free -lt 20GB) {
  throw 'C: has less than 20 GiB free. Pause large builds; reclaim space before starting one.'
}
