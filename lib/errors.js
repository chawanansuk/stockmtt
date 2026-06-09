// error ที่ "ตั้งใจแสดงให้ผู้ใช้เห็น" (ข้อความปลอดภัย ไม่ใช่รายละเอียดภายในระบบ)
export class AppError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'AppError';
    this.expose = true;
    this.status = status;
  }
}
