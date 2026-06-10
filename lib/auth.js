// ระบบยืนยันตัวตนแบบ "รหัสผ่านร่วมตัวเดียว" + session cookie ที่เซ็นด้วย HMAC
// - ตั้งรหัสผ่านผ่าน env: APP_PASSWORD (ถ้าไม่ตั้ง = ปิดระบบล็อกอิน, เปิดสาธารณะ + เตือน)
// - คีย์เซ็น cookie: ใช้ SESSION_SECRET ถ้ามี ไม่งั้น derive จากรหัสผ่าน (ไม่ต้องตั้งเพิ่ม)
// - ไม่เก็บ session ฝั่ง server (stateless) จึงใช้ได้ทั้งโหมดไฟล์ JSON และ Postgres
import crypto from 'node:crypto';

export const COOKIE_NAME = 'stockmtt_sess';
export const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 วัน

const PASSWORD = process.env.APP_PASSWORD || '';
export const authEnabled = () => PASSWORD.length > 0;

function key() {
  const base = process.env.SESSION_SECRET || 'derive:' + PASSWORD;
  return crypto.createHash('sha256').update(base).digest();
}

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const fromB64u = (s) => Buffer.from(s, 'base64url');

export function signToken(maxAgeMs = MAX_AGE_MS) {
  const payload = b64u(JSON.stringify({ exp: Date.now() + maxAgeMs }));
  const sig = b64u(crypto.createHmac('sha256', key()).update(payload).digest());
  return payload + '.' + sig;
}

export function verifyToken(token) {
  if (!token || typeof token !== 'string') return false;
  const dot = token.indexOf('.');
  if (dot < 0) return false;
  const payload = token.slice(0, dot);
  const sig = fromB64u(token.slice(dot + 1));
  const expected = crypto.createHmac('sha256', key()).update(payload).digest();
  if (sig.length !== expected.length || !crypto.timingSafeEqual(sig, expected)) return false;
  try {
    const { exp } = JSON.parse(fromB64u(payload).toString());
    return typeof exp === 'number' && exp > Date.now();
  } catch {
    return false;
  }
}

// เทียบรหัสผ่านแบบ timing-safe (เทียบ hash ความยาวเท่ากันเสมอ)
export function checkPassword(input) {
  if (!authEnabled()) return false;
  const ha = crypto.createHash('sha256').update(String(input ?? '')).digest();
  const hb = crypto.createHash('sha256').update(PASSWORD).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// PIN เจ้าของ (ไม่บังคับ): ตั้ง APP_ADMIN_PIN เพื่อล็อกการกระทำสำคัญ
// (แก้/ลบสินค้า, ยกเลิกรายการ, ปรับยอด/นับสต๊อก) — พนักงานยังตัด/รับของได้ตามปกติ
const ADMIN_PIN = process.env.APP_ADMIN_PIN || '';
export const adminPinEnabled = () => ADMIN_PIN.length > 0;
export function checkAdminPin(input) {
  if (!adminPinEnabled()) return true;
  const ha = crypto.createHash('sha256').update(String(input ?? '')).digest();
  const hb = crypto.createHash('sha256').update(ADMIN_PIN).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// อ่าน cookie ค่าเดียวจาก header เอง (ไม่ต้องพึ่ง cookie-parser)
export function readCookie(req, name) {
  const raw = req.headers.cookie;
  if (!raw) return '';
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return '';
}
