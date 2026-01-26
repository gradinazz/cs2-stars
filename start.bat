@echo off
chcp 65001 > nul
color 0B
title CS2 Stars Manager

cls
echo ╔════════════════════════════════════════════════════════════════════════════╗
echo ║                       CS2 STARS MANAGER v1.1                               ║
echo ╚════════════════════════════════════════════════════════════════════════════╝
echo.

REM Проверка Node.js
node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [✗] Node.js не установлен!
    echo.
    echo Скачайте Node.js LTS: https://nodejs.org/
    echo.
    pause
    exit /b 1
)

echo [✓] Node.js обнаружен
node --version

REM Проверка зависимостей
if not exist "node_modules" (
    echo.
    echo [!] Первый запуск - установка зависимостей...
    echo     Это займёт ~30 секунд...
    echo.
    call npm install
    if %errorlevel% neq 0 (
        echo.
        echo [✗] Ошибка установки зависимостей
        pause
        exit /b 1
    )
    echo.
    echo [✓] Зависимости установлены успешно!
    timeout /t 2 /nobreak >nul
)

cls
node cs2-stars-cli.mjs

if %errorlevel% neq 0 (
    echo.
    echo [✗] Программа завершилась с ошибкой
    pause
)
