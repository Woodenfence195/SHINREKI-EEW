@echo off
setlocal
cd /d "%~dp0"
set PYTHONIOENCODING=utf-8

where python >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Python 3.9+ was not found in PATH.
  echo   Install it from https://www.python.org/downloads/ and tick "Add python.exe to PATH".
  echo.
  pause
  exit /b 1
)

python -c "import PIL, numpy" >nul 2>nul
if errorlevel 1 (
  echo   Installing dependencies ^(Pillow, numpy^)...
  python -m pip install -r requirements.txt
)

python -m app --app-window %*
