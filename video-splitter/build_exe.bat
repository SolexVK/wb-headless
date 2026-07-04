@echo off
REM Сборка автономного .exe для Windows 10 с помощью PyInstaller.
REM Результат: dist\VideoSplitter.exe (один файл, без окна консоли).
setlocal
cd /d "%~dp0"

REM Определяем, как запускать Python: сначала py launcher, затем python.
set "PYCMD="
py -3 --version >nul 2>nul && set "PYCMD=py -3"
if not defined PYCMD (
    python --version >nul 2>nul && set "PYCMD=python"
)
if not defined PYCMD (
    echo [!] Python не найден. Установите Python 3.10+ и добавьте в PATH.
    pause
    exit /b 1
)

%PYCMD% -m pip install --disable-pip-version-check -q -r requirements.txt pyinstaller

REM --onefile   — один exe-файл
REM --windowed  — без чёрного окна консоли (GUI-приложение)
REM ffmpeg НЕ включается в exe: положите ffmpeg\bin\ffmpeg.exe рядом с exe
REM   или установите ffmpeg в системный PATH.
%PYCMD% -m PyInstaller --noconfirm --clean --onefile --windowed ^
    --name VideoSplitter ^
    main.py

echo.
echo Готово. Файл: dist\VideoSplitter.exe
echo Не забудьте положить ffmpeg рядом (папка ffmpeg\bin) или в PATH.
pause
endlocal
