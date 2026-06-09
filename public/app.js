const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

let PRODUCTS = [];
let currentImage = null; // data URL
let extractedDate = '';

async function api(path, opts) {
  const res = await fetch(path, opts);
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(e.error || 'HTTP ' + res.status);
  }
  return res.json();
}

// ---------- แท็บ ----------
$$('.tab').forEach((t) =>
  t.addEventListener('click', () => {
    $$('.tab').forEach((x) => x.classList.remove('active'));
    $$('.panel').forEach((x) => x.classList.remove('active'));
    t.classList.add('active');
    $('#tab-' + t.dataset.tab).classList.add('active');
    if (t.dataset.tab === 'stock') renderStock();
    if (t.dataset.tab === 'history') renderHistory();
  })
);

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

// ---------- ตัดสต๊อกจากรูป ----------
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
      body: JSON.stringify({ image: currentImage }),
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
  none.textContent = '— ไม่ตัด / เลือกสินค้า —';
  sel.appendChild(none);

  const byCat = {};
  for (const p of PRODUCTS) (byCat[p.category] ||= []).push(p);
  for (const cat of Object.keys(byCat)) {
    const og = document.createElement('optgroup');
    og.label = cat || 'อื่น ๆ';
    for (const p of byCat[cat]) {
      const o = document.createElement('option');
      o.value = String(p.id);
      o.textContent = `${p.name} (คงเหลือ ${p.stock})`;
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

  const qtyWrap = document.createElement('div');
  const qty = document.createElement('input');
  qty.type = 'number';
  qty.className = 'qty-input';
  qty.min = '0';
  qty.value = item.quantity || 1;
  qtyWrap.appendChild(qty);

  const del = document.createElement('button');
  del.className = 'del-btn';
  del.textContent = '🗑';
  del.title = 'ลบรายการนี้';
  del.addEventListener('click', () => card.remove());

  row2.appendChild(grow);
  row2.appendChild(qtyWrap);
  row2.appendChild(del);
  card.appendChild(row2);

  const after = document.createElement('div');
  after.className = 'after';
  card.appendChild(after);

  const update = () => {
    const pid = Number(sel.value);
    const p = PRODUCTS.find((x) => x.id === pid);
    const q = Number(qty.value) || 0;
    if (!p) { after.innerHTML = ''; return; }
    const remain = (p.stock || 0) - q;
    after.innerHTML =
      `คงเหลือ ${p.stock} → <b class="${remain < 0 ? 'neg' : ''}">${remain}</b>` +
      (remain < 0 ? ' ⚠️ ติดลบ' : '');
  };
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
    const qty = Number($('.qty-input', card).value);
    if (pid > 0 && qty > 0) items.push({ productId: pid, quantity: qty });
  }
  if (!items.length) { alert('ยังไม่มีรายการที่จะตัด (เลือกสินค้าและใส่จำนวน)'); return; }

  const btn = $('#btn-commit');
  btn.disabled = true;
  try {
    const out = await api('/api/commit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items, note: $('#deduct-note').value, date: extractedDate }),
    });
    PRODUCTS = out.products;
    showCommitResult(out.transaction);
  } catch (err) {
    alert('ผิดพลาด: ' + err.message);
  } finally {
    btn.disabled = false;
  }
});

function showCommitResult(tx) {
  $('#review').hidden = true;
  const box = $('#commit-result');
  const rows = tx.items
    .map((i) => `<li>${i.name} <b>−${i.quantity}</b> (เหลือ ${i.after})</li>`)
    .join('');
  box.innerHTML = `<h2>✅ ตัดสต๊อกแล้ว ${tx.items.length} รายการ</h2><ul>${rows}</ul>`;
  box.hidden = false;
  // ล้างฟอร์ม
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
function renderStock() {
  const q = $('#stock-search').value.trim().toLowerCase();
  const list = $('#stock-list');
  list.innerHTML = '';
  const filtered = PRODUCTS.filter(
    (p) => !q || p.name.toLowerCase().includes(q) || (p.category || '').toLowerCase().includes(q)
  );
  $('#stock-count').textContent = `สินค้า ${filtered.length} / ${PRODUCTS.length} รายการ`;

  for (const p of filtered) {
    const row = document.createElement('div');
    row.className = 'stock-item';
    row.innerHTML = `<div class="info"><div class="name"></div><div class="cat"></div></div>`;
    $('.name', row).textContent = p.name;
    $('.cat', row).textContent = p.category || '';

    const input = document.createElement('input');
    input.type = 'number';
    input.value = p.stock;

    const save = document.createElement('button');
    save.className = 'save';
    save.textContent = 'บันทึก';
    save.addEventListener('click', async () => {
      save.disabled = true;
      try {
        const updated = await api(`/api/products/${p.id}/stock`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ stock: Number(input.value) }),
        });
        p.stock = updated.stock;
        save.textContent = '✓';
        setTimeout(() => (save.textContent = 'บันทึก'), 1200);
      } catch (err) {
        alert(err.message);
      } finally {
        save.disabled = false;
      }
    });

    row.appendChild(input);
    row.appendChild(save);
    list.appendChild(row);
  }
}
$('#stock-search').addEventListener('input', renderStock);

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
      }),
    });
    PRODUCTS.push(p);
    $('#add-name').value = '';
    $('#add-category').value = '';
    $('#add-stock').value = '0';
    renderStock();
  } catch (err) {
    alert(err.message);
  }
});

// ---------- ประวัติ ----------
async function renderHistory() {
  const list = $('#history-list');
  list.innerHTML = '<p class="muted">กำลังโหลด...</p>';
  try {
    const txs = await api('/api/transactions');
    if (!txs.length) { list.innerHTML = '<p class="muted">ยังไม่มีประวัติ</p>'; return; }
    list.innerHTML = '';
    for (const tx of txs) {
      const when = new Date(tx.createdAt).toLocaleString('th-TH');
      const rows = tx.items.map((i) => `<li>${i.name} <b>−${i.quantity}</b> (เหลือ ${i.after})</li>`).join('');
      const div = document.createElement('div');
      div.className = 'tx';
      div.innerHTML =
        `<div class="tx-head"><span>${when}</span><span>${tx.date || ''}</span></div>` +
        (tx.note ? `<div class="muted small">📝 ${tx.note}</div>` : '') +
        `<ul>${rows}</ul>`;
      list.appendChild(div);
    }
  } catch (err) {
    list.innerHTML = `<p class="status error">${err.message}</p>`;
  }
}

// ---------- เริ่มทำงาน ----------
(async function init() {
  try {
    PRODUCTS = await api('/api/products');
  } catch (err) {
    setStatus('โหลดรายการสินค้าไม่ได้: ' + err.message, true);
  }
})();
