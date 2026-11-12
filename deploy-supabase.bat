@echo off
setlocal
rem API কে Supabase Edge Functions এ লাইভ করে। ডাবল-ক্লিক করুন।
cd /d "%~dp0"

if not exist .env (
  echo STOP: এই ফোল্ডারে .env ফাইল নেই। .env.example কপি করে .env বানান এবং মান বসান।
  pause
  exit /b 1
)

rem Project ID supabase-project-id.txt এ থাকে (গোপন নয়)।
set PROJECT_REF=
if exist supabase-project-id.txt set /p PROJECT_REF=<supabase-project-id.txt
if "%PROJECT_REF%"=="REPLACE_WITH_SUPABASE_PROJECT_REF" set PROJECT_REF=
if "%PROJECT_REF%"=="" (
  echo Supabase Dashboard -^> আপনার project -^> Project Settings -^> General -^> "Project ID"
  set /p PROJECT_REF=এখানে Project ID পেস্ট করুন: 
)
if "%PROJECT_REF%"=="" (
  echo কোনো Project ID দেওয়া হয়নি।
  pause
  exit /b 1
)
> supabase-project-id.txt echo %PROJECT_REF%

echo.
echo [1/5] প্যাকেজ ইনস্টল হচ্ছে...
call npm install --no-audit --no-fund
if errorlevel 1 goto fail

echo.
echo [2/5] Supabase এর জন্য API বিল্ড হচ্ছে...
call node edge/build.mjs
if errorlevel 1 goto fail

echo.
echo [3/5] Supabase এ লগইন। বললে Enter চাপুন, তারপর ব্রাউজারে Authorize করুন...
call npx --yes supabase projects list >nul 2>nul
if errorlevel 1 (
  call npx --yes supabase login
  if errorlevel 1 goto fail
) else (
  echo আগেই লগইন করা আছে।
)

echo.
echo [4/5] .env এর গোপন মান Supabase এ বসানো হচ্ছে (মান দেখানো হয় না)...
rem DATABASE_URL_UNPOOLED ও POS_APP_PASSWORD শুধু মাইগ্রেশনের জন্য; Edge এ লাগে না, তাই আলাদা ফাইলে ছেঁকে নেওয়া হয়।
findstr /b /v /c:"DATABASE_URL_UNPOOLED=" /c:"POS_APP_PASSWORD=" /c:"#" .env > .env.edge.tmp
call npx --yes supabase secrets set --env-file .env.edge.tmp --project-ref %PROJECT_REF%
set SECRETS_ERR=%errorlevel%
del .env.edge.tmp
if not "%SECRETS_ERR%"=="0" goto fail
call npx --yes supabase secrets set NODE_ENV=production --project-ref %PROJECT_REF%
if errorlevel 1 goto fail

echo.
echo [5/5] "api" ফাংশন ডিপ্লয় হচ্ছে...
call npx --yes supabase functions deploy api --project-ref %PROJECT_REF% --no-verify-jwt --use-api
if errorlevel 1 goto fail

set API_URL=https://%PROJECT_REF%.supabase.co/functions/v1/api
echo.
echo পরীক্ষা: %API_URL%/health
curl -s %API_URL%/health
echo.
echo.
echo হয়ে গেছে। ব্যাকএন্ড লাইভ: %API_URL%
echo ফ্রন্টএন্ডের NEXT_PUBLIC_API_URL এ এটি বসান।
pause
exit /b 0

:fail
echo.
echo উপরে কিছু ব্যর্থ হয়েছে। লাল বার্তা পড়ুন, ঠিক করুন, তারপর আবার চালান।
pause
exit /b 1
