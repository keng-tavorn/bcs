# งานเบื้องหลังที่ส่งไม่ออก (outbox)

คู่มือนี้สำหรับคนดูแลระบบหลัง deploy (เจ้าของโปรเจกต์หรือ agent) ใช้เมื่อ `/api/health` บอกว่า `inngest` เป็น `fail` หรือ log มีคำเตือนเรื่อง outbox

## outbox คืออะไร

ทุกคำสั่งที่เปลี่ยนข้อมูล (เช่น อนุมัติคำขอ) จะเขียน "ข้อความถึงงานเบื้องหลัง" ลงตาราง `Outbox` ในธุรกรรมเดียวกับข้อมูลนั้น แล้วระบบส่งต่อให้ Inngest ซึ่งเป็นตัวรันงานเบื้องหลัง เช่น ส่งแจ้งเตือน (spec §4.3 · ADR-030 · ADR-041)

- ส่งทันทีหลังบันทึก ถ้าไม่สำเร็จ งาน `outbox-sweeper` ส่งใหม่ทุก 1 นาที
- Inngest ล่มหรือติดต่อไม่ได้ → ไม่นับเป็นความผิดของข้อความ ข้อความรอแล้วออกไปเองภายใน 2 นาทีหลัง Inngest กลับมา
- Inngest ปฏิเสธข้อความนั้นเอง (เช่น ข้อมูลใหญ่เกิน) → นับครั้ง ครบ 10 ครั้งข้อความ "ตาย" (`deadAt`) และ log เตือน

## สัญญาณที่บอกว่ามีปัญหา

| เห็นอะไร | หมายความว่า |
| --- | --- |
| log `alert: true` ข้อความ `outbox message is dead` (มี `outboxId`) | Inngest ปฏิเสธข้อความนี้ 10 ครั้ง ระบบเลิกส่งแล้ว |
| log `alert: true` ข้อความ `outbox is stalled` | มีข้อความรอนานเกิน 10 นาทีและรอบล่าสุดส่งอะไรไม่ออกเลย |
| `/api/health` ตอบ `inngest: "fail"` | ตั้งค่า Inngest ไม่ครบ หรือมีข้อความที่ยังไม่เคยส่งสำเร็จค้างเกิน 5 นาที |

## หาข้อความที่ค้าง

agent รันคำสั่งนี้ได้ (อ่านอย่างเดียว ไม่เปลี่ยนข้อมูล)

```sql
SELECT id, "organizationId", "eventName", attempts, "lastError", "nextAttemptAt", "createdAt", "deadAt"
FROM "Outbox"
WHERE "sentAt" IS NULL AND NOT "suppressed"
  AND ("deadAt" IS NOT NULL OR "createdAt" < now() - interval '10 minutes')
ORDER BY "createdAt";
```

ช่อง `lastError` บอกสาเหตุ

| `lastError` | สาเหตุ | แก้อย่างไร |
| --- | --- | --- |
| 401 403 404 หรือ "could not reach Inngest" | ค่า `INNGEST_EVENT_KEY` หรือ `INNGEST_BASE_URL` ใน Vercel ผิด หรือ Inngest ล่ม | แก้ค่าใน Vercel ([p0-07-inngest.md](p0-07-inngest.md)) แล้ว deploy ใหม่ ข้อความออกไปเองภายใน 2 นาที |
| 4xx "refused" เช่น 400 413 | ข้อความนั้นผิดเอง เช่น payload ใหญ่เกิน | ต้องแก้โค้ด ให้ agent ดู `eventName` และ `outboxId` |
| 500 หรือ "no answer" ซ้ำกับข้อความเดียว | ข้อความนั้นอาจทำให้ Inngest ล้ม | ให้ agent ตรวจ payload ของข้อความนั้น |

## ส่งใหม่หรือเลิกส่ง

หลังแก้สาเหตุแล้ว ส่งข้อความที่ตายใหม่ได้ด้วยคำสั่งนี้ รอบถัดไปของ `outbox-sweeper` (ภายใน 1 นาที) จะส่ง Inngest กันการทำซ้ำด้วย event id (= `Outbox.id`) ข้อความที่เคยไปถึงแล้วจึงไม่ถูกทำซ้ำ

```sql
UPDATE "Outbox" SET "deadAt" = NULL, attempts = 0, "nextAttemptAt" = now(), "lastError" = NULL WHERE id = '<outboxId>';
```

ถ้าตัดสินใจเลิกส่งข้อความนั้น

```sql
UPDATE "Outbox" SET "deadAt" = now() WHERE id = '<outboxId>';
```

**บน staging หรือ production คำสั่ง UPDATE ทั้งสองเป็นการแก้ข้อมูล agent ต้องขออนุมัติคุณก่อนทุกครั้ง** (CLAUDE.md §2) บนเครื่องของคุณทำได้เลย

## ที่มา

spec §4.3 §4.6 · FR-PLT-012 AC3 · NFR-OBS-02 · ADR-030 · ADR-041
