@echo off
chcp 65001 >nul
cd /d "%~dp0"
node server.js
echo.
echo ================================================
echo  Service stopped.
echo ================================================
pause
