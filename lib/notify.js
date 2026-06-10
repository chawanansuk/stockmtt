// แจ้งเตือนผ่าน LINE (Messaging API) — สรุปของใกล้หมดวันละครั้ง
// ตั้งค่า: LINE_CHANNEL_ACCESS_TOKEN + LINE_TO (userId/groupId) และ NOTIFY_HOUR (ชั่วโมงไทย, ค่าเริ่มต้น 8)
// การส่งถูกเช็คตอนมีคนเรียก /healthz หรือเปิดแอพ — ใช้คู่กับตัว ping (เช่น UptimeRobot) เพื่อให้ส่งตรงเวลา
import * as store from './store.js';

const TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || '';
const TO = process.env.LINE_TO || '';
const NOTIFY_HOUR = Math.min(23, Math.max(0, Number(process.env.NOTIFY_HOUR) || 8));

export const lineEnabled = () => !!(TOKEN && TO);

const isLow = (p) => {
  const s = Number(p.stock) || 0;
  const r = Number(p.reorderPoint) || 0;
  return (r > 0 && s <= r) || s < 0;
};

// เวลาไทย (UTC+7 คงที่ ไม่มี DST)
const bangkokNow = () => new Date(Date.now() + 7 * 3600e3);
const bangkokDate = () => bangkokNow().toISOString().slice(0, 10);

async function pushLine(text) {
  const res = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN },
    body: JSON.stringify({ to: TO, messages: [{ type: 'text', text: String(text).slice(0, 4900) }] }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error('LINE ตอบ ' + res.status + (body ? ': ' + body.slice(0, 200) : ''));
  }
}

// สร้างข้อความสรุปของใกล้หมด — คืน null ถ้าไม่มีอะไรต้องเตือน (ฟังก์ชัน pure เพื่อเทสต์ได้)
export function buildLowStockMessage(products, date = bangkokDate()) {
  const low = products.filter(isLow).sort((a, b) => (a.stock || 0) - (b.stock || 0));
  if (!low.length) return null;
  const MAX = 20;
  const lines = low.slice(0, MAX).map((p, i) => {
    const unit = p.unit ? ' ' + p.unit : '';
    const rp = p.reorderPoint > 0 ? ` (จุดสั่ง ${p.reorderPoint})` : '';
    return `${i + 1}. ${p.name} เหลือ ${p.stock}${unit}${rp}`;
  });
  if (low.length > MAX) lines.push(`…และอีก ${low.length - MAX} รายการ (ดูในเว็บ)`);
  return `📦 สต๊อก — ของใกล้หมด ${low.length} รายการ (${date})\n` + lines.join('\n');
}

// ส่งสรุปวันละครั้งหลังเวลาที่ตั้งไว้ (จองสิทธิ์ผ่าน kv ก่อนส่ง กันส่งซ้ำตอนมีหลายคำขอพร้อมกัน)
let busy = false;
export async function maybeDailyNotify() {
  if (!lineEnabled() || busy) return;
  busy = true;
  try {
    if (bangkokNow().getUTCHours() < NOTIFY_HOUR) return;
    const today = bangkokDate();
    if ((await store.getKV('lineDailyDate')) === today) return;
    await store.setKV('lineDailyDate', today);
    const msg = buildLowStockMessage(await store.getProducts(), today);
    if (msg) await pushLine(msg); // ไม่มีของใกล้หมด = ไม่ส่ง (ไม่สแปม)
  } catch (e) {
    console.error('LINE notify:', e.message);
  } finally {
    busy = false;
  }
}

// ปุ่มทดสอบจากหน้าเว็บ: ส่งทันที (ถ้าไม่มีของใกล้หมดก็ส่งบอกว่าปกติ เพื่อยืนยันว่าตั้งค่าถูก)
export async function sendTestNow() {
  if (!lineEnabled()) throw Object.assign(new Error('ยังไม่ได้ตั้งค่า LINE_CHANNEL_ACCESS_TOKEN / LINE_TO'), { expose: true, status: 400 });
  const msg = buildLowStockMessage(await store.getProducts()) || `📦 สต๊อก (${bangkokDate()})\nทุกรายการปกติ ✅ — นี่คือข้อความทดสอบ`;
  await pushLine(msg);
}
