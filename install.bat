@echo off
chcp 65001 >nul
title WeChat MiMoCode Bridge - Installer
cd /d "%~dp0"

echo ============================================
echo   WeChat MiMoCode Bridge - 安装程序
echo ============================================
echo.

REM 检查 Node.js
where node >nul 2>&1
if errorlevel 1 (
    echo [错误] 未检测到 Node.js，请先安装 Node.js ^>= 18
    echo 下载地址: https://nodejs.org/
    pause
    exit /b 1
)

for /f "tokens=*" %%i in ('node -v') do set NODE_VER=%%i
echo [√] Node.js 版本: %NODE_VER%

REM 检查 npm
where npm >nul 2>&1
if errorlevel 1 (
    echo [错误] 未检测到 npm，请检查 Node.js 安装
    pause
    exit /b 1
)
echo [√] npm 已就绪
echo.

REM 检查 MiMoCode CLI
where mimo >nul 2>&1
if errorlevel 1 (
    echo [警告] 未检测到 mimo 命令，请确保已安装 MiMoCode CLI
    echo 仓库地址: https://github.com/XiaomiMiMo/MiMo-Code
    echo 安装后请完成认证再运行本桥接
    echo.
    choice /c YN /m "是否继续安装本桥接程序"
    if errorlevel 2 exit /b 0
) else (
    echo [√] MiMoCode CLI 已安装
)
echo.

echo [1/4] 安装项目依赖...
call npm install
if errorlevel 1 (
    echo [错误] 依赖安装失败
    pause
    exit /b 1
)
echo.

echo [2/4] 编译 TypeScript...
call npm run build
if errorlevel 1 (
    echo [错误] 编译失败
    pause
    exit /b 1
)
echo.

echo [3/4] 全局安装命令行工具...
call npm install -g .
if errorlevel 1 (
    echo [警告] 全局安装失败，可改用 npm start 方式运行
) else (
    echo [√] wechat-mimocode 命令已全局可用
)
echo.

echo [4/4] 验证安装...
call wechat-mimocode --version
if errorlevel 1 (
    echo [警告] 全局命令验证失败，请检查 PATH 配置
    echo 也可直接使用: npm start
) else (
    echo [√] 安装验证通过
)
echo.

echo ============================================
echo   安装完成！
echo ============================================
echo.
echo 下一步操作：
echo   1. 扫码绑定:  wechat-mimocode setup
echo   2. 启动服务:  wechat-mimocode daemon start
echo   3. 开始聊天:  在微信中给新好友发消息
echo.
echo 管理服务：
echo   查看状态:  wechat-mimocode daemon status
echo   停止服务:  wechat-mimocode daemon stop
echo   查看日志:  wechat-mimocode daemon logs
echo.
pause
