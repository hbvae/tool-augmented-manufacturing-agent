@echo off
setlocal
cd /d "%~dp0"
set PYTHONUTF8=1
set PYTHONIOENCODING=utf-8
if not exist ".venv-langchain\Scripts\python.exe" (
  echo LangChain environment was not found. Run install-langchain-agent.cmd first.
  exit /b 1
)
".venv-langchain\Scripts\python.exe" -m pytest -q -p no:cacheprovider --basetemp "experiments\pytest-temp-%RANDOM%-%RANDOM%" test\test_langchain_agent.py test\test_comparison_experiment.py
if errorlevel 1 exit /b 1
call run-langchain-agent.cmd --smoke-test
