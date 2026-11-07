@echo off
REM Stops the whole AERIS stack (all 4 hosts).
REM NOTE: kills all node.exe / py.exe on this machine.
cd /d "%~dp0"
taskkill /F /IM node.exe >nul 2>&1
taskkill /F /IM py.exe >nul 2>&1
timeout /t 2 /nobreak >nul
echo [stop] stack stopped. Verify: no LISTENING lines below = clean.
netstat -ano | findstr "LISTENING" | findstr ":8000 :8080 :8081 :8443"
echo [stop] done.
pause
