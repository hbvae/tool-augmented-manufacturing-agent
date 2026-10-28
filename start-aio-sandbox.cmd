@echo off
setlocal
where docker >nul 2>nul
if errorlevel 1 (
  echo Docker was not found. Install and start Docker Desktop first.
  exit /b 1
)
if "%AIO_SANDBOX_API_KEY%"=="" (
  echo AIO_SANDBOX_API_KEY is not set.
  echo Run: set AIO_SANDBOX_API_KEY=your-random-secret
  exit /b 1
)
docker compose -f "%~dp0aio-sandbox.compose.yml" up -d
if errorlevel 1 exit /b 1
echo AIO Sandbox is starting at http://127.0.0.1:8080
echo API docs: http://127.0.0.1:8080/v1/docs
echo If the image was just downloaded, wait until the sandbox health is healthy.
