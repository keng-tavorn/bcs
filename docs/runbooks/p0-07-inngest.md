# P0-07 · Inngest (งานเบื้องหลัง) สำหรับ staging

| รายการ | ค่า |
| --- | --- |
| ข้อใน spec | P0-07 `[คน]` `[demo]` บัญชี Inngest และ signing key |
| เสร็จเมื่อ | ใส่ `INNGEST_EVENT_KEY` และ `INNGEST_SIGNING_KEY` ใน staging แล้ว Inngest เห็นฟังก์ชันของแอป |
| ก่อนเริ่ม | ส่วนที่ 1: ทำ Vercel ส่วน A แล้ว (มีที่ใส่ค่า) · ส่วนที่ 2: agent deploy staging ครั้งแรกสำเร็จแล้ว |
| เวลา | ส่วนที่ 1 ประมาณ 10 นาที · ส่วนที่ 2 ประมาณ 5 นาที |

## Inngest คืออะไร

บริการที่ปลุกงานเบื้องหลังตามเวลาหรือตามเหตุการณ์ เช่น เตือนเมื่องานอนุมัติใกล้เกิน SLA ส่งสรุปรายวันตอน 08:00 และส่งรายการ outbox ที่ค้าง (spec §4.6 · ADR-006) Inngest จะเรียกแอปของเราที่ `https://<โดเมน staging>/api/inngest` ส่วนบนเครื่องของคุณใช้ Inngest Dev Server ใน Docker อยู่แล้ว

## ค่าใช้จ่ายและโควตา (ตรวจ ต.ค. 2026)

- **Free:** ฟรี ไม่ต้องใช้บัตร · 50,000 executions ต่อเดือน · ทำงานพร้อมกันได้ 5 step · เก็บประวัติการรัน 24 ชั่วโมง · **ถ้าใช้เกินโควตา งานจะหยุดจนกว่าจะอัปเกรด** (แผนฟรีไม่คิดเงินส่วนเกิน)
- **Pro:** เริ่ม US$99 ต่อเดือน (1 ล้าน executions)
- 1 execution คือการรันฟังก์ชัน 1 ครั้ง หรือ 1 step ภายในฟังก์ชัน (ฟังก์ชันที่มี 2 step รัน 1 ครั้งนับ 3)
- **ข้อควรรู้:** งาน `outbox-sweeper` รันทุก 1 นาที (spec §4.6) เดือนละ 43,200 ครั้ง
  - ถ้าเขียนงานนี้แบบไม่มี step จะใช้ 43,200 executions ซึ่งอยู่ในโควตาฟรี (เหลือให้งานอื่นราว 6,800 ต่อเดือน)
  - ถ้ามี step 1 ตัวจะใช้ 86,400 ซึ่งเกินโควตาฟรีในราววันที่ 17–18 ของเดือน (เร็วกว่านั้นเมื่อรวมงานอื่น) แล้วการเตือน SLA สรุปรายวัน และการส่งแจ้งเตือนบน staging จะหยุดจนกว่าจะอัปเกรด
  - ตั้งแต่ 2026-10-03 งานนี้ไม่มี step และไม่ให้ Inngest ลองซ้ำเอง (`src/server/jobs/outbox-sweeper.ts` · ADR-041) จึงใช้ 43,200 executions ต่อเดือน อยู่ในโควตาฟรี ยังไม่ต้องตัดสินเรื่องแผน Pro · ถ้างานที่เพิ่มในขั้นหลังทำให้ใกล้โควตา agent จะแจ้งคุณก่อน
  - ฐานข้อมูล Neon เป็นอีกเรื่องที่ต้องตัดสินก่อน deploy ครั้งแรก (ข้อ 2 ใน README)

## ส่วนที่ 1 · สมัครและสร้าง key (ทำก่อน deploy)

### 1.1 สมัคร

1. เปิด <https://app.inngest.com/sign-up>
2. สมัครด้วยอีเมลของบริษัท (หรือ Google หรือ GitHub) แล้วใช้แผน **Free**

### 1.2 สร้าง environment ชื่อ `staging`

Inngest แยก key และประวัติการรันตาม environment เราจึงสร้าง environment `staging` แยกไว้ และเก็บ environment **Production** ของ Inngest ไว้ใช้กับระบบจริงตอน go-live

1. เปิด <https://app.inngest.com/env> (หน้ารวม environment)
2. กด **Create environment** ตั้งชื่อ `staging` แล้วสร้าง
3. ใช้ตัวเลือก environment ที่แถบบนของหน้าเว็บ สลับไปที่ `staging` ขั้นต่อไปทั้งหมดต้องทำใน environment นี้ ตรวจชื่อที่แถบบนทุกครั้ง

environment ที่สร้างเองได้ลำดับความสำคัญต่ำกว่า Production จึงอาจช้ากว่าเล็กน้อย ยอมรับได้สำหรับ staging

### 1.3 Event key → `INNGEST_EVENT_KEY`

1. ใน environment `staging` เปิดเมนู **Manage** → **Event Keys** (ถ้าไม่เห็นเมนู Manage ให้หาเมนูชื่อ Event Keys)
2. กด **Create Event Key** ตั้งชื่อ `bcs-staging-app`
3. คัดลอก key แล้วใส่ใน Vercel: Name `INNGEST_EVENT_KEY` · ชนิด **Secret** · Environment **Production** (วิธีอยู่ในหัวข้อ "วิธีเพิ่ม environment variable ใน Vercel" ของ [p0-08-vercel.md](p0-08-vercel.md))

event key ให้แอปส่งเหตุการณ์ (เช่น `bcs/approval_task.assigned`) เข้า Inngest

### 1.4 Signing key → `INNGEST_SIGNING_KEY`

1. ใน environment `staging` เปิดเมนู **Manage** → **Signing Key**
2. คัดลอก signing key (ขึ้นต้นด้วย `signkey-`)
3. ใส่ใน Vercel: Name `INNGEST_SIGNING_KEY` · ชนิด **Secret** · Environment **Production**

signing key ใช้ยืนยันว่าคำขอที่เข้ามาที่ `/api/inngest` มาจาก Inngest จริง และใช้ลงทะเบียนฟังก์ชันของแอป (spec §5.1: ต้องตั้ง signing key ทุก environment ที่ไม่ใช่ local)

### 1.5 สิ่งที่ห้ามทำ

- **ห้ามวาง key ใดในแชทกับ agent** ใส่ใน Vercel เองตามขั้นข้างบน แล้วพิมพ์บอกแค่ว่าใส่แล้ว ถ้าเผลอวางไปแล้ว ให้สร้าง key ใหม่ที่หน้าเดิมทันทีและเปลี่ยนค่าใน Vercel
- **ห้ามใส่ `INNGEST_DEV` ใน Vercel** แอปบน staging จะไม่ยอมเริ่มทำงานถ้ามีค่านี้ (Inngest SDK v4 ต้องใช้โหมด cloud นอกเครื่อง)
- **ห้ามติดตั้ง Inngest integration จาก Vercel Marketplace ให้ project นี้** integration จะผูก environment Production ของ Vercel กับ environment Production ของ Inngest และใส่ key ของ Production ให้เอง ซึ่งไม่ใช่ environment `staging` ที่เราสร้าง เราจึง sync เองในส่วนที่ 2
- ใน `.env` บนเครื่อง คง `INNGEST_DEV=1` และเว้น `INNGEST_EVENT_KEY` `INNGEST_SIGNING_KEY` ว่างไว้ตามเดิม

พิมพ์บอก agent: "ใส่ key ของ Inngest (environment staging) ใน Vercel แล้ว"

## ส่วนที่ 2 · sync แอปหลัง deploy ครั้งแรก

ทำเมื่อ agent บอกว่า deploy staging สำเร็จ และ `https://<โดเมน staging>/api/health` ตอบ 200 แล้ว

1. เปิด <https://app.inngest.com> → สลับไป environment `staging`
2. เมนู **Apps** → กด **Sync new app**
3. วาง URL: `https://<โดเมน staging>/api/inngest`
   - ใช้โดเมน staging เท่านั้น ห้ามใช้ URL ของ deployment ที่มีรหัสสุ่มต่อท้าย เพราะ URL แบบนั้นถูกกันด้วย Deployment Protection
   - เอกสาร Inngest (หน้า Vercel) บอกว่า Standard Protection กระทบ environment Production ของ Inngest ด้วย ข้อนี้หมายถึงกรณีใช้ integration ของ Vercel ซึ่ง sync ด้วย URL ของ deployment (มีรหัสสุ่มต่อท้าย) เรา sync เองด้วยโดเมน staging ซึ่งเป็นโดเมน production ของ project ใน Vercel จึงไม่โดนกัน
4. กดปุ่ม sync ที่หน้านั้น
5. หน้า **Apps** ต้องแสดงแอปของเรา และหน้า **Functions** ต้องแสดงรายชื่อฟังก์ชัน (เช่น `outbox-sweeper`)
   - ถ้าหน้า **Apps** แสดง URL ของแอปเป็น URL ที่มีรหัสสุ่มแทนโดเมน staging ให้บอก agent
6. พิมพ์บอก agent: "sync Inngest แล้ว เห็นฟังก์ชัน <จำนวน> ตัว"

ทุกครั้งที่ deploy ใหม่ต้อง sync ใหม่ Inngest จึงจะเห็นฟังก์ชันล่าสุด agent ทำเองได้ด้วยการส่งคำขอ `PUT` ไปที่ `https://<โดเมน staging>/api/inngest` หลัง deploy (ไม่ต้องใช้ค่าลับ) หรือคุณกด sync ซ้ำที่หน้า **Apps** ก็ได้

### ถ้า sync ไม่ผ่าน

| อาการ | สาเหตุที่พบบ่อย | วิธีแก้ |
| --- | --- | --- |
| ได้หน้า login ของ Vercel หรือ error 401 จาก Vercel | ใช้ URL ของ deployment แทนโดเมน staging หรือ Deployment Protection ถูกตั้งเป็น All Deployments (Standard Protection ไม่กันโดเมน staging ดูหมายเหตุในข้อ 3 ด้านบน) | ใช้โดเมน staging และตั้ง Deployment Protection เป็น Standard Protection ([p0-08-vercel.md](p0-08-vercel.md) ส่วน A3 ข้อ 3) |
| error เรื่อง signing key | key ใน Vercel ไม่ได้มาจาก environment `staging` | คัดลอก key จาก environment `staging` ใหม่ แก้ค่าใน Vercel แล้วบอก agent ให้ deploy ใหม่ |
| ไม่เจอหน้า (404) | แอปยังไม่มี `/api/inngest` หรือ deploy ไม่สำเร็จ | ส่งข้อความ error ให้ agent |

## ถ้า key หลุด

- **Event key:** สร้าง key ใหม่ (1.3) → แก้ `INNGEST_EVENT_KEY` ใน Vercel → บอก agent ให้ deploy ใหม่ → ลบ key เก่าที่หน้า Event Keys
- **Signing key:** Inngest มีวิธีหมุน key ที่หน้า Signing Key ระหว่างหมุนต้องใส่ key เก่าในตัวแปร `INNGEST_SIGNING_KEY_FALLBACK` ซึ่งยังไม่มีใน env schema ของโปรเจกต์ จึงต้องบอก agent ก่อนหมุน

## เอกสารอ้างอิงที่ใช้ตรวจ (ต.ค. 2026)

- <https://www.inngest.com/pricing>
- <https://www.inngest.com/docs/usage-limits/inngest>
- <https://www.inngest.com/docs/platform/environments>
- <https://www.inngest.com/docs/platform/signing-keys>
- <https://www.inngest.com/docs/events/creating-an-event-key>
- <https://www.inngest.com/docs/apps/cloud>
- <https://www.inngest.com/docs/platform-and-operations/apps-and-syncs>
- <https://www.inngest.com/docs/durable-execution/deploying-functions/serve>
- <https://www.inngest.com/docs/deploy/vercel>
- <https://vercel.com/docs/deployment-protection>
