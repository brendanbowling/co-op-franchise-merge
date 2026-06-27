@echo off
REM ===== cfb-merge one-time setup (Windows) =====
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Node.js is not installed.
  echo  Install the LTS version from https://nodejs.org/  then double-click this file again.
  echo.
  pause
  exit /b 1
)

echo Node detected:
node -v

if not exist "node_modules\madden-franchise" (
  echo.
  echo Installing dependencies ^(first run only^)...
  call npm install
) else (
  echo Dependencies already present.
)

echo.
echo Running self-test...
echo --------------------------------------------------
node cli.js selftest
echo --------------------------------------------------
echo.
echo Setup complete. You can now use inspect.bat / snapshot, or run: node cli.js
echo.
pause
