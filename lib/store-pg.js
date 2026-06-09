// เก็บข้อมูลใน PostgreSQL (ใช้ตอนขึ้นออนไลน์ — ข้อมูลถาวร ไม่หายตอนรีสตาร์ท)
// จะถูกใช้เมื่อมี environment variable DATABASE_URL
import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const seedPath = path.join(__dirname, '..', 'data', 'products.json');

const normAlias = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

let pool = null;
export function _setPool(p) { pool = p; } // สำหรับการทดสอบ
function getPool() {
  if (!pool) {
    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false },
    });
  }
  return pool;
}

const toISO = (v) => (v instanceof Date ? v.toISOString() : v || undefined);
const mapProduct = (r) => ({ id: r.id, name: r.name, category: r.category, stock: r.stock, reorderPoint: r.reorder_point });
const mapTx = (r) => ({
  id: r.id,
  type: r.type,
  date: r.date,
  note: r.note,
  items: typeof r.items === 'string' ? JSON.parse(r.items) : r.items,
  createdAt: toISO(r.created_at),
  voided: r.voided,
  voidedAt: toISO(r.voided_at),
});

export async function init() {
  const p = getPool();
  await p.query(`CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT '',
    stock INTEGER NOT NULL DEFAULT 0,
    reorder_point INTEGER NOT NULL DEFAULT 0
  )`);
  await p.query(`CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY,
    type TEXT NOT NULL,
    date TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    items JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    voided BOOLEAN NOT NULL DEFAULT false,
    voided_at TIMESTAMPTZ
  )`);
  await p.query(`CREATE TABLE IF NOT EXISTS aliases (
    text TEXT PRIMARY KEY,
    product_id INTEGER NOT NULL
  )`);

  // นำเข้าสินค้าตั้งต้นจาก data/products.json ถ้าฐานข้อมูลยังว่าง
  const c = await p.query('SELECT COUNT(*)::int AS n FROM products');
  if (c.rows[0].n === 0 && fs.existsSync(seedPath)) {
    let seed = [];
    try { seed = JSON.parse(fs.readFileSync(seedPath, 'utf8')); } catch {}
    for (const s of seed) {
      await p.query(
        'INSERT INTO products(id,name,category,stock,reorder_point) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO NOTHING',
        [s.id, s.name, s.category || '', Number(s.stock) || 0, Number(s.reorderPoint) || 0]
      );
    }
    console.log(`  (ฐานข้อมูล) นำเข้าสินค้าตั้งต้น ${seed.length} รายการ`);
  }
}

export async function getProducts() {
  const r = await getPool().query('SELECT * FROM products ORDER BY id');
  return r.rows.map(mapProduct);
}

export async function getProduct(id) {
  const r = await getPool().query('SELECT * FROM products WHERE id=$1', [Number(id)]);
  return r.rows[0] ? mapProduct(r.rows[0]) : undefined;
}

export async function getTransactions() {
  const r = await getPool().query('SELECT * FROM transactions ORDER BY id DESC');
  return r.rows.map(mapTx);
}

export async function getAliases() {
  const r = await getPool().query('SELECT text, product_id FROM aliases');
  return r.rows.map((x) => ({ text: x.text, productId: x.product_id }));
}

async function upsertAlias(p, text, productId) {
  const t = normAlias(text);
  if (!t || !productId) return;
  const u = await p.query('UPDATE aliases SET product_id=$2 WHERE text=$1', [t, Number(productId)]);
  if (u.rowCount === 0) await p.query('INSERT INTO aliases(text,product_id) VALUES ($1,$2)', [t, Number(productId)]);
}

export async function addAlias(text, productId) {
  await upsertAlias(getPool(), text, productId);
}

export async function updateProduct(id, fields = {}) {
  const sets = [];
  const vals = [];
  let i = 1;
  if (fields.stock !== undefined && Number.isFinite(Number(fields.stock))) { sets.push(`stock=$${i++}`); vals.push(Number(fields.stock)); }
  if (fields.reorderPoint !== undefined && Number.isFinite(Number(fields.reorderPoint))) { sets.push(`reorder_point=$${i++}`); vals.push(Math.max(0, Number(fields.reorderPoint))); }
  if (fields.name !== undefined && String(fields.name).trim()) { sets.push(`name=$${i++}`); vals.push(String(fields.name).trim()); }
  if (fields.category !== undefined) { sets.push(`category=$${i++}`); vals.push(String(fields.category).trim()); }
  if (!sets.length) return getProduct(id);
  vals.push(Number(id));
  const r = await getPool().query(`UPDATE products SET ${sets.join(', ')} WHERE id=$${i} RETURNING *`, vals);
  return r.rows[0] ? mapProduct(r.rows[0]) : null;
}

export async function addProduct({ name, category = '', stock = 0, reorderPoint = 0 }) {
  const p = getPool();
  const m = await p.query('SELECT COALESCE(MAX(id),0)+1 AS id FROM products');
  const id = m.rows[0].id;
  const r = await p.query(
    'INSERT INTO products(id,name,category,stock,reorder_point) VALUES ($1,$2,$3,$4,$5) RETURNING *',
    [id, String(name).trim(), String(category).trim(), Number(stock) || 0, Math.max(0, Number(reorderPoint) || 0)]
  );
  return mapProduct(r.rows[0]);
}

export async function deleteProduct(id) {
  const r = await getPool().query('DELETE FROM products WHERE id=$1 RETURNING id', [Number(id)]);
  return r.rows.length > 0;
}

export async function commit({ items, note = '', date = '', type = 'deduct' }) {
  const p = getPool();
  const sign = type === 'receive' ? 1 : -1;
  const applied = [];
  for (const it of items) {
    const qty = Number(it.quantity) || 0;
    if (qty <= 0) continue;
    const delta = sign * qty;
    // อัปเดตแบบ atomic ต่อแถว (กันแข่งกันแก้พร้อมกัน)
    const r = await p.query('UPDATE products SET stock = stock + $1 WHERE id=$2 RETURNING id,name,category,stock', [delta, Number(it.productId)]);
    if (!r.rows.length) continue;
    const row = r.rows[0];
    applied.push({ productId: row.id, name: row.name, category: row.category, quantity: qty, before: row.stock - delta, after: row.stock });
    if (it.rawText) await upsertAlias(p, it.rawText, row.id); // จำคำย่อให้ AI
  }
  if (!applied.length) return null;

  const m = await p.query('SELECT COALESCE(MAX(id),0)+1 AS id FROM transactions');
  const id = m.rows[0].id;
  const r = await p.query(
    'INSERT INTO transactions(id,type,date,note,items,voided) VALUES ($1,$2,$3,$4,$5,false) RETURNING *',
    [id, type, date, note, JSON.stringify(applied)]
  );
  return mapTx(r.rows[0]);
}

export async function voidTransaction(id) {
  const p = getPool();
  const tr = await p.query('SELECT * FROM transactions WHERE id=$1', [Number(id)]);
  if (!tr.rows.length) return null;
  const tx = mapTx(tr.rows[0]);
  if (tx.voided) return tx;
  const sign = tx.type === 'receive' ? 1 : -1;
  for (const it of tx.items) {
    const reverseDelta = -(sign * Number(it.quantity)); // กลับทิศของตอนบันทึก
    await p.query('UPDATE products SET stock = stock + $1 WHERE id=$2', [reverseDelta, Number(it.productId)]);
  }
  const r = await p.query('UPDATE transactions SET voided=true, voided_at=now() WHERE id=$1 RETURNING *', [Number(id)]);
  return mapTx(r.rows[0]);
}
