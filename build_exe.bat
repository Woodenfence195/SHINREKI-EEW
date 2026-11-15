@echo off
setlocal
cd /d "%~dp0"
set PYTHONIOENCODING=utf-8

echo [1/3] checking PyInstaller...
python -c "import PyInstaller" >nul 2>nul
if errorlevel 1 (
  python -m pip install pyinstaller
)

echo [2/3] cleaning old build...
if exist build rmdir /s /q build
if exist dist rmdir /s /q dist

echo [3/3] building dist\Shinreki.exe ...
python -m PyInstaller --noconfirm --clean --onefile --name Shinreki ^
  --add-data "web;web" ^
  --add-data "app\assets;app\assets" ^
  --hidden-import PIL._imaging ^
  --collect-submodules app ^
  shinreki.py

if errorlevel 1 (
  echo BUILD FAILED
  pause
  exit /b 1
)
echo.
echo Done: dist\Shinreki.exe
pause
