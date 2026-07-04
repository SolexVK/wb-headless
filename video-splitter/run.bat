@echo off
REM Запуск приложения из исходников (нужен установленный Python 3.10+).
setlocal
cd /d "%~dp0"

REM Определяем, как запускать Python: сначала py launcher, затем python.
set "PYCMD="
py -3 --version >nul 2>nul && set "PYCMD=py -3"
if not defined PYCMD (
    python --version >nul 2>nul && set "PYCMD=python"
)
if not defined PYCMD (
    echo.
    echo [!] Python не найден.
    echo     Установите Python 3.10+ с https://www.python.org/downloads/
    echo     и при установке отметьте галочку "Add python.exe to PATH".
    echo.
    pause
    exit /b 1
)

echo Использую Python: %PYCMD%
echo Проверяю зависимости (при первом запуске может занять минуту)...
%PYCMD% -m pip install --disable-pip-version-check -q -r requirements.txt

echo Запуск приложения...
%PYCMD% main.py
set "RC=%ERRORLEVEL%"

if not "%RC%"=="0" (
    echo.
    echo [!] Программа завершилась с ошибкой (код %RC%).
    echo     Скопируйте текст выше и пришлите — помогу разобраться.
    echo.
    pause
)
endlocal
