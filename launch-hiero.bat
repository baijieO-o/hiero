@echo off
setlocal
cd /d "%~dp0"

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
