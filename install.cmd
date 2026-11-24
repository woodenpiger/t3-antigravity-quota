@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
echo [1/2] Closing T3 Code and installing T3 Antigravity Quota plugin...
node scripts\install.mjs --close-t3
if errorlevel 1 (
  echo.
  echo Install failed with exit code %errorlevel%.
  pause
  exit /b %errorlevel%
)
echo [2/2] Launching T3 Code (Beta)...
if exist "%LOCALAPPDATA%\Programs\t3code\T3 Code (Beta).exe" (
  start "" "%LOCALAPPDATA%\Programs\t3code\T3 Code (Beta).exe"
)
echo Done!
timeout /t 2 >nul
