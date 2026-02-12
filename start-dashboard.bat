@echo off
echo.
echo ╔════════════════════════════════════════════════════════════════╗
echo ║                                                                ║
echo ║     🚀 Starting AdHash Projects Status Dashboard...           ║
echo ║                                                                ║
echo ╚════════════════════════════════════════════════════════════════╝
echo.
echo Checking dependencies...
echo.

REM Check if node_modules exists
if not exist "node_modules\" (
    echo Installing dependencies...
    call npm install
    echo.
)

REM Check if Playwright browsers are installed
if not exist "%USERPROFILE%\AppData\Local\ms-playwright\chromium-1208\" (
    echo Installing Playwright browsers...
    call npx playwright install chromium
    echo.
)

echo.
echo ╔════════════════════════════════════════════════════════════════╗
echo ║                                                                ║
echo ║     ✅ Dashboard is starting...                                ║
echo ║                                                                ║
echo ║     📍 URL: http://localhost:5001                            ║
echo ║                                                                ║
echo ║     The browser will open automatically.                      ║
echo ║     If not, manually navigate to the URL above.               ║
echo ║                                                                ║
echo ║     Press Ctrl+C to stop the server.                          ║
echo ║                                                                ║
echo ╚════════════════════════════════════════════════════════════════╝
echo.

REM Start the server and open browser
start http://localhost:5001
node server.js

