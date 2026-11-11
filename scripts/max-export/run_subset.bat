@echo off
rem ============================================================================
rem  Aventurine "Waveflair" .max -> FBX  *SUBSET*  export (full scene, mesh kept)
rem  RUN THIS AFTER run_full.bat (optional but recommended).
rem  It exports ~14 key clips WITH the model mesh so the Mac side can compare the
rem  original character against official gameplay videos (A-grade skills + B idle/walk).
rem  Output: D:\sjxl\fbx-subset
rem ============================================================================
setlocal
chcp 65001 >nul
title Aventurine FBX export - SUBSET (mesh kept)

set "SRC=D:\sjxl\max"
set "OUT=D:\sjxl\fbx-subset"

if not "%~1"=="" set "SRC=%~1"

call :findmax
if not defined MAXEXE (
  echo [ERROR] 3dsmaxbatch.exe was not found in the usual Autodesk folders.
  echo         Open this .bat in Notepad and set MAXEXE to your install path.
  pause
  exit /b 1
)
echo Using Max batch: %MAXEXE%
echo Source folder  : %SRC%
echo Output folder  : %OUT%
echo.

if not exist "%SRC%" (
  echo [ERROR] Source folder not found: %SRC%
  pause
  exit /b 1
)
if not exist "%OUT%" mkdir "%OUT%"

"%MAXEXE%" "%~dp0export_max.ms" -mxsString mode:subset -mxsString dir:"%SRC%" -mxsString out:"%OUT%" -dm on -listenerlog "%OUT%\listener.log" -log "%OUT%\max.log"
set RC=%ERRORLEVEL%
echo.
echo Exit code: %RC%
if "%RC%"=="-8" echo [!] License error: open 3ds Max GUI, sign in to the 30-day trial, then run this again.
if "%RC%"=="-130" echo [!] Script error: send listener.log and max.log to the Mac side.
if "%RC%"=="-110" echo [!] 3ds Max process could not start: reboot and retry, or use the GUI fallback.
if "%RC%"=="-7" echo [!] Graphics device error: use the GUI fallback (Scripting ^> Run Script ^> export_max.ms).
echo Output folder: %OUT%
if exist "%OUT%" start "" "%OUT%"
echo.
echo Next step: zip the whole output folder and send it back to the Mac side.
pause
exit /b %RC%

:findmax
set "MAXEXE="
for %%V in (2027 2026 2025 2024) do (
  if not defined MAXEXE if exist "C:\Program Files\Autodesk\3ds Max %%V\3dsmaxbatch.exe" set "MAXEXE=C:\Program Files\Autodesk\3ds Max %%V\3dsmaxbatch.exe"
)
for %%V in (2027 2026 2025 2024) do (
  if not defined MAXEXE if exist "D:\Program Files\Autodesk\3ds Max %%V\3dsmaxbatch.exe" set "MAXEXE=D:\Program Files\Autodesk\3ds Max %%V\3dsmaxbatch.exe"
)
exit /b
