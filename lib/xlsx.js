// ตัวอ่านไฟล์ .xlsx แบบไม่ต้องพึ่ง library ภายนอก
// (.xlsx คือไฟล์ ZIP ที่ข้างในเป็น XML — เราอ่าน ZIP ด้วย zlib ของ Node เอง)
import fs from 'node:fs';
import zlib from 'node:zlib';

// อ่านรายการไฟล์ทั้งหมดใน ZIP ผ่าน Central Directory (เชื่อถือได้ที่สุด)
function readZipEntries(buf) {
  const EOCD_SIG = 0x06054b50;
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('อ่านไฟล์ไม่ได้: ไม่พบโครงสร้าง ZIP (อาจไม่ใช่ไฟล์ .xlsx)');

  const entryCount = buf.readUInt16LE(eocd + 10);
  let cd = buf.readUInt32LE(eocd + 16);
  const entries = {};

  for (let n = 0; n < entryCount; n++) {
    if (buf.readUInt32LE(cd) !== 0x02014b50) break;
    const method = buf.readUInt16LE(cd + 10);
    const compSize = buf.readUInt32LE(cd + 20);
    const nameLen = buf.readUInt16LE(cd + 28);
    const extraLen = buf.readUInt16LE(cd + 30);
    const commentLen = buf.readUInt16LE(cd + 32);
    const localOffset = buf.readUInt32LE(cd + 42);
    const name = buf.toString('utf8', cd + 46, cd + 46 + nameLen);

    const lhNameLen = buf.readUInt16LE(localOffset + 26);
    const lhExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lhNameLen + lhExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);

    let content;
    if (method === 0) content = Buffer.from(raw);
    else if (method === 8) content = zlib.inflateRawSync(raw);
    else throw new Error('ไม่รองรับการบีบอัด ZIP แบบ method ' + method);

    entries[name] = content;
    cd += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function decodeXml(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}

function parseSharedStrings(xml) {
  if (!xml) return [];
  const out = [];
  const re = /<si>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = re.exec(xml))) {
    const parts = [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]);
    out.push(decodeXml(parts.join('')));
  }
  return out;
}

function colToNum(col) {
  let n = 0;
  for (const c of col) n = n * 26 + (c.charCodeAt(0) - 64);
  return n;
}

function parseSheet(xml, shared) {
  const rows = [];
  const rowRe = /<row[^>]*\br="(\d+)"[^>]*>([\s\S]*?)<\/row>/g;
  let r;
  while ((r = rowRe.exec(xml))) {
    const rowNum = +r[1];
    const cells = {};
    const cRe = /<c[^>]*\br="([A-Z]+)\d+"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let c;
    while ((c = cRe.exec(r[2]))) {
      const col = colToNum(c[1]);
      const attrs = c[2] || '';
      const body = c[3] || '';
      const t = (/\bt="([^"]*)"/.exec(attrs) || [])[1] || 'n';
      let val = '';
      if (t === 's') {
        const v = (/<v>([\s\S]*?)<\/v>/.exec(body) || [])[1];
        if (v !== undefined) val = shared[+v] ?? '';
      } else if (t === 'inlineStr') {
        const parts = [...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]);
        val = decodeXml(parts.join(''));
      } else {
        const v = (/<v>([\s\S]*?)<\/v>/.exec(body) || [])[1];
        if (v !== undefined) val = decodeXml(v);
      }
      cells[col] = val;
    }
    rows[rowNum] = cells;
  }
  return rows;
}

// คืนค่าเป็น [{ name: ชื่อชีต, rows: [ {1:'ค่าคอลัมน์A', 2:'ค่าคอลัมน์B'}, ... ] }]
export function readWorkbook(filePath) {
  const buf = fs.readFileSync(filePath);
  const entries = readZipEntries(buf);
  const get = (name) => (entries[name] ? entries[name].toString('utf8') : '');

  const shared = parseSharedStrings(get('xl/sharedStrings.xml'));
  const wbXml = get('xl/workbook.xml');
  const relsXml = get('xl/_rels/workbook.xml.rels');

  const rels = {};
  for (const m of relsXml.matchAll(/<Relationship[^>]*\bId="([^"]*)"[^>]*\bTarget="([^"]*)"/g)) {
    rels[m[1]] = m[2];
  }

  const sheets = [];
  for (const m of wbXml.matchAll(/<sheet[^>]*\bname="([^"]*)"[^>]*\br:id="([^"]*)"[^>]*\/?>/g)) {
    let target = rels[m[2]] || '';
    if (target) {
      target = target.replace(/^\//, '');
      if (!target.startsWith('xl/')) target = 'xl/' + target;
    }
    sheets.push({ name: decodeXml(m[1]), file: target });
  }

  return sheets.map((s) => ({ name: s.name, rows: parseSheet(get(s.file), shared) }));
}
