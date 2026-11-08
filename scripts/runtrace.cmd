@echo off
rem Runs any runtrace command against this install folder. Kept under its old name so existing habits keep working.
setlocal
"%~dp0bin\runtrace.exe" --config "%~dp0config\default.toml" %*
