@echo off
setlocal
rem Node: SSAM_NODE (gravada por scripts\setup-dev.ps1), depois o Node do runtime Codex, depois o node do PATH.
if not defined SSAM_NODE set "SSAM_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if not exist "%SSAM_NODE%" set "SSAM_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if not exist "%SSAM_NODE%" set "SSAM_NODE=node"
"%SSAM_NODE%" "%~dp0facade\ssam.mjs" %*
exit /b %errorlevel%
