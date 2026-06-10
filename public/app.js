// ลงทะเบียน service worker (PWA) — ย้ายมาจาก index.html เพื่อให้ CSP เข้มขึ้นได้
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// แตะช่องตัวเลขแล้วเลือกเลขทั้งหมด (พิมพ์ทับได้ทันที) — ครอบคลุมช่องที่สร้างทีหลังด้วย
document.addEventListener('focusin', (e) => {
  if (e.target.matches && e.target.matches('input[type="number"]')) e.target.select();
});

let PRODUCTS = [];
let MODE = 'deduct'; // 'deduct' = ตัดออก, 'receive' = รับเข้า
let currentImage = null;
let extractedDate = '';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const skeleton = (n) => '<div class="skel"></div>'.repeat(n);

// แบนเนอร์ "เซิร์ฟเวอร์กำลังเริ่ม" จะโผล่ถ้าคำขอช้าผิดปกติ (Render free ตื่นจากพักหลับ)
let wakingTimer = null;
let wakingCount = 0;
function wakingStart() {
  wakingCount++;
  if (!wakingTimer) wakingTimer = setTimeout(() => { const b = $('#waking-banner'); if (b) b.hidden = false; }, 3500);
}
function wakingStop() {
  wakingCount = Math.max(0, wakingCount - 1);
  if (wakingCount === 0) {
    if (wakingTimer) { clearTimeout(wakingTimer); wakingTimer = null; }
    const b = $('#waking-banner'); if (b) b.hidden = true;
  }
}

// fetch + JSON พร้อม timeout และ retry (เฉพาะ GET ที่ปลอดภัย) กัน cold-start ค้าง
async function api(path, opts = {}) {
  const isGet = !opts.method || opts.method === 'GET';
  const { timeout = 45000, retries = isGet ? 2 : 0, ...fetchOpts } = opts;
  let lastErr;
  wakingStart();
  try {
    for (let attempt = 0; attempt <= retries; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeout);
      try {
        const res = await fetch(path, { ...fetchOpts, signal: ctrl.signal });
        clearTimeout(timer);
        if (!res.ok) {
          const e = await res.json().catch(() => ({}));
          if (res.status === 401 && e.code === 'AUTH') { showLogin(); throw new Error('ต้องเข้าสู่ระบบ'); }
          if ([502, 503, 504].includes(res.status) && attempt < retries) { lastErr = new Error(e.error || 'HTTP ' + res.status); await wait(1000 * 2 ** attempt); continue; }
          throw new Error(e.error || 'HTTP ' + res.status);
        }
        return await res.json();
      } catch (err) {
        clearTimeout(timer);
        if (err.message === 'ต้องเข้าสู่ระบบ') throw err;
        lastErr = err.name === 'AbortError'
          ? new Error('เซิร์ฟเวอร์ตอบช้า (อาจกำลังตื่นจากพักหลับ) ลองใหม่อีกครั้ง')
          : err;
        if (attempt < retries) { await wait(1000 * 2 ** attempt); continue; }
        throw lastErr;
      }
    }
    throw lastErr;
  } finally {
    wakingStop();
  }
}

const baht = (n) => '฿' + Number(n).toLocaleString('th-TH', { maximumFractionDigits: 2 });
const unitSuffix = (p) => (p && p.unit ? ' ' + p.unit : '');

const isLow = (p) => {
  const s = Number(p.stock) || 0;
  const r = Number(p.reorderPoint) || 0;
  return (r > 0 && s <= r) || s < 0;
};

// ---------- แท็บ ----------
$$('.tab').forEach((t) =>
  t.addEventListener('click', () => {
    $$('.tab').forEach((x) => x.classList.remove('active'));
    $$('.panel').forEach((x) => x.classList.remove('active'));
    t.classList.add('active');
    $('#tab-' + t.dataset.tab).classList.add('active');
    try { localStorage.setItem('stockmtt.tab', t.dataset.tab); } catch {}
    if (t.dataset.tab === 'stock') { renderReorderBanner(); renderStock(); }
    if (t.dataset.tab === 'history') renderHistory();
  })
);
function restoreTab() {
  let saved = '';
  try { saved = localStorage.getItem('stockmtt.tab') || ''; } catch {}
  if (saved && saved !== 'deduct') {
    const btn = $(`.tab[data-tab="${saved}"]`);
    if (btn) btn.click();
  }
}

// ---------- โหมด ตัดออก / รับเข้า ----------
$$('.mode-btn').forEach((b) =>
  b.addEventListener('click', () => {
    $$('.mode-btn').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    MODE = b.dataset.mode;
    updateModeUI();
  })
);
function countValidItems() {
  let n = 0;
  for (const card of $$('.review-card')) {
    if (Number($('.prod-select', card).value) > 0 && Number($('.qty-input', card).value) > 0) n++;
  }
  return n;
}
function updateCommitButton() {
  const verb = MODE === 'receive' ? 'ยืนยันรับเข้า' : 'ยืนยันตัดออก';
  const n = countValidItems();
  const btn = $('#btn-commit');
  btn.textContent = n > 0 ? `✅ ${verb} (${n} รายการ)` : `✅ ${verb}`;
  btn.disabled = n === 0;
}
function updateModeUI() {
  $$('.review-card').forEach((c) => c._update && c._update());
  updateCommitButton();
}

// ---------- ย่อรูปก่อนส่ง ----------
function fileToResizedDataURL(file, maxDim = 1600, quality = 0.85) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      let { width, height } = img;
      const longEdge = Math.max(width, height);
      if (longEdge > maxDim) {
        const s = maxDim / longEdge;
        width = Math.round(width * s);
        height = Math.round(height * s);
      }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      canvas.getContext('2d').drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('โหลดรูปไม่สำเร็จ')); };
    img.src = url;
  });
}

// ---------- ตัด/รับ จากรูป ----------
$('#photo').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    currentImage = await fileToResizedDataURL(file);
    const prev = $('#preview');
    prev.src = currentImage;
    prev.hidden = false;
    $('#btn-extract').hidden = false;
    $('#review').hidden = true;
    $('#commit-result').hidden = true;
    setStatus('');
  } catch (err) {
    setStatus(err.message, true);
  }
});

function setStatus(msg, isError = false) {
  const el = $('#extract-status');
  el.textContent = msg;
  el.classList.toggle('error', isError);
}

$('#btn-extract').addEventListener('click', async () => {
  if (!currentImage) return;
  const btn = $('#btn-extract');
  btn.disabled = true;
  setStatus('⏳ กำลังอ่านรูป... (อาจใช้เวลาสักครู่)');
  try {
    const data = await api('/api/extract', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: currentImage, mode: MODE }),
    });
    extractedDate = data.date || '';
    renderReview(data.items || []);
    setStatus(`อ่านได้ ${data.items?.length || 0} รายการ`);
  } catch (err) {
    setStatus('❌ ' + err.message, true);
  } finally {
    btn.disabled = false;
  }
});

function buildProductSelect(selectedId) {
  const sel = document.createElement('select');
  sel.className = 'prod-select';
  const none = document.createElement('option');
  none.value = '0';
  none.textContent = '— ไม่บันทึก / เลือกสินค้า —';
  sel.appendChild(none);

  const byCat = {};
  for (const p of PRODUCTS) (byCat[p.category] ||= []).push(p);
  for (const cat of Object.keys(byCat)) {
    const og = document.createElement('optgroup');
    og.label = cat || 'อื่น ๆ';
    for (const p of byCat[cat]) {
      const o = document.createElement('option');
      o.value = String(p.id);
      o.textContent = `${p.name} (คงเหลือ ${p.stock}${unitSuffix(p)})`;
      if (p.id === selectedId) o.selected = true;
      og.appendChild(o);
    }
    sel.appendChild(og);
  }
  return sel;
}

function makeReviewCard(item) {
  const card = document.createElement('div');
  card.className = 'review-card';
  card._rawText = item.rawText || ''; // เก็บไว้ส่งให้ระบบจำคำย่อตอนยืนยัน

  const conf = item.confidence || 'low';
  const confLabel = { high: 'มั่นใจสูง', medium: 'ปานกลาง', low: 'ไม่แน่ใจ' }[conf] || conf;

  const raw = document.createElement('div');
  raw.className = 'raw';
  if (item.rawText) {
    const badge = document.createElement('span');
    badge.className = 'badge ' + conf;
    badge.textContent = confLabel;
    raw.appendChild(badge);
    const t = document.createElement('span');
    t.textContent = 'อ่านได้: “' + item.rawText + '”';
    raw.appendChild(t);
  }
  card.appendChild(raw);

  const row2 = document.createElement('div');
  row2.className = 'row2';
  const grow = document.createElement('div');
  grow.className = 'grow';
  const sel = buildProductSelect(item.productId || 0);
  grow.appendChild(sel);

  const qty = document.createElement('input');
  qty.type = 'number';
  qty.className = 'qty-input';
  qty.min = '0';
  qty.inputMode = 'numeric';
  qty.value = item.quantity || 1;
  qty.addEventListener('input', () => { if (qty.value !== '' && Number(qty.value) < 0) qty.value = '0'; });

  const del = document.createElement('button');
  del.className = 'del-btn';
  del.textContent = '🗑';
  del.title = 'ลบรายการนี้';
  del.addEventListener('click', () => { card.remove(); updateCommitButton(); });

  row2.appendChild(grow);
  row2.appendChild(qty);
  row2.appendChild(del);
  card.appendChild(row2);

  const after = document.createElement('div');
  after.className = 'after';
  card.appendChild(after);

  const update = () => {
    const pid = Number(sel.value);
    const p = PRODUCTS.find((x) => x.id === pid);
    const q = Number(qty.value) || 0;
    if (!p) {
      after.innerHTML = '';
    } else {
      const delta = MODE === 'receive' ? q : -q;
      const remain = (p.stock || 0) + delta;
      const sign = MODE === 'receive' ? '+' : '−';
      after.innerHTML =
        `คงเหลือ ${p.stock} → <b class="${remain < 0 ? 'neg' : ''}">${remain}</b> <span class="muted">(${sign}${q}${unitSuffix(p)})</span>` +
        (remain < 0 ? ' ⚠️ ติดลบ' : '');
    }
    updateCommitButton();
  };
  card._update = update;
  sel.addEventListener('change', update);
  qty.addEventListener('input', update);
  update();

  return card;
}

function renderReview(items) {
  const list = $('#review-list');
  list.innerHTML = '';
  for (const it of items) list.appendChild(makeReviewCard(it));
  $('#review-date').textContent = extractedDate ? 'วันที่บนใบ: ' + extractedDate : '';
  updateModeUI();
  $('#review').hidden = false;
  $('#commit-result').hidden = true;
  $('#review').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

$('#btn-add-row').addEventListener('click', () => {
  $('#review-list').appendChild(makeReviewCard({ rawText: '', quantity: 1, productId: 0, confidence: 'low' }));
});

$('#btn-commit').addEventListener('click', async () => {
  const items = [];
  for (const card of $$('.review-card')) {
    const pid = Number($('.prod-select', card).value);
    const q = Number($('.qty-input', card).value);
    if (pid > 0 && q > 0) items.push({ productId: pid, quantity: q, rawText: card._rawText || '' });
  }
  if (!items.length) { alert('ยังไม่มีรายการ (เลือกสินค้าและใส่จำนวน)'); return; }

  const actor = $('#actor').value.trim();
  try { localStorage.setItem('stockmtt.actor', actor); } catch {}

  const btn = $('#btn-commit');
  btn.disabled = true;
  try {
    const out = await api('/api/commit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items, note: $('#deduct-note').value, date: extractedDate, type: MODE, actor }),
    });
    PRODUCTS = out.products;
    updateLowBadge();
    showCommitResult(out.transaction);
  } catch (err) {
    alert('ผิดพลาด: ' + err.message);
  } finally {
    btn.disabled = false;
  }
});

function showCommitResult(tx) {
  $('#review').hidden = true;
  const sign = tx.type === 'receive' ? '+' : '−';
  const verb = tx.type === 'receive' ? 'รับเข้า' : 'ตัดออก';
  const rows = tx.items
    .map((i) => `<li>${esc(i.name)} <b>${sign}${i.quantity}</b> (เหลือ ${i.after})</li>`)
    .join('');
  const box = $('#commit-result');
  box.innerHTML = `<h2>✅ ${verb}แล้ว ${tx.items.length} รายการ</h2><ul>${rows}</ul>`;
  box.hidden = false;

  currentImage = null;
  extractedDate = '';
  $('#photo').value = '';
  $('#preview').hidden = true;
  $('#btn-extract').hidden = true;
  $('#deduct-note').value = '';
  setStatus('');
  box.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---------- สต๊อก ----------
function updateLowBadge() {
  const n = PRODUCTS.filter(isLow).length;
  const b = $('#low-badge');
  if (n > 0) { b.textContent = n; b.hidden = false; } else b.hidden = true;
}

function renderReorderBanner() {
  const low = PRODUCTS.filter(isLow);
  const box = $('#reorder-banner');
  if (!low.length) { box.hidden = true; return; }
  const items = low
    .map(
      (p) =>
        `<li>${esc(p.name)} <b>เหลือ ${p.stock}${esc(unitSuffix(p))}</b>` +
        (p.reorderPoint > 0 ? ` <span class="muted">(จุดสั่ง ${p.reorderPoint})</span>` : '') +
        `</li>`
    )
    .join('');
  box.innerHTML = `<h2>⚠️ ต้องสั่งซื้อ ${low.length} รายการ</h2><ul>${items}</ul>`;
  box.hidden = false;
}

// ---------- จำฟิลเตอร์ล่าสุด (localStorage) + toast ----------
const FILTERS_KEY = 'stockmtt.filters';
let pendingCat = '';
function saveFilters() {
  try {
    localStorage.setItem(FILTERS_KEY, JSON.stringify({
      q: $('#stock-search').value,
      cat: $('#filter-category').value,
      low: $('#filter-low').checked,
      neg: $('#filter-neg').checked,
      sort: $('#sort-by').value,
    }));
  } catch {}
}
function loadFilters() {
  let f = {};
  try { f = JSON.parse(localStorage.getItem(FILTERS_KEY) || '{}'); } catch {}
  if (f.q) $('#stock-search').value = f.q;
  if (f.low) $('#filter-low').checked = true;
  if (f.neg) $('#filter-neg').checked = true;
  if (f.sort) $('#sort-by').value = f.sort;
  pendingCat = f.cat || ''; // ตัวเลือกหมวดถูกสร้างทีหลัง → เก็บไว้ใช้ตอน refreshCategories
}

function showToast(msg) {
  let t = $('#toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; t.className = 'toast'; document.body.appendChild(t); }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => t.classList.remove('show'), 2000);
}

// เติมตัวเลือกหมวด/โกดังในดรอปดาวน์ (คงค่าที่เลือกไว้ถ้ายังมีอยู่)
function refreshCategories() {
  const sel = $('#filter-category');
  if (!sel) return;
  const cur = sel.value || pendingCat;
  const cats = [...new Set(PRODUCTS.map((p) => p.category || '').filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'th'));
  sel.innerHTML =
    '<option value="">ทุกหมวด/โกดัง</option>' +
    cats.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
  sel.value = cats.includes(cur) ? cur : '';
  pendingCat = '';
}

function makeStockItem(p) {
  const row = document.createElement('div');
  row.className = 'stock-item' + (isLow(p) ? ' low' : '');

  // หัวข้อ: ชื่อ + หมวด + ปุ่มแก้ไข
  const info = document.createElement('div');
  info.className = 'info';
  const nm = document.createElement('div');
  nm.className = 'name';
  nm.textContent = p.name;
  const cat = document.createElement('div');
  cat.className = 'cat';
  const renderCatLine = () => {
    const bits = [p.category || ''];
    if (p.unit) bits.push('หน่วย: ' + p.unit);
    if (p.cost > 0) bits.push(`ทุน ${baht(p.cost)} • มูลค่า ${baht((p.stock || 0) * p.cost)}`);
    cat.textContent = bits.filter(Boolean).join(' • ');
  };
  renderCatLine();
  info.appendChild(nm);
  info.appendChild(cat);

  const histToggle = document.createElement('button');
  histToggle.className = 'hist-toggle';
  histToggle.textContent = '📜';
  histToggle.title = 'ดูการเคลื่อนไหวของสินค้านี้';
  histToggle.addEventListener('click', () => {
    historyProductId = p.id;
    historyProductName = p.name;
    $('.tab[data-tab="history"]').click(); // สลับไปแท็บประวัติ → renderHistory จะกรองตาม productId
  });

  const editToggle = document.createElement('button');
  editToggle.className = 'edit-toggle';
  editToggle.textContent = '✎';
  editToggle.title = 'แก้ไข/ลบสินค้า';

  const head = document.createElement('div');
  head.className = 'item-head';
  head.appendChild(info);
  head.appendChild(histToggle);
  head.appendChild(editToggle);

  // ยอดคงเหลือ / จุดสั่งซื้อ / บันทึก
  const fields = document.createElement('div');
  fields.className = 'sfields';

  const sWrap = document.createElement('label');
  sWrap.className = 'mini';
  sWrap.innerHTML = `<span>ยอดคงเหลือ${p.unit ? ' (' + esc(p.unit) + ')' : ''}</span>`;
  const sInput = document.createElement('input');
  sInput.type = 'number';
  sInput.inputMode = 'numeric';
  sInput.value = p.stock;
  sWrap.appendChild(sInput);

  const rWrap = document.createElement('label');
  rWrap.className = 'mini';
  rWrap.innerHTML = '<span>จุดสั่งซื้อ</span>';
  const rInput = document.createElement('input');
  rInput.type = 'number';
  rInput.min = '0';
  rInput.inputMode = 'numeric';
  rInput.value = p.reorderPoint || 0;
  rWrap.appendChild(rInput);

  const save = document.createElement('button');
  save.className = 'save';
  save.textContent = 'บันทึก';
  save.addEventListener('click', async () => {
    const newStock = Number(sInput.value);
    const newReorder = Number(rInput.value);
    if (sInput.value.trim() === '' || !Number.isFinite(newStock) || !Number.isFinite(newReorder)) {
      alert('กรอกตัวเลขให้ถูกต้อง'); return;
    }
    if (newReorder < 0) { alert('จุดสั่งซื้อต้องไม่ติดลบ'); return; }
    // เปลี่ยนยอดเยอะ ๆ ให้ยืนยันก่อน (กันพิมพ์พลาด)
    if (Math.abs(newStock - (p.stock || 0)) >= 100 &&
        !confirm(`ยืนยันแก้ยอด "${p.name}" จาก ${p.stock} เป็น ${newStock}?`)) return;
    save.disabled = true;
    try {
      const updated = await api(`/api/products/${p.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stock: newStock, reorderPoint: newReorder, actor: localStorage.getItem('stockmtt.actor') || '' }),
      });
      p.stock = updated.stock;
      p.reorderPoint = updated.reorderPoint;
      row.className = 'stock-item' + (isLow(p) ? ' low' : '');
      renderCatLine();
      updateStockSummary();
      updateLowBadge();
      renderReorderBanner();
      showToast('บันทึกแล้ว');
    } catch (err) {
      alert(err.message);
    } finally {
      save.disabled = false;
    }
  });

  fields.appendChild(sWrap);
  fields.appendChild(rWrap);
  fields.appendChild(save);

  // แผงแก้ไขชื่อ/หมวด + ลบ (ซ่อนไว้ กดปุ่ม ✎ เพื่อเปิด)
  const edit = document.createElement('div');
  edit.className = 'edit-panel';
  edit.hidden = true;

  const neWrap = document.createElement('label');
  neWrap.className = 'field';
  neWrap.innerHTML = '<span>ชื่อสินค้า</span>';
  const nInput = document.createElement('input');
  nInput.type = 'text';
  nInput.value = p.name;
  neWrap.appendChild(nInput);

  const ceWrap = document.createElement('label');
  ceWrap.className = 'field';
  ceWrap.innerHTML = '<span>หมวด/โกดัง</span>';
  const cInput = document.createElement('input');
  cInput.type = 'text';
  cInput.value = p.category || '';
  ceWrap.appendChild(cInput);

  const uWrap = document.createElement('label');
  uWrap.className = 'field';
  uWrap.innerHTML = '<span>หน่วยนับ (เช่น ตัว/เส้น/ถุง)</span>';
  const uInput = document.createElement('input');
  uInput.type = 'text';
  uInput.value = p.unit || '';
  uWrap.appendChild(uInput);

  const costWrap = document.createElement('label');
  costWrap.className = 'field';
  costWrap.innerHTML = '<span>ราคาทุนต่อหน่วย (บาท)</span>';
  const costInput = document.createElement('input');
  costInput.type = 'number';
  costInput.min = '0';
  costInput.step = '0.01';
  costInput.inputMode = 'decimal';
  costInput.value = p.cost || 0;
  costWrap.appendChild(costInput);

  const editActions = document.createElement('div');
  editActions.className = 'edit-actions';
  const saveEdit = document.createElement('button');
  saveEdit.className = 'save';
  saveEdit.textContent = 'บันทึกแก้ไข';
  const delBtn = document.createElement('button');
  delBtn.className = 'danger';
  delBtn.textContent = '🗑 ลบสินค้า';

  saveEdit.addEventListener('click', async () => {
    const name = nInput.value.trim();
    if (!name) { alert('ใส่ชื่อสินค้า'); return; }
    const cost = Number(costInput.value);
    if (costInput.value !== '' && (!Number.isFinite(cost) || cost < 0)) { alert('ราคาทุนไม่ถูกต้อง'); return; }
    saveEdit.disabled = true;
    try {
      const updated = await api(`/api/products/${p.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, category: cInput.value, unit: uInput.value, cost: costInput.value === '' ? 0 : cost }),
      });
      p.name = updated.name;
      p.category = updated.category;
      p.unit = updated.unit;
      p.cost = updated.cost;
      renderStock();
      showToast('บันทึกการแก้ไขแล้ว');
    } catch (err) {
      alert(err.message);
    } finally {
      saveEdit.disabled = false;
    }
  });

  delBtn.addEventListener('click', async () => {
    if (!confirm(`ลบสินค้า "${p.name}" ?\n(ประวัติเดิมยังอยู่ แต่จะเพิ่ม/ตัดสต๊อกสินค้านี้ไม่ได้อีก)`)) return;
    delBtn.disabled = true;
    try {
      await api(`/api/products/${p.id}`, { method: 'DELETE' });
      const i = PRODUCTS.findIndex((x) => x.id === p.id);
      if (i >= 0) PRODUCTS.splice(i, 1);
      renderStock();
      updateLowBadge();
      renderReorderBanner();
      showToast('ลบสินค้าแล้ว');
    } catch (err) {
      alert(err.message);
      delBtn.disabled = false;
    }
  });

  editActions.appendChild(saveEdit);
  editActions.appendChild(delBtn);
  edit.appendChild(neWrap);
  edit.appendChild(ceWrap);
  edit.appendChild(uWrap);
  edit.appendChild(costWrap);
  edit.appendChild(editActions);

  editToggle.addEventListener('click', () => {
    edit.hidden = !edit.hidden;
    editToggle.classList.toggle('open', !edit.hidden);
  });

  row.appendChild(head);
  row.appendChild(fields);
  row.appendChild(edit);
  return row;
}

const STOCK_PAGE = 40;
let stockView = [];
let stockShown = 0;
let stockObserver = null;

function renderStock() {
  refreshCategories();
  const q = $('#stock-search').value.trim().toLowerCase();
  const onlyLow = $('#filter-low').checked;
  const onlyNeg = $('#filter-neg').checked;
  const cat = $('#filter-category').value;
  const sort = $('#sort-by').value;

  let items = PRODUCTS.filter(
    (p) => !q || p.name.toLowerCase().includes(q) || (p.category || '').toLowerCase().includes(q)
  );
  if (cat) items = items.filter((p) => (p.category || '') === cat);
  if (onlyLow) items = items.filter(isLow);
  if (onlyNeg) items = items.filter((p) => (Number(p.stock) || 0) < 0);
  if (sort === 'name') items = [...items].sort((a, b) => a.name.localeCompare(b.name, 'th'));
  else if (sort === 'stock-asc') items = [...items].sort((a, b) => (a.stock || 0) - (b.stock || 0));
  else if (sort === 'stock-desc') items = [...items].sort((a, b) => (b.stock || 0) - (a.stock || 0));

  // render เป็นชุด ๆ (กัน DOM หนักตอนมีหลายร้อยรายการ — โหลดต่อเมื่อเลื่อนใกล้ท้าย)
  stockView = items;
  updateStockSummary();
  stockShown = 0;
  const list = $('#stock-list');
  list.innerHTML = '';
  if (!items.length) { list.innerHTML = '<p class="muted">ไม่พบสินค้า</p>'; return; }
  appendStockBatch();
}

// จำนวน + มูลค่ารวม (ตามที่กรองอยู่) — โชว์มูลค่าเฉพาะเมื่อมีสินค้าที่ใส่ราคาทุนแล้ว
function updateStockSummary() {
  const value = stockView.reduce((s, p) => s + (p.cost > 0 ? (Number(p.stock) || 0) * p.cost : 0), 0);
  const withCost = stockView.filter((p) => p.cost > 0).length;
  let text = `สินค้า ${stockView.length} / ${PRODUCTS.length} รายการ`;
  if (withCost > 0) {
    text += ` • มูลค่ารวม ${baht(value)}`;
    if (withCost < stockView.length) text += ` (จาก ${withCost} รายการที่ใส่ทุนแล้ว)`;
  }
  $('#stock-count').textContent = text;
}

function appendStockBatch() {
  const list = $('#stock-list');
  const old = $('#stock-sentinel');
  if (old) old.remove();
  const end = Math.min(stockShown + STOCK_PAGE, stockView.length);
  const frag = document.createDocumentFragment();
  for (let i = stockShown; i < end; i++) frag.appendChild(makeStockItem(stockView[i]));
  list.appendChild(frag);
  stockShown = end;

  if (stockObserver) { stockObserver.disconnect(); stockObserver = null; }
  if (stockShown < stockView.length) {
    const sentinel = document.createElement('div');
    sentinel.id = 'stock-sentinel';
    list.appendChild(sentinel);
    stockObserver = new IntersectionObserver(
      (entries) => { if (entries.some((e) => e.isIntersecting)) appendStockBatch(); },
      { rootMargin: '400px' }
    );
    stockObserver.observe(sentinel);
  }
}

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
const onFilterChange = () => { saveFilters(); renderStock(); };
$('#stock-search').addEventListener('input', debounce(onFilterChange, 200));
$('#filter-low').addEventListener('change', onFilterChange);
$('#filter-neg').addEventListener('change', onFilterChange);
$('#filter-category').addEventListener('change', onFilterChange);
$('#sort-by').addEventListener('change', onFilterChange);
loadFilters();
try { $('#actor').value = localStorage.getItem('stockmtt.actor') || ''; } catch {}

// ล้างฟิลเตอร์ทั้งหมดในคลิกเดียว
$('#clear-filters').addEventListener('click', () => {
  $('#stock-search').value = '';
  $('#filter-category').value = '';
  $('#sort-by').value = 'default';
  $('#filter-low').checked = false;
  $('#filter-neg').checked = false;
  pendingCat = '';
  saveFilters();
  renderStock();
});

// ปุ่มลอยกลับขึ้นบนสุด (โผล่เมื่อเลื่อนลงเยอะ)
const toTopBtn = $('#to-top');
if (toTopBtn) {
  addEventListener('scroll', () => { toTopBtn.hidden = scrollY < 600; }, { passive: true });
  toTopBtn.addEventListener('click', () => scrollTo({ top: 0, behavior: 'smooth' }));
}

$('#btn-add-product').addEventListener('click', async () => {
  const name = $('#add-name').value.trim();
  if (!name) { alert('ใส่ชื่อสินค้า'); return; }
  try {
    const p = await api('/api/products', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        category: $('#add-category').value,
        stock: Number($('#add-stock').value) || 0,
        unit: $('#add-unit').value,
        cost: Number($('#add-cost').value) || 0,
      }),
    });
    PRODUCTS.push(p);
    $('#add-name').value = '';
    $('#add-category').value = '';
    $('#add-stock').value = '0';
    $('#add-unit').value = '';
    $('#add-cost').value = '0';
    renderStock();
    updateLowBadge();
    showToast('เพิ่มสินค้าแล้ว');
  } catch (err) {
    alert(err.message);
  }
});

// ---------- ประวัติ (กรอง + แบ่งหน้า) ----------
const HISTORY_PAGE = 50;
let historyProductId = null;
let historyProductName = '';
let historyCursor = null; // id ของรายการสุดท้ายที่โหลด (ใช้เป็น cursor "before")
let historyEnded = false;
let historyLoading = false;

function makeTxCard(tx) {
  const when = new Date(tx.createdAt).toLocaleString('th-TH');
  const isAdjust = tx.type === 'adjust';
  const verb = tx.type === 'receive' ? 'รับเข้า' : isAdjust ? 'ปรับยอด' : 'ตัดออก';
  const rows = tx.items
    .map((i) => {
      if (isAdjust) {
        const d = Number(i.quantity);
        return `<li>${esc(i.name)} <b>${i.before} → ${i.after}</b> <span class="muted">(${d >= 0 ? '+' : ''}${d})</span></li>`;
      }
      const sign = tx.type === 'receive' ? '+' : '−';
      return `<li>${esc(i.name)} <b>${sign}${i.quantity}${i.unit ? ' ' + esc(i.unit) : ''}</b> (เหลือ ${i.after})</li>`;
    })
    .join('');

  const div = document.createElement('div');
  div.className = 'tx' + (tx.voided ? ' voided' : '');
  div.innerHTML =
    `<div class="tx-head"><span>${when}${tx.date ? ' • ใบลงวันที่ ' + esc(tx.date) : ''}</span>` +
    `<span class="tx-type ${tx.type}">${verb}${tx.voided ? ' • ยกเลิกแล้ว' : ''}</span></div>` +
    (tx.note ? `<div class="muted small">📝 ${esc(tx.note)}</div>` : '') +
    (tx.actor ? `<div class="muted small">👤 โดย ${esc(tx.actor)}</div>` : '') +
    (tx.voided && tx.voidedBy ? `<div class="muted small">↩ ยกเลิกโดย ${esc(tx.voidedBy)}</div>` : '') +
    `<ul>${rows}</ul>`;

  if (!tx.voided) {
    const btn = document.createElement('button');
    btn.className = 'void-btn';
    btn.textContent = '↩ ยกเลิก (คืนสต๊อก)';
    btn.addEventListener('click', async () => {
      if (!confirm('ยกเลิกรายการนี้และคืนสต๊อกกลับ?')) return;
      btn.disabled = true;
      try {
        const out = await api(`/api/transactions/${tx.id}/void`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ by: localStorage.getItem('stockmtt.actor') || '' }),
        });
        PRODUCTS = out.products;
        updateLowBadge();
        renderHistory();
      } catch (err) {
        alert(err.message);
        btn.disabled = false;
      }
    });
    div.appendChild(btn);
  }
  return div;
}

function historyQuery(before) {
  const params = new URLSearchParams();
  params.set('limit', String(HISTORY_PAGE));
  const type = $('#history-type').value;
  const from = $('#history-from').value;
  const to = $('#history-to').value;
  if (type) params.set('type', type);
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  if (historyProductId) params.set('productId', String(historyProductId));
  if (before) params.set('before', String(before));
  return '/api/transactions?' + params.toString();
}

async function renderHistory(reset = true) {
  const list = $('#history-list');
  const moreBtn = $('#history-more');
  if (historyLoading) return;
  historyLoading = true;
  moreBtn.hidden = true;

  // แบนเนอร์ "กรองเฉพาะสินค้า"
  const pf = $('#history-product-filter');
  if (historyProductId) {
    pf.innerHTML = `🔎 เฉพาะ: <b>${esc(historyProductName)}</b> <button id="history-pf-clear" class="link-btn">✕ ดูทั้งหมด</button>`;
    pf.hidden = false;
    $('#history-pf-clear').addEventListener('click', () => { historyProductId = null; historyProductName = ''; renderHistory(); });
  } else {
    pf.hidden = true;
  }

  if (reset) { historyCursor = null; historyEnded = false; list.innerHTML = skeleton(4); }
  try {
    const txs = await api(historyQuery(reset ? null : historyCursor));
    if (reset) list.innerHTML = '';
    if (reset && !txs.length) { list.innerHTML = '<p class="muted">ไม่พบประวัติ</p>'; return; }
    for (const tx of txs) list.appendChild(makeTxCard(tx));
    if (txs.length) historyCursor = txs[txs.length - 1].id;
    historyEnded = txs.length < HISTORY_PAGE;
    moreBtn.hidden = historyEnded;
  } catch (err) {
    if (reset) list.innerHTML = `<p class="status error">${esc(err.message)}</p>`;
    else alert(err.message);
  } finally {
    historyLoading = false;
  }
}

$('#history-more').addEventListener('click', () => renderHistory(false));
$('#history-type').addEventListener('change', () => renderHistory());
$('#history-from').addEventListener('change', () => renderHistory());
$('#history-to').addEventListener('change', () => renderHistory());
$('#history-clear').addEventListener('click', () => {
  $('#history-type').value = '';
  $('#history-from').value = '';
  $('#history-to').value = '';
  historyProductId = null;
  historyProductName = '';
  renderHistory();
});

// ---------- ส่งออก Excel (.csv รองรับภาษาไทย) ----------
function csvCell(v) {
  const s = String(v == null ? '' : v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function downloadCSV(filename, rows) {
  const csv = rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' }); // BOM ให้ Excel อ่านไทยถูก
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
const todayStr = () => new Date().toISOString().slice(0, 10);

$('#btn-export-stock').addEventListener('click', () => {
  if (!PRODUCTS.length) { alert('ยังไม่มีสินค้า'); return; }
  const rows = [['ชื่อสินค้า', 'หมวด/โกดัง', 'หน่วย', 'ยอดคงเหลือ', 'ราคาทุน/หน่วย', 'มูลค่า', 'จุดสั่งซื้อ', 'ต้องสั่งซื้อ']];
  for (const p of PRODUCTS) {
    rows.push([
      p.name, p.category || '', p.unit || '', p.stock,
      p.cost > 0 ? p.cost : '', p.cost > 0 ? (Number(p.stock) || 0) * p.cost : '',
      p.reorderPoint || 0, isLow(p) ? 'ใช่' : '',
    ]);
  }
  downloadCSV(`stock-${todayStr()}.csv`, rows);
});

$('#btn-export-history').addEventListener('click', async () => {
  let txs;
  try { txs = await api('/api/transactions'); } catch (err) { alert(err.message); return; }
  if (!txs.length) { alert('ยังไม่มีประวัติ'); return; }
  const rows = [['วันเวลา', 'ประเภท', 'สถานะ', 'สินค้า', 'จำนวน', 'หน่วย', 'คงเหลือหลังทำ', 'มูลค่า (ทุน ณ วันบันทึก)', 'หมายเหตุ', 'วันที่บนใบ', 'ผู้ทำรายการ']];
  for (const tx of txs) {
    const when = new Date(tx.createdAt).toLocaleString('th-TH');
    const isAdjust = tx.type === 'adjust';
    const verb = tx.type === 'receive' ? 'รับเข้า' : isAdjust ? 'ปรับยอด' : 'ตัดออก';
    const status = tx.voided ? 'ยกเลิกแล้ว' : 'ปกติ';
    for (const it of tx.items) {
      const qtyStr = isAdjust
        ? (Number(it.quantity) >= 0 ? '+' : '') + it.quantity
        : (tx.type === 'receive' ? '+' : '-') + it.quantity;
      const value = it.cost > 0 ? Math.abs(Number(it.quantity)) * it.cost : '';
      rows.push([when, verb, status, it.name, qtyStr, it.unit || '', it.after, value, tx.note || '', tx.date || '', tx.actor || '']);
    }
  }
  downloadCSV(`history-${todayStr()}.csv`, rows);
});

// สำรองข้อมูลทั้งหมดเป็นไฟล์ JSON (เก็บไว้กันฐานข้อมูลมีปัญหา)
$('#btn-backup').addEventListener('click', async () => {
  const btn = $('#btn-backup');
  btn.disabled = true;
  try {
    const data = await api('/api/backup');
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `stockmtt-backup-${todayStr()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showToast('ดาวน์โหลดข้อมูลสำรองแล้ว');
  } catch (err) {
    alert('สำรองข้อมูลไม่สำเร็จ: ' + err.message);
  } finally {
    btn.disabled = false;
  }
});

// ---------- ยืนยันตัวตน (รหัสผ่านร่วม) ----------
function showLogin() {
  $('#login-overlay').hidden = false;
  $('#btn-logout').hidden = true;
  setTimeout(() => $('#login-password').focus(), 50);
}
function hideLogin() {
  $('#login-overlay').hidden = true;
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#login-form button');
  const errEl = $('#login-error');
  errEl.textContent = '';
  btn.disabled = true;
  try {
    await api('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: $('#login-password').value }),
    });
    $('#login-password').value = '';
    hideLogin();
    $('#btn-logout').hidden = false;
    await loadData();
  } catch (err) {
    errEl.textContent = err.message || 'เข้าสู่ระบบไม่สำเร็จ';
  } finally {
    btn.disabled = false;
  }
});

$('#btn-logout').addEventListener('click', async () => {
  try { await api('/api/logout', { method: 'POST' }); } catch {}
  location.reload();
});

// ---------- เริ่มทำงาน ----------
async function loadData() {
  try {
    PRODUCTS = await api('/api/products');
    updateLowBadge();
  } catch (err) {
    if (err.message !== 'ต้องเข้าสู่ระบบ') setStatus('โหลดรายการสินค้าไม่ได้: ' + err.message, true);
  }
  updateModeUI();
  restoreTab();
}

(async function boot() {
  let sess = { authEnabled: false, authed: true };
  try { sess = await api('/api/session'); } catch {}
  if (sess.authEnabled && !sess.authed) { showLogin(); return; }
  if (!sess.authEnabled) $('#auth-warning').hidden = false;
  if (sess.authEnabled && sess.authed) $('#btn-logout').hidden = false;
  await loadData();
})();
