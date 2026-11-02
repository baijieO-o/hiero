@echo off
setlocal
cd /d "%~dp0"

if not exist "hiero-llm.local.ps1" (
  copy /Y "hiero-llm.local.example.ps1" "hiero-llm.local.ps1" >nul
  echo 已创建 hiero-llm.local.ps1
) else (
  echo hiero-llm.local.ps1 已存在，不覆盖。
)

notepad "hiero-llm.local.ps1"
echo.
echo 编辑并保存 Token 后，在 PowerShell 中执行：
echo   . .\hiero-llm.local.ps1
echo   npm start
pause
