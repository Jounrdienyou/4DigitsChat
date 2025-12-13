@echo off 
node server.js 
if errorlevel 1 ( 
    echo. 
    echo Server encountered an error! 
    pause 
    exit /b 1 
) 
