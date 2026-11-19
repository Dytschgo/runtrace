# Fresh local install qualification with no real collection and an unused port.
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('runtrace-install-' + [Guid]::NewGuid().ToString('N'))
$testRoot = [IO.Path]::GetFullPath($testRoot)
$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([IO.Path]::DirectorySeparatorChar)
if (-not $testRoot.StartsWith($tempRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unexpected install target' }
foreach ($entry in @(Get-ChildItem Env: | Where-Object { $_.Name -like 'RUNTRACE_*' -or $_.Name -like 'T3UI_*' })) { Remove-Item -LiteralPath ('Env:' + $entry.Name) }
$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$listener.Start()
$port = $listener.LocalEndpoint.Port
$listener.Stop()
New-Item -ItemType Directory -Path (Join-Path $testRoot 'config') -Force | Out-Null
$slashRoot = $testRoot.Replace('\', '/')
$settings = (Get-Content -LiteralPath (Join-Path $repoRoot 'config/default.toml') -Raw).Replace('port = 4310', "port = $port").Replace('./data/t3-usage.duckdb', "$slashRoot/data/fixture.duckdb").Replace('./data/archive', "$slashRoot/archive")
$settings = $settings.Replace('sqlite_path = ""', "sqlite_path = `"$slashRoot/absent.sqlite`"").Replace('collect_on_serve = true', 'collect_on_serve = false').Replace('checks = true', 'checks = false').Replace('notifications = true', 'notifications = false')
$settings += "`n[update]`ncheck = false`n"
[IO.File]::WriteAllText((Join-Path $testRoot 'config/default.toml'), $settings)
$stopped = $false
$testShell = (Get-Process -Id $PID).Path
try {
    & (Join-Path $repoRoot 'scripts/install.ps1') -Destination $testRoot
    if ($LASTEXITCODE -ne 0) { throw 'Fresh installer failed' }
    $health = Invoke-RestMethod "http://127.0.0.1:$port/health/ready" -TimeoutSec 5
    if (-not $health.ready -or $health.collector.state -ne 'disabled') { throw 'Unexpected scratch collector state' }
    $cargoTarget = if ($env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR } else { 'target' }
    if (-not [IO.Path]::IsPathRooted($cargoTarget)) { $cargoTarget = Join-Path $repoRoot $cargoTarget }
    $cargoTarget = [IO.Path]::GetFullPath($cargoTarget)
    $runtime = Join-Path $cargoTarget 'release/duckdb.dll'
    $runtimeCopied = $false
    if (Test-Path -LiteralPath $runtime) {
        $runtimeCopied = (Get-FileHash -LiteralPath $runtime).Hash -eq (Get-FileHash -LiteralPath (Join-Path $testRoot 'bin/duckdb.dll')).Hash
        if (-not $runtimeCopied) { throw 'External local runtime was not copied exactly' }
    }
    & $testShell -NoProfile -NonInteractive -File (Join-Path $testRoot 'stop.ps1')
    if ($LASTEXITCODE -ne 0) { throw 'Installed stop script failed' }
    $stopped = $true
    [pscustomobject]@{fresh_install_started=$true;collector_disabled=$true;external_runtime_copied=$runtimeCopied;stop_script_passed=$true;version=$health.version;isolated_port=($port -ne 4310)} | ConvertTo-Json -Compress
} finally {
    if (-not $stopped -and (Test-Path -LiteralPath (Join-Path $testRoot 'bin/runtrace.exe'))) {
        & $testShell -NoProfile -NonInteractive -File (Join-Path $testRoot 'stop.ps1')
        $stopped = $LASTEXITCODE -eq 0
    }
    if ($stopped) {
        $resolved = [IO.Path]::GetFullPath($testRoot)
        if (-not $resolved.StartsWith($tempRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or -not ([IO.Path]::GetFileName($resolved)).StartsWith('runtrace-install-')) { throw 'Unexpected cleanup target' }
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}
