@echo off
title Media BMSTU - Reyting
cd /d "%~dp0"
powershell -ExecutionPolicy Bypass -NoProfile -File "%~dp0..\server.ps1"
echo.
echo Server ostanovlen. Mozhno zakryt okno.
pause
