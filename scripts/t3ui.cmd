@echo off
setlocal
set "T3UI_CONFIG=%~dp0config\default.toml"
"%~dp0bin\t3ui.exe" %*
