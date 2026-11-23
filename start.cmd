@echo off
rem Starts AgentWingman without a console window staying open.
cd /d "%~dp0"
if not exist node_modules\electron\dist\electron.exe (
  echo Electron is not installed. Run "npm install" in this folder first.
  pause
  exit /b 1
)
start "" node_modules\electron\dist\electron.exe .
