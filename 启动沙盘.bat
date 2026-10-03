@echo off
cd /d "%~dp0"

set "URL=http://localhost:8788/index.html"

rem 1) Node.js must be available
where node >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js not found. Please install Node.js first.
    pause
    exit /b 1
)

rem 2) Start local server if not already running (minimized window)
curl -s --max-time 2 "%URL%" >nul 2>&1
if errorlevel 1 (
    start "sandbox-server" /min node serve.mjs
    ping -n 3 127.0.0.1 >nul
)

rem 3) Open fullscreen in Edge / Chrome (auto-detect)
set "BROWSER="
if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" set "BROWSER=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not defined BROWSER if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" set "BROWSER=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if not defined BROWSER if exist "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" set "BROWSER=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"
if not defined BROWSER if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "BROWSER=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not defined BROWSER if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "BROWSER=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"

if defined BROWSER (
    start "" "%BROWSER%" --new-window --start-fullscreen "%URL%"
) else (
    start "" "%URL%"
)

exit /b
