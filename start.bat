@echo off
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  ไม่พบ Node.js — กรุณาติดตั้งก่อนที่  https://nodejs.org
  echo  ติดตั้งเสร็จแล้วเปิดไฟล์นี้อีกครั้ง
  echo.
  pause
  exit /b
)

if not exist node_modules (
  echo  กำลังติดตั้งครั้งแรก... รอสักครู่
  call npm install
)

echo.
echo  กำลังเปิดเว็บ... เปิดลิงก์ที่ขึ้นด้านล่าง หรือสแกน QR บนมือถือ
echo  (ปิดเว็บ: กด Ctrl+C หรือปิดหน้าต่างนี้)
echo.
call npm start
pause
