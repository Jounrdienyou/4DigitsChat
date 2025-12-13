@echo off
echo Starting frontend with serve public...
start cmd /k "npx serve public"

echo Starting backend server...
cd server
echo Press Ctrl+C to stop the server gracefully
node server.js

echo.
echo Server stopped. Press any key to exit...
pause >nul