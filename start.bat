@echo off
chcp 65001 >nul
title WeChat MiMoCode Bridge
cd /d "F:\program\wechat-mimocode"
echo Starting WeChat MiMoCode Bridge...
node dist\main.js start
pause
