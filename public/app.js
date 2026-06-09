const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let PRODUCTS = [];
let MODE = 'deduct'; // 'deduct' = ตัดออก, 'receive' = รับเข้า
let currentImage = null;
let extractedDate = '';

async function api(path, opts) {
  const res = await fetch(path, opts);
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(e.error || 'HTTP ' + res.status);
  }
  return res.json();
}

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
    if (t.dataset.tab === 'stock') { renderReorderBanner(); renderStock(); }
    if (t.dataset.tab === 'history') renderHistory();
  })
);

// ---------- โหมด ตัดออก / รับเข้า ----------
$$('.mode-btn').forEach((b) =>
  b.addEventListener('click', () => {
    $$('.mode-btn').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    MODE = b.dataset.mode;
    updateModeUI();
  })
);
function updateModeUI() {
  $('#btn-commit').textContent = MODE === 'receive' ? '✅ ยืนยันรับเข้า' : '✅ ยืนยันตัดออก';
  $$('.review-card').forEach((c) => c._update && c._update());
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

  const qty = document.createElement('input');
  qty.type = 'number';
  qty.className = 'qty-input';
  qty.min = '0';
  qty.value = item.quantity || 1;

  const del = document.createElement('button');
  del.className = 'del-btn';
  del.textContent = '🗑';
  del.title = 'ลบรายการนี้';
  del.addEventListener('click', () => card.remove());

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
    if (!p) { after.innerHTML = ''; return; }
    const delta = MODE === 'receive' ? q : -q;
    const remain = (p.stock || 0) + delta;
    const sign = MODE === 'receive' ? '+' : '−';
    after.innerHTML =
      `คงเหลือ ${p.stock} → <b class="${remain < 0 ? 'neg' : ''}">${remain}</b> <span class="muted">(${sign}${q})</span>` +
      (remain < 0 ? ' ⚠️ ติดลบ' : '');
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
    if (pid > 0 && q > 0) items.push({ productId: pid, quantity: q });
  }
  if (!items.length) { alert('ยังไม่มีรายการ (เลือกสินค้าและใส่จำนวน)'); return; }

  const btn = $('#btn-commit');
  btn.disabled = true;
  try {
    const out = await api('/api/commit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items, note: $('#deduct-note').value, date: extractedDate, type: MODE }),
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
        `<li>${esc(p.name)} <b>เหลือ ${p.stock}</b>` +
        (p.reorderPoint > 0 ? ` <span class="muted">(จุดสั่ง ${p.reorderPoint})</span>` : '') +
        `</li>`
    )
    .join('');
  box.innerHTML = `<h2>⚠️ ต้องสั่งซื้อ ${low.length} รายการ</h2><ul>${items}</ul>`;
  box.hidden = false;
}

function renderStock() {
  const q = $('#stock-search').value.trim().toLowerCase();
  const onlyLow = $('#filter-low').checked;
  const list = $('#stock-list');
  list.innerHTML = '';

  let items = PRODUCTS.filter(
    (p) => !q || p.name.toLowerCase().includes(q) || (p.category || '').toLowerCase().includes(q)
  );
  if (onlyLow) items = items.filter(isLow);
  $('#stock-count').textContent = `สินค้า ${items.length} / ${PRODUCTS.length} รายการ`;

  for (const p of items) {
    const row = document.createElement('div');
    row.className = 'stock-item' + (isLow(p) ? ' low' : '');

    const info = document.createElement('div');
    info.className = 'info';
    const nm = document.createElement('div');
    nm.className = 'name';
    nm.textContent = p.name;
    const cat = document.createElement('div');
    cat.className = 'cat';
    cat.textContent = p.category || '';
    info.appendChild(nm);
    info.appendChild(cat);

    const fields = document.createElement('div');
    fields.className = 'sfields';

    const sWrap = document.createElement('label');
    sWrap.className = 'mini';
    sWrap.innerHTML = '<span>ยอดคงเหลือ</span>';
    const sInput = document.createElement('input');
    sInput.type = 'number';
    sInput.value = p.stock;
    sWrap.appendChild(sInput);

    const rWrap = document.createElement('label');
    rWrap.className = 'mini';
    rWrap.innerHTML = '<span>จุดสั่งซื้อ</span>';
    const rInput = document.createElement('input');
    rInput.type = 'number';
    rInput.min = '0';
    rInput.value = p.reorderPoint || 0;
    rWrap.appendChild(rInput);

    const save = document.createElement('button');
    save.className = 'save';
    save.textContent = 'บันทึก';
    save.addEventListener('click', async () => {
      save.disabled = true;
      try {
        const updated = await api(`/api/products/${p.id}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ stock: Number(sInput.value), reorderPoint: Number(rInput.value) }),
        });
        p.stock = updated.stock;
        p.reorderPoint = updated.reorderPoint;
        save.textContent = '✓';
        setTimeout(() => (save.textContent = 'บันทึก'), 1200);
        row.className = 'stock-item' + (isLow(p) ? ' low' : '');
        updateLowBadge();
        renderReorderBanner();
      } catch (err) {
        alert(err.message);
      } finally {
        save.disabled = false;
      }
    });

    fields.appendChild(sWrap);
    fields.appendChild(rWrap);
    fields.appendChild(save);
    row.appendChild(info);
    row.appendChild(fields);
    list.appendChild(row);
  }
}
$('#stock-search').addEventListener('input', renderStock);
$('#filter-low').addEventListener('change', renderStock);

$('#btn-add-product').addEventListener('click', async () => {
  const name = $('#add-name').value.trim();
  if (!name) { alert('ใส่ชื่อสินค้า'); return; }
  try {
    const p = await api('/api/products', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, category: $('#add-category').value, stock: Number($('#add-stock').value) || 0 }),
    });
    PRODUCTS.push(p);
    $('#add-name').value = '';
    $('#add-category').value = '';
    $('#add-stock').value = '0';
    renderStock();
    updateLowBadge();
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
      const sign = tx.type === 'receive' ? '+' : '−';
      const verb = tx.type === 'receive' ? 'รับเข้า' : 'ตัดออก';
      const rows = tx.items
        .map((i) => `<li>${esc(i.name)} <b>${sign}${i.quantity}</b> (เหลือ ${i.after})</li>`)
        .join('');

      const div = document.createElement('div');
      div.className = 'tx' + (tx.voided ? ' voided' : '');
      div.innerHTML =
        `<div class="tx-head"><span>${when}</span>` +
        `<span class="tx-type ${tx.type}">${verb}${tx.voided ? ' • ยกเลิกแล้ว' : ''}</span></div>` +
        (tx.note ? `<div class="muted small">📝 ${esc(tx.note)}</div>` : '') +
        `<ul>${rows}</ul>`;

      if (!tx.voided) {
        const btn = document.createElement('button');
        btn.className = 'void-btn';
        btn.textContent = '↩ ยกเลิก (คืนสต๊อก)';
        btn.addEventListener('click', async () => {
          if (!confirm('ยกเลิกรายการนี้และคืนสต๊อกกลับ?')) return;
          btn.disabled = true;
          try {
            const out = await api(`/api/transactions/${tx.id}/void`, { method: 'POST' });
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
      list.appendChild(div);
    }
  } catch (err) {
    list.innerHTML = `<p class="status error">${esc(err.message)}</p>`;
  }
}

// ---------- เริ่มทำงาน ----------
(async function init() {
  try {
    PRODUCTS = await api('/api/products');
    updateLowBadge();
  } catch (err) {
    setStatus('โหลดรายการสินค้าไม่ได้: ' + err.message, true);
  }
  updateModeUI();
})();
