@echo off
echo Killing all Node.js processes...
taskkill /F /IM node.exe 2>nul
timeout /t 3 /nobreak >nul
echo.
echo Starting dashboard server on port 7777...
echo.
start "AdHash Dashboard Server" cmd /k "node server.js"
echo.
echo Server is starting in a new window...
echo Once you see the success message, open http://localhost:7777 in your browser
echo.

