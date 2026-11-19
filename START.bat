@echo off
setlocal
title Easy Agent Office - One Click Start
cd /d "%~dp0"

echo.
echo  ==========================================
echo    EASY AGENT OFFICE  -  ONE CLICK START
echo  ==========================================
echo.

echo [1/5] Checking Node.js...
where node >nul 2>nul
if errorlevel 1 (
  echo   [X] Node.js not found. Install it from https://nodejs.org
  echo.
  pause
  exit /b 1
)
echo   [OK] Node.js found

echo [2/5] Checking Antigravity...
tasklist /FI "IMAGENAME eq Antigravity IDE.exe" 2>nul | find /I "Antigravity" >nul
if not errorlevel 1 (
  echo   [OK] Antigravity is already running
  goto :deps
)
echo   Antigravity is not running. Starting it...
if exist "%LOCALAPPDATA%\Programs\Antigravity IDE\Antigravity IDE.exe" (
  start "" "%LOCALAPPDATA%\Programs\Antigravity IDE\Antigravity IDE.exe"
  echo   [OK] Antigravity started. Waiting 10 seconds...
  timeout /t 10 /nobreak >nul
  goto :deps
)
if exist "%LOCALAPPDATA%\Programs\Antigravity\Antigravity.exe" (
  start "" "%LOCALAPPDATA%\Programs\Antigravity\Antigravity.exe"
  echo   [OK] Antigravity started. Waiting 10 seconds...
  timeout /t 10 /nobreak >nul
  goto :deps
)
echo   [!] Could not find Antigravity automatically.
echo       Open Antigravity yourself, then run this file again.
echo.
pause
exit /b 1

:deps
echo [3/5] Checking dependencies...
if not exist "node_modules" (
  echo   Installing packages ^(first time only, about 30 seconds^)...
  call npm install
  if errorlevel 1 (
    echo   [X] npm install failed.
    pause
    exit /b 1
  )
) else (
  echo   [OK] Already installed
)

echo [4/5] Checking AI agents...
if not exist "agents.config.json" (
  echo   Creating your 4 agents in Antigravity ^(first time only^)...
  call node setup-agents.js
  if errorlevel 1 (
    echo   [X] Agent setup failed. Make sure Antigravity is open and logged in.
    pause
    exit /b 1
  )
) else (
  echo   [OK] Agents already created
)

echo [5/5] Starting the office...
netstat -ano 2>nul | findstr "LISTENING" | findstr ":3000 " >nul
if not errorlevel 1 (
  echo   [OK] Office server is already running
) else (
  start "Easy Agent Office Server" /MIN cmd /c "node server.js >> server.log 2>&1"
  echo   [OK] Server started in the background
  timeout /t 4 /nobreak >nul
)

start "" http://localhost:3000

echo.
echo  ==========================================
echo   DONE! Watch the office in your browser.
echo   You can close this window now.
echo  ==========================================
echo.
timeout /t 6
exit /b 0
