import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import * as store from './lib/store.js';
import { extractFromImage } from './lib/claude.js';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { authEnabled, signToken, verifyToken, checkPassword, readCookie, COOKIE_NAME, MAX_AGE_MS } from './lib/auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // อยู่หลัง proxy ของ Render/Cloudflare → req.ip / req.secure ถูกต้อง

// security headers (helmet) + CSP ที่พอดีกับแอพนี้
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'blob:'], // พรีวิวรูปเป็น dataURL
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'self'"],
        formAction: ["'self'"],
        upgradeInsecureRequests: null, // อย่าบังคับ https บน localhost
      },
    },
  })
);

app.use(express.json({ limit: '8mb' })); // รูปย่อฝั่งเครื่องแล้วเล็กกว่านี้มาก — กันยิงข้อมูลใหญ่

// เสิร์ฟ manifest ด้วย content-type ที่ถูกต้อง ก่อนไฟล์ static อื่น ๆ
app.get('/manifest.webmanifest', (req, res) =>
  res.type('application/manifest+json').sendFile(path.join(__dirname, 'public', 'manifest.webmanifest'))
);
app.use(express.static(path.join(__dirname, 'public')));

// health check (ไม่ต้องล็อกอิน) — ใช้สำหรับ keep-alive / ปลุกเซิร์ฟเวอร์จากพักหลับ
app.get('/healthz', (req, res) => res.json({ ok: true, ts: Date.now() }));

// ---------- rate limiting ----------
const limiterMsg = (msg) => ({ error: msg });
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false,
  message: limiterMsg('พยายามเข้าสู่ระบบบ่อยเกินไป ลองใหม่อีกครั้งใน 15 นาที'),
});
const extractLimiter = rateLimit({
  windowMs: 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false,
  message: limiterMsg('เรียกใช้ AI ถี่เกินไป พักสักครู่แล้วลองใหม่'),
});
const writeLimiter = rateLimit({
  windowMs: 60 * 1000, max: 90, standardHeaders: true, legacyHeaders: false,
  message: limiterMsg('ทำรายการถี่เกินไป พักสักครู่แล้วลองใหม่'),
});

// ---------- ยืนยันตัวตน (รหัสผ่านร่วมตัวเดียว) ----------
const cookieOpts = (req) => ({ httpOnly: true, sameSite: 'lax', secure: !!req.secure, maxAge: MAX_AGE_MS, path: '/' });

app.post('/api/login', loginLimiter, (req, res) => {
  if (!authEnabled()) return res.json({ ok: true, authEnabled: false });
  if (!checkPassword((req.body || {}).password)) return res.status(401).json({ error: 'รหัสผ่านไม่ถูกต้อง' });
  res.cookie(COOKIE_NAME, signToken(), cookieOpts(req));
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME, { path: '/' });
  res.json({ ok: true });
});

app.get('/api/session', (req, res) => {
  res.json({ authEnabled: authEnabled(), authed: !authEnabled() || verifyToken(readCookie(req, COOKIE_NAME)) });
});

// ด่านตรวจ: ทุก /api/* ใต้บรรทัดนี้ต้องล็อกอินก่อน (ถ้าตั้ง APP_PASSWORD ไว้)
app.use('/api', (req, res, next) => {
  if (!authEnabled()) return next(); // ยังไม่ตั้งรหัสผ่าน = ใช้ได้เลย (มี warning ที่ UI + log)
  if (verifyToken(readCookie(req, COOKIE_NAME))) return next();
  res.status(401).json({ error: 'กรุณาเข้าสู่ระบบก่อนใช้งาน', code: 'AUTH' });
});

// ตัวช่วยจับ error ใน async route
// - AppError (err.expose) → แสดงข้อความที่ตั้งใจให้ผู้ใช้เห็น
// - error อื่น → log ไว้ฝั่งเซิร์ฟเวอร์ แล้วส่งข้อความกลาง ๆ (ไม่เผยรายละเอียดภายใน)
const wrap = (fn) => (req, res) => fn(req, res).catch((err) => {
  if (err?.expose) return res.status(err.status || 400).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: 'เกิดข้อผิดพลาดในระบบ ลองใหม่อีกครั้ง' });
});

// ---------- ตรวจความถูกต้องของข้อมูล ----------
const MAX_QTY = 1_000_000;
const MAX_ITEMS = 500;
function validProductFields(body) {
  if (body.name !== undefined && String(body.name).length > 200) return 'ชื่อสินค้ายาวเกินไป';
  if (body.category !== undefined && String(body.category).length > 100) return 'ชื่อหมวดยาวเกินไป';
  for (const f of ['stock', 'reorderPoint']) {
    const v = body[f];
    if (v !== undefined && v !== '' && v !== null) {
      const n = Number(v);
      if (!Number.isFinite(n) || Math.abs(n) > 1e9) return 'ค่าตัวเลขไม่ถูกต้อง';
    }
  }
  return null;
}

// รายการสินค้าทั้งหมด
app.get('/api/products', wrap(async (req, res) => {
  res.json(await store.getProducts());
}));

// เพิ่มสินค้าใหม่
app.post('/api/products', writeLimiter, wrap(async (req, res) => {
  const body = req.body || {};
  const { name, category, stock, reorderPoint } = body;
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'ต้องระบุชื่อสินค้า' });
  const verr = validProductFields(body);
  if (verr) return res.status(400).json({ error: verr });
  res.json(await store.addProduct({ name, category, stock, reorderPoint }));
}));

// แก้ไขสินค้า (ยอดคงเหลือ / จุดสั่งซื้อ / ชื่อ / หมวด)
app.post('/api/products/:id', writeLimiter, wrap(async (req, res) => {
  const body = req.body || {};
  const verr = validProductFields(body);
  if (verr) return res.status(400).json({ error: verr });
  const actor = (body.actor || '').toString().slice(0, 60); // ใครแก้ยอด (ลงประวัติปรับยอด)
  const p = await store.updateProduct(req.params.id, body, actor);
  if (!p) return res.status(404).json({ error: 'ไม่พบสินค้า' });
  res.json(p);
}));

// ลบสินค้า
app.delete('/api/products/:id', writeLimiter, wrap(async (req, res) => {
  const ok = await store.deleteProduct(req.params.id);
  if (!ok) return res.status(404).json({ error: 'ไม่พบสินค้า' });
  res.json({ ok: true });
}));

// อ่านรูปด้วย AI (ยังไม่บันทึก — แค่คืนรายการให้ตรวจ)
app.post('/api/extract', extractLimiter, wrap(async (req, res) => {
  const { image, mode } = req.body || {};
  if (!image) return res.status(400).json({ error: 'ไม่มีรูปภาพ' });
  const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]*)$/.exec(image);
  if (!m) return res.status(400).json({ error: 'รูปภาพไม่ถูกต้อง' });

  const data = await extractFromImage({
    mediaType: m[1],
    base64: m[2],
    mode: mode === 'receive' ? 'receive' : 'deduct',
  });

  // ดึงสินค้าทั้งหมดครั้งเดียวแล้วจับคู่ด้วย Map (กัน N+1 query)
  const products = await store.getProducts();
  const byId = new Map(products.map((p) => [p.id, p]));
  const items = [];
  for (const it of data.items || []) {
    const p = it.productId ? byId.get(Number(it.productId)) : null;
    items.push({
      rawText: it.rawText || '',
      quantity: Number(it.quantity) || 1,
      productId: p ? p.id : 0,
      productName: p ? p.name : it.productName || '',
      category: p ? p.category : '',
      currentStock: p ? p.stock : null,
      confidence: it.confidence || 'low',
    });
  }
  res.json({ date: data.date || '', items });
}));

// ยืนยันบันทึก (ตัดออก หรือ รับเข้า)
app.post('/api/commit', writeLimiter, wrap(async (req, res) => {
  const { items, note, date, type, actor } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'ไม่มีรายการ' });
  if (items.length > MAX_ITEMS) return res.status(400).json({ error: 'รายการมากเกินไป' });
  for (const it of items) {
    const q = Number(it?.quantity);
    if (!Number.isFinite(q) || q <= 0 || q > MAX_QTY) return res.status(400).json({ error: 'จำนวนไม่ถูกต้อง' });
    const pid = Number(it?.productId);
    if (!Number.isInteger(pid) || pid <= 0) return res.status(400).json({ error: 'รหัสสินค้าไม่ถูกต้อง' });
  }
  const tx = await store.commit({
    items,
    note: (note || '').toString().slice(0, 500),
    date: (date || '').toString().slice(0, 50),
    type: type === 'receive' ? 'receive' : 'deduct',
    actor: (actor || '').toString().slice(0, 60),
  });
  if (!tx) return res.status(400).json({ error: 'ไม่มีรายการที่บันทึกได้' });
  res.json({ transaction: tx, products: await store.getProducts() });
}));

// ยกเลิกรายการ (คืนสต๊อก)
app.post('/api/transactions/:id/void', writeLimiter, wrap(async (req, res) => {
  const by = ((req.body || {}).by || '').toString().slice(0, 60);
  const tx = await store.voidTransaction(req.params.id, by);
  if (!tx) return res.status(404).json({ error: 'ไม่พบรายการ' });
  res.json({ transaction: tx, products: await store.getProducts() });
}));

// ประวัติการเคลื่อนไหวสต๊อก
app.get('/api/transactions', wrap(async (req, res) => {
  res.json(await store.getTransactions());
}));

// สำรองข้อมูลทั้งหมด (JSON ครบทุกตาราง) — เผื่อฐานข้อมูลมีปัญหาจะกู้คืนได้
app.get('/api/backup', wrap(async (req, res) => {
  res.json(await store.exportAll());
}));

function lanUrls(port) {
  const out = [];
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const ni of ifs[name] || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(`http://${ni.address}:${port}`);
    }
  }
  return out;
}

const PORT = process.env.PORT || 3000;

// เตรียมฐานข้อมูล (ถ้ามี) ก่อนเปิดเซิร์ฟเวอร์
try {
  await store.init();
} catch (e) {
  console.error('\n  ❌ เชื่อมต่อ/เตรียมฐานข้อมูลไม่สำเร็จ:', e.message);
  console.error('     ตรวจ DATABASE_URL ให้ถูกต้อง (หรือเอาออกเพื่อใช้ไฟล์ JSON ในเครื่อง)\n');
  process.exit(1);
}

app.listen(PORT, () => {
  const urls = lanUrls(PORT);
  console.log('\n  ✅ stockmtt พร้อมใช้งานแล้ว\n');
  console.log('  • เปิดบนเครื่องนี้:  http://localhost:' + PORT);
  if (urls.length) {
    console.log('  • เปิดบนมือถือ (ต้องอยู่ Wi-Fi เดียวกัน):');
    urls.forEach((u) => console.log('       ' + u));
    import('qrcode-terminal')
      .then((qr) => {
        console.log('\n  หรือสแกน QR นี้ด้วยกล้องมือถือเพื่อเปิดเว็บ:\n');
        qr.default.generate(urls[0], { small: true });
      })
      .catch(() => {});
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('\n  ⚠️  ยังไม่ได้ตั้งค่า ANTHROPIC_API_KEY — ฟังก์ชันอ่านรูปด้วย AI จะใช้ไม่ได้ (ดู .env.example)');
  }
  if (!authEnabled()) {
    console.warn('\n  ⚠️  ยังไม่ได้ตั้งค่า APP_PASSWORD — เว็บนี้ใครก็เข้าได้ (ไม่มีการล็อกอิน)');
    console.warn('      ตั้ง APP_PASSWORD ใน environment variable เพื่อเปิดระบบล็อกอิน');
  }
  console.log('');
});
