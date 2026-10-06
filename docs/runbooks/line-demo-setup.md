# LINE ของ BCS สำหรับ demo (D-02 · D-03)

| รายการ | ค่า |
| --- | --- |
| ข้อใน spec | D-02 `[demo]` คู่มือนี้และสคริปต์ `pnpm line:richmenu` (ส่วนที่ 4: ค่าจำลองบนเครื่องและสคริปต์) · D-03 `[demo]` `[คน]` สร้าง provider และ channel ของ BCS ตามคู่มือนี้แล้วใส่ค่าใน secret ของ staging |
| D-03 เสร็จเมื่อ | ปุ่มทดสอบการเชื่อมต่อบน staging ผ่านทุกข้อ (FR-ADM-006 AC3) |
| ใช้ของใคร | provider และ channel ของ **BCS เอง** ไม่ใช่ LINE OA ของลูกค้า (spec §16.10) ของลูกค้าทำตอน go-live (P0-04 · OQ-15) |
| ก่อนเริ่ม | รู้โดเมน staging แล้ว ([p0-08-vercel.md](p0-08-vercel.md) ส่วน A) · มีแอป LINE บนมือถือ · มีอีเมลของบริษัท · ส่วนที่ 3 ต้องเก็บ `SEED_DEV_PASSWORD` และ `SEED_TOTP_KEY` ไว้แล้ว ([p0-08-vercel.md](p0-08-vercel.md) B2) |
| เวลา | ส่วนที่ 1 ประมาณ 45 นาที · ส่วนที่ 3 ประมาณ 30 นาที · ส่วนที่ 4 (บนเครื่อง ไม่บังคับ) ประมาณ 15 นาที |

## จะสร้างอะไรบ้าง

ทุกอย่างต้องอยู่ใต้ **provider เดียวกัน** เพราะ LINE ให้ user ID ของคนคนเดียวต่างกันตาม provider และย้าย channel ข้าม provider ไม่ได้ (spec §9.2)

| สิ่งที่สร้าง | ใช้ทำอะไรใน demo |
| --- | --- |
| Provider `BCS` | กล่องที่รวม channel ทั้งหมด ชื่อนี้แสดงให้ผู้ใช้เห็นตอนขอความยินยอม |
| LINE Official Account (OA) และ Messaging API channel | บัญชี LINE ที่ส่งการ์ดอนุมัติ รับการกดปุ่มผ่าน webhook และแสดง rich menu |
| LINE MINI App channel | หน้า LIFF ที่ `/liff` เช่น ผูกบัญชี งานรออนุมัติ ยืนยัน PIN และตรวจรับ (ค่าเริ่มต้นของ OQ-16) |
| LINE Login channel | login ด้วย LINE บนเว็บ (S5) และใช้เป็นทางสำรองของหน้า LIFF ถ้าสร้าง MINI App channel ไม่ได้ |

## ค่าใช้จ่าย (ตรวจ ต.ค. 2026)

- LINE OA แผนฟรีของไทยส่งข้อความ push ได้ราว 300 ข้อความต่อเดือน ข้อความ reply และ rich menu ไม่นับ แผนเสียเงินเริ่มราว ฿1,280 ต่อเดือน (15,000 ข้อความ) ตัวเลขนี้มาจากแหล่งข้อมูลภายนอก ให้ตรวจราคาจริงใน LINE Official Account Manager ก่อนตัดสิน (spec §9.3)
- แผนฟรีซื้อข้อความเพิ่มไม่ได้ ถ้าโควตาหมด ระบบจะส่งงานอนุมัติทางอีเมลแทน (FR-LINE-007)
- MINI App channel และ LINE Login channel ไม่มีค่าใช้จ่าย

## ส่วนที่ 1 · สร้างใน LINE

ค่าที่ได้ในแต่ละขั้นให้ใส่ใน Vercel ทันทีตามตารางในส่วนที่ 2 (วิธีอยู่ในหัวข้อ "วิธีเพิ่ม environment variable ใน Vercel" ของ [p0-08-vercel.md](p0-08-vercel.md)) ถ้าหน้าเว็บของ LINE เป็นภาษาไทย ชื่อปุ่มจะเป็นคำแปลของชื่อในคู่มือนี้

### 1.1 Provider

1. เปิด <https://developers.line.biz/console/> แล้ว login ด้วยบัญชี LINE (ครั้งแรกระบบจะให้กรอกชื่อและอีเมลเพื่อสร้าง developer account)
2. หน้า **Providers** กด **Create** ตั้งชื่อ `BCS` (ใช้ชื่อบริษัทจริง ไม่ใช้ชื่อชั่วคราว) แล้วกด **Create**
3. เปิด provider `BCS` → แท็บ **Settings** → คัดลอก **Provider ID** (หรือดูตัวเลขใน URL หลัง `/provider/`) → `LINE_PROVIDER_ID`

### 1.2 LINE Official Account และ Messaging API channel

ตั้งแต่ 4 ก.ย. 2024 สร้าง Messaging API channel จากหน้า Developers Console โดยตรงไม่ได้ ต้องสร้าง OA ก่อน

1. เปิด <https://entry.line.biz/form/entry/unverified> แล้ว login ด้วยบัญชี LINE
2. กรอกฟอร์ม: ชื่อบัญชี `BCS Demo` · อีเมล · ประเทศหรือภูมิภาคของธุรกิจ **Thailand** · ชื่อบริษัท · ประเภทธุรกิจ แล้วยืนยัน ระบบจะสร้าง OA ให้
3. เปิด <https://manager.line.biz/> → เลือก OA `BCS Demo`
4. มุมขวาบนกด **Settings** → แถบซ้าย **Messaging API** → กด **Enable Messaging API**
5. เลือก provider **`BCS`** (ช่อง privacy policy และ terms of use เว้นได้) แล้วกด **OK**
   - **ระวัง:** เลือก provider ให้ OA แล้วเปลี่ยนหรือยกเลิกไม่ได้อีก
6. กลับไปที่ LINE Developers Console → provider `BCS` จะเห็น channel `BCS Demo` ชนิด Messaging API
7. แท็บ **Basic settings:**
   - **Channel ID** → `LINE_MESSAGING_CHANNEL_ID`
   - **Channel secret** → `LINE_MESSAGING_CHANNEL_SECRET`
8. แท็บ **Messaging API:**
   - ส่วน **Channel access token (long-lived)** กด **Issue** แล้วคัดลอก → `LINE_MESSAGING_CHANNEL_ACCESS_TOKEN`
   - **Auto-reply messages** กด **Edit** (จะเปิดหน้า OA Manager) แล้วตั้งเป็น **Disabled** ไม่อย่างนั้น OA จะตอบข้อความสำเร็จรูปแทรกการ์ดของระบบ
   - **Greeting messages** spec ไม่ได้กำหนด จะเปิดหรือปิดก็ได้
   - **Allow bot to join group chats** คงค่าเริ่มต้น (ปิด)
   - **Webhook URL** ยังไม่ต้องใส่ ทำในส่วนที่ 3
   - จดตำแหน่ง **QR code** ของ OA ไว้ ใช้เพิ่มเพื่อนบนมือถือที่ใช้ demo
9. ห้ามสร้าง rich menu ใน OA Manager เอง rich menu สร้างด้วยสคริปต์ `pnpm line:richmenu` (spec §9.5) ในส่วนที่ 3

### 1.3 LINE MINI App channel (หน้า LIFF)

ค่าเริ่มต้นของ OQ-16 คือใช้ MINI App channel และตั้งแต่ 11 มี.ค. 2026 ผู้ที่นโยบาย LINE MINI App อนุญาตสามารถสร้าง MINI App channel สำหรับบริการในไทยได้

1. Developers Console → provider `BCS` → แท็บ **Channels** → **Create a new channel** → **LINE MINI App**
2. กรอก:
   - **Region to provide the service:** **Thailand**
   - **Service company's country or region:** **Thailand**
   - **Channel icon:** โลโก้ BCS (ถ้ามี)
   - **Channel name:** `BCS Demo` (ห้ามมีคำว่า LINE)
   - **Channel description:** เช่น "ระบบจัดซื้อและอนุมัติของ BCS สำหรับ demo"
   - **Email address:** อีเมลของบริษัท
   - **Privacy policy URL:** ถ้าระบบบังคับ ให้ใส่หน้านโยบายความเป็นส่วนตัวของ BCS (spec ไม่ได้กำหนด)
   - ติ๊กยอมรับข้อตกลงทั้งหมด (LINE Developers Agreement · LINE MINI App Platform Agreement · LINE MINI App Policy · LY Corporation Privacy Policy ที่ขึ้นเมื่อเลือกไทย)
3. กด **Create** ถ้าระบบไม่ให้สร้าง (เช่น แจ้งว่าไม่มีสิทธิ์) ให้ใช้ "ทางสำรอง" ด้านล่างแทน แล้วบอก agent
4. แท็บ **Web app settings** → แถว **Developing** → **Endpoint URL:** `https://<โดเมน staging>/liff` → กด **Update** (แถว Review และ Published ยังไม่ต้องใส่) ถ้ามีช่อง Scopes ให้ติ๊ก `openid` และ `profile`
5. คัดลอก **LIFF ID** ของแถว **Developing** (รูปแบบ `1234567890-AbCdEfGh`) → `NEXT_PUBLIC_LIFF_ID`
   - staging ใช้ LIFF ID ของ Developing เสมอ (spec §9.2 · ADR-024: local และ staging ใช้ Developing · UAT ใช้ Review · production ใช้ Published)
6. `LINE_LIFF_CHANNEL_ID` = ตัวเลขหน้าเครื่องหมาย `-` ของ LIFF ID แถว Developing (เช่น `1234567890-AbCd` → `1234567890`)
7. แท็บ **Basic settings** → **Linked LINE Official Account** → **Edit** → เลือก `BCS Demo` เพื่อให้หน้า LIFF ชวนผู้ใช้เพิ่มเพื่อนได้ (BR-LINE-08)
8. แท็บ **Roles** → **Invite by email** → ใส่อีเมลของทุกคนที่จะเปิดหน้า LIFF บนมือถือของตัวเอง → เลือก role **Tester** → **Send invitation**
   - ผู้รับต้องเปิดอีเมลหัวข้อ "You have received an invitation to join a channel" แล้ว login LINE Developers Console ด้วยบัญชี LINE ของตัวเอง (ครั้งแรกต้องสร้าง developer account) แล้วกดรับ
   - ช่อง Developing เปิดได้เฉพาะ Admin และ Tester ที่รับคำเชิญแล้ว คนอื่นเปิดหน้า LIFF ไม่ได้

### 1.4 LINE Login channel

1. provider `BCS` → แท็บ **Channels** → **Create a new channel** → **LINE Login**
2. กรอก **Region to provide the service:** Thailand · **Company or owner's country or region:** Thailand · **Channel name:** `BCS Demo Login` · **Channel description** · **App types:** **Web app** · **Email address** แล้วยอมรับข้อตกลง → **Create**
3. แท็บ **Basic settings:**
   - **Channel ID** → `LINE_LOGIN_CHANNEL_ID`
   - **Channel secret** → `LINE_LOGIN_CHANNEL_SECRET`
   - **Linked LINE Official Account** → **Edit** → เลือก `BCS Demo` (ทำได้เพราะอยู่ provider เดียวกัน)
4. คงสถานะ **Developing** ไว้ การเปลี่ยนเป็น Published ย้อนกลับไม่ได้ และ demo ยังไม่ต้องใช้
5. **Callback URL** ในแท็บ LINE Login ยังไม่ต้องใส่ spec ไม่ได้ระบุว่า demo ใช้ login ด้วย LINE บนเว็บ ถ้าต้องใช้ agent จะบอก

## ส่วนที่ 2 · ใส่ค่าใน Vercel แล้วบอก agent

ใส่ทุกตัวที่ project `bcs-staging` → **Settings** → **Environment Variables** · Environment **Production**

| ตัวแปร | ได้จาก | ชนิดใน Vercel | `.env` บนเครื่อง |
| --- | --- | --- | --- |
| `LINE_PROVIDER_ID` | 1.1 ข้อ 3 | Config | ไม่ต้องใส่ |
| `LINE_MESSAGING_CHANNEL_ID` | 1.2 ข้อ 7 | Config | ไม่ต้องใส่ |
| `LINE_MESSAGING_CHANNEL_SECRET` | 1.2 ข้อ 7 | Secret | ไม่ต้องใส่ |
| `LINE_MESSAGING_CHANNEL_ACCESS_TOKEN` | 1.2 ข้อ 8 | Secret | ไม่ต้องใส่ |
| `LINE_LOGIN_CHANNEL_ID` | 1.4 ข้อ 3 | Config | ไม่ต้องใส่ |
| `LINE_LOGIN_CHANNEL_SECRET` | 1.4 ข้อ 3 | Secret | ไม่ต้องใส่ |
| `NEXT_PUBLIC_LIFF_ID` | 1.3 ข้อ 5 | Config | ไม่ต้องใส่ |
| `LINE_LIFF_CHANNEL_ID` | 1.3 ข้อ 6 | Config | ไม่ต้องใส่ |

- บนเครื่องใช้ค่าจำลองและ fake LINE server ไม่ต้องใส่ค่าจริงใน `.env` (ส่วนที่ 4)
- ห้ามใส่ `LINE_API_BASE_URL` และ `LIFF_MOCK` ใน Vercel
- `NEXT_PUBLIC_LIFF_ID` ถูกฝังในหน้าเว็บตอน build จึงต้อง deploy ใหม่ทุกครั้งที่ใส่หรือแก้ค่านี้

พิมพ์บอก agent: "สร้าง LINE channel ตาม line-demo-setup แล้ว ใส่ค่า LINE ใน Vercel แล้ว (ใช้ MINI App)" หรือ "(ใช้ทางสำรอง LIFF บน LINE Login)"

agent จะ deploy ใหม่ แล้วบอกเมื่อหน้าตั้งค่า LINE บน staging พร้อมสำหรับส่วนที่ 3 พร้อมวิธีสร้าง rich menu และวิธีหา webhook URL · agent จะไม่เขียนค่า LINE ลงฐานข้อมูล staging เอง เพราะ:

- หลัง seed ครั้งแรกแล้ว การแก้ข้อมูลบน staging ต้องให้คุณอนุมัติก่อน (spec §17.4 · คุณตัดสิน 2026-10-02)
- ค่า secret และ access token ใน Vercel เป็นชนิด Secret ซึ่ง agent เปิดดูไม่ได้

ทางหลักจึงเป็นการที่คุณใส่ค่าเองในหน้าตั้งค่า LINE ของผู้ดูแลบน staging (FR-ADM-006 AC2) ตามส่วนที่ 3 ถ้าอยากให้ agent ใส่แทน agent ต้องขออนุมัติจากคุณก่อน

## ส่วนที่ 3 · ค่าในหน้าผู้ดูแล rich menu webhook และทดสอบ

ทำเมื่อ agent บอกว่าหน้าตั้งค่า LINE และ webhook บน staging พร้อมแล้ว (S5-01 และ S5-02)

1. login staging ด้วยผู้ดูแลตัวอย่าง `admin@demo.bcs.local` · รหัสผ่านคือ `SEED_DEV_PASSWORD` ที่คุณเก็บไว้ · รหัส 2FA มาจากแอป authenticator ที่ตั้งด้วยคำสั่งที่ agent ให้ ซึ่งต้องใช้ `SEED_TOTP_KEY` ที่คุณเก็บไว้ตาม [p0-08-vercel.md](p0-08-vercel.md) B2 (คุณรันคำสั่งนั้นในหน้าต่าง PowerShell ของคุณเอง ค่าไม่ผ่านแชท)
2. เปิดหน้าตั้งค่าช่องทาง LINE ในเมนูผู้ดูแล ใส่ค่าของ channel ตามที่ agent บอกว่าช่องไหนใส่อะไร (คัดลอกจาก LINE Developers Console ตามส่วนที่ 1) แล้วบันทึก หลังบันทึก secret ถูกเข้ารหัสและแสดงแบบ mask (FR-ADM-006 AC2)
   - ถ้าหาค่าเดิมใน LINE Developers Console ไม่เจอ ให้ถาม agent ก่อนกดออกค่าใหม่ เพราะการออก access token ใหม่ทำให้ token เดิมใช้ไม่ได้ และต้องแก้ค่าใน Vercel ด้วย
3. สร้าง rich menu 2 ชุด (ยังไม่ผูกบัญชี และผูกแล้ว · spec §9.5): ในหน้าตั้งค่าช่องทาง LINE กดปุ่ม **สร้าง rich menu** (agent จะบอกเมื่อปุ่มนี้พร้อม · มาพร้อมหน้าจอ LINE ของ S5)
   - ปุ่มนี้สั่งงานเดียวกับ `pnpm line:richmenu` แต่ทำบน Vercel ซึ่งเปิด access token ที่บันทึกในข้อ 2 ได้เอง คุณจึงไม่ต้องคัดลอก token ไปที่ไหนอีก และไม่มีใครต้องวาง token ในแชท
   - ระบบสร้างเมนูทั้ง 2 ชุดจากภาพใน repo ตั้งชุด "ยังไม่ผูกบัญชี" เป็นเมนูเริ่มต้นของ OA แล้วบันทึกรหัสเมนูไว้ในค่าของ channel การกดปุ่มเป็นงานของคุณเองในฐานะผู้ดูแล จึงไม่ใช่การที่ agent แก้ข้อมูล staging
   - กดซ้ำได้ทุกเมื่อ ระบบสร้างชุดใหม่ ย้ายผู้ที่ผูกบัญชีแล้วไปเมนูใหม่ แล้วลบชุดเก่า ต้องกดใหม่ทุกครั้งที่แก้ LIFF ID เพราะปุ่มในเมนูเปิดหน้าของ LIFF ID นั้น
   - ห้ามสร้าง rich menu ใน LINE Official Account Manager เอง (ส่วนที่ 1.2 ข้อ 9)
4. Developers Console → channel `BCS Demo` (Messaging API) → แท็บ **Messaging API** → **Webhook URL** → **Edit**
5. วาง webhook URL ตามที่ agent บอกวิธีหา ซึ่งมีรูปแบบ `https://<โดเมน staging>/api/webhooks/line/<channelKey>` (`channelKey` เป็นรหัสสุ่มที่เปิดเผยได้ ไม่ใช่ค่าลับ) แล้วกด **Update**
6. กด **Verify** ต้องขึ้น **Success** ถ้าไม่ผ่าน ให้คัดลอกข้อความ error ส่งให้ agent
7. เปิดสวิตช์ **Use webhook**
8. บนมือถือที่ใช้ demo: สแกน QR code ของ OA (แท็บ Messaging API) เพื่อเพิ่มเพื่อน ต้องเห็น rich menu แบบยังไม่ผูกบัญชี (ผูกบัญชี · ช่วยเหลือ)
9. กลับไปที่หน้าตั้งค่าช่องทาง LINE บน staging → กดปุ่มทดสอบการเชื่อมต่อ ต้องผ่านทุกข้อ (FR-ADM-006 AC3)
10. ลองผูกบัญชีด้วยมือถือเครื่องเดียวกัน: login staging บนคอมพิวเตอร์ด้วยผู้ใช้ตัวอย่างคนหนึ่ง → เปิดหน้า **ตั้งค่า LINE** ของตัวเอง → สแกน QR ที่ขึ้นด้วยแอป LINE ภายใน 10 นาที → หน้า LIFF แสดงชื่อองค์กรและชื่อผู้ใช้ตัวอย่างคนนั้น ตรวจว่าตรงแล้วกดยืนยัน → หน้า LIFF แจ้งว่าผูกแล้ว ได้ข้อความต้อนรับในแชท และเมนูด้านล่างเปลี่ยนเป็น 4 ปุ่ม (ขอซื้อ · งานรออนุมัติ · ติดตามสถานะ · ช่วยเหลือ) ภายใน 1 นาที (FR-LINE-001 · FR-LINE-004)
    - ลองบล็อก OA แล้วเลิกบล็อก (ในแชทของ OA กดชื่อด้านบน → บล็อก → เลิกบล็อก) เมนูต้องกลับมาเป็น 4 ปุ่ม และได้ข้อความต้อนรับกลับ · ถ้าเมนูเป็น 2 ปุ่ม ให้บอก agent (ข้อนี้ตรวจกับ LINE จริงได้ที่นี่เท่านั้น)
    - กดยกเลิกผูกในหน้า **ตั้งค่า LINE** เมนูต้องกลับเป็น 2 ปุ่ม
11. พิมพ์บอก agent: "ใส่ค่าในหน้าตั้งค่า LINE แล้ว ใส่ webhook แล้ว Verify ผ่าน ปุ่มทดสอบผ่านทุกข้อ ผูกบัญชีแล้วเมนูเปลี่ยน บล็อกแล้วเลิกบล็อกเมนูยังเป็น 4 ปุ่ม" D-03 เป็นข้อ `[คน]` agent ห้ามติ๊กเอง ต้องให้คุณยืนยัน

### ก่อนวัน demo

- ทดสอบกับมือถือของคนนอกทีมอย่างน้อย 1 เครื่อง เพราะ channel ที่ยังไม่เผยแพร่จำกัดผู้ใช้ (spec §16.10) โดยเชิญเป็น Tester ก่อน (1.3 ข้อ 8) แล้วลอง: เพิ่มเพื่อน → ผูกบัญชี → เปิดงานรออนุมัติ → อนุมัติในแชท
- ถ้าผู้บริหารของลูกค้าจะลองบนมือถือของตัวเองในวัน demo ต้องเชิญเป็น Tester ล่วงหน้าทุกคน อีกทางคือเผยแพร่ MINI App แล้วให้ staging ใช้ LIFF ID ของ Published ซึ่งต่างจาก spec §9.2 ที่ให้ staging ใช้ Developing จึงต้องให้คุณตัดสินก่อน (บอก agent)

## ทางสำรอง · LIFF บน LINE Login channel (ใช้เมื่อสร้าง MINI App channel ไม่ได้)

ทางนี้ต่างจากค่าเริ่มต้นของ OQ-16 ต้องบอก agent ทุกครั้งที่ใช้ เพราะรูปแบบลิงก์ของหน้า LIFF ต่างกันตามชนิด channel (spec §9.4)

1. channel `BCS Demo Login` → แท็บ **LIFF** → **Add**
2. **LIFF app name:** `BCS` · **Size:** **Full** · **Endpoint URL:** `https://<โดเมน staging>/liff` · **Scopes:** ติ๊ก `openid` และ `profile` · **Add friend option:** **On (normal)** (ต้องทำ 1.4 ข้อ 3 ส่วน Linked LINE Official Account ก่อน) · **Scan QR** และ **Module mode** ปิดไว้ → กด **Add**
3. **LIFF ID** ที่ได้ → `NEXT_PUBLIC_LIFF_ID` · **Channel ID ของ LINE Login channel** → `LINE_LIFF_CHANNEL_ID`
4. LINE Login channel ที่ยังเป็น Developing ใช้ได้เฉพาะ Admin และ Tester ให้เชิญ Tester แบบ 1.3 ข้อ 8 ที่แท็บ **Roles** ของ channel นี้ การเปลี่ยนเป็น Published ย้อนกลับไม่ได้ ต้องให้คุณตัดสินก่อน

## ถ้าค่าลับหลุด

- **Channel secret** (Messaging API หรือ LINE Login): แท็บ **Basic settings** → ออก channel secret ใหม่ที่ส่วน Channel secret → แก้ค่าใน Vercel และใส่ค่าใหม่ในหน้าตั้งค่า LINE บน staging (ส่วนที่ 3 ข้อ 2) → บอก agent ให้ deploy ใหม่
- **Channel access token (long-lived):** แท็บ **Messaging API** → ออก token ใหม่ที่ส่วน Channel access token (long-lived) → แก้ค่าใน Vercel และใส่ค่าใหม่ในหน้าตั้งค่า LINE บน staging → บอก agent ให้ deploy ใหม่

## ส่วนที่ 4 · บนเครื่อง: LINE จำลอง และ pnpm line:richmenu (D-02)

บนเครื่องไม่ใช้ LINE จริงเลย ใช้ **fake LINE server** ที่อยู่ใน repo (`pnpm line:fake`) ซึ่งทำตัวเหมือน LINE: รับคำสั่งส่งข้อความ สร้าง rich menu ตรวจ ID token และส่ง webhook ทดสอบ ค่าทุกตัวในส่วนนี้เป็น **ค่าจำลอง** ไม่ใช่ของจริง ห้ามใช้ค่าจาก LINE Developers Console ที่นี่

### 4.1 ค่าใน `.env` บนเครื่อง

เปิดไฟล์ `.env` ในโฟลเดอร์โปรเจกต์ แล้วใส่ค่าตามตาราง (ตัวไหนมีค่าอยู่แล้วให้แก้ทับ)

| ตัวแปร | ใส่ค่าอะไร | หมายเหตุ |
| --- | --- | --- |
| `LINE_PROVIDER_ID` | `1650000001` | ตัวเลขอะไรก็ได้ |
| `LINE_MESSAGING_CHANNEL_ID` | `1650000002` | ตัวเลขอะไรก็ได้ |
| `LINE_MESSAGING_CHANNEL_SECRET` | ผลของคำสั่ง A ข้างล่าง | เลขฐานสิบหก 32 ตัว แบบเดียวกับของจริง ใช้เซ็น webhook ทดสอบ |
| `LINE_MESSAGING_CHANNEL_ACCESS_TOKEN` | ผลของคำสั่ง B ข้างล่าง | fake LINE server รับเฉพาะ token นี้ |
| `LINE_LIFF_CHANNEL_ID` | `1650000003` | ต้องเป็นตัวเลขเดียวกับหน้าเครื่องหมาย `-` ของ `NEXT_PUBLIC_LIFF_ID` |
| `NEXT_PUBLIC_LIFF_ID` | `1650000003-LocalDev` | |
| `LINE_API_BASE_URL` | `http://127.0.0.1:4100` | ที่อยู่ของ fake LINE server · ใช้ได้เฉพาะ `APP_ENV=local` |
| `LINE_DATA_API_BASE_URL` | `http://127.0.0.1:4100` | ที่อัปโหลดภาพ rich menu · ค่าเดียวกับบรรทัดบน |
| `LIFF_MOCK` | `1` | ให้หน้า LIFF เปิดในเบราว์เซอร์ปกติได้ (ID token มาจาก fake LINE server) · ใช้ได้เฉพาะ local |
| `LINE_LOGIN_CHANNEL_ID` `LINE_LOGIN_CHANNEL_SECRET` | เว้นว่าง | demo ยังไม่ใช้ login ด้วย LINE บนเว็บ |

สร้างค่า A และ B ในหน้าต่าง PowerShell (คัดลอกผลไปวางใน `.env` เอง ไม่ต้องส่งให้ใคร):

```powershell
node -e "const c=require('crypto');console.log('A=' + c.randomBytes(16).toString('hex'));console.log('B=' + c.randomBytes(30).toString('base64url'))"
```

- ถ้าพอร์ต 4100 ถูกใช้อยู่ ใส่ `FAKE_LINE_PORT=4101` ใน `.env` แล้วเปลี่ยนเลขพอร์ตใน `LINE_API_BASE_URL` และ `LINE_DATA_API_BASE_URL` ให้ตรงกัน
- ค่าใน `.env` ต้องเป็นค่าเดียวกับที่ seed บันทึกไว้ในฐานข้อมูล ถ้าแก้ค่า LINE หลัง seed แล้ว ให้รัน `pnpm db:reset` (ล้างและ seed ใหม่ ใช้ได้เฉพาะบนเครื่อง)

### 4.2 เปิด fake LINE server และ seed

1. เปิดหน้าต่าง PowerShell ใหม่ในโฟลเดอร์โปรเจกต์ แล้วรัน `pnpm line:fake` ต้องขึ้นว่า `fake LINE server พร้อมที่ http://127.0.0.1:4100` เปิดหน้าต่างนี้ทิ้งไว้ (กด Ctrl+C เมื่อเลิกใช้) · คำสั่งนี้พิมพ์แค่ชื่อคำสั่งที่แอปเรียกกับรหัสผล ไม่พิมพ์ token หรือข้อความที่ส่ง
2. ในอีกหน้าต่าง รัน `pnpm db:seed` (หรือ `pnpm db:reset`) บรรทัด `db:seed LINE:` ต้องบอกว่าสร้างค่า LINE channel ขององค์กรตัวอย่างแล้ว (secret และ access token ถูกเข้ารหัสก่อนบันทึก)

### 4.3 สร้าง rich menu: `pnpm line:richmenu`

รัน `pnpm line:richmenu` ในโฟลเดอร์โปรเจกต์ (fake LINE server ต้องเปิดอยู่) ผลที่ถูกต้องหน้าตาประมาณนี้

```text
line:richmenu เสร็จ: องค์กร <รหัสองค์กร> · สร้างครั้งแรก
  UNLINKED richmenu-… · ตั้งเป็นเมนูเริ่มต้นแล้ว
  LINKED   richmenu-… · ผูกให้ผู้ที่ผูกบัญชีแล้ว 0 คน
  ลบชุดเดิม 0 ชุด
```

- สคริปต์ทำงานในนามผู้ดูแลองค์กร (ORG_ADMIN) คนแรกขององค์กรที่มีค่า LINE channel: สร้างเมนู "ยังไม่ผูกบัญชี" (ผูกบัญชี · ช่วยเหลือ) และ "ผูกแล้ว" (ขอซื้อ · งานรออนุมัติ · ติดตามสถานะ · ช่วยเหลือ) จากภาพใน `assets/line/` ตั้งชุดแรกเป็นเมนูเริ่มต้น ย้ายผู้ที่ผูกบัญชีอยู่แล้วไปชุดใหม่ บันทึกรหัสเมนูในค่าของ channel (มี event `organization.settings_updated`) แล้วลบชุดเก่า
- รันซ้ำได้เสมอ ถ้าบรรทัดใดบอกว่า "ไม่สำเร็จชั่วคราว" ให้รันอีกครั้ง (ระบบเก็บชุดเก่าไว้ให้ก่อนจนกว่าจะย้ายครบ) · ถ้าบอกว่า "LINE ไม่รับ" แปลว่าผู้ใช้คนนั้นบล็อก OA อยู่หรือยังไม่ได้เพิ่มเพื่อน ไม่ต้องทำอะไร เมื่อเขาเพิ่มเพื่อนอีกครั้งระบบตั้งเมนูให้เอง
- ถ้ามีหลายองค์กรที่มีค่า LINE ให้ระบุองค์กร: `pnpm line:richmenu --org <รหัสองค์กร>`
- คำสั่งนี้ใช้ได้เฉพาะบนเครื่อง (`APP_ENV=local`) ที่อื่นสคริปต์จะหยุดก่อนแตะอะไร เพราะสคริปต์บันทึก event ในนามผู้ดูแลขององค์กร ซึ่งบน staging หรือ production จะดูเหมือนผู้ดูแลคนนั้นทำเอง · บน staging ให้ผู้ดูแลกดปุ่ม **สร้าง rich menu** ตามส่วนที่ 3 ข้อ 3 ซึ่งทำงานเดียวกันบน Vercel ในชื่อของผู้ดูแลที่กดจริง (เครื่องของคุณไม่มีรหัสผ่านฐานข้อมูลและกุญแจเข้ารหัสของ staging และไม่ควรมี)

### 4.4 ลองผูกบัญชีและ webhook บนเครื่อง

- ผูกบัญชี: เปิด `pnpm dev` แล้ว login ผู้ใช้ตัวอย่าง → หน้า **ตั้งค่า LINE** ของตัวเอง → กดลิงก์ใต้ QR (บนเครื่องลิงก์เปิดหน้า `/liff/link` ในเบราว์เซอร์ได้เพราะ `LIFF_MOCK=1` และ ID token มาจาก fake LINE server) → หน้า LIFF แสดงชื่อองค์กรและชื่อของคุณ → กดยืนยันจึงผูก · ใช้ได้เมื่อหน้าจอ LINE ของ S5 พร้อม
- ยกเลิกผูก: ที่หน้า **ตั้งค่า LINE** บนเว็บ หรือในหน้า LIFF (ฝั่ง LINE) · ในแชทไม่มีปุ่มยกเลิกผูก
- ดูว่าเมนูของผู้ใช้จำลองเปลี่ยนแล้วหรือยัง: เปิด `http://127.0.0.1:4100/__fake/users/<LINE user id>/richmenu` ค่า `effectiveRichMenuId` คือเมนูที่ผู้ใช้คนนั้นเห็น
- ส่ง webhook ที่เซ็นเหมือน LINE: `pnpm line:simulate follow` (เพิ่มเพื่อน) · `pnpm line:simulate follow --unblocked` (เลิกบล็อก: ถ้าผู้ใช้ผูกบัญชีอยู่ ระบบตั้งเมนู "ผูกแล้ว" ให้อีกครั้ง เพราะ LINE จริงถอดเมนูรายผู้ใช้ออกเมื่อบล็อกแล้วเลิกบล็อก) · `pnpm line:simulate unfollow` (บล็อก: ยังผูกอยู่ แต่ระบบส่งงานทางอีเมลแทน) · สคริปต์บอกรหัสผลที่แอปตอบ (200 = รับแล้ว · 401 = secret ไม่ตรงกับ `.env`)

### 4.5 วาดภาพ rich menu ใหม่

ภาพทั้ง 2 ไฟล์ใน `assets/line/` (`richmenu-unlinked.png` และ `richmenu-linked.png` ขนาด 2500 × 843 px) วาดจากคำบนปุ่มตาม spec §9.5 ด้วยฟอนต์ Sarabun และไอคอน Lucide ทุกครั้งที่วาดได้ภาพเดิมทุกพิกเซล ปกติไม่ต้องวาดใหม่ ถ้าแก้คำหรือหน้าตาของเมนูในโค้ด:

1. เปิด Docker Desktop (ใช้ตัวแปลง PDF เป็นภาพตัวเดียวกับเทสต์เอกสารพิมพ์)
2. รัน `pnpm line:richmenu --images` แล้วเปิดดูภาพทั้ง 2 ไฟล์ก่อน commit
3. เทสต์ `tests/integration/line-richmenu-images.test.ts` ตรวจว่าภาพใน repo ตรงกับที่วาดได้จริง ถ้าลืมวาดใหม่เทสต์นี้จะไม่ผ่าน
4. บน staging กดปุ่ม **สร้าง rich menu** อีกครั้งหลัง deploy เพื่อให้ LINE ได้ภาพใหม่

### 4.6 ทดสอบกับ LINE จริงจากเครื่อง (ปกติไม่ต้องทำ)

ทดสอบกับ LINE จริงบน staging ตามส่วนที่ 3 แทน การต่อ LINE จริงเข้าเครื่องต้องใช้ tunnel สาธารณะ (spec §5.3) และต้องเปลี่ยน Webhook URL กับ Endpoint URL ของ LIFF แถว Developing ซึ่ง staging ใช้อยู่ ทำให้ staging ใช้ LINE ไม่ได้ระหว่างนั้น ถ้าจำเป็นจริงให้บอก agent ก่อน แล้ว agent จะเขียนขั้นตอนให้

## หมายเหตุสำหรับ agent

- `LINE_LIFF_CHANNEL_ID` คือ channel ID ที่ออก LIFF ID นั้น ซึ่ง BR-LINE-02 ให้ส่งไปตรวจ ID token (ตรวจ `aud`) ตัวเลขหน้า `-` ของ LIFF ID คือ channel ID นี้ · ของ MINI App channel ตัวเลขนี้อาจไม่ตรงกับ Channel ID ในแท็บ Basic settings (Developing Review Published แต่ละตัวมี LIFF ID ของตัวเอง · §9.2) ให้ยึดตัวเลขจาก LIFF ID ของ Developing
- ค่าต่อองค์กรเก็บใน `LineChannelConfig` (secret เข้ารหัสด้วย `ENCRYPTION_KEY` · §6.2) ส่วนค่า LINE 7 ตัวและ `NEXT_PUBLIC_LIFF_ID` ใน env ใช้กับ local และ OA กลาง (หมายเหตุใน `.env.example`) การเขียน `LineChannelConfig` หรือรหัส rich menu ลงฐานข้อมูล staging หลัง seed ครั้งแรกต้องขออนุมัติเจ้าของก่อน (§17.4)
- Rich menu (S5-04 · D-02): `pnpm line:richmenu` (`scripts/line-richmenu.ts`, `APP_ENV=local` เท่านั้น) และปุ่มในหน้า `/admin/line` เรียก `replaceLineRichMenus` ของ `src/server/services/line-link` ตัวเดียวกัน (command `organization.store_line_rich_menus` · capability `admin.channels`) · ภาพอ่านจาก `assets/line` ใน working directory: route ของปุ่มต้องอยู่ใน `outputFileTracingIncludes` ของ `next.config.ts` แบบเดียวกับฟอนต์ PDF ไม่อย่างนั้น Vercel ไม่ส่งภาพไปกับ function · เมนูชื่อ `bcs:<channelKey>:<UNLINKED|LINKED>:<เวลาที่สร้าง ms>` · การสร้างใหม่ลบเมนูทุกตัวที่ขึ้นต้นด้วย `bcs:<channelKey>:` ขององค์กรนั้นซึ่งสร้างก่อนรอบนี้ (ชื่อที่ไม่มีเวลานับเป็นเก่าที่สุด จึงห้ามตั้งชื่อเมนูด้วยมือแบบนี้) แต่ไม่ลบชุดที่สร้างหลังรอบนี้เริ่มและชุดที่บันทึกอยู่ · แก้ LIFF ID แล้วต้องสร้างเมนูใหม่
- การผูกบัญชี: `/settings/line` ขอรหัสด้วย `issueLineLinkCode` (QR ของ `url` วาดด้วย `uqr`) · หน้า `/liff/link` เรียก `previewLineLinkCode` เพื่อแสดงชื่อองค์กรและชื่อสมาชิกของรหัส แล้วรอให้ผู้ใช้กดยืนยันก่อนส่ง `{ code, idToken }` ไป `POST /api/liff/link` (ห้ามส่งเองจาก URL: รหัสที่คนอื่นส่งมาจะผูก LINE ของผู้เปิดเข้ากับบัญชีของคนส่ง) · รหัสที่ออกก่อนการยกเลิกผูกครั้งล่าสุดใช้ไม่ได้ · ลองผูกได้ไม่เกิน 10 ครั้งต่อสมาชิกใน 10 นาที (ตาราง `RateLimit`) · เมนูสลับทันทีหลังผูกหรือยกเลิกผูก และ job `line-rich-menu` สลับซ้ำจาก event `line.linked` `line.unlinked` (ทางเดียวของการปิดใช้งาน member) · การ follow ของสมาชิกที่ผูกอยู่ตั้งเมนู "ผูกแล้ว" ซ้ำ (follow hook ใน `src/server/services/line-link/follow.ts`) · ยกเลิกผูกจากฝั่ง LINE ทำในหน้า LIFF เท่านั้น ไม่มี postback ยกเลิกผูกในแชทเพราะ BR-TOK-02 ให้ postback มี token เสมอ

## เอกสารอ้างอิงที่ใช้ตรวจ (ต.ค. 2026)

- <https://developers.line.biz/en/docs/line-developers-console/overview/>
- <https://developers.line.biz/en/docs/line-developers-console/managing-roles/>
- <https://developers.line.biz/en/docs/messaging-api/getting-started/>
- <https://developers.line.biz/en/docs/messaging-api/building-bot/>
- <https://developers.line.biz/en/docs/basics/channel-access-token/>
- <https://developers.line.biz/en/docs/line-mini-app/develop/develop-overview/>
- <https://developers.line.biz/en/docs/line-mini-app/discover/console-guide/>
- <https://developers.line.biz/en/docs/line-mini-app/develop/configure-console/>
- <https://developers.line.biz/en/docs/line-mini-app/discover/custom-features/>
- <https://developers.line.biz/en/news/2026/03/11/line-mini-app/>
- <https://developers.line.biz/en/news/2026/>
- <https://developers.line.biz/en/docs/liff/getting-started/>
- <https://developers.line.biz/en/docs/liff/registering-liff-apps/>
- <https://developers.line.biz/en/docs/line-login/getting-started/>
- <https://developers.line.biz/en/docs/line-login/link-a-bot/>
- <https://www.better-auth.com/docs/authentication/line>
- <https://vercel.com/changelog/environment-variables-now-use-config-and-secret-types>
- ราคา LINE OA ไทย (แหล่งภายนอก ต้องตรวจซ้ำใน OA Manager): <https://linebot.pro/blog/line-official-account-pricing-guide>
