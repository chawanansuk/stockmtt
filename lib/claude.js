// อ่านรูปใบรายการสินค้าด้วย Claude (vision) แล้วจับคู่กับรายการสินค้า
import Anthropic from '@anthropic-ai/sdk';
import { getProducts } from './store.js';

const MODEL = 'claude-opus-4-8';

// สร้าง client แบบ lazy เพื่อให้แอพสตาร์ทได้แม้ยังไม่ได้ตั้งค่า key
// (ฟังก์ชันดูสต๊อก/ประวัติยังใช้ได้ จะเตือนเฉพาะตอนเรียกอ่านรูป)
let _client = null;
function getClient() {
  if (_client) return _client;
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ยังไม่ได้ตั้งค่า ANTHROPIC_API_KEY — กรุณาใส่ค่าในไฟล์ .env ก่อนใช้ฟังก์ชันอ่านรูป');
  }
  _client = new Anthropic();
  return _client;
}

const schema = {
  type: 'object',
  properties: {
    date: { type: 'string', description: 'วันที่บนใบ ถ้าอ่านได้ (ตามที่เขียน) ไม่งั้นเว้นว่าง' },
    items: {
      type: 'array',
      description: 'รายการสินค้า แต่ละบรรทัด',
      items: {
        type: 'object',
        properties: {
          rawText: { type: 'string', description: 'ข้อความที่อ่านได้จากบรรทัดนั้น' },
          quantity: { type: 'number', description: 'จำนวน (ตัวเลขนำหน้าบรรทัด ถ้าไม่ชัดให้ 1)' },
          productId: { type: 'integer', description: 'รหัสสินค้าที่ตรงที่สุดจากรายการ หรือ 0 ถ้าไม่พบ' },
          productName: { type: 'string', description: 'ชื่อสินค้าที่จับคู่ หรือชื่อที่อ่านได้' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'], description: 'ความมั่นใจในการจับคู่' },
        },
        required: ['rawText', 'quantity', 'productId', 'productName', 'confidence'],
        additionalProperties: false,
      },
    },
  },
  required: ['date', 'items'],
  additionalProperties: false,
};

const SYSTEM = `คุณเป็นผู้ช่วยจัดการสต๊อกของร้านฮาร์ดแวร์ไทย
หน้าที่: อ่าน "ใบรายการสินค้า" ที่พนักงานเขียนด้วยลายมือ (ภาษาไทย) จากรูปภาพ
อาจเป็นใบเบิกของออก หรือใบรับของเข้าก็ได้ แต่ละบรรทัดมักมี (1) จำนวนเป็นตัวเลขนำหน้า และ (2) ชื่อสินค้าหรือคำย่อ
ให้จับคู่ชื่อสินค้าในแต่ละบรรทัดกับ "รายการสินค้าหลัก" ที่ให้มา แล้วส่งกลับเป็น JSON ตาม schema

กติกาสำคัญ:
- ตัวเลขที่ติดกับชื่อสินค้า (เช่น ขนาด 32 / 38 / 50) ถือเป็นส่วนหนึ่งของชื่อสินค้า ไม่ใช่จำนวน
- จำนวนคือตัวเลขเดี่ยวที่อยู่ต้นบรรทัด ถ้าไม่เห็นหรือไม่ชัดให้ใส่ 1
- ลายมือและคำย่ออาจสะกดไม่ตรงเป๊ะ ให้เลือกสินค้าที่ใกล้เคียงที่สุดตามความหมาย/เสียงอ่าน
- ถ้าหาสินค้าที่ตรงไม่ได้จริง ๆ ให้ productId = 0 และใส่สิ่งที่อ่านได้ไว้ใน productName
- ใส่ confidence ตามความมั่นใจ (high/medium/low)
- ห้ามเดารายการที่ไม่ได้เขียนไว้ อ่านเฉพาะที่ปรากฏบนใบเท่านั้น`;

function parseJsonLoose(text) {
  try { return JSON.parse(text); } catch {}
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fence) { try { return JSON.parse(fence[1]); } catch {} }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
  throw new Error('แปลงผลลัพธ์ AI เป็น JSON ไม่ได้');
}

export async function extractFromImage({ base64, mediaType, mode = 'deduct' }) {
  const products = getProducts();
  const list = products.map((p) => `${p.id}\t${p.name}\t[${p.category}]`).join('\n');
  const modeLine =
    mode === 'receive'
      ? 'ประเภทเอกสาร: ใบรับของเข้า (สินค้าเข้าคลัง)'
      : 'ประเภทเอกสาร: ใบเบิกของออก (สินค้าออกจากคลัง)';

  const userText =
    `${modeLine}\n\n` +
    `รายการสินค้าหลัก (รูปแบบ: รหัส<TAB>ชื่อ<TAB>[หมวด]):\n${list}\n\n` +
    `โปรดอ่านรูปใบรายการด้านบน แล้วส่งผลลัพธ์ตาม schema`;

  const resp = await getClient().messages.create({
    model: MODEL,
    max_tokens: 8000,
    thinking: { type: 'adaptive' },
    system: SYSTEM,
    output_config: { format: { type: 'json_schema', schema } },
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
          { type: 'text', text: userText },
        ],
      },
    ],
  });

  const textBlock = resp.content.find((b) => b.type === 'text');
  if (!textBlock) throw new Error('ไม่ได้รับผลลัพธ์ข้อความจาก AI');
  return parseJsonLoose(textBlock.text);
}
