@echo off
setlocal
rem ডাটাবেস স্কিমা Supabase এ প্রয়োগ করে (db/migrations/*.sql)। ডাবল-ক্লিক করুন।
rem .env এ DATABASE_URL_UNPOOLED (Session pooler, ইউজার postgres.<ref>) ও POS_APP_PASSWORD লাগবে।
cd /d "%~dp0"

if not exist .env (
  echo STOP: .env ফাইল নেই। .env.example কপি করে মান বসান।
  pause
  exit /b 1
)

call npm install --no-audit --no-fund
if errorlevel 1 goto fail

call npm run db:migrate
if errorlevel 1 goto fail

echo.
echo ডাটাবেস প্রস্তুত।
pause
exit /b 0

:fail
echo.
echo কিছু ব্যর্থ হয়েছে। উপরের বার্তা পড়ুন।
pause
exit /b 1
