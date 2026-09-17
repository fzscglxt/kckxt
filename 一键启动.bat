@echo off
chcp 65001 >nul
title 库存电子看板系统
cd /d "%~dp0"

echo.
echo ============================================
echo     库存电子看板系统 - 启动中...
echo ============================================
echo.

REM ===== 1. 查找 Node.js =====
set "NODE_EXE="

REM 1.1 检查 PATH 中的 node
where node >nul 2>nul
if %errorlevel%==0 (
    for /f "delims=" %%i in ('where node') do (
        if not defined NODE_EXE set "NODE_EXE=%%i"
    )
)

REM 1.2 检查常见安装路径
if not defined NODE_EXE (
    if exist "C:\nodejs\node.exe" set "NODE_EXE=C:\nodejs\node.exe"
)
if not defined NODE_EXE (
    if exist "C:\Program Files\nodejs\node.exe" set "NODE_EXE=C:\Program Files\nodejs\node.exe"
)
if not defined NODE_EXE (
    if exist "C:\Program Files (x86)\nodejs\node.exe" set "NODE_EXE=C:\Program Files (x86)\nodejs\node.exe"
)
if not defined NODE_EXE (
    if exist "%LOCALAPPDATA%\fnm_multishells\default\node.exe" set "NODE_EXE=%LOCALAPPDATA%\fnm_multishells\default\node.exe"
)
if not defined NODE_EXE (
    if exist "%USERPROFILE%\AppData\Roaming\nvm\v20\node.exe" set "NODE_EXE=%USERPROFILE%\AppData\Roaming\nvm\v20\node.exe"
)

REM ===== 2. 如果没找到 Node.js，提示安装 =====
if not defined NODE_EXE (
    echo [错误] 未找到 Node.js 运行环境！
    echo.
    echo 请先安装 Node.js：
    echo   1. 访问 https://nodejs.org 下载 LTS 版本（推荐 v20+）
    echo   2. 运行安装程序，一路"下一步"即可
    echo   3. 安装完成后重新双击此文件启动系统
    echo.
    echo 或者将本文件夹中自带的 node.exe（如果有）放在 PATH 中。
    echo.
    pause
    exit /b 1
)

echo [OK] Node.js: %NODE_EXE%

REM ===== 3. 检查核心文件 =====
set "MISSING=0"
for %%f in (server.js index.html data.json accounts.json) do (
    if not exist "%%f" (
        echo [警告] 缺少文件: %%f
        set "MISSING=1"
    )
)
if "%MISSING%"=="1" (
    echo.
    echo [错误] 核心文件缺失，系统无法启动！
    echo 请确认解压完整。
    pause
    exit /b 1
)
echo [OK] 核心文件检查通过

REM ===== 4. 获取本机IP =====
set "LOCAL_IP=127.0.0.1"
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /i "IPv4"') do (
    set "LOCAL_IP=%%a"
    set "LOCAL_IP=%LOCAL_IP: =%"
)

REM ===== 5. 启动服务器 =====
echo.
echo ============================================
echo   系统启动成功！
echo ============================================
echo.
echo   本机访问:   http://localhost:3000
echo   局域网访问: http://%LOCAL_IP%:3000
echo.
echo   默认账户:   admin / 123456
echo.
echo   按 Ctrl+C 停止服务
echo ============================================
echo.
echo 浏览器将在3秒后自动打开...
start /b "" cmd /c "timeout /t 3 >nul && start http://localhost:3000"

"%NODE_EXE%" server.js
pause
