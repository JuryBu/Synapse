@echo off
title Synapse 启动器

echo.
echo    ______
echo   / ____/_  ______  ____ _____  ________
echo  / /__  / / / / __ \/ __ `/ __ \/ ___/ _ \
echo  \___ \/ /_/ / / / / /_/ / /_/ (__  )  __/
echo /____/\__, /_/ /_/\__,_/ .___/____/\___/
echo      /____/           /_/
echo.
echo   AI 驱动的交互式学习平台
echo.
echo   ----------------------------------
echo   请选择启动模式:
echo.
echo   [1] Web 模式    (浏览器访问 localhost:5173)
echo   [2] Electron 模式 (桌面应用窗口)
echo   [3] 退出
echo.
echo   ----------------------------------
echo.

set /p choice="  请输入选项 (1/2/3): "

rem Trim whitespace from input
set "choice=%choice: =%"

cd /d "%~dp0synapse-app"

if "%choice%"=="1" (
    echo.
    echo   [*] 启动 Web 开发模式...
    echo   [*] 浏览器访问: http://localhost:5173
    echo.
    call npm run dev
) else if "%choice%"=="2" (
    echo.
    echo   [*] 启动 Electron 桌面模式...
    echo.
    call npm run electron:dev
) else if "%choice%"=="3" (
    echo.
    echo   再见！
    exit /b
) else (
    echo.
    echo   [!] 无效选项，请输入 1、2 或 3
    pause
)
