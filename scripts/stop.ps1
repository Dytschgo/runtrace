# Stops the service of this install folder. Only a process that answers as this install is stopped.
$ErrorActionPreference = 'Stop'
$root = [System.IO.Path]::GetFullPath($PSScriptRoot)
& "$root\bin\runtrace.exe" stop --config "$root\config\default.toml"
exit $LASTEXITCODE
