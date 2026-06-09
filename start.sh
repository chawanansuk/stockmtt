#!/usr/bin/env bash
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo
  echo "  ไม่พบ Node.js — กรุณาติดตั้งก่อนที่  https://nodejs.org"
  echo
  exit 1
fi

[ -d node_modules ] || npm install

echo
echo "  กำลังเปิดเว็บ... เปิดลิงก์ที่ขึ้นด้านล่าง หรือสแกน QR บนมือถือ"
echo "  (ปิดเว็บ: กด Ctrl+C)"
echo
npm start
