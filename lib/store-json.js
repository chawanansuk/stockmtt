// เก็บข้อมูลในไฟล์ JSON (ใช้ตอนรันในเครื่อง — ไม่ต้องมีฐานข้อมูล)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, '..', 'data');
const productsPath = path.join(dataDir, 'products.json');
const txPath = path.join(dataDir, 'transactions.json');
const aliasesPath = path.join(dataDir, 'aliases.json');

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

let products = readJson(productsPath, []).map((p) => ({ reorderPoint: 0, ...p }));
let transactions = readJson(txPath, []);
let aliases = readJson(aliasesPath, []); // [{ text, productId }]

export async function init() {} // ไม่ต้องเตรียมอะไร

export async function getProducts() { return products.filter((p) => !p.deleted); } // ซ่อนที่ถูกลบ (soft-delete)
export async function getProduct(id) { return products.find((p) => p.id === Number(id)); } // หาเจอแม้ถูกลบ (ใช้ตอน void)
export async function getTransactions() { return transactions; }
export async function getAliases() { return aliases; }

export async function addAlias(text, productId) {
  const t = normAlias(text);
  if (!t || !productId) return;
  const existing = aliases.find((a) => a.text === t);
  if (existing) existing.productId = Number(productId);
  else aliases.push({ text: t, productId: Number(productId) });
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
  writeJson(productsPath, products);
  // แก้ยอดด้วยมือ → บันทึกเป็นรายการ "ปรับยอด" ลงประวัติ
  if (stockChanged) {
    const delta = p.stock - beforeStock;
    transactions.unshift({
      id: transactions.reduce((m, t) => Math.max(m, t.id || 0), 0) + 1,
      type: 'adjust', date: '', note: 'ปรับยอดด้วยมือ', actor: actor || '',
      items: [{ productId: p.id, name: p.name, category: p.category, quantity: delta, before: beforeStock, after: p.stock }],
      createdAt: new Date().toISOString(), voided: false,
    });
    writeJson(txPath, transactions);
  }
  return p;
}

export async function addProduct({ name, category = '', stock = 0, reorderPoint = 0 }) {
  const id = products.reduce((m, p) => Math.max(m, p.id || 0), 0) + 1;
  const p = {
    id,
    name: String(name).trim(),
    category: String(category).trim(),
    stock: Number(stock) || 0,
    reorderPoint: Math.max(0, Number(reorderPoint) || 0),
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

export async function commit({ items, note = '', date = '', type = 'deduct', actor = '' }) {
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
    applied.push({ productId: p.id, name: p.name, category: p.category, quantity: qty, before, after: p.stock });
    // จำคำที่อ่านได้ -> สินค้าที่เลือก เพื่อให้ AI แม่นขึ้นครั้งหน้า
    const t = normAlias(it.rawText);
    if (t) {
      const existing = aliases.find((a) => a.text === t);
      if (existing) { if (existing.productId !== p.id) { existing.productId = p.id; aliasChanged = true; } }
      else { aliases.push({ text: t, productId: p.id }); aliasChanged = true; }
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
  return tx;
}

export async function voidTransaction(id, by = '') {
  const tx = transactions.find((t) => t.id === Number(id));
  if (!tx) return null;
  if (tx.voided) return tx;
  for (const it of tx.items) {
    const p = products.find((x) => x.id === Number(it.productId));
    if (!p) continue;
    const q = Number(it.quantity);
    const reverseDelta = tx.type === 'adjust' ? -q : -((tx.type === 'receive' ? 1 : -1) * q);
    p.stock = (p.stock || 0) + reverseDelta;
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
