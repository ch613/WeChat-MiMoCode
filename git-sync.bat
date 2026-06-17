@echo off
chcp 65001 >nul
title WeChat MiMoCode Bridge - Git Sync
cd /d "%~dp0"

echo ============================================
echo   Git 同步 - 提交并推送变更
echo ============================================
echo.

REM 检查是否有变更
git diff --quiet HEAD
if %errorlevel% equ 0 (
    git diff --cached --quiet
    if %errorlevel% equ 0 (
        echo [信息] 没有需要提交的变更
        echo.
        pause
        exit /b 0
    )
)

REM 显示变更概览
echo [1/4] 当前变更概览:
git status --short
echo.

REM 获取提交信息
set /p COMMIT_MSG=请输入提交信息（留空则自动生成）:

if "%COMMIT_MSG%"=="" (
    REM 自动生成提交信息
    for /f "tokens=2" %%i in ('git log --oneline -1 2^>nul') do set LAST_HASH=%%i
    for /f "delims=" %%i in ('git rev-parse --short HEAD 2^>nul') do set SHORT_HASH=%%i
    for /f "delims=" %%i in ('powershell -Command "Get-Date -Format yyyy-MM-dd HH:mm:ss"') do set TIMESTAMP=%%i
    set COMMIT_MSG=update at !TIMESTAMP!
)

echo.
echo [2/4] 暂存所有变更...
git add -A
if errorlevel 1 (
    echo [错误] git add 失败
    pause
    exit /b 1
)
echo [√] 已暂存
echo.

echo [3/4] 提交变更...
git commit -m "%COMMIT_MSG%"
if errorlevel 1 (
    echo [错误] git commit 失败
    pause
    exit /b 1
)
echo [√] 已提交: %COMMIT_MSG%
echo.

echo [4/4] 推送到远程仓库...
git push origin main
if errorlevel 1 (
    echo [警告] 推送失败，可能是网络问题或需要登录
    echo 可稍后手动执行: git push origin main
    pause
    exit /b 1
)
echo [√] 已推送到 https://github.com/ch613/WeChat-MiMoCode
echo.

echo ============================================
echo   同步完成！
echo ============================================
echo.
echo 最新提交:
git log --oneline -3
echo.
pause
