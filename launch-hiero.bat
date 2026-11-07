@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Please install Node.js 22 or newer: https://nodejs.org/
  pause
  exit /b 1
)

if not exist "node_modules\.bin\tsc.cmd" (
  echo Installing backend dependencies. The first run may take a few minutes...
  call npm ci
  if errorlevel 1 goto :fail
)

if not exist "frontend\node_modules\.bin\vite.cmd" (
  echo Installing frontend dependencies...
  call npm ci --prefix frontend
  if errorlevel 1 goto :fail
)

echo Starting Hiero backend WebSocket runtime on ws://localhost:8080...
start "Hiero Backend" cmd /k "cd /d "%~dp0" && npm run start"

echo Starting Hiero frontend...
start "Hiero Frontend" cmd /k "cd /d "%~dp0frontend" && npm run dev"

echo Waiting for Vite to start...
timeout /t 5 /nobreak >nul
start "" "http://localhost:5173"

echo.
echo Hiero is starting.
echo Backend:  ws://localhost:8080
echo Frontend: http://localhost:5173
echo.
endlocal
exit /b 0

:fail
echo.
echo Dependency installation failed. See the error messages above.
pause
endlocal
exit /b 1
