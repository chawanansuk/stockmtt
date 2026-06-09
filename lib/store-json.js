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

export async function getProducts() { return products; }
export async function getProduct(id) { return products.find((p) => p.id === Number(id)); }
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

export async function updateProduct(id, fields = {}) {
  const p = products.find((x) => x.id === Number(id));
  if (!p) return null;
  if (fields.stock !== undefined && Number.isFinite(Number(fields.stock))) p.stock = Number(fields.stock);
  if (fields.reorderPoint !== undefined && Number.isFinite(Number(fields.reorderPoint))) {
    p.reorderPoint = Math.max(0, Number(fields.reorderPoint));
  }
  if (fields.name !== undefined && String(fields.name).trim()) p.name = String(fields.name).trim();
  if (fields.category !== undefined) p.category = String(fields.category).trim();
  writeJson(productsPath, products);
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

export async function deleteProduct(id) {
  const i = products.findIndex((x) => x.id === Number(id));
  if (i < 0) return false;
  products.splice(i, 1);
  writeJson(productsPath, products);
  return true;
}

export async function commit({ items, note = '', date = '', type = 'deduct' }) {
  const sign = type === 'receive' ? 1 : -1;
  const applied = [];
  let aliasChanged = false;
  for (const it of items) {
    const p = products.find((x) => x.id === Number(it.productId));
    if (!p) continue;
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

export async function voidTransaction(id) {
  const tx = transactions.find((t) => t.id === Number(id));
  if (!tx) return null;
  if (tx.voided) return tx;
  const sign = tx.type === 'receive' ? 1 : -1;
  for (const it of tx.items) {
    const p = products.find((x) => x.id === Number(it.productId));
    if (p) p.stock = (p.stock || 0) - sign * it.quantity;
  }
  tx.voided = true;
  tx.voidedAt = new Date().toISOString();
  writeJson(productsPath, products);
  writeJson(txPath, transactions);
  return tx;
}
