// เก็บข้อมูลในไฟล์ JSON (ใช้ตอนรันในเครื่อง — ไม่ต้องมีฐานข้อมูล)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, '..', 'data');
const productsPath = path.join(dataDir, 'products.json');
const txPath = path.join(dataDir, 'transactions.json');
const aliasesPath = path.join(dataDir, 'aliases.json');
const kvPath = path.join(dataDir, 'kv.json');
const imagesDir = path.join(dataDir, 'images');

const normAlias = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}
function writeJson(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, p);
}

let products = readJson(productsPath, []).map((p) => ({ reorderPoint: 0, unit: '', cost: 0, ...p }));
let transactions = readJson(txPath, []);
let aliases = readJson(aliasesPath, []); // [{ text, productId }]
let kv = readJson(kvPath, {});

// รูปใบจริง: เก็บเป็นไฟล์ใน data/images/<txId>.txt (dataURL) — จำชุด id ที่มีรูปไว้เช็คเร็ว ๆ
const txImageIds = new Set();
try {
  for (const f of fs.readdirSync(imagesDir)) {
    const m = /^(\d+)\.txt$/.exec(f);
    if (m) txImageIds.add(Number(m[1]));
  }
} catch {}

export async function init() {} // ไม่ต้องเตรียมอะไร

export async function getProducts() { return products.filter((p) => !p.deleted); } // ซ่อนที่ถูกลบ (soft-delete)
export async function getProduct(id) { return products.find((p) => p.id === Number(id)); } // หาเจอแม้ถูกลบ (ใช้ตอน void)
// กรอง/แบ่งหน้าได้ (ไม่ส่ง opts = คืนทั้งหมด — backward-compat เช่นตอนส่งออก CSV)
export async function getTransactions(opts = {}) {
  const { limit, before, type, productId, from, to } = opts;
  let list = transactions;
  if (type) list = list.filter((t) => t.type === type);
  if (productId) list = list.filter((t) => (t.items || []).some((it) => Number(it.productId) === Number(productId)));
  if (from) list = list.filter((t) => (t.createdAt || '').slice(0, 10) >= from);
  if (to) list = list.filter((t) => (t.createdAt || '').slice(0, 10) <= to);
  if (before) list = list.filter((t) => Number(t.id) < Number(before));
  list = [...list].sort((a, b) => b.id - a.id);
  if (limit) list = list.slice(0, Number(limit));
  return list.map((t) => ({ ...t, hasImage: txImageIds.has(Number(t.id)) }));
}

// ---------- ค่าตั้งค่าถาวรเล็ก ๆ ----------
export async function getKV(key) { return Object.prototype.hasOwnProperty.call(kv, key) ? kv[key] : null; }
export async function setKV(key, value) { kv[String(key)] = String(value); writeJson(kvPath, kv); }

// ---------- รูปใบจริงแนบกับรายการ ----------
const IMAGE_KEEP = Math.max(20, Number(process.env.IMAGE_KEEP) || 400);
export async function saveTxImage(txId, dataUrl) {
  fs.mkdirSync(imagesDir, { recursive: true });
  fs.writeFileSync(path.join(imagesDir, Number(txId) + '.txt'), String(dataUrl), 'utf8');
  txImageIds.add(Number(txId));
  // เก็บล่าสุดไม่เกิน IMAGE_KEEP รูป
  const ids = [...txImageIds].sort((a, b) => b - a);
  for (const old of ids.slice(IMAGE_KEEP)) {
    try { fs.unlinkSync(path.join(imagesDir, old + '.txt')); } catch {}
    txImageIds.delete(old);
  }
}
export async function getTxImage(txId) {
  try { return fs.readFileSync(path.join(imagesDir, Number(txId) + '.txt'), 'utf8'); } catch { return null; }
}
export async function getAliases() { return aliases; }

export async function addAlias(text, productId) {
  const t = normAlias(text);
  if (!t || !productId) return;
  const idx = aliases.findIndex((a) => a.text === t);
  if (idx >= 0) aliases.splice(idx, 1); // ขยับไปท้าย (= ล่าสุด) เพื่อให้ slice(-300) แม่น
  aliases.push({ text: t, productId: Number(productId) });
  writeJson(aliasesPath, aliases);
}

export async function updateProduct(id, fields = {}, actor = '') {
  const p = products.find((x) => x.id === Number(id));
  if (!p) return null;
  const beforeStock = p.stock || 0;
  let stockChanged = false;
  if (fields.stock !== undefined && Number.isFinite(Number(fields.stock))) {
    const ns = Number(fields.stock);
    if (ns !== p.stock) stockChanged = true;
    p.stock = ns;
  }
  if (fields.reorderPoint !== undefined && Number.isFinite(Number(fields.reorderPoint))) {
    p.reorderPoint = Math.max(0, Number(fields.reorderPoint));
  }
  if (fields.name !== undefined && String(fields.name).trim()) p.name = String(fields.name).trim();
  if (fields.category !== undefined) p.category = String(fields.category).trim();
  if (fields.unit !== undefined) p.unit = String(fields.unit).trim();
  if (fields.cost !== undefined && Number.isFinite(Number(fields.cost))) p.cost = Math.max(0, Number(fields.cost));
  writeJson(productsPath, products);
  // แก้ยอดด้วยมือ → บันทึกเป็นรายการ "ปรับยอด" ลงประวัติ
  if (stockChanged) {
    const delta = p.stock - beforeStock;
    transactions.unshift({
      id: transactions.reduce((m, t) => Math.max(m, t.id || 0), 0) + 1,
      type: 'adjust', date: '', note: 'ปรับยอดด้วยมือ', actor: actor || '',
      items: [{ productId: p.id, name: p.name, category: p.category, unit: p.unit || '', quantity: delta, before: beforeStock, after: p.stock }],
      createdAt: new Date().toISOString(), voided: false,
    });
    writeJson(txPath, transactions);
  }
  return p;
}

export async function addProduct({ name, category = '', stock = 0, reorderPoint = 0, unit = '', cost = 0 }) {
  const id = products.reduce((m, p) => Math.max(m, p.id || 0), 0) + 1;
  const p = {
    id,
    name: String(name).trim(),
    category: String(category).trim(),
    stock: Number(stock) || 0,
    reorderPoint: Math.max(0, Number(reorderPoint) || 0),
    unit: String(unit).trim(),
    cost: Math.max(0, Number(cost) || 0),
  };
  products.push(p);
  writeJson(productsPath, products);
  return p;
}

// soft-delete: ทำเครื่องหมายว่าลบ ไม่ลบแถวจริง (ประวัติ/การ void ยังอ้างถึงได้)
export async function deleteProduct(id) {
  const p = products.find((x) => x.id === Number(id));
  if (!p) return false;
  p.deleted = true;
  writeJson(productsPath, products);
  return true;
}

export async function commit({ items, note = '', date = '', type = 'deduct', actor = '', slipImage = '' }) {
  const sign = type === 'receive' ? 1 : -1;
  const applied = [];
  let aliasChanged = false;
  for (const it of items) {
    const p = products.find((x) => x.id === Number(it.productId));
    if (!p || p.deleted) continue; // กันตัดสต๊อกสินค้าที่ถูกลบไปแล้ว
    const qty = Number(it.quantity) || 0;
    if (qty <= 0) continue;
    const before = p.stock || 0;
    p.stock = before + sign * qty;
    // snapshot unit/cost ณ เวลาบันทึก
    applied.push({ productId: p.id, name: p.name, category: p.category, unit: p.unit || '', cost: Number(p.cost) || 0, quantity: qty, before, after: p.stock });
    // จำคำที่อ่านได้ -> สินค้าที่เลือก เพื่อให้ AI แม่นขึ้นครั้งหน้า
    const t = normAlias(it.rawText);
    if (t) {
      const idx = aliases.findIndex((a) => a.text === t);
      if (idx >= 0) aliases.splice(idx, 1); // ขยับไปท้าย (= ใช้ล่าสุด)
      aliases.push({ text: t, productId: p.id });
      aliasChanged = true;
    }
  }
  if (applied.length === 0) return null;

  const tx = {
    id: transactions.reduce((m, t) => Math.max(m, t.id || 0), 0) + 1,
    type,
    date,
    note,
    actor,
    items: applied,
    createdAt: new Date().toISOString(),
    voided: false,
  };
  transactions.unshift(tx);
  writeJson(productsPath, products);
  writeJson(txPath, transactions);
  if (aliasChanged) writeJson(aliasesPath, aliases);
  if (slipImage) { try { await saveTxImage(tx.id, slipImage); tx.hasImage = true; } catch {} }
  return tx;
}

// นับสต๊อกจริง: ปรับหลายรายการเป็นใบ "ปรับยอด" ใบเดียว (เฉพาะตัวที่นับได้ต่างจากระบบ)
export async function stocktake(items, actor = '') {
  const applied = [];
  for (const it of items) {
    const counted = Number(it.counted);
    if (!Number.isFinite(counted)) continue;
    const p = products.find((x) => x.id === Number(it.productId));
    if (!p || p.deleted) continue;
    const before = p.stock || 0;
    if (before === counted) continue;
    p.stock = counted;
    applied.push({ productId: p.id, name: p.name, category: p.category, unit: p.unit || '', quantity: counted - before, before, after: counted });
  }
  if (!applied.length) return null;
  const tx = {
    id: transactions.reduce((m, t) => Math.max(m, t.id || 0), 0) + 1,
    type: 'adjust', date: '', note: 'นับสต๊อกจริง', actor: actor || '',
    items: applied, createdAt: new Date().toISOString(), voided: false,
  };
  transactions.unshift(tx);
  writeJson(productsPath, products);
  writeJson(txPath, transactions);
  return tx;
}

const reverseDeltaFor = (type, quantity) => {
  const q = Number(quantity);
  return type === 'adjust' ? -q : -((type === 'receive' ? 1 : -1) * q);
};

// ยกเลิกเฉพาะบางรายการในใบ (คืนสต๊อกเฉพาะแถวนั้น)
export async function voidTransactionItem(id, itemIndex, by = '') {
  const tx = transactions.find((t) => t.id === Number(id));
  if (!tx) return null;
  const it = tx.items[Number(itemIndex)];
  if (tx.voided || !it || it.voided) return tx; // ยกเลิกไปแล้ว → ไม่ทำซ้ำ
  const p = products.find((x) => x.id === Number(it.productId));
  if (p) p.stock = (p.stock || 0) + reverseDeltaFor(tx.type, it.quantity);
  it.voided = true;
  if (by) it.voidedBy = by;
  if (tx.items.every((x) => x.voided)) {
    tx.voided = true;
    tx.voidedBy = by;
    tx.voidedAt = new Date().toISOString();
  }
  writeJson(productsPath, products);
  writeJson(txPath, transactions);
  return tx;
}

export async function voidTransaction(id, by = '') {
  const tx = transactions.find((t) => t.id === Number(id));
  if (!tx) return null;
  if (tx.voided) return tx;
  for (const it of tx.items) {
    if (it.voided) continue; // แถวที่ถูกยกเลิกรายตัวไปแล้ว — ข้าม
    const p = products.find((x) => x.id === Number(it.productId));
    if (!p) continue;
    p.stock = (p.stock || 0) + reverseDeltaFor(tx.type, it.quantity);
  }
  tx.voided = true;
  tx.voidedBy = by;
  tx.voidedAt = new Date().toISOString();
  writeJson(productsPath, products);
  writeJson(txPath, transactions);
  return tx;
}

// ส่งออกข้อมูลทุกอย่างสำหรับสำรอง
export async function exportAll() {
  return { exportedAt: new Date().toISOString(), products, transactions, aliases };
}
