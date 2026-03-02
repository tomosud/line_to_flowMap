@echo off
chcp 65001 >nul
setlocal

REM ========================================
REM Line to Flow Map - Runner
REM ========================================

REM === Script directory ===
set SCRIPT_DIR=%~dp0
set SCRIPT_DIR=%SCRIPT_DIR:~0,-1%

REM === Virtual environment Python ===
set VENV_PYTHON=%SCRIPT_DIR%\venv\Scripts\python.exe

if not exist "%VENV_PYTHON%" (
    echo [ERROR] Virtual environment not found.
    echo [INFO] Please run setup.bat first.
    pause
    exit /b 1
)

REM === Check argument ===
if "%~1"=="" (
    echo [INFO] Usage: Drag and drop an image file onto this bat file.
    pause
    exit /b 0
)

REM === Run script for each dropped file ===
:loop
if "%~1"=="" goto end
echo [INFO] Processing: %~1
"%VENV_PYTHON%" "%SCRIPT_DIR%\line_to_flowmap.py" "%~1"
if errorlevel 1 (
    echo [ERROR] Failed to process: %~1
)
shift
goto loop

:end
echo.
echo [INFO] All files processed.
pause
endlocal
