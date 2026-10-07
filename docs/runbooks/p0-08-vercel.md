# P0-08 · Vercel สำหรับ staging (และอีเมลของ demo)

| รายการ | ค่า |
| --- | --- |
| ข้อใน spec | P0-08 `[คน]` `[demo]` เลือก hosting (ADR-032) และ inbox อีเมลสำหรับ demo (ADR-031) |
| เสร็จเมื่อ | agent deploy staging ได้ด้วย token ที่ให้ไว้ |
| ตัดสินแล้ว | staging ใช้ Vercel ภูมิภาคสิงคโปร์ `sin1` (ADR-032 · คุณตัดสิน 2026-10-02) |
| วิธี deploy | staging เป็น project แยกชื่อ `bcs-staging` และ agent deploy ด้วย `--prod` จึงใช้ environment ชื่อ Production ของ project นี้ (ตามแผนงานที่คุณอนุมัติ บันทึกใน ADR-032 · `--prod` ไม่ได้แปลว่า production ของ BCS) |
| ยังไม่ตัดสิน | อีเมลของ staging (ADR-031) ดูหัวข้อ B4 ต้องเลือกก่อน deploy ครั้งแรก |
| เวลา | ส่วน A ประมาณ 20 นาที · ส่วน B ประมาณ 20 นาที |

คู่มือนี้แบ่งเป็น 2 ส่วน: **ส่วน A** สร้างบัญชี token และ project ทำก่อน Neon เพื่อให้มีที่ใส่ค่าลับทันทีที่ได้มา · **ส่วน B** ใส่ค่าที่เหลือแล้วให้ agent deploy ทำหลัง Neon ที่เก็บไฟล์ และ Inngest

## ค่าใช้จ่าย (ตรวจ ต.ค. 2026)

- ต้องใช้แผน **Pro** เพราะแผนฟรี (Hobby) ใช้ได้เฉพาะงานส่วนตัวที่ไม่ใช่เชิงพาณิชย์ และ Vercel นับงานที่มีคนได้ค่าจ้างเป็นงานเชิงพาณิชย์
- Pro ราคา US$20 ต่อเดือน รวมที่นั่งที่ deploy ได้ 1 ที่ และเครดิตค่าใช้งาน US$20 ต่อเดือน (staging ของ demo น่าจะใช้ไม่เกินเครดิตนี้) · ที่นั่งเพิ่มที่ deploy ได้ US$20 ต่อที่ · ที่นั่งแบบดูอย่างเดียว (Viewer) ฟรี
- ไม่ต้องเปิด Password Protection: ไม่จำเป็น และเสียเงิน US$20 ต่อเดือนต่อ project และถ้าใช้คู่กับ All Deployments จะกัน LINE และ Inngest

## ส่วน A · บัญชี token และ project (ทำก่อน Neon)

### A1. สมัครและสร้าง team แบบ Pro

1. เปิด <https://vercel.com/signup> สมัครด้วยอีเมลของบริษัท (หรือ login ถ้ามีบัญชีแล้ว)
2. ที่ตัวเลือกบัญชีและ team มุมซ้ายบน กด **Create Team** ตั้งชื่อ `BCS` เลือกแผน **Pro** แล้วใส่ข้อมูลการชำระเงิน
   - ถ้ามี team ของบริษัทที่เป็น Pro อยู่แล้ว ใช้ team นั้นได้ แต่ token ในขั้น A2 จะเข้าได้ทุก project ใน team นั้น (จำกัดให้แคบลงได้ใน A4)
3. จด **team slug** (ชื่อ team ใน URL เช่น `vercel.com/<team-slug>`) ไว้บอก agent ค่านี้ไม่ใช่ค่าลับ
4. แนะนำ: ที่ team → **Settings** → **Billing** ตั้ง spend management ให้แจ้งเตือนที่ยอดที่คุณรับได้ (ค่าเริ่มต้นแจ้งที่ US$200 ต่อรอบบิล)

### A2. สร้าง token ให้ agent ใช้ deploy

1. ที่มุมซ้ายบนเลือก **บัญชีส่วนตัว** (ไม่ใช่ team) แล้วเปิด <https://vercel.com/account/tokens> (หน้า **Account Tokens**)
   - ถ้า team บังคับ two-factor authentication ระบบจะให้เปิดก่อนสร้าง token
2. ช่องชื่อ token ใส่ `bcs-agent-cli`
3. **Scope:** เลือก team `BCS` แล้วเลือก **All Projects** (ตอนนี้ยังไม่มี project จึงเลือกราย project ไม่ได้ หลัง agent สร้าง project แล้ว เปลี่ยนเป็น token เฉพาะ project ได้ตาม A4)
4. **Expiration:** เลือก 90 วัน (หมดอายุแล้วสร้างใหม่ตามขั้นนี้)
5. กด **Create** แล้วคัดลอก token (ขึ้นต้นด้วย `vcp_` แสดงครั้งเดียว)
6. เปิดไฟล์ `E:\BCS\.env` ด้วย Notepad หรือ VS Code หาบรรทัด `VERCEL_TOKEN=` แล้ววาง token ต่อท้ายเครื่องหมาย `=` ทันที (ไม่มีช่องว่าง ไม่ต้องมีเครื่องหมายคำพูด) แล้วบันทึกไฟล์
   - ถ้าไม่มีบรรทัดนี้ ให้เพิ่มบรรทัด `VERCEL_TOKEN=<token>` ท้ายไฟล์
   - ไฟล์ `.env` อยู่ใน `.gitignore` จึงไม่เข้า git
   - **ห้ามใส่ `VERCEL_TOKEN` ใน Environment Variables ของ Vercel และห้ามวางในแชท**
7. พิมพ์บอก agent: "ใส่ VERCEL_TOKEN ใน .env แล้ว team slug คือ <team-slug> ช่วยสร้าง project bcs-staging"

agent จะสร้าง project `bcs-staging` ด้วย Vercel CLI และเชื่อมโฟลเดอร์โปรเจกต์ไว้ (โฟลเดอร์ `.vercel/` ไม่เข้า git) แล้วตั้ง framework เป็น Next.js และ region ของ function เป็น `sin1` ผ่าน API ของ Vercel ให้ด้วย (ทำแล้ว 2026-10-07 ใน team `tavorn-bcs`)

**ก่อน deploy ครั้งใดก็ตาม** agent จะสร้างไฟล์ `.vercelignore` ที่กันไฟล์ `.env` ไม่ให้ถูกอัปโหลดขึ้น Vercel คุณถามยืนยันกับ agent ได้ว่าสร้างแล้ว (มีแล้ว และกันทุกอย่างที่ `.gitignore` กัน โดยมีเทสต์ `tests/unit/vercel-config.test.ts` คอยตรวจ) เหตุผล:

- Vercel CLI อัปโหลดทุกไฟล์ในโฟลเดอร์ ยกเว้นรายการที่กันไว้ รายการที่ Vercel กันให้เองมีแค่ `.env.local` และ `.env.*.local` ไม่รวม `.env`
- ไฟล์ `.env` มี `VERCEL_TOKEN` และไฟล์ที่อัปโหลดแล้วเปิดดูได้ที่ `/_src` ของ deployment โดยสมาชิก team

### A3. ตั้งค่า project หลัง agent สร้างแล้ว

เปิด <https://vercel.com> → เลือก team `BCS` → project `bcs-staging` → **Settings**

1. **โดเมน staging:** **Settings** → **Domains** จะมีโดเมนที่ลงท้ายด้วย `.vercel.app` ซึ่งอาจมีคำสุ่มต่อท้าย
   - **ถ้ายังไม่มีโดเมนในหน้านี้** (Vercel ผูกโดเมนให้ตอน deploy ครั้งแรก) ให้พิมพ์บอก agent: "ยังไม่มีโดเมนในหน้า Domains ช่วย deploy ครั้งแรก" agent จะตรวจว่ามี `.vercelignore` แล้ว deploy ครั้งแรกให้ (หน้าเว็บอาจยังใช้ไม่ได้จนกว่าจะทำส่วน B ไม่เป็นไร) จากนั้นกลับมาที่หน้านี้
   - ถ้าอยากได้ชื่อที่อ่านง่าย กด **Edit** แล้วเปลี่ยนเป็นชื่อที่ยังว่าง เช่น `bcs-staging-demo.vercel.app`
   - ตัดสินชื่อครั้งเดียวตอนนี้ เพราะโดเมนนี้จะใช้ใน `APP_URL` LINE Inngest และ CORS ถ้าเปลี่ยนภายหลังต้องแก้ทุกที่
   - จด `https://<โดเมน>` ไว้ คู่มือทุกฉบับเรียกค่านี้ว่า "โดเมน staging"
2. **Region ของ function:** agent ตั้งเป็น `sin1` ให้แล้วตอนสร้าง project คุณแค่ตรวจ: **Settings** → **Functions** → ส่วน **Function Regions** ต้องเป็น **Singapore (`sin1`)** อย่างเดียว ถ้าไม่ใช่ ให้เลือก `sin1` เอาภูมิภาคอื่นออก แล้วกด **Save**
   - project ใหม่ตั้งค่าเริ่มต้นเป็น Washington D.C. (`iad1`) ซึ่งไกลจากฐานข้อมูลที่สิงคโปร์
   - ถ้า agent ใส่ `regions` ในไฟล์ `vercel.json` ค่านั้นจะใช้แทนค่านี้ และต้องเป็น `sin1` เหมือนกัน
3. **Deployment Protection:** **Settings** → **Deployment Protection** → ส่วน **Vercel Authentication** เปิดไว้และเลือก **Standard Protection** (ค่าเริ่มต้น) แล้วกด **Save** · project ที่ agent สร้าง 2026-10-07 เป็นค่านี้อยู่แล้ว (API แสดง `all_except_custom_domains`) ถ้าหน้าจอตรงกันไม่ต้องกด Save
   - Standard Protection กันคนนอกเปิด URL ของแต่ละ deployment แต่ไม่กันโดเมน production ซึ่งก็คือโดเมน staging ของเรา LINE และ Inngest จึงเรียก `https://<โดเมน staging>/api/webhooks/line/…` และ `https://<โดเมน staging>/api/inngest` ได้
   - **ห้ามเลือก All Deployments** เพราะจะกัน LINE และ Inngest · ไม่ต้องเปิด Password Protection (เสียเงินเพิ่มและไม่จำเป็น)
   - ผลคือใครก็เปิดหน้า login ของ staging ได้ จึงใช้ข้อมูลตัวอย่างเท่านั้น (ห้ามข้อมูลจริงของลูกค้าจนกว่า OQ-19 ปิด)
   - ถ้าภายหลังเปิดกฎ Firewall หรือ Attack Challenge Mode ของ Vercel ระวังว่าจะกันเครื่องของ LINE และ Inngest ที่ไม่ใช่เบราว์เซอร์
4. **ห้ามติดตั้ง integration ของ Neon หรือ Inngest จาก Vercel Marketplace** (เหตุผลอยู่ในคู่มือ Neon และ Inngest)
5. พิมพ์บอก agent: "ตั้ง region sin1 และ Deployment Protection แล้ว โดเมน staging คือ https://<โดเมน>"

### A4. (แนะนำ) เปลี่ยนเป็น token ที่ใช้ได้กับ project นี้เท่านั้น

token ใน A2 เข้าได้ทุก project ใน team เอกสาร Vercel แนะนำให้เลือก scope แคบที่สุด เมื่อมี project `bcs-staging` แล้ว จึงควรเปลี่ยนเป็น token ที่ใช้ได้กับ project นี้อย่างเดียว

1. ทำตาม A2 ข้อ 1–6 อีกครั้ง โดยเปลี่ยน 3 จุด:
   - ข้อ 2 ตั้งชื่อ `bcs-agent-cli-project`
   - ข้อ 3 **Scope:** เลือก team `BCS` แล้วเลือก project **`bcs-staging`** (ไม่ใช่ All Projects)
   - ข้อ 6 วางทับค่า `VERCEL_TOKEN` เดิมใน `.env`
2. พิมพ์บอก agent: "เปลี่ยน VERCEL_TOKEN เป็นแบบเฉพาะ project แล้ว ช่วยทดสอบ"
3. ถ้า agent บอกว่าใช้ได้ ลบ token เดิม `bcs-agent-cli` ที่หน้า Account Tokens
4. ถ้า agent บอกว่าใช้ไม่ได้ (เอกสาร Vercel ไม่ได้ยืนยันว่า Vercel CLI ใช้ token แบบนี้ได้ทุกคำสั่ง) ให้สร้าง token แบบ All Projects ตาม A2 ใส่แทนใน `.env` แล้วลบทั้ง token ใหม่ที่ใช้ไม่ได้ และ token `bcs-agent-cli` ตัวแรก (ค่าของมันถูกวางทับใน `.env` ไปแล้ว)

## วิธีเพิ่ม environment variable ใน Vercel

คู่มือทุกฉบับอ้างหัวข้อนี้

1. project `bcs-staging` → **Settings** → **Environment Variables**
2. เลือกชนิดของตัวแปร (ตั้งแต่ 24 ส.ค. 2026 Vercel ให้เลือก Config หรือ Secret แทนสวิตช์ Sensitive แบบเดิม)
   - **Secret** สำหรับค่าลับ บันทึกแล้วไม่มีใครเปิดดูค่าได้อีก รวมถึงคุณและ agent แต่ deployment ยังใช้ได้และแก้ทับได้
   - **Config** สำหรับค่าที่ไม่ลับ เปิดดูได้ภายหลัง
   - ถ้าหน้าจอยังเป็นสวิตช์ **Sensitive**: เปิด Sensitive = Secret · ปิด = Config
3. ช่อง **Name** ใส่ชื่อตัวแปรตามคู่มือ สะกดให้ตรงทุกตัวอักษร
4. ช่อง **Value** วางค่า ไม่มีช่องว่างหน้าหลัง ไม่ต้องใส่เครื่องหมายคำพูด
5. **Environments:** ติ๊ก **Production** อย่างเดียว (project นี้ทั้ง project คือ staging เราจึงใช้ environment ชื่อ Production ของมัน)
6. ค่าชนิด Secret ให้ตรวจข้อความในช่อง Value ก่อนกด Save เพราะบันทึกแล้วเปิดดูไม่ได้ แล้วกด **Save**
7. ค่าใหม่หรือค่าที่แก้มีผลกับ deployment ถัดไปเท่านั้น หลังแก้ค่าให้บอก agent ให้ deploy ใหม่
8. ใส่หลายตัวพร้อมกันได้โดยวางข้อความแบบไฟล์ `.env` (บรรทัดละ `NAME=value`) ลงในฟอร์ม ระบบจะแยกเป็นหลายแถวให้ ใช้วิธีนี้กับค่า Config ใน B1 เท่านั้น ค่าลับให้ใส่ทีละตัว
9. แก้ค่า: กดจุดสามจุดท้ายแถว → **Edit** (ค่า Secret ต้องวางค่าใหม่ทั้งค่า) · ลบ: จุดสามจุด → **Delete**

## ส่วน B · ใส่ค่าที่เหลือแล้วให้ agent deploy (ทำหลัง Neon ที่เก็บไฟล์ และ Inngest)

### B1. ค่าคงที่ (Config) วางทีเดียว

เลือกชนิด **Config** · Environment **Production** แล้ววางข้อความนี้ แก้ `<โดเมน staging>` ทั้ง 2 บรรทัดก่อนกด Save (ไม่มี `/` ท้าย)

```dotenv
APP_ENV=staging
APP_URL=https://<โดเมน staging>
BETTER_AUTH_URL=https://<โดเมน staging>
REGISTRY_MODE=stub
LOG_LEVEL=info
AI_ENABLED=false
ENABLE_EXPERIMENTAL_COREPACK=1
```

- `ENABLE_EXPERIMENTAL_COREPACK=1` ให้ Vercel ใช้ pnpm รุ่นเดียวกับโปรเจกต์ (pnpm 12 ตาม `packageManager` ใน `package.json`) เพราะ Vercel รู้จัก pnpm เองถึงรุ่น 10 เท่านั้น
- `REGISTRY_MODE=stub` คือค่าเริ่มต้นของ OQ-37 · `AI_ENABLED=false` จนถึงขั้น S13

### B2. สร้างค่าลับ 4 ตัวด้วยตัวเอง

1. เปิด PowerShell ของคุณเอง **ห้ามพิมพ์คำสั่งนี้ในช่องแชทของ Claude Code** เพราะผลลัพธ์จะเข้าไปในบทสนทนา
2. วางคำสั่งนี้แล้วกด Enter:

   ```powershell
   node -e "const c=require('crypto');console.log('BETTER_AUTH_SECRET=' + c.randomBytes(32).toString('base64'));console.log('ENCRYPTION_KEY=base64:' + c.randomBytes(32).toString('base64'));console.log('SEED_TOTP_KEY=' + c.randomBytes(32).toString('base64url'))"
   ```

3. จะได้ 3 บรรทัด ใส่ใน Vercel เป็นชนิด **Secret** ทีละตัว ชื่อคือข้อความหน้า `=` ตัวแรก ค่าคือทุกอย่างหลัง `=` ตัวแรก
   - ค่าของ `ENCRYPTION_KEY` ต้องมีคำว่า `base64:` นำหน้าด้วย (แอปตรวจว่าถอดได้ 32 ไบต์)
4. `SEED_DEV_PASSWORD` คือรหัสผ่านของผู้ใช้ตัวอย่างทุกคนบน staging และคุณต้องพิมพ์ตอน login ใน demo ให้ตั้งเอง แล้วใส่ใน Vercel เป็นชนิด **Secret**:
   - ยาวอย่างน้อย 16 ตัวอักษร (ระบบกำหนดขั้นต่ำ 12 · FR-AUTH-001) เช่น คำภาษาอังกฤษ 3 ถึง 4 คำที่ไม่เกี่ยวกันต่อด้วยตัวเลข
   - ห้ามมีคำว่า `change-me` และห้ามซ้ำกับรหัสบนเครื่อง (แอปปฏิเสธค่าตัวอย่างนอกเครื่อง)
5. **เก็บ `SEED_TOTP_KEY` และ `SEED_DEV_PASSWORD` ไว้ในโปรแกรมจัดการรหัสผ่าน (password manager)** ห้ามวางในแชทและห้ามเก็บในไฟล์ของโปรเจกต์ เหตุผล:
   - ค่าชนิด Secret ใน Vercel เปิดดูไม่ได้อีกหลังบันทึก รวมถึงคุณและ agent
   - ผู้ดูแลและผู้อนุมัติต้องตั้ง 2FA (TOTP) ก่อนใช้งาน และ login ด้วยรหัสจากแอป authenticator (FR-AUTH-002 AC1: ทุกคนที่มีบทบาทอื่นนอกจากผู้ขอ REQUESTER หรือดำรงตำแหน่งที่ DOA อ้างถึง)
   - รหัส 2FA ของผู้ใช้ตัวอย่างบน staging สร้างจาก `SEED_TOTP_KEY` ถ้าไม่มีค่านี้ จะไม่มีใครสร้าง QR สำหรับแอป authenticator ให้ `admin@demo.bcs.local` และผู้อนุมัติตัวอย่างได้ ฉาก demo ของ S1 การทดสอบ LINE (D-03) และการซ้อม (D-08) จะติด จนกว่าจะ seed ใหม่ ซึ่งต้องให้คุณอนุมัติการแก้ข้อมูล staging
   - เมื่อถึงเวลาตั้งแอป authenticator agent จะให้คำสั่งที่คุณรันในหน้าต่าง PowerShell ของคุณเอง แล้ววางค่าเมื่อคำสั่งถาม ค่าจึงไม่ผ่านแชท
6. ปิดหน้าต่าง PowerShell หลังใส่ครบ ค่าที่แสดงในหน้าต่างไม่ได้ถูกบันทึกลงไฟล์ใด · ถ้าเปิดประวัติคลิปบอร์ด (Win+V) ไว้ ให้ลบรายการที่คัดลอกค่าลับออก
   - `BETTER_AUTH_SECRET` และ `ENCRYPTION_KEY` ไม่ต้องเก็บที่อื่น

**คำเตือน:** หลังเริ่มใช้ staging แล้ว ห้ามเปลี่ยน `ENCRYPTION_KEY` และ `BETTER_AUTH_SECRET` เอง ค่าที่ระบบเข้ารหัสเก็บไว้ (เช่น secret ของ LINE) จะอ่านไม่ได้ และผู้ใช้อาจต้อง login และตั้ง 2FA ใหม่ ถ้าจำเป็นต้องเปลี่ยน ให้บอก agent ก่อน

### B3. ตารางตัวแปรทั้งหมดของ staging

| ตัวแปร | ชนิด | ค่า หรือได้จาก |
| --- | --- | --- |
| `APP_ENV` | Config | `staging` (B1) |
| `APP_URL` | Config | `https://<โดเมน staging>` (B1) |
| `BETTER_AUTH_URL` | Config | เหมือน `APP_URL` (B1) |
| `REGISTRY_MODE` | Config | `stub` (B1) |
| `LOG_LEVEL` | Config | `info` (B1) |
| `AI_ENABLED` | Config | `false` (B1) |
| `ENABLE_EXPERIMENTAL_COREPACK` | Config | `1` (B1) |
| `BETTER_AUTH_SECRET` | Secret | B2 |
| `ENCRYPTION_KEY` | Secret | B2 (ขึ้นต้น `base64:`) |
| `SEED_TOTP_KEY` | Secret | B2 (เก็บสำเนาในโปรแกรมจัดการรหัสผ่าน) |
| `SEED_DEV_PASSWORD` | Secret | B2 (คุณตั้งเอง เก็บสำเนาในโปรแกรมจัดการรหัสผ่าน) |
| `SEED_DEV_PIN` | Secret | ไม่บังคับ · PIN ยืนยันธุรกรรม 6 หลักของผู้อนุมัติตัวอย่าง (คุณตั้งเอง ห้ามใช้เลขเรียงหรือเลขซ้ำ เก็บสำเนาในโปรแกรมจัดการรหัสผ่าน) ถ้าไม่ใส่ ผู้อนุมัติตั้ง PIN เองที่ `/settings/pin` |
| `DATABASE_URL` | Secret | [p0-05-neon-staging.md](p0-05-neon-staging.md) ขั้นที่ 9 (`bcs_app` แบบ pooled) |
| `DIRECT_URL` | Secret | [p0-05-neon-staging.md](p0-05-neon-staging.md) ขั้นที่ 5 (`bcs_migrator` แบบ direct) |
| `S3_ENDPOINT` `S3_REGION` `S3_BUCKET` `S3_FORCE_PATH_STYLE` | Config | [p0-06-storage-staging.md](p0-06-storage-staging.md) |
| `S3_ACCESS_KEY_ID` `S3_SECRET_ACCESS_KEY` | Secret | [p0-06-storage-staging.md](p0-06-storage-staging.md) |
| `INNGEST_EVENT_KEY` `INNGEST_SIGNING_KEY` | Secret | [p0-07-inngest.md](p0-07-inngest.md) ส่วนที่ 1 |
| `EMAIL_PROVIDER` `EMAIL_FROM` | Config | B4 |
| `EMAIL_SMTP_URL` | Secret | B4 |
| `LINE_PROVIDER_ID` `LINE_MESSAGING_CHANNEL_ID` `LINE_LOGIN_CHANNEL_ID` `LINE_LIFF_CHANNEL_ID` `NEXT_PUBLIC_LIFF_ID` | Config | [line-demo-setup.md](line-demo-setup.md) ส่วนที่ 2 ใส่ทีหลังได้ |
| `LINE_MESSAGING_CHANNEL_SECRET` `LINE_MESSAGING_CHANNEL_ACCESS_TOKEN` `LINE_LOGIN_CHANNEL_SECRET` | Secret | [line-demo-setup.md](line-demo-setup.md) ส่วนที่ 2 ใส่ทีหลังได้ |

**ห้ามใส่ใน Vercel** (ถ้าใส่ แอปอาจไม่ยอมทำงาน ค่าลับอาจรั่ว ค่าที่ agent ตั้งให้อาจถูกทับ หรือแอปเรียกบริการผิดที่ ดูเหตุผลรายตัวในตาราง):

| ตัวแปร | เหตุผล |
| --- | --- |
| `INNGEST_DEV` | ต้องว่างนอกเครื่อง แอปจะไม่ยอมเริ่มทำงานถ้ามีค่า |
| `E2E_TEST_CLOCK` `LIFF_MOCK` | ใช้ทดสอบบนเครื่องเท่านั้น แอปปฏิเสธบน staging |
| `VERCEL_TOKEN` | อยู่ใน `.env` บนเครื่องเท่านั้น |
| `APP_COMMIT_SHA` | agent ใส่ให้อัตโนมัติตอน deploy |
| `LINE_API_BASE_URL` | ใช้ชี้ไป fake LINE server บนเครื่อง บน staging ใช้ค่าเริ่มต้น `https://api.line.me` |

**ยังไม่ต้องใส่** (ใส่ภายหลังเมื่อถึงขั้นที่ใช้):

| ตัวแปร | ใช้เมื่อ |
| --- | --- |
| `GOOGLE_*` `MICROSOFT_*` | SSO ตอน go-live (S5-09) |
| `ANTHROPIC_API_KEY` `AI_MODEL_DEFAULT` | ชั้น 4 (S13) เท่านั้น |
| `SENTRY_DSN` | เมื่อสมัคร Sentry (เป็น SHOULD) |
| `RD_VAT_SERVICE_URL` `DBD_JURISTIC_API_URL` | เมื่อเปลี่ยน `REGISTRY_MODE` เป็น `live` (OQ-37) |

### B4. อีเมลของ staging (รอคุณตัดสิน · ADR-031)

แอปบน staging เริ่มทำงานไม่ได้ถ้าไม่มี `EMAIL_PROVIDER` และ `EMAIL_FROM` (และ `EMAIL_SMTP_URL` เมื่อใช้ `smtp`) จึงต้องเลือกก่อน deploy ครั้งแรก

ข้อเท็จจริงที่ต้องรู้:

- spec §16.10 ให้ demo ส่งอีเมลเข้า "inbox demo ที่ BCS ควบคุม"
- ผู้ใช้ตัวอย่างทุกคนมีอีเมลปลอมรูปแบบ `<code>@demo.bcs.local` และผู้ขายตัวอย่างใช้ `@supplier.demo.local` ซึ่งส่งถึงจริงไม่ได้
- ตอนนี้แอปส่งอีเมลได้ทาง SMTP อย่างเดียว (`EMAIL_PROVIDER=resend` และ `ses` ยังไม่ได้ทำ และยังไม่มีตัวแปรสำหรับ API key) ทั้งสองทางเลือกด้านล่างจึงใช้ `EMAIL_PROVIDER=smtp`
- ผู้ให้บริการอีเมลสำหรับใช้งานจริง (production) ยังต้องเลือกก่อนขั้น S4 การเลือกตรงนี้ใช้กับ staging ของ demo เท่านั้น

| ทางเลือก | เหมาะกับ | ค่าใช้จ่าย |
| --- | --- | --- |
| 1. กล่องจดหมายทดสอบ (email sandbox) เช่น Mailtrap Email Sandbox รับทุกอีเมลไว้ในกล่องเดียวและไม่ส่งออกจริง | ตรงกับ §16.10 ใช้กับอีเมลปลอมของผู้ใช้ตัวอย่างได้ ไม่ต้องตั้งโดเมน | แผนฟรี 50 อีเมลต่อเดือน เก็บได้ 10 ฉบับ น่าจะไม่พอสำหรับซ้อม · แผน Basic US$17 ต่อเดือน หรือ US$14 ต่อเดือนถ้าจ่ายรายปี (500 อีเมล) |
| 2. ผู้ให้บริการส่งจริง เช่น Resend ด้วยโดเมนของ BCS | อยากเห็นอีเมลเข้ากล่องจริง ต้องยืนยันโดเมนผ่าน DNS และต้องเปลี่ยนอีเมลผู้ใช้ตัวอย่างในไฟล์ input เป็นกล่องจริงที่ BCS ควบคุม ซึ่งเป็นการตัดสินเรื่องข้อมูล demo เพิ่ม | แผนฟรี 3,000 อีเมลต่อเดือน (100 ต่อวัน) |

คำแนะนำ: ทางเลือก 1 สำหรับ demo เพราะไม่ต้องแก้ข้อมูลตัวอย่างและไม่มีอีเมลหลุดออกไปหาคนจริง เมื่อตัดสินแล้ว ทำตามหัวข้อย่อยของทางเลือกนั้น แล้วพิมพ์บอก agent: "เลือกอีเมลของ staging แบบ <ทางเลือก> และใส่ค่า EMAIL_* แล้ว"

#### ทางเลือก 1 · Mailtrap Email Sandbox ทีละขั้น

1. เปิด <https://mailtrap.io/register/signup> สมัครด้วยอีเมลของบริษัท (หรือบัญชี Google GitHub หรือ Office 365) ไม่ต้องใช้บัตร
2. login แล้วที่แถบซ้ายกด **Sandboxes** → เปิด **My Sandbox** (Mailtrap สร้างให้เองตอนสมัคร)
3. เปิดแท็บ **Integration** → เลือก **SMTP** จะเห็น Host `sandbox.smtp.mailtrap.io` · Port · Username · Password (แต่ละ sandbox มี Username และ Password ของตัวเอง)
4. ใส่ใน Vercel 3 ตัว ตัวละ 1 แถว:

   | Name | ชนิด | ค่า |
   | --- | --- | --- |
   | `EMAIL_PROVIDER` | Config | `smtp` |
   | `EMAIL_FROM` | Config | `BCS <no-reply@bcs.local>` |
   | `EMAIL_SMTP_URL` | Secret | `smtp://<Username>:<Password>@sandbox.smtp.mailtrap.io:2525` โดยแทน `<Username>` และ `<Password>` ด้วยค่าจากแท็บ Integration |

5. หลัง agent deploy อีเมลที่ระบบส่งจะไปอยู่ใน **My Sandbox** แทนการส่งออกจริง เปิดดูได้ที่หน้า Sandboxes
6. ถ้าแผนฟรีไม่พอ อัปเกรดเป็น Basic ที่หน้า Billing ของ Mailtrap

#### ทางเลือก 2 · Resend (ส่งจริง)

spec และโค้ดยังไม่มีตัวแปรสำหรับ API key ของ Resend จึงส่งผ่าน SMTP ของ Resend แทน:

| Name | ชนิด | ค่า |
| --- | --- | --- |
| `EMAIL_PROVIDER` | Config | `smtp` |
| `EMAIL_FROM` | Config | `BCS <no-reply@ชื่อโดเมน>` โดย `ชื่อโดเมน` คือโดเมนที่ยืนยันใน Resend แล้ว |
| `EMAIL_SMTP_URL` | Secret | `smtps://resend:<API key>@smtp.resend.com:465` |

ก่อนใช้ทางนี้ต้องยืนยันโดเมนใน Resend และเปลี่ยนอีเมลผู้ใช้ตัวอย่างในไฟล์ input ซึ่งคู่มือนี้ไม่ได้เขียนขั้นตอนไว้ ให้บอก agent ก่อนเริ่ม

### B5. ตรวจก่อนบอก agent

- [ ] มีตัวแปรครบตาราง B3 (ค่า LINE ใส่ทีหลังได้)
- [ ] ทุกตัวเลือก Environment **Production**
- [ ] ค่าลับทุกตัวเป็นชนิด **Secret** (หรือเปิดสวิตช์ Sensitive)
- [ ] ไม่มีตัวแปรในตาราง "ห้ามใส่ใน Vercel"
- [ ] `APP_URL` และ `BETTER_AUTH_URL` ขึ้นต้นด้วย `https://` และไม่มี `/` ท้าย
- [ ] เก็บ `SEED_DEV_PASSWORD` และ `SEED_TOTP_KEY` ในโปรแกรมจัดการรหัสผ่านแล้ว (B2)
- [ ] ตัดสินเรื่องแผนของ Neon แล้ว ("เรื่องที่รอคุณตัดสิน" ข้อ 2 ใน [README.md](README.md))

พิมพ์บอก agent: "ใส่ค่า staging ใน Vercel ครบแล้ว deploy ได้"

### B6. agent จะทำอะไรต่อ

1. deploy ด้วย `vercel deploy --prod` (ไฟล์ `.vercelignore` ทำไว้แล้วตั้งแต่ส่วน A) และ migrate กับ seed ครั้งแรก ซึ่งคุณอนุมัติแล้ว (2026-10-02) การ reset หรือแก้ข้อมูลบน staging ครั้งต่อไป agent ต้องถามคุณก่อน
2. ตรวจว่าแอปบน staging เชื่อมต่อฐานข้อมูลด้วย role `bcs_app` และ `bcs_app` แก้ตาราง `Event` ไม่ได้ ([p0-05-neon-staging.md](p0-05-neon-staging.md) ขั้นที่ 10)
3. ตรวจว่า `https://<โดเมน staging>/api/health` ตอบ 200 พร้อม commit sha (S1-14) แล้วรายงานผล
4. บอกให้คุณทำส่วนที่ 2 ของ [p0-07-inngest.md](p0-07-inngest.md) (sync)

## หลังจากนี้

- เปลี่ยนค่าใดใน Vercel ต้องบอก agent ให้ deploy ใหม่
- token หมดอายุ (90 วัน) หรือหลุด: สร้างใหม่ตาม A2 (หรือ A4 ถ้าใช้ token เฉพาะ project) → แทนค่าเดิมใน `.env` → ลบ token เก่าที่หน้า Account Tokens
- ทำ LINE ต่อที่ [line-demo-setup.md](line-demo-setup.md)

## เอกสารอ้างอิงที่ใช้ตรวจ (ต.ค. 2026)

- <https://vercel.com/docs/plans/pro-plan>
- <https://vercel.com/docs/plans/hobby>
- <https://vercel.com/docs/limits/fair-use-guidelines>
- <https://vercel.com/docs/accounts/access-tokens>
- <https://vercel.com/changelog/project-scoped-tokens>
- <https://vercel.com/docs/projects/deploy-from-cli>
- <https://vercel.com/docs/deployments/environments>
- <https://vercel.com/blog/default-production-domain>
- <https://vercel.com/docs/deployments/generated-urls>
- <https://vercel.com/docs/functions/configuring-functions/region>
- <https://vercel.com/docs/deployment-protection>
- <https://vercel.com/docs/deployment-protection/methods-to-protect-deployments/vercel-authentication>
- <https://vercel.com/docs/environment-variables/managing-environment-variables>
- <https://vercel.com/docs/environment-variables/sensitive-environment-variables>
- <https://vercel.com/changelog/environment-variables-now-use-config-and-secret-types>
- <https://vercel.com/kb/guide/how-to-add-vercel-environment-variables>
- <https://vercel.com/docs/package-managers>
- <https://vercel.com/docs/builds/configure-a-build>
- <https://vercel.com/docs/builds/build-features>
- <https://vercel.com/docs/deployments/vercel-ignore>
- <https://mailtrap.io/pricing/>
- <https://docs.mailtrap.io/email-sandbox/overview>
- <https://docs.mailtrap.io/getting-started/email-sandbox>
- <https://docs.mailtrap.io/email-sandbox/setup/sandbox-smtp-integration>
- <https://resend.com/pricing>
- <https://resend.com/docs/send-with-smtp>
