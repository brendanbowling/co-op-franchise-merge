@echo off
REM ===== Pass-through runner. Examples:
REM   cfb-merge inspect "CAREER-MYLEAGUE"
REM   cfb-merge snapshot "CAREER-BASELINE" --out snapshots\baseline.json
REM   cfb-merge diff snapshots\baseline.json snapshots\userB.json --out snapshots\report.json
REM   cfb-merge selftest
cd /d "%~dp0"
node "%~dp0cli.js" %*
