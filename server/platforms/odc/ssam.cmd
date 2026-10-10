@echo off
rem SSAM Hybrid entry for BOTH lanes (o11 and odc). Same Node resolution as odc.cmd.
set "NODE=%SSAM_NODE%"
if not defined NODE set "NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if not exist "%NODE%" set "NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if not exist "%NODE%" set "NODE=node"
"%NODE%" "%~dp0facade\ssam.mjs" %*
