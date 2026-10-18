# รีวิวโค้ดทั้งระยะ 1 (P1-10)

รีวิวโค้ดของรอบ P1 ทั้งหมดก่อนเส้นชัย A3 ด้วยคำสั่งเดียวตาม ADR-073: `/code-review xhigh p1-start...HEAD` · ตัวตรวจอ่านโค้ดโดยไม่มีบริบทของผู้เขียนแต่ละขั้น (แต่ละขั้นเขียนในสายของตัวเอง) แล้วแชต main แก้ข้อที่กระทบความถูกต้อง เงิน สิทธิ์ หรือ "เสร็จเมื่อ"

- วันที่: 2026-10-18 · HEAD ตอนรีวิว `9d44664e` (หลังติ๊ก P1-09)
- ช่วง: `p1-start...HEAD` = 747 ไฟล์ใน `src` ราว 66,000 บรรทัดที่เพิ่ม
- วิธี: ส่วนที่อยู่ใน main ถึง `152bc40c` ผ่านรีวิวล่วงหน้าของสาย l1 แล้ว (`docs/reports/p1-review-pre.md` · 68 ข้อ แก้ 41 · ที่เหลืออยู่ใน NEW-92 NEW-93 NEW-94) รอบนี้จึง (1) อ่านทุก hunk ของ `152bc40c...HEAD` (81 ไฟล์ใน `src` ราว 1,150 บรรทัด: โค้ดของ P1-11 จากสาย l2 งานแก้ของรีวิวล่วงหน้า NEW-95 ถึง NEW-102 และ P1-09) ทีละบรรทัดพร้อมฟังก์ชันที่ล้อม ผู้เรียก และสิ่งที่ถูกลบ (2) กวาดทั้งช่วงหาบั๊กแบบที่ข้ามสาย: รายการที่ผูกกับชนิด subject ของการอนุมัติ 12 ชนิด (ชนิดเดียวกับที่ P1-09 พบในตาราง KPI) ไฟล์ที่ job บน Vercel อ่าน วันที่แบบ UTC ที่ควรเป็นวันไทย เลขทศนิยมกับเงิน raw SQL เวลาใน `src/core` catch ที่กลืน error และ route GET ที่เปลี่ยนสถานะ
- ไม่พบ: raw SQL นอก `src/server/db/sql` · `Date.now()` หรือ `new Date()` ใน `src/core` · `number` กับเงิน (ที่ใช้ `Number` เป็นร้อยละ basis point และ credits) · catch ว่าง · route GET ใหม่ที่เขียนข้อมูล (`/api/go/receiving/prepare` `/api/go/resolve` `/api/ai/actions/[id]` และ `form.json` อ่านอย่างเดียว · route POST ใหม่ตรวจ origin และ session)
- ผลรวม: พบ 7 ข้อ · แก้แล้ว 6 ข้อ · ย้ายไป NEW-107 `[go-live]` 1 ข้อ · ไม่มีข้อที่กระทบความถูกต้อง เงิน หรือสิทธิ์ค้าง

## ผลตรวจ

| # | ความรุนแรง | เรื่อง | ไฟล์ | ผล |
| --- | --- | --- | --- | --- |
| 1 | สูง | reset staging (P1-11 ของสาย l2) อ่าน `docs/inputs/BCS_inputs_p1.xlsx` ใน `/api/inngest` ทั้งตอนตรวจก่อนล้าง (`sampleOrgCodes` อ่านทุก workbook) และตอนย้ายช่อง LINE แต่ `next.config.ts` ส่งไฟล์ไปกับ route นั้นแค่ workbook demo · บน Vercel ทุกครั้งที่ reset (รวมแบบ demo เดิม) จึงหยุดที่ ENOENT และ P1-11 seed SIMEC บน staging ไม่ได้ | `next.config.ts` | แก้แล้ว `16d7f42e`: `SEED_FILES` มี workbook ระยะ 1 · เทสต์ใน `tests/integration/staging-first-seed.test.ts` ตรวจทุก workbook ของ `INPUT_WORKBOOKS` (ล้มก่อนแก้ ผ่านหลังแก้) |
| 2 | กลาง | หน้าลิงก์ในอีเมลรู้จัก subject 5 ชนิดเดิม ชนิดอื่นทุกชนิดขึ้นหัวว่า "คำขอซื้อ …" เช่น ลิงก์ของการโอนงบ BT-2569-00001 ทั้งที่ข้อความของทุกชนิดมีแล้ว | `src/app/(auth)/a/[token]/page.tsx` | แก้แล้ว: รายการ 12 ชนิดใน `subjects.ts` · เทสต์ `tests/unit/subject-names.test.ts` เทียบกับ `APPROVAL_SUBJECTS` |
| 3 | กลาง | การ์ดอนุมัติใน LINE ของการโอนงบ เกินงบ ใบแก้ไข PO ใบแจ้งหนี้ และ workflow แสดงประเภทว่า "เอกสาร" (P1-07 ระบุให้เพิ่มในไฟล์นี้) | `src/channels/line/flex/labels.ts` | แก้แล้ว: ชื่อไทยและอังกฤษครบ 12 ชนิด · เทสต์เดียวกัน |
| 4 | กลาง | การแจ้งเตือนตาม SLA (เตือน เลยกำหนด ส่งต่อ สรุปรายวัน) เรียก subject ใหม่ว่า "เอกสาร …" และลิงก์ไป `/tasks` แทนหน้าของเอกสาร | `src/server/notifications/templates/sla.ts` | แก้แล้ว: `SUBJECT_NAME` เป็น `satisfies Record<ApprovalSubject, …>` และลิงก์ไปหน้าของแต่ละชนิด |
| 5 | ต่ำ | รายการเอกสารของบอร์ดเอกสารค้าง รายการ KPI insights และ audit ยังรู้จัก 5 ชนิด (P1-07 ให้ทำเป็น `satisfies Record<ApprovalSubject, …>`) · `/kpi/g5?kind=INVOICE` แสดงการตัดสินเป็น "เอกสาร" ที่ไม่มีลิงก์ | `src/server/services/reports/screens.ts` `board/index.ts` | ไม่แก้ในข้อนี้: ไม่กระทบเงิน สิทธิ์ หรือฉาก demo และเป็นงานเพิ่มชนิดเอกสารลงหน้าภาพรวม (query ต่อชนิด ลิงก์ตามสิทธิ์) → NEW-107 `[go-live]` |
| 6 | ต่ำ | `invoice.payment_released` `retention.payment_released` และ `payment_run.documents_removed` เปลี่ยนรูป `data` (เหตุผลเป็น id ของรอบจ่ายหรือ Comment) โดยไม่ขึ้น `schemaVersion` (§6: เวอร์ชันรูปแบบ `data` ของ type นั้น) | `src/server/events/schemas/invoice.ts` `payment-run.ts` | แก้แล้ว: schemaVersion 2 ทั้งสาม และบันทึกในแคตตาล็อก §10.2 |
| 7 | ต่ำ | Intake Agent ส่ง `asOf` เป็นวันที่ UTC ไม่ใช่วันไทย (BR-DATE-01) · ตอนนี้ไม่มีผลเพราะ agent ส่งแคตตาล็อกว่าง (NEW-98) แต่จะผิดหนึ่งวันช่วง 00:00–07:00 เมื่อ NEW-98 ส่งแคตตาล็อก | `src/server/services/ai/agents/intake.ts` | แก้แล้ว: `taxDateOf(now)` |

## ที่ตรวจแล้วไม่ใช่ปัญหา

- `runMatch` ตรวจ BR-AP-05 ทุกรอบ: การตรวจซ้ำอัตโนมัติหลังตรวจรับเป็นคำสั่งแยกต่อใบ (`invoice-auto-recheck`) จึงไม่ทำให้การตรวจรับล้ม ใบที่ผู้บันทึกกลายเป็นผู้ตรวจรับคง EXCEPTION และกดตรวจซ้ำได้คำตอบ SOD_VIOLATION ตามกฎ
- `closePoInTx` เรียก `setRetentionsDue` ทุกครั้งที่ปิด: ตั้งเฉพาะเงินประกันที่ยังไม่มีวันครบกำหนด จึงไม่เลื่อนวันของ PO ที่รับครบแล้ว
- ส่วนประวัติแบบแบ่งช่วงของ reset (`seedDemoHistoryPart`): ช่วงแรกปฏิเสธองค์กรที่เริ่มประวัติแล้ว ช่วงอื่นปฏิเสธเมื่อพบ key ของขั้นในช่วงนั้น ทุกช่วงใช้ `now` เดียวกันจาก step reset
- `activateStep` ไม่รวมผู้อนุมัติซ้ำอีกครั้ง (`collapseDuplicateApprovers: false`) จึงหาขั้นด้วย `ruleStepNo` ได้ตรง (ADR-074) และ `stepOfRoute` ให้ขั้นสุดท้ายของช่วงที่ยกขึ้นเมื่อมีความขัดแย้ง
- คิวของ BCS Go แยกเวอร์ชันที่รู้ตามสมาชิก: เครื่องที่ใช้ร่วมกันไม่ยกใบรับของสมาชิกอีกคนข้าม `CONFLICT_VERSION`

## ผลการตรวจหลังแก้

- เทสต์ที่เกี่ยวข้อง 10 ไฟล์ 154 เคสผ่าน (การ์ด LINE แม่แบบการแจ้งเตือน ลิงก์ในอีเมล SLA Intake รอบจ่าย) · `pnpm typecheck` และ lint ของไฟล์ที่แก้ผ่าน

## ผล `pnpm verify --strict --e2e`

รันบน `e469147e` (หลังแก้ทุกข้อและเพิ่ม NEW-107) เมื่อ 2026-10-18 06:00–08:20 · ไม่มีสายใดรัน Playwright ระหว่างนั้น (ADR-073)

```text
PASS  e2e          หน้าจอ: 500 เคสผ่าน · ไม่มีเคสที่ข้าม · ฉาก demo: 9 เคสผ่าน · ไม่มีเคสที่ข้าม · ฉากระยะ 1: 15 เคสผ่าน · ไม่มีเคสที่ข้าม
PASS  trace        ข้อที่ติ๊ก 235 ข้อ · AC ที่ต้องมีเทสต์ 265/265 · ยังไม่มีเจ้าของ 0
สรุป: 0 FAIL · 19 PASS · 0 SKIP → ผ่าน
```

ด่านอื่นผ่านทั้งหมด: unit 2,219 เคส · integration 2,060 + generated 1,596 เคส · golden 699 เคส (57 ไฟล์ตรงกับ spec ทุกไบต์) · property 80 · coverage ของ engine เงินและอำนาจ branch 100% (1,907/1,907) · prisma ไม่มี drift · spec 85 PASS · inputs 25 และ 41 PASS · e2e ไม่มี flaky
