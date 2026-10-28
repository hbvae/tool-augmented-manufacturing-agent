@echo off
setlocal
cd /d "%~dp0"
set PYTHONUTF8=1
set PYTHONIOENCODING=utf-8
if not exist ".venv-langchain\Scripts\python.exe" (
  echo LangChain environment was not found. Run install-langchain-agent.cmd first.
  exit /b 1
)
".venv-langchain\Scripts\python.exe" -m streamlit run langchain_agent\web.py --server.address 127.0.0.1 --server.port 8501 --server.headless true --browser.gatherUsageStats false
