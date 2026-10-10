@echo off
rem SSAM Hybrid-ODC entry. Node: SSAM_NODE, then the Node bundled with the Codex runtime, then node on PATH.
set "NODE=%SSAM_NODE%"
if not defined NODE set "NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if not exist "%NODE%" set "NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if not exist "%NODE%" set "NODE=node"
"%NODE%" "%~dp0facade\odc.mjs" %*
