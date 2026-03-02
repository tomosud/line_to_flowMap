@echo off
chcp 65001 >nul
setlocal

REM ========================================
REM Line to Flow Map - Virtual Environment Setup
REM ========================================

echo [INFO] Line to Flow Map - virtual environment setup...

REM === Script directory ===
set SCRIPT_DIR=%~dp0
set SCRIPT_DIR=%SCRIPT_DIR:~0,-1%
pushd "%SCRIPT_DIR%"

REM === Avoid inherited Python environment pollution ===
set PYTHONHOME=
set PYTHONPATH=

REM === Virtual environment directory ===
set VENV_DIR=%SCRIPT_DIR%\venv

REM === Python executable (try relative path first, then system) ===
set PY_EXE=%SCRIPT_DIR%\..\Python\env\Python311.4\python.exe

REM === Check Python executable ===
if not exist "%PY_EXE%" (
    echo [WARN] Specific Python not found: %PY_EXE%
    echo [INFO] Trying to use system Python...

    where python >nul 2>nul
    if errorlevel 1 (
        echo [ERROR] No Python found in system PATH either
        echo [INFO] Please install Python or check the path in this script
        popd
        pause
        exit /b 1
    )

    set PY_EXE=python
    echo [INFO] Using system Python from PATH
)

REM === Create virtual environment ===
echo [INFO] Creating virtual environment... (%VENV_DIR%)
"%PY_EXE%" -m venv --clear "%VENV_DIR%"
if errorlevel 1 (
    echo [ERROR] Failed to create virtual environment.
    popd
    pause
    exit /b 1
)

REM === Virtual environment Python / pip path ===
set VENV_PYTHON=%VENV_DIR%\Scripts\python.exe
set PIP_EXE=%VENV_DIR%\Scripts\pip.exe
set USE_PIP_EXE=0

REM === Ensure pip in venv ===
echo [INFO] Bootstrapping pip (ensurepip)...
"%VENV_PYTHON%" -m ensurepip --upgrade --default-pip
if errorlevel 1 (
    echo [WARN] ensurepip failed, continuing with existing pip.
)

REM === Decide pip invocation method ===
"%VENV_PYTHON%" -m pip --version >nul 2>nul
if errorlevel 1 (
    if exist "%PIP_EXE%" (
        echo [WARN] python -m pip is unavailable. Falling back to pip.exe.
        set USE_PIP_EXE=1
    ) else (
        echo [ERROR] pip is not available in the virtual environment.
        popd
        pause
        exit /b 1
    )
)

REM === Upgrade pip ===
echo [INFO] Upgrading pip...
if "%USE_PIP_EXE%"=="1" (
    "%PIP_EXE%" install --upgrade pip
) else (
    "%VENV_PYTHON%" -m pip install --upgrade pip
)
if errorlevel 1 (
    echo [WARN] Failed to upgrade pip, but continuing.
)

REM === Install required libraries ===
echo [INFO] Installing required libraries...
if "%USE_PIP_EXE%"=="1" (
    "%PIP_EXE%" install -r "%SCRIPT_DIR%\requirements.txt"
) else (
    "%VENV_PYTHON%" -m pip install -r "%SCRIPT_DIR%\requirements.txt"
)
if errorlevel 1 (
    echo [ERROR] Failed to install libraries.
    popd
    pause
    exit /b 1
)

echo.
echo [SUCCESS] Setup completed!
echo [INFO] Virtual environment: %VENV_DIR%
echo [INFO] Usage: Drag image file onto run.bat
echo.
pause
popd
endlocal
