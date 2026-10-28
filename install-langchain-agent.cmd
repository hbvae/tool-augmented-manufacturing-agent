@echo off
setlocal
cd /d "%~dp0"
python -m venv .venv-langchain
if errorlevel 1 exit /b 1
".venv-langchain\Scripts\python.exe" -m pip install --upgrade pip
if errorlevel 1 exit /b 1
".venv-langchain\Scripts\python.exe" -m pip install -r requirements-langchain.txt
if errorlevel 1 exit /b 1
echo LangChain agent dependencies installed successfully.
