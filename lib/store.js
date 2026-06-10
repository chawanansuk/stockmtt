// เลือกที่เก็บข้อมูลอัตโนมัติ:
//   - มี DATABASE_URL  → ใช้ PostgreSQL (ออนไลน์ ข้อมูลถาวร)
//   - ไม่มี            → ใช้ไฟล์ JSON (รันในเครื่อง)
import * as jsonStore from './store-json.js';

let store = jsonStore;
if (process.env.DATABASE_URL) {
  store = await import('./store-pg.js');
  console.log('  📦 ใช้ฐานข้อมูล PostgreSQL (ข้อมูลถาวร)');
} else {
  console.log('  📁 ใช้ไฟล์ JSON ในเครื่อง (data/)');
}

export const init = (...a) => store.init(...a);
export const getProducts = (...a) => store.getProducts(...a);
export const getProduct = (...a) => store.getProduct(...a);
export const getTransactions = (...a) => store.getTransactions(...a);
export const getAliases = (...a) => store.getAliases(...a);
export const addAlias = (...a) => store.addAlias(...a);
export const updateProduct = (...a) => store.updateProduct(...a);
export const addProduct = (...a) => store.addProduct(...a);
export const deleteProduct = (...a) => store.deleteProduct(...a);
export const commit = (...a) => store.commit(...a);
export const voidTransaction = (...a) => store.voidTransaction(...a);
export const exportAll = (...a) => store.exportAll(...a);
