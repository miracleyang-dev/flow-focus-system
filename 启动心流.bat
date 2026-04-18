@echo off
chcp 65001 >nul
title 心流 · 个人效率系统
echo =======================================
echo   心流系统启动中...
echo   请不要关闭此窗口！关闭运行窗口将停止服务。
echo =======================================
start http://localhost:3000
node server.js
pause