@echo off
REM ===== Drag a franchise save file onto this .bat to list its tables =====
REM Or run:  inspect.bat "C:\path\to\CAREER-MYLEAGUE"
cd /d "%~dp0"

if "%~1"=="" (
  echo Drag a franchise save FILE onto this icon, or run:
  echo     inspect.bat "C:\Users\You\Documents\Madden NFL 26\settings\CAREER-MYLEAGUE"
  echo.
  pause
  exit /b 1
)

node cli.js inspect "%~1"
echo.
echo Tip: add a filter, e.g.  node cli.js inspect "%~1" --filter stat
echo.
pause
