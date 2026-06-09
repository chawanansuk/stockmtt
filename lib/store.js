// คลังข้อมูลอย่างง่าย: เก็บสินค้า + ประวัติการตัดสต๊อก ในไฟล์ JSON
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, '..', 'data');
const productsPath = path.join(dataDir, 'products.json');
const txPath = path.join(dataDir, 'transactions.json');

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}
function writeJson(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, p);
}

let products = readJson(productsPath, []);
let transactions = readJson(txPath, []);

export function getProducts() { return products; }
export function getProduct(id) { return products.find((p) => p.id === Number(id)); }
export function getTransactions() { return transactions; }

export function setStock(id, stock) {
  const p = getProduct(id);
  if (!p) return null;
  p.stock = Number(stock);
  writeJson(productsPath, products);
  return p;
}

export function addProduct({ name, category = '', stock = 0 }) {
  const id = products.reduce((m, p) => Math.max(m, p.id || 0), 0) + 1;
  const p = { id, name: String(name).trim(), category: String(category).trim(), stock: Number(stock) || 0 };
  products.push(p);
  writeJson(productsPath, products);
  return p;
}

// ตัดสต๊อก: items = [{ productId, quantity }]
export function commit({ items, note = '', date = '' }) {
  const applied = [];
  for (const it of items) {
    const p = getProduct(it.productId);
    if (!p) continue;
    const qty = Number(it.quantity) || 0;
    if (qty <= 0) continue;
    const before = p.stock || 0;
    p.stock = before - qty;
    applied.push({ productId: p.id, name: p.name, category: p.category, quantity: qty, before, after: p.stock });
  }
  if (applied.length === 0) return null;

  const tx = {
    id: transactions.reduce((m, t) => Math.max(m, t.id || 0), 0) + 1,
    date,
    note,
    items: applied,
    createdAt: new Date().toISOString(),
  };
  transactions.unshift(tx);
  writeJson(productsPath, products);
  writeJson(txPath, transactions);
  return tx;
}
