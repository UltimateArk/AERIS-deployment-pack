@echo off
REM AERIS full-stack host (one double-click). Starts ONE of each process,
REM minimized, with logs. Run this INSTEAD of manual terminals - manual
REM terminals left running cause duplicate processes that wedge the stack.
REM NOTE: kills all node.exe / py.exe on this machine first.
cd /d "%~dp0"
echo [host] stopping leftovers...
taskkill /F /IM node.exe >nul 2>&1
taskkill /F /IM py.exe >nul 2>&1
timeout /t 3 /nobreak >nul

echo [host] 1/4 twin :8000 ...
start "aeris-twin" /min py -m uvicorn Backend.api:app --port 8000 --host 0.0.0.0
timeout /t 6 /nobreak >nul

echo [host] 2/4 aeris backend :8080/:8081 ...
start "aeris-backend" /min /d "Backend\aeris" cmd /c "npm start > aeris-debug.log 2>&1"
timeout /t 12 /nobreak >nul

echo [host] 3/4 bridge :8000-^>:8080 ...
start "aeris-bridge" /min /d "Backend\aeris" cmd /c "node scripts/bridge.js > bridge-debug.log 2>&1"

echo [host] 4/4 SIH frontend :8443 ...
start "aeris-sih" /min /d "Frontend" cmd /c "npm run dev > sih-debug.log 2>&1"
timeout /t 12 /nobreak >nul

echo.
echo [host] expected: 4 minimized windows (aeris-twin/backend/bridge/sih).
echo [host] DO NOT close them and do NOT start manual terminals.
echo [host] Stop everything with stop_all.bat. Open http://localhost:8443
echo [host] then press START once in the UI.
pause
