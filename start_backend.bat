@echo off
REM Double-click launcher - always runs from THIS folder, so
REM "ModuleNotFoundError" cannot happen. Run exactly ONE backend
REM instance: two servers on port 8000 fight and slow the sim loop.
cd /d "%~dp0"
echo [backend] working dir: %CD%
echo [backend] starting on http://0.0.0.0:8000 ...
py -m uvicorn Backend.api:app --port 8000 --host 0.0.0.0
pause
