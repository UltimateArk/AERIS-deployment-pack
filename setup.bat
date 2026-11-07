@echo off
REM AERIS one-time setup (fresh clone): installs deps + deploys the pushed
REM model set (ML_Models/) and fault catalog (Database/) into the aeris
REM runtime folders (Backend\aeris\models, config). Those runtime folders
REM are git-ignored by design - this script recreates them.
cd /d "%~dp0"
echo [setup] working dir: %CD%

echo [1/4] python deps (twin + training tools)...
py -m pip install -r Backend\requirements.txt
if errorlevel 1 goto :fail

echo [2/4] deploying models + configs to aeris runtime...
if not exist "Backend\aeris\models" mkdir "Backend\aeris\models"
if not exist "Backend\aeris\config" mkdir "Backend\aeris\config"
if not exist "Backend\aeris\data\spill" mkdir "Backend\aeris\data\spill"
copy /Y "ML_Models\*.onnx" "Backend\aeris\models\" >nul
copy /Y "ML_Models\calibrators.json" "Backend\aeris\config\" >nul
copy /Y "ML_Models\feature_list.json" "Backend\aeris\config\" >nul
copy /Y "ML_Models\scaler_anomaly.json" "Backend\aeris\config\" >nul
copy /Y "ML_Models\threshold_anomaly.json" "Backend\aeris\config\" >nul
copy /Y "ML_Models\trend_config.json" "Backend\aeris\config\" >nul
copy /Y "Database\fault_catalog.json" "Backend\aeris\config\" >nul
if errorlevel 1 goto :fail

echo [3/4] aeris node deps...
cd "Backend\aeris" && npm install && cd ..\..
if errorlevel 1 goto :fail

echo [4/4] frontend deps...
cd "Frontend" && npm install && cd ..
if errorlevel 1 goto :fail

echo [setup] done. Host order: twin :8000, aeris :8080/:8081,
echo [setup] bridge, then SIH :8443. Twin launcher: start_backend.bat
pause
exit /b 0

:fail
echo [setup] FAILED - see error above.
pause
exit /b 1
