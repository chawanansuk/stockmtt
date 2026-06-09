import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as store from './lib/store.js';
import { extractFromImage } from './lib/claude.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '25mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// รายการสินค้าทั้งหมด
app.get('/api/products', (req, res) => {
  res.json(store.getProducts());
});

// เพิ่มสินค้าใหม่
app.post('/api/products', (req, res) => {
  const { name, category, stock, reorderPoint } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'ต้องระบุชื่อสินค้า' });
  res.json(store.addProduct({ name, category, stock, reorderPoint }));
});

// แก้ไขสินค้า (ยอดคงเหลือ / จุดสั่งซื้อ / ชื่อ / หมวด)
app.post('/api/products/:id', (req, res) => {
  const p = store.updateProduct(req.params.id, req.body || {});
  if (!p) return res.status(404).json({ error: 'ไม่พบสินค้า' });
  res.json(p);
});

// อ่านรูปด้วย AI (ยังไม่บันทึก — แค่คืนรายการให้ตรวจ)
app.post('/api/extract', async (req, res) => {
  try {
    const { image, mode } = req.body || {};
    if (!image) return res.status(400).json({ error: 'ไม่มีรูปภาพ' });
    const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]*)$/.exec(image);
    if (!m) return res.status(400).json({ error: 'รูปภาพไม่ถูกต้อง' });

    const data = await extractFromImage({
      mediaType: m[1],
      base64: m[2],
      mode: mode === 'receive' ? 'receive' : 'deduct',
    });

    const items = (data.items || []).map((it) => {
      const p = it.productId ? store.getProduct(it.productId) : null;
      return {
        rawText: it.rawText || '',
        quantity: Number(it.quantity) || 1,
        productId: p ? p.id : 0,
        productName: p ? p.name : it.productName || '',
        category: p ? p.category : '',
        currentStock: p ? p.stock : null,
        confidence: it.confidence || 'low',
      };
    });
    res.json({ date: data.date || '', items });
  } catch (err) {
    console.error('extract error:', err);
    res.status(500).json({ error: err?.message || 'เกิดข้อผิดพลาดในการอ่านรูป' });
  }
});

// ยืนยันบันทึก (ตัดออก หรือ รับเข้า)
app.post('/api/commit', (req, res) => {
  const { items, note, date, type } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'ไม่มีรายการ' });
  const tx = store.commit({
    items,
    note: note || '',
    date: date || '',
    type: type === 'receive' ? 'receive' : 'deduct',
  });
  if (!tx) return res.status(400).json({ error: 'ไม่มีรายการที่บันทึกได้' });
  res.json({ transaction: tx, products: store.getProducts() });
});

// ยกเลิกรายการ (คืนสต๊อก)
app.post('/api/transactions/:id/void', (req, res) => {
  const tx = store.voidTransaction(req.params.id);
  if (!tx) return res.status(404).json({ error: 'ไม่พบรายการ' });
  res.json({ transaction: tx, products: store.getProducts() });
});

// ประวัติการเคลื่อนไหวสต๊อก
app.get('/api/transactions', (req, res) => {
  res.json(store.getTransactions());
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ stockmtt ทำงานที่ http://localhost:${PORT}`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('⚠️  ยังไม่ได้ตั้งค่า ANTHROPIC_API_KEY — ฟังก์ชันอ่านรูปด้วย AI จะใช้ไม่ได้ (ดู .env.example)');
  }
});
