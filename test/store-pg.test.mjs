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

// ลบสินค้า
check('deleteProduct returns true', (await pgstore.deleteProduct(np.id)) === true);
check('deleted product gone', (await pgstore.getProduct(np.id)) === undefined);
check('deleteProduct missing returns false', (await pgstore.deleteProduct(999999)) === false);

console.log(`\n  ผลทดสอบ PG: ผ่าน ${pass} / ไม่ผ่าน ${fail}`);
process.exit(fail ? 1 : 0);
