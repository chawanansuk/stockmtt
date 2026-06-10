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
const mapProduct = (r) => ({ id: r.id, name: r.name, category: r.category, stock: r.stock, reorderPoint: r.reorder_point, unit: r.unit || '', cost: Number(r.cost) || 0 });
const mapTx = (r) => ({
  id: r.id,
  type: r.type,
  date: r.date,
  note: r.note,
  actor: r.actor || '',
  items: typeof r.items === 'string' ? JSON.parse(r.items) : r.items,
  createdAt: toISO(r.created_at),
  voided: r.voided,
  voidedAt: toISO(r.voided_at),
  voidedBy: r.voided_by || '',
});

export async function init() {
  const p = getPool();
  await p.query(`CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT '',
    stock INTEGER NOT NULL DEFAULT 0,
    reorder_point INTEGER NOT NULL DEFAULT 0,
    deleted BOOLEAN NOT NULL DEFAULT false,
    unit TEXT NOT NULL DEFAULT '',
    cost DOUBLE PRECISION NOT NULL DEFAULT 0
  )`);
  await p.query(`CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY,
    type TEXT NOT NULL,
    date TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    actor TEXT NOT NULL DEFAULT '',
    items JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    voided BOOLEAN NOT NULL DEFAULT false,
    voided_at TIMESTAMPTZ,
    voided_by TEXT
  )`);
  await p.query(`CREATE TABLE IF NOT EXISTS aliases (
    text TEXT PRIMARY KEY,
    product_id INTEGER NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await p.query(`CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT ''
  )`);
  await p.query(`CREATE TABLE IF NOT EXISTS tx_images (
    tx_id INTEGER PRIMARY KEY,
    data TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);

  // migration สำหรับฐานข้อมูลเดิมที่สร้างก่อนมีคอลัมน์/ดัชนีเหล่านี้ (best-effort)
  for (const sql of [
    `ALTER TABLE products ADD COLUMN IF NOT EXISTS deleted BOOLEAN NOT NULL DEFAULT false`,
    `ALTER TABLE products ADD COLUMN IF NOT EXISTS unit TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE products ADD COLUMN IF NOT EXISTS cost DOUBLE PRECISION NOT NULL DEFAULT 0`,
    `ALTER TABLE transactions ADD COLUMN IF NOT EXISTS actor TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE transactions ADD COLUMN IF NOT EXISTS voided_by TEXT`,
    `ALTER TABLE aliases ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now()`,
    `CREATE INDEX IF NOT EXISTS idx_tx_items ON transactions USING gin (items)`, // เร่งกรองประวัติรายสินค้า
  ]) {
    try { await p.query(sql); } catch {}
  }

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
  const r = await getPool().query('SELECT * FROM products WHERE deleted = false ORDER BY id');
  return r.rows.map(mapProduct);
}

export async function getProduct(id) {
  const r = await getPool().query('SELECT * FROM products WHERE id=$1', [Number(id)]);
  return r.rows[0] ? mapProduct(r.rows[0]) : undefined;
}

// กรอง/แบ่งหน้าได้ (ไม่ส่ง opts = คืนทั้งหมด เพื่อ backward-compat เช่นตอนส่งออก CSV)
// opts: { limit, before(id cursor), type, productId, from('YYYY-MM-DD'), to('YYYY-MM-DD') }
export async function getTransactions(opts = {}) {
  const { limit, before, type, productId, from, to } = opts;
  const where = [];
  const vals = [];
  let i = 1;
  if (before) { where.push(`t.id < $${i++}`); vals.push(Number(before)); }
  if (type) { where.push(`t.type = $${i++}`); vals.push(type); }
  if (productId) { where.push(`t.items @> $${i++}::jsonb`); vals.push(JSON.stringify([{ productId: Number(productId) }])); }
  if (from) { where.push(`t.created_at >= $${i++}`); vals.push(new Date(from + 'T00:00:00')); }
  if (to) { const d = new Date(to + 'T00:00:00'); d.setDate(d.getDate() + 1); where.push(`t.created_at < $${i++}`); vals.push(d); }
  // LEFT JOIN เพื่อบอกว่ามีรูปใบแนบไหม (ไม่ดึงตัวรูปมาด้วย — หนัก)
  let sql = 'SELECT t.*, (img.tx_id IS NOT NULL) AS has_image FROM transactions t LEFT JOIN tx_images img ON img.tx_id = t.id';
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY t.id DESC';
  if (limit) { sql += ` LIMIT $${i++}`; vals.push(Number(limit)); }
  const r = await getPool().query(sql, vals);
  return r.rows.map((row) => ({ ...mapTx(row), hasImage: row.has_image === true }));
}

export async function getAliases() {
  // เรียงตามเวลาใช้ล่าสุด เพื่อให้ slice(-300) ใน claude.js เป็น "300 คำล่าสุดจริง"
  const r = await getPool().query('SELECT text, product_id FROM aliases ORDER BY updated_at');
  return r.rows.map((x) => ({ text: x.text, productId: x.product_id }));
}

async function upsertAlias(p, text, productId) {
  const t = normAlias(text);
  if (!t || !productId) return;
  const u = await p.query('UPDATE aliases SET product_id=$2, updated_at=now() WHERE text=$1', [t, Number(productId)]);
  if (u.rowCount === 0) await p.query('INSERT INTO aliases(text,product_id,updated_at) VALUES ($1,$2,now())', [t, Number(productId)]);
}

export async function addAlias(text, productId) {
  await upsertAlias(getPool(), text, productId);
}

export async function updateProduct(id, fields = {}, actor = '') {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cur = await client.query('SELECT * FROM products WHERE id=$1', [Number(id)]);
    if (!cur.rows.length) { await client.query('ROLLBACK'); return null; }
    const before = mapProduct(cur.rows[0]);

    const sets = [];
    const vals = [];
    let i = 1;
    let stockChanged = false;
    if (fields.stock !== undefined && Number.isFinite(Number(fields.stock))) {
      const ns = Number(fields.stock);
      if (ns !== before.stock) stockChanged = true;
      sets.push(`stock=$${i++}`); vals.push(ns);
    }
    if (fields.reorderPoint !== undefined && Number.isFinite(Number(fields.reorderPoint))) { sets.push(`reorder_point=$${i++}`); vals.push(Math.max(0, Number(fields.reorderPoint))); }
    if (fields.name !== undefined && String(fields.name).trim()) { sets.push(`name=$${i++}`); vals.push(String(fields.name).trim()); }
    if (fields.category !== undefined) { sets.push(`category=$${i++}`); vals.push(String(fields.category).trim()); }
    if (fields.unit !== undefined) { sets.push(`unit=$${i++}`); vals.push(String(fields.unit).trim()); }
    if (fields.cost !== undefined && Number.isFinite(Number(fields.cost))) { sets.push(`cost=$${i++}`); vals.push(Math.max(0, Number(fields.cost))); }
    if (!sets.length) { await client.query('COMMIT'); return before; }
    vals.push(Number(id));
    const r = await client.query(`UPDATE products SET ${sets.join(', ')} WHERE id=$${i} RETURNING *`, vals);
    const updated = mapProduct(r.rows[0]);

    // แก้ยอดด้วยมือ → บันทึกเป็นรายการ "ปรับยอด" ลงประวัติ (audit) ในทรานแซกชันเดียวกัน
    if (stockChanged) {
      const delta = updated.stock - before.stock;
      const m = await client.query('SELECT COALESCE(MAX(id),0)+1 AS id FROM transactions');
      const item = { productId: updated.id, name: updated.name, category: updated.category, unit: updated.unit, quantity: delta, before: before.stock, after: updated.stock };
      await client.query(
        `INSERT INTO transactions(id,type,date,note,actor,items,voided) VALUES ($1,'adjust','','ปรับยอดด้วยมือ',$2,$3,false)`,
        [m.rows[0].id, actor, JSON.stringify([item])]
      );
    }
    await client.query('COMMIT');
    return updated;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    throw e;
  } finally {
    client.release();
  }
}

export async function addProduct({ name, category = '', stock = 0, reorderPoint = 0, unit = '', cost = 0 }) {
  const p = getPool();
  const m = await p.query('SELECT COALESCE(MAX(id),0)+1 AS id FROM products');
  const id = m.rows[0].id;
  const r = await p.query(
    'INSERT INTO products(id,name,category,stock,reorder_point,unit,cost) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
    [id, String(name).trim(), String(category).trim(), Number(stock) || 0, Math.max(0, Number(reorderPoint) || 0), String(unit).trim(), Math.max(0, Number(cost) || 0)]
  );
  return mapProduct(r.rows[0]);
}

// soft-delete: ทำเครื่องหมายว่าลบ ไม่ลบแถวจริง (ประวัติ/การ void ยังอ้างถึงได้)
export async function deleteProduct(id) {
  const r = await getPool().query('UPDATE products SET deleted=true WHERE id=$1 RETURNING id', [Number(id)]);
  return r.rows.length > 0;
}

// คืนค่ากลับทิศของรายการตอนบันทึก (adjust เก็บ quantity เป็นค่าบวก/ลบอยู่แล้ว)
function reverseDeltaFor(type, quantity) {
  const q = Number(quantity);
  return type === 'adjust' ? -q : -((type === 'receive' ? 1 : -1) * q);
}

export async function commit({ items, note = '', date = '', type = 'deduct', actor = '', slipImage = '' }) {
  const pool = getPool();
  const client = await pool.connect();
  const sign = type === 'receive' ? 1 : -1;
  try {
    // ครอบทั้งก้อนเป็น DB transaction: ตัดสต๊อก + บันทึกประวัติ ต้องสำเร็จพร้อมกัน
    // (กันกรณีตัดสต๊อกไปแล้วแต่ insert ประวัติล้มเหลว → ข้อมูลเพี้ยน)
    await client.query('BEGIN');
    const applied = [];
    for (const it of items) {
      const qty = Number(it.quantity) || 0;
      if (qty <= 0) continue;
      const delta = sign * qty;
      // กันตัดสต๊อกสินค้าที่ถูกลบไปแล้ว (deleted=false)
      const r = await client.query(
        'UPDATE products SET stock = stock + $1 WHERE id=$2 AND deleted=false RETURNING id,name,category,stock,unit,cost',
        [delta, Number(it.productId)]
      );
      if (!r.rows.length) continue;
      const row = r.rows[0];
      // snapshot unit/cost ณ เวลาบันทึก (ราคาทุนเปลี่ยนภายหลังได้ ประวัติต้องคงค่าตอนนั้น)
      applied.push({ productId: row.id, name: row.name, category: row.category, unit: row.unit || '', cost: Number(row.cost) || 0, quantity: qty, before: row.stock - delta, after: row.stock });
      if (it.rawText) await upsertAlias(client, it.rawText, row.id); // จำคำย่อให้ AI
    }
    if (!applied.length) { await client.query('ROLLBACK'); return null; }

    const m = await client.query('SELECT COALESCE(MAX(id),0)+1 AS id FROM transactions');
    const r = await client.query(
      'INSERT INTO transactions(id,type,date,note,actor,items,voided) VALUES ($1,$2,$3,$4,$5,$6,false) RETURNING *',
      [m.rows[0].id, type, date, note, actor, JSON.stringify(applied)]
    );
    await client.query('COMMIT');
    const tx = mapTx(r.rows[0]);
    // แนบรูปใบ (best-effort หลังบันทึกสำเร็จ — รูปพลาดไม่ทำให้รายการหาย)
    if (slipImage) { try { await saveTxImage(tx.id, slipImage); tx.hasImage = true; } catch {} }
    return tx;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    throw e;
  } finally {
    client.release();
  }
}

// นับสต๊อกจริง: ปรับหลายรายการเป็นใบ "ปรับยอด" ใบเดียว (เฉพาะตัวที่นับได้ต่างจากระบบ)
export async function stocktake(items, actor = '') {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const applied = [];
    for (const it of items) {
      const counted = Number(it.counted);
      if (!Number.isFinite(counted)) continue;
      const cur = await client.query('SELECT * FROM products WHERE id=$1 AND deleted=false', [Number(it.productId)]);
      if (!cur.rows.length) continue;
      const p = mapProduct(cur.rows[0]);
      if (p.stock === counted) continue; // นับได้ตรงกับระบบ ไม่ต้องปรับ
      await client.query('UPDATE products SET stock=$1 WHERE id=$2', [counted, p.id]);
      applied.push({ productId: p.id, name: p.name, category: p.category, unit: p.unit, quantity: counted - p.stock, before: p.stock, after: counted });
    }
    if (!applied.length) { await client.query('ROLLBACK'); return null; }
    const m = await client.query('SELECT COALESCE(MAX(id),0)+1 AS id FROM transactions');
    const r = await client.query(
      `INSERT INTO transactions(id,type,date,note,actor,items,voided) VALUES ($1,'adjust','','นับสต๊อกจริง',$2,$3,false) RETURNING *`,
      [m.rows[0].id, actor, JSON.stringify(applied)]
    );
    await client.query('COMMIT');
    return mapTx(r.rows[0]);
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    throw e;
  } finally {
    client.release();
  }
}

// ยกเลิกเฉพาะบางรายการในใบ (คืนสต๊อกเฉพาะแถวนั้น) — ครบทุกแถวเมื่อไรถือว่าทั้งใบถูกยกเลิก
export async function voidTransactionItem(id, itemIndex, by = '') {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const tr = await client.query('SELECT * FROM transactions WHERE id=$1 FOR UPDATE', [Number(id)]);
    if (!tr.rows.length) { await client.query('ROLLBACK'); return null; }
    const tx = mapTx(tr.rows[0]);
    const it = tx.items[Number(itemIndex)];
    if (tx.voided || !it || it.voided) { await client.query('ROLLBACK'); return tx; } // ยกเลิกไปแล้ว → ไม่ทำซ้ำ
    await client.query('UPDATE products SET stock = stock + $1 WHERE id=$2', [reverseDeltaFor(tx.type, it.quantity), Number(it.productId)]);
    it.voided = true;
    if (by) it.voidedBy = by;
    const allVoided = tx.items.every((x) => x.voided);
    const r = allVoided
      ? await client.query('UPDATE transactions SET items=$2, voided=true, voided_at=now(), voided_by=$3 WHERE id=$1 RETURNING *', [Number(id), JSON.stringify(tx.items), by])
      : await client.query('UPDATE transactions SET items=$2 WHERE id=$1 RETURNING *', [Number(id), JSON.stringify(tx.items)]);
    await client.query('COMMIT');
    return mapTx(r.rows[0]);
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    throw e;
  } finally {
    client.release();
  }
}

export async function voidTransaction(id, by = '') {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // ยึดสิทธิ์ยกเลิกแบบ atomic: เฉพาะคำขอแรกที่เปลี่ยน voided false→true เท่านั้นจึงคืนสต๊อก
    // (กันกดยกเลิกซ้ำเร็ว ๆ แล้วคืนสต๊อกสองรอบ)
    const claim = await client.query(
      'UPDATE transactions SET voided=true, voided_at=now(), voided_by=$2 WHERE id=$1 AND voided=false RETURNING *',
      [Number(id), by]
    );
    if (!claim.rows.length) {
      await client.query('ROLLBACK');
      const ex = await pool.query('SELECT * FROM transactions WHERE id=$1', [Number(id)]);
      return ex.rows.length ? mapTx(ex.rows[0]) : null; // ไม่พบ หรือถูกยกเลิกไปแล้ว
    }
    const tx = mapTx(claim.rows[0]);
    for (const it of tx.items) {
      if (it.voided) continue; // แถวที่ถูกยกเลิกรายตัวไปแล้ว คืนสต๊อกไปแล้ว — ข้าม
      await client.query('UPDATE products SET stock = stock + $1 WHERE id=$2', [reverseDeltaFor(tx.type, it.quantity), Number(it.productId)]);
    }
    await client.query('COMMIT');
    return tx;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    throw e;
  } finally {
    client.release();
  }
}

// ---------- ค่าตั้งค่าถาวรเล็ก ๆ (เช่น วันล่าสุดที่ส่งแจ้งเตือน LINE) ----------
export async function getKV(key) {
  const r = await getPool().query('SELECT value FROM kv WHERE key=$1', [String(key)]);
  return r.rows[0] ? r.rows[0].value : null;
}
export async function setKV(key, value) {
  const p = getPool();
  const u = await p.query('UPDATE kv SET value=$2 WHERE key=$1', [String(key), String(value)]);
  if (u.rowCount === 0) await p.query('INSERT INTO kv(key,value) VALUES ($1,$2)', [String(key), String(value)]);
}

// ---------- รูปใบจริงแนบกับรายการ (เก็บล่าสุดไม่เกิน IMAGE_KEEP รูป กันฐานข้อมูลบวม) ----------
const IMAGE_KEEP = Math.max(20, Number(process.env.IMAGE_KEEP) || 400);
export async function saveTxImage(txId, dataUrl) {
  const p = getPool();
  const u = await p.query('UPDATE tx_images SET data=$2 WHERE tx_id=$1', [Number(txId), String(dataUrl)]);
  if (u.rowCount === 0) await p.query('INSERT INTO tx_images(tx_id,data) VALUES ($1,$2)', [Number(txId), String(dataUrl)]);
  try {
    await p.query('DELETE FROM tx_images WHERE tx_id NOT IN (SELECT tx_id FROM tx_images ORDER BY tx_id DESC LIMIT $1)', [IMAGE_KEEP]);
  } catch {} // prune เป็น best-effort
}
export async function getTxImage(txId) {
  const r = await getPool().query('SELECT data FROM tx_images WHERE tx_id=$1', [Number(txId)]);
  return r.rows[0] ? r.rows[0].data : null;
}

// ส่งออกข้อมูลทุกตารางสำหรับสำรอง (รวมสินค้าที่ถูกลบไว้ด้วย เผื่อกู้คืน — ไม่รวมรูปใบ เพราะไฟล์จะใหญ่มาก)
export async function exportAll() {
  const p = getPool();
  const [pr, tx, al] = await Promise.all([
    p.query('SELECT * FROM products ORDER BY id'),
    p.query('SELECT * FROM transactions ORDER BY id'),
    p.query('SELECT text, product_id FROM aliases'),
  ]);
  return {
    exportedAt: new Date().toISOString(),
    products: pr.rows.map((r) => ({ id: r.id, name: r.name, category: r.category, stock: r.stock, reorderPoint: r.reorder_point, deleted: r.deleted })),
    transactions: tx.rows.map(mapTx),
    aliases: al.rows.map((x) => ({ text: x.text, productId: x.product_id })),
  };
}
