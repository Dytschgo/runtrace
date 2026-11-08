# Installs or updates Runtrace for this Windows user, then starts it and opens the dashboard.
#   irm https://github.com/Dytschgo/runtrace/releases/latest/download/install.ps1 | iex
# Everything goes in %LOCALAPPDATA%\Runtrace (program, settings, data, logs). Nothing needs administrator rights.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$repo = 'Dytschgo/runtrace'
$root = if ($env:RUNTRACE_HOME) { $env:RUNTRACE_HOME } else { Join-Path $env:LOCALAPPDATA 'Runtrace' }
$bin = Join-Path $root 'bin'
$exe = Join-Path $bin 'runtrace.exe'
$asset = 'runtrace-x86_64-pc-windows-msvc.exe'
# RUNTRACE_RELEASE_BASE, RUNTRACE_NO_PATH and RUNTRACE_NO_OPEN exist for testing and scripted installs.
$base = if ($env:RUNTRACE_RELEASE_BASE) { $env:RUNTRACE_RELEASE_BASE } else { "https://github.com/$repo/releases/latest/download" }
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) "runtrace-install-$([guid]::NewGuid())"
New-Item -ItemType Directory -Force -Path $tmp, $bin | Out-Null
try {
  Write-Output "Downloading Runtrace..."
  Invoke-WebRequest "$base/$asset" -OutFile "$tmp\$asset" -UseBasicParsing
  Invoke-WebRequest "$base/SHA256SUMS" -OutFile "$tmp\SHA256SUMS" -UseBasicParsing
  $want = (Get-Content "$tmp\SHA256SUMS" | Where-Object { $_ -match "\s\*?$([regex]::Escape($asset))$" } | Select-Object -First 1) -split '\s+' | Select-Object -First 1
  $got = (Get-FileHash "$tmp\$asset" -Algorithm SHA256).Hash
  if (-not $want -or $got -ne $want.ToUpper()) { throw 'The download does not match its published checksum. Nothing was installed.' }
  if (Test-Path $exe) { & $exe stop | Out-Null }
  Move-Item -Force "$tmp\$asset" $exe
} finally { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not $env:RUNTRACE_NO_PATH -and ($userPath -split ';') -notcontains $bin) {
  [Environment]::SetEnvironmentVariable('Path', (($userPath, $bin) | Where-Object { $_ }) -join ';', 'User')
  $env:Path = "$env:Path;$bin"
  Write-Output "Added $bin to your PATH. New terminals know the runtrace command."
}
if ($env:RUNTRACE_NO_OPEN) { & $exe start } else { & $exe start --open }
if ($LASTEXITCODE -ne 0) { throw 'Runtrace was installed but did not start. Run `runtrace status` to see where its logs are.' }
Write-Output ''
Write-Output 'Runtrace is installed. Useful commands: runtrace status, runtrace stop, runtrace update, runtrace autostart on'
