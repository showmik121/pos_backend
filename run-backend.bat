@echo off
rem লোকাল পিসিতে API চালায় (http://localhost:3001/api/health)। বন্ধ করতে Ctrl+C।
cd /d "%~dp0"
if not exist .env (
  echo STOP: .env ফাইল নেই। .env.example কপি করে মান বসান।
  pause
  exit /b 1
)
call npm install --no-audit --no-fund
call npm run dev
pause
