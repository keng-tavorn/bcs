# ภาพตัวอย่างของ PDF ภาษาไทย (snapshot)

ใช้เมื่อเทสต์ `tests/integration/pdf-snapshot.test.ts` ไม่ผ่าน หรือเมื่อตั้งใจเปลี่ยนหน้าตาของ PR และ PO (spec FR-PLT-009 AC3 · ADR-044)

## เทสต์นี้ทำอะไร

1. สร้าง PDF ของ PO 3 บรรทัด PO 40 บรรทัด และ PR จากข้อมูลสมมติใน `tests/support/printable-fixtures.ts`
2. แปลงทุกหน้าเป็นภาพ PNG ด้วย poppler ใน image `bcs-pdf-raster:bookworm` (บริการ `pdf-raster` ของ `docker-compose.yml` สร้างให้เองครั้งแรก)
3. เทียบกับภาพใน `tests/snapshots/pdf/<ชื่อ>-<หน้า>.png` ทุกไบต์

## เมื่อเทสต์ไม่ผ่าน

1. เปิดภาพ `tests/snapshots/pdf/<ชื่อ>-<หน้า>.actual.png` ที่เทสต์ทิ้งไว้ เทียบกับภาพเดิม
2. ดูให้แน่ว่าวรรณยุกต์อยู่บนสระและเลี่ยงหางของ ป ฝ ฟ · ตัดบรรทัดระหว่างคำ ไม่มีขีด · ไม่มีตัวอักษรหายท้ายบรรทัด
3. ถ้าภาพใหม่ผิด แปลว่าการเปลี่ยนล่าสุดทำให้ภาษาไทยพัง (มักเป็นการอัปเกรด `@react-pdf/*` หรือ `fontkit`) ให้ย้อนการเปลี่ยนนั้น
4. ถ้าภาพใหม่ถูกและเป็นการเปลี่ยนที่ตั้งใจ สร้างภาพอ้างอิงใหม่:

```bash
UPDATE_PDF_SNAPSHOTS=1 pnpm exec vitest run --project int tests/integration/pdf-snapshot.test.ts
```

แล้วดูภาพใหม่ทุกภาพก่อน commit ไฟล์ `.actual.png` ไม่ถูก commit (อยู่ใน `.gitignore`)

## อัปเกรด react-pdf

`@react-pdf/renderer` `@react-pdf/render` `@react-pdf/textkit` และ `fontkit` ถูกล็อกเวอร์ชันใน `package.json` และ `pnpm-workspace.yaml` เพราะการแก้ภาษาไทยพึ่งรายละเอียดภายใน อัปเกรดพร้อมกันทั้งชุด สร้าง patch ของ `@react-pdf/render` ใหม่ (หรือเอาออกถ้าต้นทางแก้แล้ว) รันเทสต์ภาพ และดูภาพก่อน commit
