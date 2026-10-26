@echo off
setlocal DisableDelayedExpansion
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0study\desktop-launcher.ps1" -Action Stop %*
if errorlevel 1 goto failed
exit /b 0
:failed
echo.
pause
exit /b 1
