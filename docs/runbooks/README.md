# คู่มือตั้งค่าบริการภายนอกสำหรับ staging (runbooks)

ชุดคู่มือนี้สำหรับเจ้าของโปรเจกต์ ไม่ต้องเขียนโปรแกรมเป็น ใช้สมัครบริการและสร้างค่าที่ staging ต้องใช้ก่อน demo ตามข้อ `[คน]` ใน spec §16.1 (P0-05 ถึง P0-08) และ §16.10 (D-03)

- **staging** คือเว็บทดลองบนอินเทอร์เน็ตที่ใช้ demo กับลูกค้า ใช้ข้อมูลตัวอย่างเท่านั้น ห้ามใส่ข้อมูลจริงของ LK-RICH จนกว่า OQ-19 ปิด
- **agent** คือ Claude Code ที่ทำงานในโฟลเดอร์โปรเจกต์นี้
- ขั้นตอนบนหน้าเว็บของแต่ละบริการตรวจกับเอกสารทางการเมื่อ ต.ค. 2026 ถ้าหน้าจอจริงต่างจากคู่มือ ให้ถ่ายภาพหน้าจอ (บังค่าลับก่อน) แล้วถาม agent

## กติกาเรื่องค่าลับ (อ่านก่อนเริ่ม)

ค่าลับคือรหัสผ่าน key token secret และ connection string ที่มีรหัสผ่านอยู่ข้างใน

1. **ห้ามวางค่าลับลงในแชท** ให้ใส่เองในที่ที่คู่มือบอก แล้วพิมพ์บอก agent ว่า "ใส่แล้ว"
2. **ค่าของ staging ใส่ใน Vercel เท่านั้น** ที่ project `bcs-staging` → **Settings** → **Environment Variables** เลือก environment **Production** (วิธีอยู่ในหัวข้อ "วิธีเพิ่ม environment variable ใน Vercel" ของ [p0-08-vercel.md](p0-08-vercel.md)) ส่วนไฟล์ `.env` บนเครื่องของคุณ ใส่เพิ่มแค่ `VERCEL_TOKEN` ตัวเดียว
   - ยกเว้น `SEED_DEV_PASSWORD` และ `SEED_TOTP_KEY` ที่ต้องเก็บสำเนาไว้ในโปรแกรมจัดการรหัสผ่าน (password manager) ด้วย เพราะต้องใช้ login และตั้ง 2FA ให้ผู้ใช้ตัวอย่างบน staging (เหตุผลอยู่ใน [p0-08-vercel.md](p0-08-vercel.md) B2)
3. **คำสั่งที่สุ่มค่าลับ ให้รันในหน้าต่าง PowerShell ของคุณเอง** (กด Start แล้วพิมพ์ PowerShell) ไม่ใช่พิมพ์ในช่องแชทของ Claude Code เพราะผลลัพธ์ในแชทจะเข้าไปอยู่ในบทสนทนา
4. **ถ้าเผลอวางค่าลับในแชทหรือที่อื่น** ให้สร้างค่าใหม่ทันทีตามหัวข้อ "ถ้าค่าลับหลุด" ท้ายหน้านี้ แล้วแก้ค่าใน Vercel

## ลำดับที่แนะนำ

ทำตามตารางด้านล่างจากบนลงล่าง งาน Vercel แบ่งเป็น 2 ส่วน: ส่วน A (บัญชีและ project) ทำก่อน Neon เพื่อให้มีที่ใส่ค่าลับทันทีที่ได้มา (CLAUDE.md §12) ส่วน B (ใส่ค่าที่เหลือและ deploy) ทำหลัง Inngest

| ขั้น | คู่มือ | ทำอะไร | ข้อใน spec | เวลาโดยประมาณ |
| --- | --- | --- | --- | --- |
| 1 | [github-setup.md](github-setup.md) | repo ส่วนตัว push ครั้งแรก และกฎกัน merge เมื่อ CI ไม่ผ่าน | S1-14 (FR-PLT-006) | 20 นาที |
| 2 | [p0-08-vercel.md](p0-08-vercel.md) ส่วน A | สมัคร Vercel Pro สร้าง token ให้ agent สร้าง project ตั้ง region สิงคโปร์ | P0-08 | 20 นาที |
| 3 | [p0-05-neon-staging.md](p0-05-neon-staging.md) | ฐานข้อมูล staging ที่สิงคโปร์ และ role 2 ตัว | P0-05 | 30 นาที |
| 4 | [p0-06-storage-staging.md](p0-06-storage-staging.md) | ที่เก็บไฟล์ (ลอง Neon Object Storage ก่อน สำรองคือ Cloudflare R2) | P0-06 | 20 นาที |
| 5 | [p0-07-inngest.md](p0-07-inngest.md) ส่วนที่ 1 | บัญชี Inngest และ key 2 ตัว | P0-07 | 10 นาที |
| 6 | [p0-08-vercel.md](p0-08-vercel.md) ส่วน B | ค่าลับที่สร้างเอง อีเมล ค่าคงที่ แล้วให้ agent deploy | P0-08 | 20 นาที |
| 7 | [p0-07-inngest.md](p0-07-inngest.md) ส่วนที่ 2 | sync แอปกับ Inngest หลัง deploy ครั้งแรก | P0-07 | 5 นาที |
| 8 | [line-demo-setup.md](line-demo-setup.md) | LINE ของ BCS สำหรับ demo | D-02 · D-03 | 70 นาที |

ขั้น 1 ข้ามไปก่อนได้ เพราะคุณตัดสินเมื่อ 2026-10-02 ว่ายังไม่สร้าง GitHub repo agent deploy staging จากเครื่องด้วย Vercel CLI ได้ แต่การรัน CI และการ deploy อัตโนมัติเมื่อ merge `main` (S1-14) ต้องมี GitHub

ก่อนขั้น 6 ต้องตัดสิน "เรื่องที่รอคุณตัดสิน" ข้อ 1 (อีเมล) และข้อ 2 (แผนของ Neon) ให้เสร็จ เพราะทั้งสองข้อต้องรู้ก่อน deploy ครั้งแรก

## Checklist ของคุณ

ติ๊กในไฟล์นี้ได้เลย การติ๊กที่นี่ไม่ใช่การติ๊กใน spec ข้อ P0 และ D-03 ใน spec เป็นข้อ `[คน]` ซึ่ง agent ห้ามติ๊กเอง ต้องให้คุณยืนยันว่าเสร็จจริง

- [ ] 1. GitHub: สร้าง repo ส่วนตัวแล้ว และ push ครั้งแรกแล้ว (ข้ามไปก่อนได้)
- [ ] 1b. GitHub: ติดตั้ง `gh` และตั้ง ruleset ของ `main` แล้ว (หลัง agent บอกว่า CI รันครั้งแรกแล้ว)
- [ ] 2. Vercel ส่วน A: team แบบ Pro · `VERCEL_TOKEN` อยู่ใน `.env` · มี project `bcs-staging` · agent ยืนยันว่ามีไฟล์ `.vercelignore` กัน `.env` ก่อน deploy ครั้งใดก็ตาม · region `sin1` · Deployment Protection เป็น Standard · รู้โดเมน staging (ถ้ายังไม่มีโดเมน ให้ agent deploy ครั้งแรกก่อน) · (แนะนำ) เปลี่ยนเป็น token เฉพาะ project ตาม A4
- [ ] 3. Neon: `DATABASE_URL` และ `DIRECT_URL` อยู่ใน Vercel แล้ว และผลตรวจในขั้นที่ 8 ถูกต้อง
- [ ] 4. ที่เก็บไฟล์: ค่า `S3_*` ครบ 6 ตัวใน Vercel (ทางเลือก A หรือ B)
- [ ] 5. Inngest: environment `staging` · `INNGEST_EVENT_KEY` และ `INNGEST_SIGNING_KEY` อยู่ใน Vercel แล้ว
- [ ] 6. ตัดสินเรื่องอีเมลของ staging แล้ว และใส่ค่า `EMAIL_*` แล้ว
- [ ] 6b. ตัดสินเรื่องแผนของ Neon แล้ว ("เรื่องที่รอคุณตัดสิน" ข้อ 2)
- [ ] 7. Vercel ส่วน B: ค่าลับที่สร้างเอง 4 ตัวและค่าคงที่อยู่ใน Vercel แล้ว · เก็บ `SEED_DEV_PASSWORD` และ `SEED_TOTP_KEY` ในโปรแกรมจัดการรหัสผ่านแล้ว · agent deploy สำเร็จ และ `/api/health` ตอบ 200
- [ ] 8. Inngest: sync แล้ว และเห็นฟังก์ชันของแอป
- [ ] 9. LINE ส่วนที่ 1–2: สร้าง provider OA และ channel แล้ว ใส่ค่า LINE 7 ตัวและ `NEXT_PUBLIC_LIFF_ID` ตามตารางในส่วนที่ 2 ใน Vercel แล้ว
- [ ] 10. LINE ส่วนที่ 3: ใส่ค่าในหน้าตั้งค่า LINE บน staging แล้ว · มี rich menu แล้ว · ใส่ webhook URL แล้ว Verify ผ่าน · ปุ่มทดสอบการเชื่อมต่อบน staging ผ่านทุกข้อ
- [ ] 11. ทดสอบหน้า LIFF บนมือถือคนนอกทีมที่เชิญเป็น Tester แล้ว (spec §16.10)

## บอก agent อย่างไรเมื่อเสร็จแต่ละขั้น

ประโยคเหล่านี้ไม่มีค่าลับ คัดลอกไปพิมพ์ในแชทได้เลย แก้เฉพาะส่วนใน `< >`

| เสร็จขั้น | พิมพ์บอก agent | agent จะทำต่อ |
| --- | --- | --- |
| 1 สร้าง repo | "สร้าง GitHub repo แล้ว URL คือ https://github.com/<ชื่อบัญชี>/bcs.git ให้ตั้ง remote" | รัน `git remote add origin` แล้วบอกคำสั่ง push ให้คุณพิมพ์ |
| 1 push ครั้งแรก | "push ครั้งแรกแล้ว" | ตรวจว่า GitHub มี commit ครบ |
| 1b gh และ ruleset | "ติดตั้ง gh และ login แล้ว" · "ตั้ง ruleset ของ main แล้ว" | เปิด PR ทดสอบว่ากฎทำงาน |
| 2 token | "ใส่ VERCEL_TOKEN ใน .env แล้ว team slug คือ <team-slug> ช่วยสร้าง project bcs-staging" | สร้าง project ด้วย Vercel CLI และสร้างไฟล์ `.vercelignore` ที่กัน `.env` ก่อน deploy ครั้งใดก็ตาม |
| 2 ยังไม่มีโดเมน | "ยังไม่มีโดเมนในหน้า Domains ช่วย deploy ครั้งแรก" | ตรวจ `.vercelignore` แล้ว deploy ครั้งแรกเพื่อให้ Vercel สร้างโดเมน |
| 2 ตั้งค่า project | "ตั้ง region sin1 และ Deployment Protection แล้ว โดเมน staging คือ https://<โดเมน>" | จดโดเมนไว้ใช้ในขั้นต่อไป |
| 2 token เฉพาะ project | "เปลี่ยน VERCEL_TOKEN เป็นแบบเฉพาะ project แล้ว ช่วยทดสอบ" | ทดสอบว่า Vercel CLI ใช้ token ใหม่ได้ แล้วบอกผล |
| 3 Neon | "ตั้ง Neon แล้ว ใส่ DATABASE_URL และ DIRECT_URL ใน Vercel แล้ว" | รอ deploy ครั้งแรก |
| 4 ที่เก็บไฟล์ | "ใส่ค่า S3 ของ staging ใน Vercel แล้ว ใช้ทางเลือก A (Neon)" หรือ "… ทางเลือก B (R2) ตั้ง CORS แล้ว" | เตรียมตั้งหรือตรวจ CORS และทดสอบหลัง deploy |
| 5 Inngest | "ใส่ key ของ Inngest (environment staging) ใน Vercel แล้ว" | รอ deploy ครั้งแรก |
| 6 อีเมล | "เลือกอีเมลของ staging แบบ <ทางเลือก> และใส่ค่า EMAIL_* แล้ว" | บันทึกการตัดสินใน ADR-031 |
| 6b แผน Neon | "เลือกแผน Neon ของ staging แบบ <ก หรือ ข>" | ถ้าเลือก (ข) ปรับความถี่งานบน staging · บันทึกการตัดสินเป็น ADR |
| 7 deploy | "ใส่ค่า staging ใน Vercel ครบแล้ว deploy ได้" | deploy · migrate และ seed ครั้งแรก · ตรวจว่าแอปใช้ role `bcs_app` · ตรวจ `/api/health` แล้วรายงาน |
| 7 2FA บน staging | "ต้องการตั้ง 2FA ของผู้ใช้ตัวอย่างบน staging" | ให้คำสั่งที่คุณรันในหน้าต่าง PowerShell ของคุณเอง แล้ววาง `SEED_TOTP_KEY` เมื่อคำสั่งถาม |
| 8 sync Inngest | "sync Inngest แล้ว เห็นฟังก์ชัน <จำนวน> ตัว" | ตรวจว่างานเบื้องหลังทำงาน |
| 9 LINE | "สร้าง LINE channel ตาม line-demo-setup แล้ว ใส่ค่า LINE ใน Vercel แล้ว (ใช้ MINI App)" | deploy ใหม่ แล้วบอกเมื่อหน้าตั้งค่า LINE บน staging พร้อมให้คุณใส่ค่าเอง พร้อมวิธีสร้าง rich menu และวิธีหา webhook URL (ถ้า agent ต้องเขียนข้อมูลลงฐานข้อมูล staging จะขออนุมัติคุณก่อน) |
| 10 webhook | "ใส่ค่าในหน้าตั้งค่า LINE แล้ว ใส่ webhook แล้ว Verify ผ่าน ปุ่มทดสอบผ่านทุกข้อ" | ตรวจซ้ำ แล้วรอคุณยืนยัน D-03 |

ถ้าคุณตรวจแล้วว่าข้อ P0 ใดเสร็จครบตาม "เสร็จเมื่อ" ให้พิมพ์ยืนยันกับ agent เช่น "ยืนยันว่า P0-05 เสร็จแล้ว"

## ค่าใช้จ่ายโดยประมาณ

ราคาจากหน้าเว็บทางการเมื่อ ต.ค. 2026 ยังไม่รวมภาษี ตัวเลขที่เขียนว่า "ราว" ให้ตรวจซ้ำก่อนจ่าย

| บริการ | แผนที่ใช้ | ราคา | หมายเหตุ |
| --- | --- | --- | --- |
| Vercel | Pro (จำเป็น) | US$20 ต่อเดือน รวมที่นั่ง deploy 1 ที่ และเครดิตใช้งาน US$20 | แผนฟรี Hobby ห้ามใช้เชิงพาณิชย์ |
| Neon | Free หรือ Launch | Free 100 CU-hours ต่อเดือน · Launch US$0.106 ต่อ CU-hour ไม่มีขั้นต่ำ | ดูเรื่องที่รอตัดสินข้อ 2 |
| ที่เก็บไฟล์ | Neon Object Storage หรือ R2 | ฟรีถึง 5 GB (Neon) หรือ 10 GB (R2) | demo ใช้ไม่กี่ MB |
| Inngest | Free หรือ Pro | Free 50,000 executions ต่อเดือน · Pro เริ่ม US$99 ต่อเดือน | แผนฟรีหยุดทำงานเมื่อเกินโควตา · ดูเรื่องที่รอตัดสินข้อ 3 |
| GitHub | Free หรือ Pro | Pro ราว US$4 ต่อเดือน | ต้องใช้ Pro ถ้าจะกัน merge เมื่อ CI ไม่ผ่านใน repo ส่วนตัว |
| LINE | OA แผนฟรี | push ฟรีราว 300 ข้อความต่อเดือน | reply และ rich menu ไม่นับ · channel อื่นฟรี |
| อีเมล | รอตัดสิน | sandbox ฟรี 50 อีเมลต่อเดือน หรือราว US$14 ถึง 17 ต่อเดือน · Resend ฟรี 3,000 ต่อเดือน | ดู [p0-08-vercel.md](p0-08-vercel.md) หัวข้อ B4 |

## เรื่องที่รอคุณตัดสิน

1. **อีเมลของ staging (ADR-031)** ต้องตัดสินก่อน deploy ครั้งแรก เพราะแอปบน staging เริ่มไม่ได้ถ้าไม่มีค่า `EMAIL_PROVIDER` และ `EMAIL_FROM` ตัวเลือกและค่าที่ต้องใส่อยู่ใน [p0-08-vercel.md](p0-08-vercel.md) หัวข้อ B4
2. **แผนของ Neon สำหรับ staging (ตัดสินก่อน deploy ครั้งแรก)** งาน `outbox-sweeper` รันทุก 1 นาที (spec §4.6) จึงปลุกฐานข้อมูลทุกนาที ฐานข้อมูลเลยแทบไม่ได้หลับ แผนฟรีของ Neon ให้ 100 CU-hours ต่อเดือน เครื่องขนาดเล็กสุด (0.25 CU) ที่เปิดตลอดใช้หมดใน 400 ชั่วโมง คือราววันที่ 16–17 ของรอบบิล แล้วฐานข้อมูล staging ถูกพักจนถึงรอบบิลถัดไป ซึ่งอาจตรงวัน demo ทางเลือก:
   - (ก) อัปเกรด Neon เป็นแผน Launch ราว US$20 ต่อเดือน (จ่ายตามใช้ เครื่อง 0.25 CU เปิดทั้งเดือน) จำเป็นตราบที่งานนี้ยังรันทุก 1 นาที
   - (ข) อนุมัติให้ agent ลดความถี่งานนี้บน staging ซึ่งต่างจาก spec §4.6 จึงต้องให้คุณอนุมัติ ถามข้อดีข้อเสียกับ agent ได้
3. **Inngest Pro (เริ่ม US$99 ต่อเดือน) ยังไม่ต้องตัดสิน** งานเดียวกันรันเดือนละ 43,200 ครั้ง ตั้งแต่ 2026-10-03 งานนี้ไม่มี step จึงใช้ 43,200 จากโควตาฟรี 50,000 executions ต่อเดือน (รายละเอียดใน [p0-07-inngest.md](p0-07-inngest.md)) · agent จะแจ้งคุณถ้างานที่เพิ่มภายหลังทำให้ใกล้โควตา เพราะถ้าเกิน งานเบื้องหลังบน staging จะหยุดจนกว่าจะอัปเกรด
4. **GitHub Pro** ถ้าต้องการให้ GitHub กัน merge เมื่อ CI ไม่ผ่านใน repo ส่วนตัว (FR-PLT-006 AC1)
5. **ผู้ตรวจโค้ดส่วนเงินและสิทธิ์ตาม CODEOWNERS (spec §15.8)** spec ไม่ได้ระบุว่าเป็นใคร และ GitHub ไม่ให้คนเปิด PR อนุมัติ PR ของตัวเอง รายละเอียดอยู่ใน [github-setup.md](github-setup.md)
6. **คนนอกทีมใช้หน้า LIFF ในวัน demo** ถ้าผู้บริหารของลูกค้าจะลองบนมือถือของตัวเอง ต้องเชิญเป็น Tester ล่วงหน้า หรือเผยแพร่ MINI App ซึ่งต่างจาก spec §9.2 รายละเอียดอยู่ใน [line-demo-setup.md](line-demo-setup.md)

## ตัดสินแล้ว (2026-10-02)

- staging ใช้ Vercel ภูมิภาคสิงคโปร์ (`sin1`) (ADR-032) · hosting ของ production ยังไม่ตัดสิน
- ยังไม่มี GitHub repo ตอนนี้ commit บนเครื่องอย่างเดียว
- ผู้ให้บริการอีเมลของ staging ยังไม่ตัดสิน (ADR-031)
- ที่เก็บไฟล์บนเครื่องใช้ RustFS 1.0 (สำรองคือ bitnamilegacy/minio) เพราะ image ทางการของ MinIO ถูกลบ (หมายเหตุ 2026-10-02 ใน ADR-033)
- การ migrate และ seed ครั้งแรกบน staging คุณอนุมัติแล้ว การ reset หรือแก้ข้อมูลบน staging ครั้งต่อไป agent ต้องถามคุณก่อน (spec §17.4)

ตามแผนงานที่คุณอนุมัติ (บันทึกใน ADR-032): staging เป็น project แยกชื่อ `bcs-staging` และ agent deploy ด้วย `--prod` จึงใช้ environment ชื่อ Production ของ project นี้ (`--prod` ไม่ได้แปลว่า production ของ BCS) ถ้าต้องการแบบอื่นให้บอก agent

## คู่มือดูแลระบบ (หลัง deploy)

- [outbox.md](outbox.md) งานเบื้องหลังที่ส่งไม่ออก: หาสาเหตุ ส่งใหม่ หรือเลิกส่ง (ใช้เมื่อ `/api/health` บอกว่า inngest `fail` หรือ log มีคำเตือน outbox)

## ค่าไหนอยู่ที่ไหน

| ตัวแปร | ค่าของ staging ได้จาก | Vercel (staging) | `.env` บนเครื่อง |
| --- | --- | --- | --- |
| `APP_ENV` `APP_URL` `BETTER_AUTH_URL` | `staging` และโดเมน staging | Config | ค่าของเครื่อง (agent ตั้งแล้ว) |
| `BETTER_AUTH_SECRET` `ENCRYPTION_KEY` | คุณสร้างเอง ([p0-08-vercel.md](p0-08-vercel.md) B2) | Secret | ค่าของเครื่อง |
| `SEED_DEV_PASSWORD` `SEED_TOTP_KEY` | คุณสร้างเอง ([p0-08-vercel.md](p0-08-vercel.md) B2) และเก็บสำเนาในโปรแกรมจัดการรหัสผ่าน เพราะต้องใช้ login และตั้ง 2FA ของผู้ใช้ตัวอย่างบน staging | Secret | ค่าของเครื่อง |
| `DATABASE_URL` `DIRECT_URL` | Neon ([p0-05-neon-staging.md](p0-05-neon-staging.md)) | Secret | Postgres ใน Docker |
| `S3_*` 6 ตัว | Neon Object Storage หรือ R2 ([p0-06-storage-staging.md](p0-06-storage-staging.md)) | Config และ Secret | RustFS ใน Docker |
| `EMAIL_PROVIDER` `EMAIL_FROM` `EMAIL_SMTP_URL` | รอตัดสิน ([p0-08-vercel.md](p0-08-vercel.md) B4) | Config และ Secret | Mailpit ใน Docker |
| `INNGEST_EVENT_KEY` `INNGEST_SIGNING_KEY` | Inngest ([p0-07-inngest.md](p0-07-inngest.md)) | Secret | ว่าง |
| `INNGEST_DEV` | — | **ห้ามใส่** | `1` |
| `LINE_PROVIDER_ID` `LINE_MESSAGING_CHANNEL_ID` `LINE_MESSAGING_CHANNEL_SECRET` `LINE_MESSAGING_CHANNEL_ACCESS_TOKEN` `LINE_LOGIN_CHANNEL_ID` `LINE_LOGIN_CHANNEL_SECRET` `LINE_LIFF_CHANNEL_ID` และ `NEXT_PUBLIC_LIFF_ID` | LINE ([line-demo-setup.md](line-demo-setup.md)) | Config และ Secret | ค่าจำลอง (agent เติมภายหลัง) |
| `REGISTRY_MODE` `LOG_LEVEL` `AI_ENABLED` `ENABLE_EXPERIMENTAL_COREPACK` | ค่าคงที่ ([p0-08-vercel.md](p0-08-vercel.md) B1) | Config | ค่าของเครื่อง (ตัวสุดท้ายไม่ต้องมี) |
| `VERCEL_TOKEN` | Vercel ([p0-08-vercel.md](p0-08-vercel.md) A2 และ A4) | **ห้ามใส่** | **คุณใส่เอง** |
| `APP_COMMIT_SHA` | agent ใส่ตอน deploy | ห้ามใส่เอง | ว่าง |
| `LINE_API_BASE_URL` `E2E_TEST_CLOCK` `LIFF_MOCK` | ใช้บนเครื่องเท่านั้น | **ห้ามใส่** | agent ตั้ง |
| `GOOGLE_*` `MICROSOFT_*` `ANTHROPIC_API_KEY` `AI_MODEL_DEFAULT` `SENTRY_DSN` `RD_VAT_SERVICE_URL` `DBD_JURISTIC_API_URL` | ยังไม่ใช้ใน demo | ไม่ต้องใส่ | ตามเดิม |

## ถ้าค่าลับหลุด

ทำตามแถวของค่านั้น แล้วบอก agent ให้ deploy ใหม่ทุกครั้ง (ค่าใหม่มีผลกับ deployment ถัดไปเท่านั้น) · ค่าชนิด Secret ใน Vercel เปิดดูไม่ได้ จึงต้องกด **Edit** แล้ววางค่าใหม่ทั้งค่า

| ค่าที่หลุด | สร้างใหม่ที่ไหน | แก้ที่ |
| --- | --- | --- |
| `VERCEL_TOKEN` | ลบ token เดิมและสร้างใหม่ที่ <https://vercel.com/account/tokens> ([p0-08-vercel.md](p0-08-vercel.md) A2 หรือ A4) | `.env` บนเครื่อง |
| `DIRECT_URL` | Neon หน้า Roles → Reset password ของ `bcs_migrator` แล้วประกอบสตริงใหม่ตาม [p0-05-neon-staging.md](p0-05-neon-staging.md) ขั้นที่ 5 | Vercel |
| `DATABASE_URL` | สุ่มรหัสใหม่ตาม [p0-05-neon-staging.md](p0-05-neon-staging.md) ขั้นที่ 6 ในหน้าต่าง PowerShell ของคุณเอง → Neon SQL Editor (database `bcs`) รัน `ALTER ROLE bcs_app WITH PASSWORD '<รหัสใหม่>';` → ลบรายการในแท็บ History และในประวัติคลิปบอร์ด (Win+V) ถ้าเปิดไว้ → ประกอบสตริงใหม่ตามขั้นที่ 9 | Vercel |
| `S3_ACCESS_KEY_ID` `S3_SECRET_ACCESS_KEY` | สร้าง credential หรือ token ใหม่ แล้วลบอันเก่า ([p0-06-storage-staging.md](p0-06-storage-staging.md)) | Vercel |
| `INNGEST_EVENT_KEY` | สร้าง event key ใหม่ แล้วลบอันเก่า | Vercel |
| `INNGEST_SIGNING_KEY` | บอก agent ก่อน เพราะการหมุน key ต้องใช้ตัวแปร fallback เพิ่ม ([p0-07-inngest.md](p0-07-inngest.md)) | Vercel |
| channel secret หรือ access token ของ LINE | LINE Developers Console ออกค่าใหม่ ([line-demo-setup.md](line-demo-setup.md)) | Vercel และหน้าตั้งค่า LINE บน staging |
| `BETTER_AUTH_SECRET` `ENCRYPTION_KEY` | บอก agent ก่อนเปลี่ยน เพราะผู้ใช้อาจต้อง login และตั้ง 2FA ใหม่ และค่าที่เข้ารหัสไว้จะอ่านไม่ได้ | Vercel |
| `SEED_DEV_PASSWORD` `SEED_TOTP_KEY` | ตั้งค่าใหม่ แล้วบอก agent ผู้ใช้ตัวอย่างที่ seed ไว้แล้วยังใช้ค่าเดิมจนกว่าจะ seed ใหม่ ซึ่งเป็นการแก้ข้อมูล staging ต้องให้คุณอนุมัติ | Vercel และโปรแกรมจัดการรหัสผ่าน |
| login ของ GitHub หรือ `gh` | เปลี่ยนรหัสผ่าน GitHub · รัน `gh auth logout` แล้ว `gh auth login` ใหม่ | — |

## แหล่งข้อมูลของตารางค่าใช้จ่าย (ตรวจ ต.ค. 2026)

- Vercel: <https://vercel.com/docs/plans/pro-plan> · <https://vercel.com/docs/limits/fair-use-guidelines>
- Neon: <https://neon.com/docs/introduction/plans> · <https://neon.com/faqs/free-plan-limits-and-quotas>
- Cloudflare R2: <https://developers.cloudflare.com/r2/pricing/>
- Inngest: <https://www.inngest.com/pricing>
- GitHub: <https://github.com/pricing> · <https://docs.github.com/en/get-started/learning-about-github/githubs-plans>
- อีเมล: <https://mailtrap.io/pricing/> · <https://resend.com/pricing>
- LINE OA ไทย (แหล่งภายนอก ต้องตรวจซ้ำใน LINE Official Account Manager): <https://linebot.pro/blog/line-official-account-pricing-guide>
- รายการเอกสารทั้งหมดที่ใช้ตรวจขั้นตอน อยู่ท้ายคู่มือแต่ละฉบับ
