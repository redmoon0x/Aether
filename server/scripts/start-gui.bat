@echo off
cd /d "%~dp0.."
start "" powershell -ExecutionPolicy Bypass -File "%~dp0aether-gui.ps1"
