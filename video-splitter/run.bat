@echo off
REM Запуск приложения из исходников (нужен установленный Python 3.10+).
setlocal
cd /d "%~dp0"

where python >nul 2>nul
if errorlevel 1 (
    echo Python не найден. Установите Python 3.10+ с https://www.python.org/downloads/
    echo и отметьте галочку "Add Python to PATH".
    pause
    exit /b 1
)

REM Ставим зависимости при первом запуске (тихо).
python -m pip install --disable-pip-version-check -q -r requirements.txt

python main.py
if errorlevel 1 pause
endlocal
