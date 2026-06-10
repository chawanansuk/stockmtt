// ทดสอบตรรกะ store-pg ด้วย pg-mem (จำลอง PostgreSQL ในหน่วยความจำ)
// รัน: node test/store-pg.test.mjs
import { newDb } from 'pg-mem';
import * as pgstore from '../lib/store-pg.js';

const db = newDb();
const { Pool } = db.adapters.createPg();
pgstore._setPool(new Pool());

let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name); } };

await pgstore.init();

const prods = await pgstore.getProducts();
check('seed products > 0', prods.length > 0);

const first = prods[0];

const rx = await pgstore.commit({ items: [{ productId: first.id, quantity: 5 }], type: 'receive', note: 't' });
check('receive type', rx.type === 'receive');
const afterReceive = (await pgstore.getProduct(first.id)).stock;
check('stock += 5', afterReceive === first.stock + 5);

const upd = await pgstore.updateProduct(first.id, { reorderPoint: 99 });
check('reorderPoint set', upd.reorderPoint === 99);

const dx = await pgstore.commit({ items: [{ productId: first.id, quantity: 2 }], type: 'deduct' });
check('deduct before correct', dx.items[0].before === afterReceive);
check('deduct after = -2', dx.items[0].after === afterReceive - 2);

const v = await pgstore.voidTransaction(dx.id);
check('voided flag', v.voided === true);
check('stock restored after void', (await pgstore.getProduct(first.id)).stock === afterReceive);

const np = await pgstore.addProduct({ name: 'ทดสอบใหม่', category: 'เทส', stock: 7 });
check('addProduct id assigned', np.id > first.id);
check('addProduct fetch', (await pgstore.getProduct(np.id)).name === 'ทดสอบใหม่');

const txs = await pgstore.getTransactions();
check('transactions listed', txs.length >= 2);
check('deduct shows voided in list', txs.find((t) => t.id === dx.id)?.voided === true);

// ระบบจำคำย่อ (alias) — จาก rawText ตอน commit + addAlias โดยตรง
await pgstore.commit({ items: [{ productId: first.id, quantity: 1, rawText: 'ตดเลย ' }], type: 'deduct' });
const aliases = await pgstore.getAliases();
check('alias saved from rawText (trimmed)', aliases.some((a) => a.text === 'ตดเลย' && a.productId === first.id));
await pgstore.addAlias('  ABC  ', np.id);
check('addAlias normalizes + upserts', (await pgstore.getAliases()).some((a) => a.text === 'abc' && a.productId === np.id));

// audit log: actor (ใครทำ) + voidedBy (ใครยกเลิก)
const ax = await pgstore.commit({ items: [{ productId: first.id, quantity: 1 }], type: 'deduct', actor: 'ตั้ม' });
check('commit เก็บ actor', ax.actor === 'ตั้ม');
const av = await pgstore.voidTransaction(ax.id, 'แอน');
check('void เก็บ voidedBy', av.voidedBy === 'แอน');

// soft-delete: ลบแล้วซ่อนจาก getProducts แต่ยังหาเจอ by id และ void คืนสต๊อกได้
check('deleteProduct returns true', (await pgstore.deleteProduct(np.id)) === true);
check('soft-delete หายจาก getProducts', (await pgstore.getProducts()).every((p) => p.id !== np.id));
check('soft-delete ยังหาเจอ by id (สำหรับ void)', (await pgstore.getProduct(np.id))?.id === np.id);
check('deleteProduct missing returns false', (await pgstore.deleteProduct(999999)) === false);

const sp = await pgstore.addProduct({ name: 'จะลบ', category: 'x', stock: 10 });
const sdx = await pgstore.commit({ items: [{ productId: sp.id, quantity: 3 }], type: 'deduct' });
await pgstore.deleteProduct(sp.id);
await pgstore.voidTransaction(sdx.id);
check('void คืนสต๊อกสินค้าที่ถูกลบได้', (await pgstore.getProduct(sp.id)).stock === 10);

// P5: แก้ยอดด้วยมือ → ลงประวัติเป็น adjust (พร้อม actor) + void แล้วคืนยอดเดิม
const adjProd = await pgstore.addProduct({ name: 'ปรับยอด', category: 'x', stock: 50 });
await pgstore.updateProduct(adjProd.id, { stock: 20 }, 'เจ้าของ');
const adjTxs = (await pgstore.getTransactions()).filter((t) => t.type === 'adjust' && t.items[0].productId === adjProd.id);
check('แก้ยอดมือ → มีรายการ adjust', adjTxs.length === 1);
check('adjust เก็บ delta ถูก (-30)', adjTxs[0]?.items[0].quantity === -30);
check('adjust เก็บ actor', adjTxs[0]?.actor === 'เจ้าของ');
await pgstore.voidTransaction(adjTxs[0].id);
check('void adjust คืนยอดเดิม (20→50)', (await pgstore.getProduct(adjProd.id)).stock === 50);

// P5: แก้เฉพาะชื่อ/จุดสั่งซื้อ (ยอดไม่เปลี่ยน) ต้องไม่สร้างรายการ adjust
const beforeCount = (await pgstore.getTransactions()).length;
await pgstore.updateProduct(adjProd.id, { name: 'ปรับยอด2', reorderPoint: 3 });
check('แก้ชื่อ/จุดสั่งซื้อ ไม่สร้าง adjust', (await pgstore.getTransactions()).length === beforeCount);

// P5: กดยกเลิกซ้ำ ต้องไม่คืนสต๊อกซ้ำ (atomic claim ด้วย WHERE voided=false)
const dblProd = await pgstore.addProduct({ name: 'ยกเลิกซ้ำ', category: 'x', stock: 100 });
const dblTx = await pgstore.commit({ items: [{ productId: dblProd.id, quantity: 10 }], type: 'deduct' });
check('ก่อนยกเลิก stock = 90', (await pgstore.getProduct(dblProd.id)).stock === 90);
await pgstore.voidTransaction(dblTx.id);
await pgstore.voidTransaction(dblTx.id);
await pgstore.voidTransaction(dblTx.id);
check('ยกเลิกซ้ำ 3 ครั้ง คืนสต๊อกรอบเดียว (=100)', (await pgstore.getProduct(dblProd.id)).stock === 100);

// P5: สินค้าที่ถูกลบ ตัดสต๊อกไม่ได้ (commit ข้าม → null, ยอดไม่ขยับ)
const delProd = await pgstore.addProduct({ name: 'ถูกลบ', category: 'x', stock: 5 });
await pgstore.deleteProduct(delProd.id);
const delCommit = await pgstore.commit({ items: [{ productId: delProd.id, quantity: 2 }], type: 'deduct' });
check('commit เฉพาะสินค้าที่ถูกลบ → null', delCommit === null);
check('สินค้าที่ถูกลบ สต๊อกไม่เปลี่ยน (=5)', (await pgstore.getProduct(delProd.id)).stock === 5);

// P5: สำรองข้อมูล (exportAll) ครบทุกตาราง + รวมสินค้าที่ถูกลบ
const backup = await pgstore.exportAll();
check('exportAll มี products/transactions/aliases', Array.isArray(backup.products) && Array.isArray(backup.transactions) && Array.isArray(backup.aliases));
check('exportAll รวมสินค้าที่ถูกลบด้วย', backup.products.some((p) => p.id === delProd.id && p.deleted === true));

// P6: getTransactions กรอง/แบ่งหน้า (ไม่ส่ง opts = คืนทั้งหมด)
const allTx = await pgstore.getTransactions();
check('getTransactions() คืนทั้งหมด (backward-compat)', allTx.length > 5);
const onlyAdjust = await pgstore.getTransactions({ type: 'adjust' });
check('กรอง type=adjust', onlyAdjust.length > 0 && onlyAdjust.every((t) => t.type === 'adjust'));
const firstPage = await pgstore.getTransactions({ limit: 3 });
check('limit=3 คืน 3 รายการ', firstPage.length === 3);
check('เรียง id มาก→น้อย', firstPage[0].id > firstPage[2].id);
const nextPage = await pgstore.getTransactions({ limit: 3, before: firstPage[2].id });
check('before(cursor) ได้หน้าถัดไป', nextPage.every((t) => t.id < firstPage[2].id));

// P8a: หน่วยนับ + ราคาทุน (เพิ่ม/แก้/snapshot ลงประวัติ)
const cp = await pgstore.addProduct({ name: 'ท่อทดสอบ', category: 'x', stock: 10, unit: 'เส้น', cost: 35.5 });
check('addProduct เก็บ unit/cost', cp.unit === 'เส้น' && cp.cost === 35.5);
const cpu = await pgstore.updateProduct(cp.id, { unit: 'ถุง', cost: 40 });
check('updateProduct แก้ unit/cost', cpu.unit === 'ถุง' && cpu.cost === 40);
const ctx = await pgstore.commit({ items: [{ productId: cp.id, quantity: 2 }], type: 'deduct' });
check('commit snapshot unit/cost ณ เวลาบันทึก', ctx.items[0].unit === 'ถุง' && ctx.items[0].cost === 40);
await pgstore.updateProduct(cp.id, { cost: 99 });
const oldTx = (await pgstore.getTransactions({ productId: cp.id, type: 'deduct' }))[0];
check('แก้ทุนทีหลัง ประวัติเดิมคงค่าเดิม', oldTx.items[0].cost === 40);

// P8b: นับสต๊อกจริง (stocktake) — ปรับเฉพาะตัวที่ต่าง รวมเป็นใบเดียว + void คืนได้
const sA = await pgstore.addProduct({ name: 'นับA', category: 'x', stock: 10 });
const sB = await pgstore.addProduct({ name: 'นับB', category: 'x', stock: 20 });
const stx = await pgstore.stocktake([
  { productId: sA.id, counted: 7 },   // ต่าง -3
  { productId: sB.id, counted: 20 },  // ตรง → ข้าม
], 'คนนับ');
check('stocktake ใบเดียว เฉพาะตัวที่ต่าง', stx.type === 'adjust' && stx.items.length === 1 && stx.note === 'นับสต๊อกจริง');
check('stocktake ปรับยอดถูก (10→7)', (await pgstore.getProduct(sA.id)).stock === 7);
check('stocktake ตัวที่ตรงไม่ขยับ', (await pgstore.getProduct(sB.id)).stock === 20);
check('stocktake นับตรงหมด → null', (await pgstore.stocktake([{ productId: sB.id, counted: 20 }])) === null);
await pgstore.voidTransaction(stx.id);
check('void ใบนับสต๊อก คืนยอดเดิม (7→10)', (await pgstore.getProduct(sA.id)).stock === 10);

// P8b: ยกเลิกบางแถวในใบ (partial void)
const pvA = await pgstore.addProduct({ name: 'แถวA', category: 'x', stock: 100 });
const pvB = await pgstore.addProduct({ name: 'แถวB', category: 'x', stock: 200 });
const pvTx = await pgstore.commit({ items: [{ productId: pvA.id, quantity: 10 }, { productId: pvB.id, quantity: 5 }], type: 'deduct' });
let pv = await pgstore.voidTransactionItem(pvTx.id, 0, 'แอน');
check('void แถว 0 คืนเฉพาะ A (90→100)', (await pgstore.getProduct(pvA.id)).stock === 100);
check('void แถว 0 ไม่แตะ B (=195)', (await pgstore.getProduct(pvB.id)).stock === 195);
check('ใบยังไม่ถือว่ายกเลิกทั้งใบ', pv.voided === false && pv.items[0].voided === true && pv.items[0].voidedBy === 'แอน');
pv = await pgstore.voidTransactionItem(pvTx.id, 0, 'แอน'); // ซ้ำ
check('void แถวซ้ำ ไม่คืนสต๊อกซ้ำ', (await pgstore.getProduct(pvA.id)).stock === 100);
pv = await pgstore.voidTransactionItem(pvTx.id, 1, 'แอน');
check('ครบทุกแถว → ทั้งใบถูกยกเลิก', pv.voided === true && (await pgstore.getProduct(pvB.id)).stock === 200);

// P8b: void ทั้งใบหลังยกเลิกบางแถวไปแล้ว → คืนเฉพาะแถวที่เหลือ
const pwTx = await pgstore.commit({ items: [{ productId: pvA.id, quantity: 4 }, { productId: pvB.id, quantity: 6 }], type: 'deduct' });
await pgstore.voidTransactionItem(pwTx.id, 0);
await pgstore.voidTransaction(pwTx.id);
check('void ทั้งใบหลัง partial: A คืนรอบเดียว (=100)', (await pgstore.getProduct(pvA.id)).stock === 100);
check('void ทั้งใบหลัง partial: B คืนถูก (=200)', (await pgstore.getProduct(pvB.id)).stock === 200);

console.log(`\n  ผลทดสอบ PG: ผ่าน ${pass} / ไม่ผ่าน ${fail}`);
process.exit(fail ? 1 : 0);
