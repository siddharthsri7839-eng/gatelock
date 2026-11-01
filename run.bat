@echo off
cd /d "%~dp0"
title GateLock Pro - Bio S-B251CB Dual Gate Controller
echo ========================================================
echo  GateLock Pro - Dual Biometric S-B251CB Gate Access
echo ========================================================
echo.
echo Working Directory: %~dp0
echo Starting GateLock Web Application on http://localhost:8000 ...
echo.
python -m uvicorn main:app --app-dir "%~dp0" --host 0.0.0.0 --port 8000 --reload
if %errorlevel% neq 0 (
    echo.
    echo If port 8000 is busy, please close any existing GateLock command windows.
    echo.
)
pause
