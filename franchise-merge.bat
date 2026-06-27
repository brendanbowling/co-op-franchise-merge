@echo off
REM ===== Pass-through runner. Examples:
REM   franchise-merge inspect "CAREER-MYLEAGUE"
REM   franchise-merge snapshot "CAREER-BASELINE" --out snapshots\baseline.json
REM   franchise-merge diff snapshots\baseline.json snapshots\userB.json --out snapshots\report.json
REM   franchise-merge selftest
cd /d "%~dp0"
node "%~dp0cli.js" %*
