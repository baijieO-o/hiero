@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo 未检测到 Node.js，请先安�?Node.js 22 或更高版本：https://nodejs.org/
  pause
  exit /b 1
)

if not exist "node_modules\.bin\tsc.cmd" (
  echo 正在安装后端依赖（首次运行需要几分钟�?..
  call npm ci
  if errorlevel 1 goto :fail
)

if not exist "frontend\node_modules\.bin\vite.cmd" (
  echo 正在安装前端依赖...
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
echo 依赖安装失败，请查看上方错误信息�?
pause
endlocal
exit /b 1
