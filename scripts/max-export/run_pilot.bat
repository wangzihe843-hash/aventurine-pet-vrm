@echo off
rem ============================================================================
rem  Aventurine "Waveflair" .max -> FBX  *PILOT*  export (6 files, both variants)
rem  Put this file next to export_max.ms. Double-click to run.
rem  Output: D:\sjxl\fbx-pilot
rem ============================================================================
setlocal
chcp 65001 >nul
title Aventurine FBX export - PILOT

set "SRC=D:\sjxl\max"
set "OUT=D:\sjxl\fbx-pilot"

rem Optional: drag the folder that contains the .max files onto this .bat
if not "%~1"=="" set "SRC=%~1"

call :findmax
if not defined MAXEXE (
  echo [ERROR] 3dsmaxbatch.exe was not found in the usual Autodesk folders.
  echo         Open this .bat in Notepad and set MAXEXE to your install path, e.g.
  echo         set "MAXEXE=C:\Program Files\Autodesk\3ds Max 2027\3dsmaxbatch.exe"
  pause
  exit /b 1
)
echo Using Max batch: %MAXEXE%
echo Source folder  : %SRC%
echo Output folder  : %OUT%
echo.

if not exist "%SRC%" (
  echo [ERROR] Source folder not found: %SRC%
  echo         Unzip the animation pack to D:\sjxl\max first ^(138 .max files^).
  pause
  exit /b 1
)
if not exist "%OUT%" mkdir "%OUT%"

"%MAXEXE%" "%~dp0export_max.ms" -mxsString mode:pilot -mxsString dir:"%SRC%" -mxsString out:"%OUT%" -dm on -listenerlog "%OUT%\listener.log" -log "%OUT%\max.log"
set RC=%ERRORLEVEL%
echo.
echo Exit code: %RC%
if "%RC%"=="-8" echo [!] License error: open 3ds Max GUI, sign in to the 30-day trial, then run this again.
if "%RC%"=="-130" echo [!] Script error: send listener.log and max.log to the Mac side.
if "%RC%"=="-110" echo [!] 3ds Max process could not start: reboot and retry, or use the GUI fallback.
if "%RC%"=="-7" echo [!] Graphics device error: use the GUI fallback (Scripting ^> Run Script ^> export_max.ms).
if "%RC%"=="-7" echo [!] Graphics device failed. Use the GUI fallback: Scripting ^> Run Script ^> export_max.ms
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
