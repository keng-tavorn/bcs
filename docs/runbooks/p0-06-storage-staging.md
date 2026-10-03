# P0-06 · ที่เก็บไฟล์ของ staging

| รายการ | ค่า |
| --- | --- |
| ข้อใน spec | P0-06 `[คน]` `[demo]` ที่เก็บไฟล์: ทดสอบ Neon Object Storage ถ้าไม่ผ่านใช้ R2 หรือ S3 (ADR-033) |
| เสร็จเมื่อ | อัปโหลดและดาวน์โหลดผ่าน presigned URL บน staging ได้ |
| ก่อนเริ่ม | ทำ Vercel ส่วน A แล้ว (รู้โดเมน staging) · มี Neon project `bcs-staging` แล้ว (สำหรับทางเลือก A) |
| สถานะ ADR-033 | ยังไม่ตัดสินสำหรับ production ผลของคู่มือนี้ใช้กับ staging เท่านั้น |
| เวลา | ประมาณ 20 นาที |

## ภาพรวม

- ระบบเก็บไฟล์แนบ เช่น ใบเสนอราคาและรูปตรวจรับ ผ่าน S3 API ใน bucket แบบ private (เปิดตรงจากอินเทอร์เน็ตไม่ได้) เบราว์เซอร์อัปโหลดและดาวน์โหลดผ่านลิงก์ชั่วคราวที่ระบบออกให้ (presigned URL อายุไม่เกิน 5 นาที · NFR-SEC-08)
- เพราะเบราว์เซอร์ส่งไฟล์ตรงไปที่ที่เก็บไฟล์ จึงต้องตั้ง **CORS** คือกฎที่บอกที่เก็บไฟล์ว่ายอมรับคำขอจากหน้าเว็บของโดเมนไหน ต้องยอมรับ `PUT` (อัปโหลด) `GET` (ดาวน์โหลด) และ `HEAD` (อ่านข้อมูลของไฟล์โดยไม่ดาวน์โหลด) จากโดเมน staging
- บนเครื่องของคุณใช้ RustFS ใน Docker อยู่แล้ว (แทน MinIO ที่ image ทางการถูกลบ · หมายเหตุ 2026-10-02 ใน ADR-033) ไม่ต้องทำอะไร
- ตาม spec ให้ลอง **ทางเลือก A: Neon Object Storage** ก่อน บริการนี้เปิดใช้ทั่วไปเมื่อ 18 ก.ย. 2026 มีที่สิงคโปร์ และอยู่ใน Neon project เดียวกับฐานข้อมูล ถ้าไม่ผ่านให้ใช้ **ทางเลือก B: Cloudflare R2** (ถ้าอยากใช้ AWS S3 ให้บอก agent ก่อน คู่มือนี้ไม่ได้เขียนไว้)
- ใช้ทางเลือกเดียว ค่า `S3_*` ทั้ง 6 ตัวใน Vercel ต้องมาจากผู้ให้บริการเดียวกัน

## ค่าใช้จ่าย (ตรวจ ต.ค. 2026)

| ทางเลือก | ส่วนฟรี | เกินส่วนฟรี |
| --- | --- | --- |
| A · Neon Object Storage | 5 GB ต่อ project ไม่คิดตามจำนวนคำขอ · ข้อมูลขาออกนับรวมโควตา network ของ Neon (แผน Free 5 GB ต่อเดือน) | แผนเสียเงิน US$0.023 ต่อ GB-เดือน |
| B · Cloudflare R2 | 10 GB-เดือน · คำขอเขียน 1 ล้านครั้ง อ่าน 10 ล้านครั้งต่อเดือน · ข้อมูลขาออกฟรี | US$0.015 ต่อ GB-เดือน · ต้องเปิด R2 subscription ก่อน (อาจต้องผูกบัตร) |

demo ใช้ไฟล์ไม่กี่ MB จึงน่าจะอยู่ในส่วนฟรีทั้งสองทาง

## ทางเลือก A · Neon Object Storage (ลองก่อน)

### A1. สร้าง bucket

1. เปิด <https://console.neon.tech> → project `bcs-staging` → ตรวจว่าเลือก branch `production`
2. เปิดแท็บ **Object storage**
   - ถ้าไม่มีแท็บนี้ แปลว่าไม่ได้เปิดบริการตอนสร้าง project หรือ region หรือแผนไม่รองรับ ให้ถาม agent หรือไปทางเลือก B
3. กด **New bucket** · ชื่อ `bcs-staging` · access level **private** (ค่าเริ่มต้น ห้ามเลือก public) · กด **Create**

bucket ผูกกับ branch ถ้าภายหลังสร้าง branch ใหม่ของ Neon branch นั้นจะได้สำเนา bucket ไปด้วย

### A2. สร้าง credential (คู่ access key ให้แอปใช้)

1. กดปุ่ม **Connect** (บนสุดของแถบซ้าย) แล้วเปิดแท็บ **Storage**
2. สร้าง credential ใหม่ ตั้งชื่อ `bcs-staging-app` ให้สิทธิ์ทั้ง read และ write (`storage:read` และ `storage:write`)
3. หน้าจอจะแสดง **Access Key ID** · **Secret Access Key** · endpoint และ region ค่า secret แสดงครั้งเดียว ให้ใส่ใน Vercel ทันทีตาม A3 (ถ้าปิดหน้าไปก่อน ให้สร้าง credential ใหม่แล้วลบอันเก่า)

### A3. ใส่ใน Vercel

วิธีเพิ่มตัวแปรอยู่ในหัวข้อ "วิธีเพิ่ม environment variable ใน Vercel" ของ [p0-08-vercel.md](p0-08-vercel.md) ทุกตัวเลือก Environment **Production**

| Name | ชนิด | ค่า |
| --- | --- | --- |
| `S3_ENDPOINT` | Config | endpoint ที่ Neon แสดง ขึ้นต้นด้วย `https://` |
| `S3_REGION` | Config | region ที่ Neon แสดง (สิงคโปร์คือ `ap-southeast-1`) |
| `S3_BUCKET` | Config | `bcs-staging` |
| `S3_FORCE_PATH_STYLE` | Config | `true` (Neon รับเฉพาะรูปแบบ path-style) |
| `S3_ACCESS_KEY_ID` | Secret | Access Key ID |
| `S3_SECRET_ACCESS_KEY` | Secret | Secret Access Key |

### A4. CORS (จุดที่ต้องทดสอบ)

- เอกสาร Neon ณ ต.ค. 2026 ไม่มีหน้าตั้ง CORS บนหน้าเว็บ ต้องตั้งผ่าน S3 API (คำสั่ง `PutBucketCors`) และเอกสารไม่ได้บอกว่า credential แบบ read/write ตั้ง CORS ได้หรือไม่
- โปรเจกต์มีสคริปต์ `scripts/storage-init.ts` ที่ตั้ง CORS จากค่า `S3_*` และ `APP_URL` agent จะหาวิธีรันกับ staging โดยไม่ต้องให้คุณส่งค่าลับในแชท แล้วรายงานผล
- ตอนนี้สคริปต์ใส่ `http://localhost:3000` และ `http://localhost:3100` เป็นโดเมนที่อนุญาตเสมอ ถ้ารันกับ bucket ของ staging ตามเดิม bucket จะยอมรับคำขอจาก localhost ด้วย ก่อนรันกับ staging agent จะแก้ให้อนุญาตเฉพาะ `APP_URL` (โดเมน staging) เมื่อ `APP_ENV` ไม่ใช่ `local` และใช้กฎเดียวกับ B3 (`GET` `PUT` `HEAD` · header `Content-Type`)
- ขั้นนี้คุณไม่ต้องทำอะไร นอกจากบอก agent ว่าใช้ทางเลือก A

### A5. เมื่อไรต้องเปลี่ยนไปทางเลือก B

- ตั้ง CORS ของ bucket ใน Neon ไม่ได้ หรือ
- หลัง deploy แล้วอัปโหลดหรือดาวน์โหลดไฟล์บน staging ไม่ผ่าน และ agent แก้ไม่ได้

เมื่อเปลี่ยน ให้ทำทางเลือก B แล้ว **แก้ค่า** `S3_*` ทั้ง 6 ตัวที่มีอยู่ใน Vercel (กดจุดสามจุดท้ายแถว → **Edit** ไม่ใช่เพิ่มตัวใหม่ซ้ำชื่อ) แล้วบอก agent ให้ deploy ใหม่ จากนั้นลบ bucket และ credential ของ Neon ที่ไม่ใช้แล้ว

- **ถ้าเคยอัปโหลดไฟล์บน staging แล้ว บอก agent ก่อนลบ bucket** เพราะไฟล์ใน bucket จะหาย และรายการไฟล์ในฐานข้อมูลของ staging จะชี้ไปที่ไฟล์ที่ไม่มีแล้ว การ seed ใหม่เพื่อล้างรายการเหล่านั้นเป็นการแก้ข้อมูล staging ต้องให้คุณอนุมัติ (spec §17.4)

## ทางเลือก B · Cloudflare R2 (สำรอง)

### B1. เปิดใช้ R2

1. สมัครหรือ login ที่ <https://dash.cloudflare.com>
2. แถบซ้าย **Storage & databases** → **R2** → **Overview**
3. ทำขั้นตอนเพิ่ม R2 subscription จนเสร็จ (ระบบอาจให้ผูกบัตร ถ้าใช้ไม่เกินส่วนฟรีจะไม่เสียเงิน)

### B2. สร้าง bucket

1. หน้า R2 กด **Create bucket**
2. **Bucket name:** `bcs-staging` (ใช้ได้แค่ตัวพิมพ์เล็ก ตัวเลข และ `-`)
3. **Location:** เลือกระบุ location hint เป็น **Asia-Pacific (APAC)** ไม่ต้องเลือก Jurisdiction (location hint มีผลเฉพาะตอนสร้างครั้งแรก)
4. **Default Storage Class:** **Standard** (ส่วนฟรีใช้กับ Standard เท่านั้น)
5. กด **Create bucket**
6. bucket ใหม่เป็น private อยู่แล้ว **ห้ามเปิด Public access และห้ามเปิด r2.dev URL**

### B3. ตั้ง CORS

1. เปิด bucket `bcs-staging` → แท็บ **Settings** → หัวข้อ **CORS Policy** → **Add CORS policy**
2. เลือกแท็บ **JSON** แล้ววางข้อความนี้ แทน `<โดเมน staging>` ด้วยโดเมนจริง (ไม่มี `/` ท้าย)

   ```json
   [
     {
       "AllowedOrigins": ["https://<โดเมน staging>"],
       "AllowedMethods": ["GET", "PUT", "HEAD"],
       "AllowedHeaders": ["Content-Type"],
       "ExposeHeaders": ["ETag"],
       "MaxAgeSeconds": 3600
     }
   ]
   ```

3. กด **Save**

- กฎนี้ต้องตรงกับกฎที่ agent ใช้บนเครื่อง เพื่อให้การอัปโหลดที่ผ่านบนเครื่องผ่านบน staging ด้วย (ดูหมายเหตุสำหรับ agent ท้ายไฟล์)
- ถ้า agent แจ้งภายหลังว่าเบราว์เซอร์ส่ง header อื่นด้วย ให้เพิ่มชื่อ header นั้นใน `AllowedHeaders` ตามที่ agent บอก
- token ที่ให้แอปใน B4 มีสิทธิ์แค่ไฟล์ ตั้งค่า bucket (รวม CORS) ไม่ได้ จึงต้องตั้ง CORS ที่หน้านี้เอง และต้องตั้งใหม่ถ้าโดเมน staging เปลี่ยน

### B4. สร้าง API token ให้แอป

1. หน้า R2 **Overview** ส่วน **Account Details** กด **Manage** ข้าง **API Tokens**
2. กด **Create Account API token** ตั้งชื่อ `bcs-staging-app`
3. **Permissions:** **Object Read & Write**
4. จำกัดให้ใช้ได้กับ bucket `bcs-staging` เท่านั้น (ตัวเลือกระบุ bucket)
5. กดสร้าง token แล้วคัดลอก **Access Key ID** และ **Secret Access Key** (secret แสดงครั้งเดียว) และ endpoint รูปแบบ `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` (ใช้ endpoint ปกติ ไม่ใช่แบบ EU หรือ FedRAMP)

### B5. ใส่ใน Vercel

| Name | ชนิด | ค่า |
| --- | --- | --- |
| `S3_ENDPOINT` | Config | `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` |
| `S3_REGION` | Config | `auto` |
| `S3_BUCKET` | Config | `bcs-staging` |
| `S3_FORCE_PATH_STYLE` | Config | `true` |
| `S3_ACCESS_KEY_ID` | Secret | Access Key ID |
| `S3_SECRET_ACCESS_KEY` | Secret | Secret Access Key |

## ทดสอบให้ครบ "เสร็จเมื่อ"

ทดสอบได้หลัง agent deploy staging และทำข้อ S1-10 (อัปโหลดและดาวน์โหลดไฟล์) แล้ว

1. agent ทดสอบอัปโหลดและดาวน์โหลดผ่าน presigned URL บน staging แล้วรายงานผล
2. คุณลองเองบนมือถือ: เปิด `https://<โดเมน staging>` → login ผู้ใช้ตัวอย่าง (รหัสผ่านและ 2FA ตาม [p0-08-vercel.md](p0-08-vercel.md) B2) → อัปโหลดรูป 1 รูป → เปิดดูได้ (ตามฉาก Demo ของ S1 ใน spec §16.3)
3. ผ่านแล้วบอก agent เพื่อบันทึกผลลง ADR-033 (staging เท่านั้น)

## บอก agent

- หลังใส่ค่า: "ใส่ค่า S3 ของ staging ใน Vercel แล้ว ใช้ทางเลือก A (Neon)" หรือ "… ใช้ทางเลือก B (R2) ตั้ง CORS แล้ว"
- หลังทดสอบ: "อัปโหลดและดาวน์โหลดบน staging ผ่านแล้ว" (P0-06 เป็นข้อ `[คน]` agent ห้ามติ๊กเอง ต้องให้คุณยืนยัน)

## ถ้า key หลุด

- Neon: สร้าง credential ใหม่ (A2) → แก้ `S3_ACCESS_KEY_ID` และ `S3_SECRET_ACCESS_KEY` ใน Vercel → ลบ credential เก่า → บอก agent ให้ deploy ใหม่
- R2: สร้าง token ใหม่ (B4) → แก้ 2 ค่าเดียวกันใน Vercel → ลบ token เก่าที่หน้า API Tokens → บอก agent ให้ deploy ใหม่

## หมายเหตุสำหรับ agent

- `scripts/storage-init.ts` ณ 2026-10-02 ตั้งกฎ CORS เป็น `AllowedMethods` `GET` `PUT` `HEAD` · `AllowedHeaders` `["*"]` · `MaxAgeSeconds` 300 และใส่ `http://localhost:3000` กับ `http://localhost:3100` ทุกครั้ง (บรรทัด 15) ต้องแก้ให้ (1) ใช้กฎเดียวกับ B3 ทั้งบนเครื่องและ staging (2) อนุญาตเฉพาะ `APP_URL` เมื่อ `APP_ENV` ไม่ใช่ `local` ก่อนรันกับ bucket ของ staging
- เอกสาร R2 ระบุ `AllowedMethods` สำหรับ presigned URL เป็น `GET` `PUT` `HEAD` `DELETE` แต่ไม่ได้ยืนยันว่า `AllowedHeaders` รับ `*` คู่มือนี้จึงระบุ header ตรง ๆ (`Content-Type`) · ถ้าโค้ดอัปโหลด (S1-10) ส่ง header อื่น ให้เพิ่มทั้งใน storage-init และในข้อความของ B3 พร้อมบอกเจ้าของให้แก้ใน R2

## เอกสารอ้างอิงที่ใช้ตรวจ (ต.ค. 2026)

- <https://neon.com/docs/changelog/2026-09-18>
- <https://neon.com/docs/storage/overview>
- <https://neon.com/docs/storage/get-started>
- <https://neon.com/docs/storage/buckets>
- <https://neon.com/docs/storage/authentication>
- <https://neon.com/docs/storage/s3-compatibility>
- <https://neon.com/docs/storage/objects>
- <https://neon.com/docs/reference/api/buckets>
- <https://neon.com/docs/introduction/plans>
- <https://developers.cloudflare.com/r2/get-started/>
- <https://developers.cloudflare.com/r2/buckets/create-buckets/>
- <https://developers.cloudflare.com/r2/reference/data-location/>
- <https://developers.cloudflare.com/r2/buckets/cors/>
- <https://developers.cloudflare.com/r2/api/tokens/>
- <https://developers.cloudflare.com/r2/api/s3/presigned-urls/>
- <https://developers.cloudflare.com/r2/pricing/>
