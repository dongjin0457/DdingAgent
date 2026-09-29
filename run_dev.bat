@echo off
rem ==========================================================================
rem  DdingAgent - run in development mode (no build needed)
rem  - DTC_DEBUG=1 : DevTools (F12) window opens, verbose log
rem  - Edits in web\ are picked up on next launch (or reload with F5)
rem  - Python: %LOCALAPPDATA%\Programs\Python\Python311\python.exe, then the
rem    "py -3.11" launcher. Override with env var DTC_PYTHON.
rem  ASCII-only on purpose (cmd.exe safety). See README.md for details.
rem ==========================================================================
setlocal
set "ROOT=%~dp0"
set "PY=%LOCALAPPDATA%\Programs\Python\Python311\python.exe"
if defined DTC_PYTHON set "PY=%DTC_PYTHON%"
rem Fallback: if that path does not exist, ask the Python launcher (py -3.11)
if not defined DTC_PYTHON if not exist "%PY%" (
  for /f "usebackq delims=" %%P in (`py -3.11 -c "import sys; print(sys.executable)" 2^>nul`) do set "PY=%%P"
)
set "DTC_DEBUG=1"

if not exist "%PY%" (
  echo [ERROR] Python not found: "%PY%"
  echo         Install Python 3.11 or set DTC_PYTHON to python.exe path.
  pause
  exit /b 1
)

"%PY%" "%ROOT%main.py"
if errorlevel 1 pause
