@echo off
rem ==========================================================================
rem  DdingTycoonCalc - exe build script (double-click to run)
rem  Output: dist\DdingTycoonCalc.exe  (single file, no console window)
rem
rem  NOTE: this file is intentionally ASCII-only so cmd.exe parses it safely.
rem        Korean explanation is in README.md (build-from-source section).
rem
rem  Settings you may change:
rem    PY        - Python 3.11 interpreter that has PyInstaller + pywebview
rem                + numpy + pillow + winrt OCR packages.
rem                Default: %LOCALAPPDATA%\Programs\Python\Python311\python.exe
rem                (standard per-user install), then the "py -3.11" launcher.
rem                Override with env var DTC_PYTHON (full path to python.exe).
rem    WORK      - temp folder for PyInstaller work files (kept outside the
rem                project folder to avoid cloud-sync / file-lock problems)
rem    WEBSRC    - web app folder to bundle (override with env var
rem                DTC_BUILD_WEB_DIR to bundle a different web folder)
rem    DTC_NO_PAUSE=1 - do not wait for a key press at the end (for scripts)
rem    DTC_SELFTEST_PNG=path.png - after the build, run the new exe with
rem                --selftest on this tooltip image (PNG) and check that
rem                recognition (Windows OCR + digit templates) works inside
rem                the exe. Result JSON: dist\selftest_result.json
rem ==========================================================================
setlocal

rem Project folder = folder of this .bat (ends with a backslash)
set "ROOT=%~dp0"

rem Python interpreter (Python 3.11 with PyInstaller 6 / pywebview 6)
set "PY=%LOCALAPPDATA%\Programs\Python\Python311\python.exe"
if defined DTC_PYTHON set "PY=%DTC_PYTHON%"
rem Fallback: if that path does not exist, ask the Python launcher (py -3.11)
if not defined DTC_PYTHON if not exist "%PY%" (
  for /f "usebackq delims=" %%P in (`py -3.11 -c "import sys; print(sys.executable)" 2^>nul`) do set "PY=%%P"
)

rem PyInstaller work/spec folder (outside the project folder)
set "WORK=%TEMP%\DdingTycoonCalc_build"

rem Web app folder to bundle
set "WEBSRC=%ROOT%web"
if defined DTC_BUILD_WEB_DIR set "WEBSRC=%DTC_BUILD_WEB_DIR%"

if not exist "%PY%" (
  echo [ERROR] Python not found: "%PY%"
  echo         Install Python 3.11 or set DTC_PYTHON to python.exe path.
  goto :fail
)
if not exist "%WEBSRC%\index.html" (
  echo [ERROR] index.html not found in web folder: "%WEBSRC%"
  goto :fail
)
if not exist "%ROOT%recognizer\digit_templates.json" (
  echo [ERROR] recognizer\digit_templates.json not found.
  echo         It is part of the source code. Restore it from the original source.
  goto :fail
)

rem Check that the screen-recognition packages are installed
"%PY%" -c "import numpy, PIL, winrt.windows.media.ocr, winrt.windows.graphics.imaging, winrt.windows.storage.streams, winrt.windows.globalization, winrt.windows.foundation" 1>nul 2>nul
if errorlevel 1 (
  echo [ERROR] numpy / pillow / winrt OCR packages are missing in "%PY%"
  echo         pip install numpy pillow winrt-runtime winrt-Windows.Media.Ocr
  echo             winrt-Windows.Graphics.Imaging winrt-Windows.Storage.Streams
  echo             winrt-Windows.Globalization winrt-Windows.Foundation
  echo             winrt-Windows.Foundation.Collections
  goto :fail
)

rem Create the icon if it does not exist yet
if not exist "%ROOT%assets\icon.ico" (
  echo Generating icon...
  "%PY%" "%ROOT%tools\make_icon.py"
  if errorlevel 1 goto :fail
)

echo.
echo Building DdingTycoonCalc.exe ...
echo.

rem --collect-submodules/--collect-binaries winrt : the winrt projection
rem   modules are thin wrappers around _winrt_*.pyd files (+ msvcp140.dll);
rem   collect all of them so Windows OCR works inside the exe.
rem --hidden-import recognizer.* : modules imported lazily at run time.
rem --exclude-module : packages this app does not use (keeps them out of the exe).
"%PY%" -m PyInstaller --noconfirm --clean ^
  --onefile --windowed ^
  --name DdingTycoonCalc ^
  --icon "%ROOT%assets\icon.ico" ^
  --version-file "%ROOT%version_info.txt" ^
  --paths "%ROOT%." ^
  --add-data "%WEBSRC%;web" ^
  --add-data "%ROOT%assets\icon.ico;assets" ^
  --add-data "%ROOT%recognizer\digit_templates.json;recognizer" ^
  --collect-submodules winrt ^
  --collect-binaries winrt ^
  --hidden-import recognizer ^
  --hidden-import recognizer.engine ^
  --hidden-import recognizer.ocr ^
  --hidden-import recognizer.selftest ^
  --hidden-import recognizer.win32 ^
  --exclude-module tkinter ^
  --exclude-module matplotlib ^
  --exclude-module scipy ^
  --exclude-module pandas ^
  --exclude-module mss ^
  --exclude-module keyboard ^
  --workpath "%WORK%\work" ^
  --specpath "%WORK%\spec" ^
  --distpath "%ROOT%dist" ^
  "%ROOT%main.py"
if errorlevel 1 goto :fail

echo.
echo [OK] Build finished: dist\DdingTycoonCalc.exe

if not defined DTC_SELFTEST_PNG goto :done
echo.
echo Running self-test inside the exe: "%DTC_SELFTEST_PNG%"
if exist "%ROOT%dist\selftest_result.json" del "%ROOT%dist\selftest_result.json"
rem start /wait: the exe is a GUI (windowed) program, so wait for it explicitly
start "" /wait "%ROOT%dist\DdingTycoonCalc.exe" --selftest "%DTC_SELFTEST_PNG%" --out "%ROOT%dist\selftest_result.json"
if errorlevel 1 (
  echo [FAILED] Self-test did not recognize the tooltip. See dist\selftest_result.json
  goto :fail
)
echo [OK] Self-test passed. Result: dist\selftest_result.json

:done
if not defined DTC_NO_PAUSE pause
exit /b 0

:fail
echo.
echo [FAILED] Build did not complete. See messages above.
if not defined DTC_NO_PAUSE pause
exit /b 1
