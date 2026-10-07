# P0-05 · ฐานข้อมูล staging บน Neon (สิงคโปร์)

| รายการ | ค่า |
| --- | --- |
| ข้อใน spec | P0-05 `[คน]` `[demo]` Neon project ภูมิภาคสิงคโปร์สำหรับ staging (production รอ OQ-19) |
| เสร็จเมื่อ | ใส่ `DATABASE_URL` และ `DIRECT_URL` ของ staging ใน Vercel แล้ว |
| ก่อนเริ่ม | ทำ Vercel ส่วน A เสร็จแล้ว (มี project `bcs-staging` ไว้ใส่ค่า ดู [p0-08-vercel.md](p0-08-vercel.md)) · เครื่องมี Node.js (ใช้สุ่มรหัสผ่าน) |
| เวลา | ประมาณ 30 นาที |

ภาพรวม: สร้างฐานข้อมูลชื่อ `bcs` ที่สิงคโปร์ พร้อมบัญชีผู้ใช้ของฐานข้อมูล (เรียกว่า role) 2 บัญชี แล้วนำ "ที่อยู่สำหรับเชื่อมต่อ" (connection string) ของแต่ละบัญชีไปใส่ใน Vercel

## ทำไมต้องมี 2 role

| role | ใช้ทำอะไร | ต่อแบบ | ใส่ในตัวแปร |
| --- | --- | --- | --- |
| `bcs_migrator` | เจ้าของฐานข้อมูล ใช้สร้างและแก้โครงตาราง (migration) | direct (ต่อตรง) | `DIRECT_URL` |
| `bcs_app` | แอปใช้ตอนทำงานจริง สิทธิ์เท่าที่จำเป็น แก้หรือลบประวัติ audit (`Event`) ไม่ได้ | pooled (ผ่านตัวรวม connection) | `DATABASE_URL` |

- บัญชีที่สร้างจากหน้าเว็บของ Neon ได้สิทธิ์สูงมาก (อ่านและเขียนได้ทุกตาราง) เหมาะกับ `bcs_migrator` ที่เป็นเจ้าของ แต่สูงเกินไปสำหรับแอป
- บัญชีของแอป `bcs_app` จึงต้องสร้างด้วยคำสั่ง SQL ในขั้นที่ 7 เท่านั้น ถ้าสร้างจากหน้าเว็บ `bcs_app` จะได้สิทธิ์เขียนทุกตาราง ซึ่งขัด spec §6.3 และ `pnpm verify` บนเครื่องตรวจไม่เจอ เพราะตรวจแค่ฐานข้อมูลในเครื่อง ขั้นที่ 8 จึงเป็นจุดตรวจเดียวก่อน deploy (หลัง deploy agent ตรวจซ้ำบน staging ตามขั้นที่ 10)

รายละเอียดทางเทคนิคอยู่ใน "หมายเหตุสำหรับ agent" ท้ายไฟล์

## ค่าใช้จ่าย (ตรวจ ต.ค. 2026)

- **Free:** ฟรี 100 CU-hours ต่อ project ต่อเดือน พื้นที่ 1 GB ต่อ project ข้อมูลขาออก 5 GB ต่อเดือน · ฐานข้อมูลหลับเองหลังว่าง 5 นาที (ปิดไม่ได้ ครั้งแรกหลังหลับจะช้าขึ้นเล็กน้อย) · **ถ้าใช้ CU-hours เกิน ฐานข้อมูลถูกพักจนถึงรอบบิลถัดไปหรือจนกว่าจะอัปเกรด**
- **Launch:** จ่ายตามที่ใช้ US$0.106 ต่อ CU-hour และ US$0.35 ต่อ GB-เดือน ไม่มีขั้นต่ำ ปิดการหลับได้
- **ข้อควรรู้ (ตัดสินก่อน deploy ครั้งแรก):** งาน `outbox-sweeper` ของระบบรันทุก 1 นาที (spec §4.6) จึงปลุกฐานข้อมูลทุกนาทีและฐานข้อมูลแทบไม่ได้หลับ เครื่องขนาดเล็กสุด 0.25 CU ที่เปิดตลอดใช้โควตาฟรี 100 CU-hours หมดใน 400 ชั่วโมง คือราววันที่ 16–17 ของรอบบิล (ทั้งเดือนใช้ราว 182 CU-hours) แล้วฐานข้อมูล staging ถูกพักจนถึงรอบบิลถัดไป ซึ่งอาจตรงวัน demo ทางเลือกคืออัปเกรดเป็น Launch (ราว US$20 ต่อเดือนที่ 0.25 CU) หรืออนุมัติให้ agent ลดความถี่งานนี้บน staging (ดู "เรื่องที่รอคุณตัดสิน" ข้อ 2 ใน [README.md](README.md))
  - **ตัดสินแล้ว 2026-10-07:** ใช้แผน Free และบน staging งานตามรอบ 4 งาน (รวม 3 งานที่รันทุก 5 นาทีซึ่งเพิ่มมาใน S4 และ S5) รันทุก 30 นาที ฐานข้อมูลจึงหลับได้ คาดว่าใช้ราว 30 CU-hours ต่อเดือนก่อนรวมการใช้งาน (ADR-054)
- สร้าง project ด้วยแผน Free ได้ และอัปเกรดภายหลังได้โดยไม่ต้องสร้าง project ใหม่ แต่ให้ตัดสินเรื่องข้างบนก่อน deploy ครั้งแรก

## ขั้นที่ 1 · สมัคร Neon

1. เปิด <https://console.neon.tech/signup>
2. สมัครด้วยอีเมลของบริษัท (หรือ Google หรือ GitHub)

## ขั้นที่ 2 · สร้าง project

1. กดปุ่ม **New Project**
2. **Project name:** `bcs-staging`
3. **Region:** เลือก **AWS Asia Pacific (Singapore)** (รหัส `aws-ap-southeast-1`) เปลี่ยนภายหลังไม่ได้
4. ส่วน **Services:**
   - **Postgres database** เปิดอยู่แล้ว กดขยายแล้วเลือก Postgres version **17** (spec §5.1)
   - **Object storage** ถ้ามีให้เลือก ให้เปิดไว้ ใช้ในคู่มือ [p0-06-storage-staging.md](p0-06-storage-staging.md) ทางเลือก A
   - **Neon Auth** **Functions** **AI gateway** ปิดไว้ ระบบเราไม่ใช้
5. กด **Create project**
6. Neon จะสร้าง branch ชื่อ `production` ฐานข้อมูล `neondb` และ role `neondb_owner` ให้เอง เราไม่ใช้ `neondb` และ `neondb_owner` ปล่อยไว้ได้ (ห้ามลบ branch `production`)

## ขั้นที่ 3 · สร้าง role `bcs_migrator` จากหน้าเว็บ

1. ที่แถบซ้ายด้านบน ตรวจว่าเลือก branch `production`
2. แถบซ้าย ส่วน **Postgres database** กด **Roles**
3. กด **Add role** ใส่ชื่อ `bcs_migrator` แล้วกด **Create**
4. Neon จะแสดงรหัสผ่านของ role นี้ (มักขึ้นต้นด้วย `npg_`) ยังไม่ต้องจดไว้ที่อื่น ขั้นที่ 5 จะคัดลอกจากปุ่ม **Connect** ถ้าหาไม่เจอภายหลัง ใช้ **Reset password** ของ role นี้ที่หน้า **Roles** ได้

## ขั้นที่ 4 · สร้างฐานข้อมูล `bcs`

1. แถบซ้าย ส่วน **Postgres database** กด **Databases**
2. กด **Add database**
3. **Database name:** `bcs` · **Owner:** `bcs_migrator`
4. กด **Create**

## ขั้นที่ 5 · คัดลอก `DIRECT_URL` ใส่ Vercel

1. กดปุ่ม **Connect** (บนสุดของแถบซ้าย หรือหน้า Dashboard ของ project)
2. เลือก **Branch** `production` · **Database** `bcs` · **Role** `bcs_migrator`
3. **ปิด** สวิตช์ **Connection pooling** (แบบ direct ชื่อ host จะไม่มีคำว่า `-pooler`)
4. คัดลอก connection string ถ้ารหัสผ่านถูกซ่อนเป็น `****` ให้กดแสดงรหัสผ่านก่อนคัดลอก ถ้าในสตริงไม่มีรหัสผ่านเลย ให้ไปที่หน้า **Roles** กด **Reset password** ของ `bcs_migrator` แล้วนำรหัสใหม่ที่แสดงไปใส่ในตำแหน่งรหัสผ่านของสตริง
5. เพิ่มตัวแปรใน Vercel: Name `DIRECT_URL` · ชนิด **Secret** · Environment **Production** (วิธีอยู่ในหัวข้อ "วิธีเพิ่ม environment variable ใน Vercel" ของ [p0-08-vercel.md](p0-08-vercel.md)) วางสตริงในช่อง Value แล้วแก้ในช่องนั้นเลย:
   - ถ้าท้ายสตริงมี `&channel_binding=require` ให้ลบส่วนนั้นออก ให้เหลือแค่ `?sslmode=require` ตามรูปแบบในคู่มือ Prisma ของ Neon (เครื่องมือ migration ของ Prisma อาจไม่รับพารามิเตอร์นี้)
   - ส่วน `<host>` คัดลอกตามที่ Neon ให้มา ห้ามพิมพ์เอง
6. **ตรวจข้อความในช่อง Value ก่อนกด Save** เพราะบันทึกแล้วเปิดดูอีกไม่ได้ (ชนิด Secret) ต้องได้รูปแบบนี้:

   ```text
   postgresql://bcs_migrator:<รหัสผ่าน>@<host ที่ไม่มี -pooler>/bcs?sslmode=require
   ```

   - มีชื่อผู้ใช้ `bcs_migrator` · host ไม่มีคำว่า `-pooler` · ลงท้ายด้วย `/bcs?sslmode=require`
7. กด **Save** ถ้าภายหลังพบว่าผิด ให้กด **Edit** ที่แถวนั้นแล้ววางสตริงที่ถูกต้องทั้งเส้น

## ขั้นที่ 6 · สุ่มรหัสผ่านของ `bcs_app`

1. เปิด PowerShell ของคุณเอง (กด Start แล้วพิมพ์ PowerShell) **ห้ามพิมพ์คำสั่งนี้ในช่องแชทของ Claude Code** เพราะผลลัพธ์จะเข้าไปในบทสนทนา
2. วางคำสั่งนี้แล้วกด Enter:

   ```powershell
   node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
   ```

3. จะได้รหัสผ่านยาว 32 ตัวอักษร ที่มีแค่ a–z A–Z 0–9 `-` `_` จึงใส่ใน connection string ได้ตรง ๆ เปิดหน้าต่างนี้ค้างไว้จนจบขั้นที่ 9
   - ถ้าจะใช้ตัวสร้างรหัสผ่านของโปรแกรมจัดการรหัสผ่านแทน ให้ตั้งความยาว 32 ตัว และใช้ตัวอักษรกับตัวเลขเท่านั้น ห้ามมีสัญลักษณ์ เพราะ `@ : / # ? %` ทำให้ connection string ใช้ไม่ได้

## ขั้นที่ 7 · รัน SQL ใน SQL Editor

1. แถบซ้าย ส่วน **Postgres database** กด **SQL Editor**
2. ด้านบนของ editor เลือก branch `production` และ database **`bcs`** (ไม่ใช่ `neondb`)
3. **รันครั้งที่ 1 (จำเป็น):** วางคำสั่งด้านล่าง แทน `PASTE_BCS_APP_PASSWORD_HERE` ด้วยรหัสผ่านจากขั้นที่ 6 โดยให้ยังอยู่ในเครื่องหมาย `'` เหมือนเดิม แล้วกด **Run**

   ```sql
   -- 1) role ของแอป สร้างด้วย SQL จึงได้แค่สิทธิ์พื้นฐาน (แก้ประวัติ audit ไม่ได้)
   CREATE ROLE bcs_app WITH LOGIN PASSWORD 'PASTE_BCS_APP_PASSWORD_HERE';

   -- 2) ให้ bcs_app เชื่อมต่อฐานข้อมูล bcs ได้ สิทธิ์รายตาราง migration ของโปรเจกต์จะให้เอง
   GRANT CONNECT ON DATABASE bcs TO bcs_app;
   ```

4. ผลที่ถูกต้องคือไม่มีข้อความ **ERROR**
   - ถ้าเห็น WARNING เช่น `no privileges were granted` ไม่เป็นไร สิทธิ์เชื่อมต่อพื้นฐานมีอยู่แล้ว
   - ERROR ว่ารหัสผ่านไม่ปลอดภัยพอ (Neon ต้องการรหัสที่สุ่มพอ อย่างน้อย 60 bit) ให้สุ่มใหม่ในขั้นที่ 6 แล้วรันใหม่
   - ERROR `role "bcs_app" already exists` แปลว่าเคยรันมาแล้ว และอาจหยุดกลางทาง ห้ามข้ามไปขั้นที่ 8 ทันที ให้เปลี่ยนบรรทัด `CREATE ROLE …` เป็นบรรทัดด้านล่าง (ใส่รหัสผ่านจากขั้นที่ 6 แบบเดียวกัน) แล้วกด **Run** อีกครั้ง คำสั่ง `GRANT` รันซ้ำได้ไม่เสียหาย และรหัสผ่านของ `bcs_app` จะตรงกับรหัสในหน้าต่าง PowerShell ของคุณ แล้วจึงไปขั้นที่ 8

     ```sql
     ALTER ROLE bcs_app WITH PASSWORD 'PASTE_BCS_APP_PASSWORD_HERE';
     ```

   - ERROR อื่น: คัดลอกข้อความ error ไปถาม agent **แต่ก่อนส่ง ตรวจว่าไม่มีรหัสผ่านในข้อความ** เพราะบาง error ยกข้อความรอบจุดที่ผิดมาแสดง ซึ่งอาจมีรหัสผ่านอยู่ ถ้ามีให้ลบส่วนนั้นออกก่อนส่ง ถ้าเผลอส่งรหัสผ่านไปแล้ว ให้สุ่มรหัสใหม่ตามขั้นที่ 6 แล้วใช้รหัสใหม่แทน (ถ้า role ถูกสร้างไปแล้ว ใช้คำสั่ง `ALTER ROLE` ด้านบนกับรหัสใหม่)
5. **รันครั้งที่ 2 (ไม่บังคับ):** ลบข้อความเดิมใน editor วางคำสั่งนี้แล้วกด **Run** แยกจากครั้งที่ 1 เพื่อให้ error ของคำสั่งนี้ (ถ้ามี) ไม่กระทบคำสั่งในครั้งที่ 1 คำสั่งนี้ไม่มีค่าลับ

   ```sql
   -- 3) extension ที่ migration ขั้น S2 ใช้กันไม่ให้ DOA ฉบับที่มีผลมีช่วงเวลาทับกัน (spec §6.3 ข้อ 5)
   CREATE EXTENSION IF NOT EXISTS btree_gist;
   ```

   - ถ้าขึ้น ERROR ไม่เป็นไร ข้ามได้ migration ของโปรเจกต์ติดตั้ง extension นี้เองด้วย `bcs_migrator`
6. SQL Editor เก็บประวัติคำสั่งซึ่งมีรหัสผ่านอยู่ ถ้าแท็บ **History** มีปุ่มลบ ให้ลบรายการของรันครั้งที่ 1 (และรายการ `ALTER ROLE` ถ้ามี)

## ขั้นที่ 8 · ตรวจผล

วางคำสั่งนี้ใน SQL Editor (database `bcs`) แล้วกด **Run** คำสั่งนี้ไม่มีค่าลับ

```sql
SELECT rolname,
       rolcanlogin AS can_login,
       pg_has_role(rolname, 'neon_superuser', 'MEMBER') AS is_neon_superuser
FROM pg_roles
WHERE rolname IN ('bcs_migrator', 'bcs_app')
ORDER BY rolname;

SELECT pg_get_userbyid(datdba) AS db_owner FROM pg_database WHERE datname = 'bcs';

SELECT extname FROM pg_extension WHERE extname = 'btree_gist';
```

ผลที่ต้องได้ (true อาจแสดงเป็น `t` และ false เป็น `f`):

| ส่วนของผล | ค่าที่ถูกต้อง |
| --- | --- |
| แถว `bcs_app` | `can_login` = true · `is_neon_superuser` = **false** |
| แถว `bcs_migrator` | `can_login` = true · `is_neon_superuser` = true |
| `db_owner` | `bcs_migrator` |
| `extname` | `btree_gist` 1 แถว ถ้ารันครั้งที่ 2 ของขั้นที่ 7 สำเร็จ · ถ้าไม่มีแถว ไม่เป็นไร (migration ติดตั้งเอง) |

ถ้า `bcs_app` ได้ `is_neon_superuser` = true แปลว่าถูกสร้างจากหน้าเว็บ หยุดแล้วบอก agent ก่อนทำต่อ

## ขั้นที่ 9 · ประกอบ `DATABASE_URL` ใส่ Vercel

1. กด **Connect** อีกครั้ง เลือก **Branch** `production` · **Database** `bcs` · **Role** `bcs_migrator` แล้ว **เปิด** สวิตช์ **Connection pooling** (host จะมีคำว่า `-pooler`)
2. คัดลอกสตริง แล้ววางในช่อง Value ของตัวแปรใหม่ใน Vercel (Name `DATABASE_URL` · ชนิด **Secret** · Environment **Production**) จากนั้นแก้ในช่องนั้น 3 จุด:
   - ชื่อผู้ใช้ `bcs_migrator` เปลี่ยนเป็น `bcs_app`
   - รหัสผ่าน (ข้อความระหว่าง `:` ตัวที่สองกับ `@`) เปลี่ยนเป็นรหัสผ่านจากขั้นที่ 6
   - ถ้ามี `&channel_binding=require` ให้ลบออก
3. **ตรวจข้อความในช่อง Value ก่อนกด Save** เพราะบันทึกแล้วเปิดดูอีกไม่ได้ ต้องได้รูปแบบนี้:

   ```text
   postgresql://bcs_app:<รหัสผ่าน bcs_app>@<host ที่มี -pooler>/bcs?sslmode=require
   ```

   - ขึ้นต้นด้วย `postgresql://bcs_app:` (ไม่ใช่ `bcs_migrator`) · host มีคำว่า `-pooler` · ลงท้ายด้วย `/bcs?sslmode=require`
   - ถ้าลืมเปลี่ยนชื่อผู้ใช้และรหัสผ่าน `DATABASE_URL` จะชี้ไปที่ `bcs_migrator` ซึ่งมีสิทธิ์สูงเกินสำหรับแอป จึงต้องตรวจตรงนี้ และ agent ตรวจซ้ำหลัง deploy (ขั้นที่ 10)
4. กด **Save**
5. ปิดหน้าต่าง PowerShell รหัสผ่านของ `bcs_app` ไม่ต้องจดเก็บ ถ้าต้องใช้อีก ให้ตั้งใหม่ตามหัวข้อ "ถ้ารหัสผ่านหลุด" ด้านล่าง
   - ถ้าเปิดประวัติคลิปบอร์ด (Win+V) ไว้ ให้ลบรายการที่มีรหัสผ่านออก
   - ถ้าใช้ Notepad ช่วยแก้ข้อความ ระวังว่า Notepad ของ Windows 11 จำแท็บที่ไม่ได้บันทึกไว้ให้ ต้องปิดแท็บแล้วเลือกไม่บันทึก

## ขั้นที่ 10 · บอก agent

พิมพ์: "ตั้ง Neon แล้ว ใส่ DATABASE_URL และ DIRECT_URL ใน Vercel แล้ว"

ตอน deploy ครั้งแรก agent จะ:

- รัน migration ด้วย `bcs_migrator` และให้แอปต่อด้วย `bcs_app` (FR-PLT-006 AC3)
- ตรวจบน staging ว่าแอปเชื่อมต่อด้วย role `bcs_app` จริง เช่น ให้แอปรายงานชื่อ role ที่ใช้อยู่ทาง `/api/health` หรือ log ถ้าเป็น `bcs_migrator` แปลว่า `DATABASE_URL` ยังใช้ชื่อผู้ใช้เดิม ให้ประกอบใหม่ตามขั้นที่ 9 แล้วกด **Edit** ที่ `DATABASE_URL` ใน Vercel วางทับทั้งเส้น
- ตรวจบน staging ว่า `bcs_app` ไม่มีสิทธิ์ UPDATE DELETE หรือ TRUNCATE บนตาราง `Event` (spec §6.3 · INV-EVT-01) เพราะ `pnpm verify` บนเครื่องตรวจฐานข้อมูลของ staging ไม่ได้

การ migrate และ seed ครั้งแรกบน staging คุณอนุมัติแล้ว (2026-10-02) · การ reset หรือแก้ข้อมูลบน staging ครั้งต่อไป agent ต้องถามคุณก่อน (spec §17.4)

## ข้อห้าม

- ห้ามสร้าง `bcs_app` จากหน้าเว็บ (เหตุผลอยู่ด้านบน)
- ห้ามใช้ `neondb_owner` หรือ connection string เริ่มต้นของ Neon ใน Vercel
- ห้ามติดตั้ง Neon integration จาก Vercel Marketplace เพราะมันจะใส่ `DATABASE_URL` ของ role ที่มีสิทธิ์สูงเกินแทนค่าของเรา
- ห้ามรัน `prisma migrate reset` หรือคำสั่งลบข้อมูลกับ staging (spec §17.3 · `pnpm db:reset` ปฏิเสธเองเมื่อ `APP_ENV` ไม่ใช่ `local`)
- ห้ามใส่ข้อมูลจริงของลูกค้าจนกว่า OQ-19 ปิด (spec §4.12)
- ห้ามใส่ค่าเหล่านี้ใน `.env` บนเครื่อง เครื่องของคุณใช้ Postgres ใน Docker อยู่แล้ว

## ถ้ารหัสผ่านหลุด

ค่าใน Vercel เป็นชนิด Secret เปิดดูไม่ได้ จึงต้องประกอบสตริงใหม่ทั้งเส้น แล้วกด **Edit** ที่แถวนั้นวางทับ

| role | วิธีตั้งใหม่ | แล้วแก้ |
| --- | --- | --- |
| `bcs_migrator` | หน้า **Roles** → เมนูของ `bcs_migrator` → **Reset password** | `DIRECT_URL` ใน Vercel (ประกอบใหม่ตามขั้นที่ 5) |
| `bcs_app` | สุ่มรหัสใหม่ตามขั้นที่ 6 ในหน้าต่าง PowerShell ของคุณเอง → SQL Editor (database `bcs`) รัน `ALTER ROLE bcs_app WITH PASSWORD '<รหัสใหม่>';` → ลบรายการในแท็บ **History** และในประวัติคลิปบอร์ด (Win+V) ถ้าเปิดไว้ | `DATABASE_URL` ใน Vercel (ประกอบใหม่ตามขั้นที่ 9) |

จากนั้นบอก agent ให้ deploy ใหม่ (ค่าใหม่มีผลกับ deployment ถัดไปเท่านั้น)

## หมายเหตุสำหรับ agent

- role ที่สร้างจาก Console API หรือ CLI ของ Neon เป็นสมาชิก `neon_superuser` ซึ่งมี `CREATEDB` `CREATEROLE` `BYPASSRLS` `REPLICATION` เป็นสมาชิก `pg_read_all_data` `pg_write_all_data` `pg_maintain` และได้ `GRANT ALL ON TABLES` กับ `SEQUENCES` ใน schema `public` แบบ `WITH GRANT OPTION` (เอกสาร Neon หน้า roles) ส่วน role ที่สร้างด้วย SQL ได้แค่สิทธิ์พื้นฐานของ schema `public`
- ถ้า `bcs_app` เป็นสมาชิก `neon_superuser` คำสั่ง `REVOKE UPDATE, DELETE, TRUNCATE … FROM bcs_app` ใน migration (§6.3 ข้อ 2) ถอนสิทธิ์ที่มาจาก `pg_write_all_data` ไม่ได้ `has_table_privilege('bcs_app', '"Event"', 'UPDATE')` จะเป็น true ซึ่งขัดบรรทัดท้าย §6.3 และ INV-EVT-01 · trigger `bcs_forbid_mutation` (BEFORE UPDATE OR DELETE รายแถว) ยังกัน UPDATE และ DELETE ได้ทุก role แต่ชั้นสิทธิ์หายไป และ trigger รายแถวไม่ครอบคลุม TRUNCATE (หมายเหตุใน §6.3) จึงต้องตรวจ TRUNCATE ด้วย
- ด่าน db ของ `pnpm verify` (`scripts/verify-db.ts`) ตรวจเฉพาะฐาน `bcs_verify` บนเครื่องที่สร้างจาก `.env` ของเครื่อง (`scripts/lib/db-urls.ts`) จึงไม่เห็น role บน staging · หลัง deploy ให้ตรวจบน staging แบบเดียวกับ verify-db: `has_table_privilege` ของ `bcs_app` กับ UPDATE DELETE TRUNCATE บน `Event` `BudgetLedgerEntry` `EventSeal` และ `current_user` ของ runtime เป็น `bcs_app` (FR-PLT-006 AC3) · agent อ่าน `DATABASE_URL` และ `DIRECT_URL` ใน Vercel ไม่ได้ (Secret) จึงต้องตรวจผ่านโค้ดที่รันบน Vercel
- เหตุที่สร้าง `bcs_migrator` จากหน้าเว็บ: ต้องเป็นเจ้าของฐานข้อมูลและติดตั้ง extension ได้ เอกสาร Neon ไม่ได้ยืนยันว่า role ที่สร้างด้วย SQL ทำได้ใน SQL Editor · ใน PostgreSQL 15 ขึ้นไป schema `public` เป็นของ `pg_database_owner` เจ้าของฐานข้อมูล (`bcs_migrator`) จึงเป็นเจ้าของ schema `public` ไปด้วย
- ข้อแลกเปลี่ยน: `DIRECT_URL` (`bcs_migrator` สิทธิ์สูง) ต้องเป็น Secret เสมอ และ ณ 2026-10-02 schema ใน `src/lib/env.ts` บังคับให้มี `DIRECT_URL` ตอน runtime ขณะที่ environment variable ของ Vercel ใช้ทั้งตอน build และ runtime ทุกฟังก์ชันของแอปจึงเข้าถึงสิทธิ์ของ migrator ได้ ข้อเสนอ: ให้ `DIRECT_URL` เป็น optional ตอน runtime เพราะใช้แค่ตอน build และ migration (เป็นการตัดสินใจออกแบบของ agent)
- เอกสาร Neon ไม่ได้บอกว่า SQL Editor รันด้วย role ไหน และไม่ได้บอกว่าหลายคำสั่งรันในธุรกรรมเดียวหรือไม่ จึงแยก `CREATE EXTENSION` ไปรันครั้งที่ 2 · `btree_gist` เป็น extension แบบ trusted (ผู้มีสิทธิ์ `CREATE` บนฐานข้อมูลติดตั้งได้) migration ที่รันด้วย `bcs_migrator` ซึ่งเป็นเจ้าของฐานข้อมูลจึงติดตั้งเองได้ (§6.3 ข้อ 5)

## เอกสารอ้างอิงที่ใช้ตรวจ (ต.ค. 2026)

- <https://neon.com/docs/manage/projects>
- <https://neon.com/docs/introduction/regions>
- <https://neon.com/docs/manage/roles>
- <https://neon.com/docs/manage/databases>
- <https://neon.com/docs/manage/database-access>
- <https://neon.com/docs/reference/compatibility>
- <https://neon.com/docs/connect/connection-pooling>
- <https://neon.com/docs/connect/connect-from-any-app>
- <https://neon.com/docs/guides/prisma>
- <https://neon.com/docs/extensions/btree_gist>
- <https://neon.com/docs/get-started/query-with-neon-sql-editor>
- <https://neon.com/docs/introduction/plans>
- <https://neon.com/faqs/free-plan-limits-and-quotas>
- <https://www.postgresql.org/docs/17/btree-gist.html>
- <https://vercel.com/changelog/environment-variables-now-use-config-and-secret-types>
