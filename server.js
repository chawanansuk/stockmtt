import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import * as store from './lib/store.js';
import { extractFromImage } from './lib/claude.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '25mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ตัวช่วยจับ error ใน async route
const wrap = (fn) => (req, res) => fn(req, res).catch((err) => {
  console.error(err);
  res.status(500).json({ error: err?.message || 'เกิดข้อผิดพลาด' });
});

// รายการสินค้าทั้งหมด
app.get('/api/products', wrap(async (req, res) => {
  res.json(await store.getProducts());
}));

// เพิ่มสินค้าใหม่
app.post('/api/products', wrap(async (req, res) => {
  const { name, category, stock, reorderPoint } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'ต้องระบุชื่อสินค้า' });
  res.json(await store.addProduct({ name, category, stock, reorderPoint }));
}));

// แก้ไขสินค้า (ยอดคงเหลือ / จุดสั่งซื้อ / ชื่อ / หมวด)
app.post('/api/products/:id', wrap(async (req, res) => {
  const p = await store.updateProduct(req.params.id, req.body || {});
  if (!p) return res.status(404).json({ error: 'ไม่พบสินค้า' });
  res.json(p);
}));

// อ่านรูปด้วย AI (ยังไม่บันทึก — แค่คืนรายการให้ตรวจ)
app.post('/api/extract', wrap(async (req, res) => {
  const { image, mode } = req.body || {};
  if (!image) return res.status(400).json({ error: 'ไม่มีรูปภาพ' });
  const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]*)$/.exec(image);
  if (!m) return res.status(400).json({ error: 'รูปภาพไม่ถูกต้อง' });

  const data = await extractFromImage({
    mediaType: m[1],
    base64: m[2],
    mode: mode === 'receive' ? 'receive' : 'deduct',
  });

  const items = [];
  for (const it of data.items || []) {
    const p = it.productId ? await store.getProduct(it.productId) : null;
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
app.post('/api/commit', wrap(async (req, res) => {
  const { items, note, date, type } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'ไม่มีรายการ' });
  const tx = await store.commit({
    items,
    note: note || '',
    date: date || '',
    type: type === 'receive' ? 'receive' : 'deduct',
  });
  if (!tx) return res.status(400).json({ error: 'ไม่มีรายการที่บันทึกได้' });
  res.json({ transaction: tx, products: await store.getProducts() });
}));

// ยกเลิกรายการ (คืนสต๊อก)
app.post('/api/transactions/:id/void', wrap(async (req, res) => {
  const tx = await store.voidTransaction(req.params.id);
  if (!tx) return res.status(404).json({ error: 'ไม่พบรายการ' });
  res.json({ transaction: tx, products: await store.getProducts() });
}));

// ประวัติการเคลื่อนไหวสต๊อก
app.get('/api/transactions', wrap(async (req, res) => {
  res.json(await store.getTransactions());
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

await store.init(); // เตรียมฐานข้อมูล (ถ้ามี) ก่อนเปิดเซิร์ฟเวอร์

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
  console.log('');
});
