# รีวิวโค้ดขั้น S17 (สาย 3 ส่วน LINE · สาย 1 ส่วน BCS Go)

บันทึกผลรีวิวตาม skill `bcs-lane` และ §17.9 · ข้อเงินและสิทธิ์ของสาย 3 รีวิว `xhigh` ทันทีหลังทำแต่ละข้อ (ADR-072) · ส่วน LINE ส่งเข้า main หลัง S17-08 · S17-18 (สาย 1) รีวิวทั้งขั้นแล้วต่อท้ายไฟล์นี้

## S17-01 migration ค่าตั้งต้น และกฎของขั้น (สาย 3 · 2026-10-16 · ส่งเข้า main บางส่วนครั้งเดียวของ S17)

คำสั่ง: `/code-review xhigh origin/main...HEAD` ที่ commit 718d6d3 · ฐานคือ `origin/main` (294c7de) ไม่ใช่ `9ba60f4` (commit ก่อนร่างแรก) เพราะหลังรวม main ที่มีงานของ S6 ฐาน `9ba60f4...HEAD` จะรวมโค้ดของ S6 ทั้งขั้นที่รีวิวแล้วใน S6-22 · `origin/main...HEAD` เห็นเฉพาะงานของ S17-01 (ร่าง S17-03 ถูก revert ไว้ใน 7166d37 จนถึงข้อนั้น) · พบ 7 ข้อ · แก้ 3 ข้อ · ไม่แก้ 4 ข้อ (เหตุผลข้างล่าง)

| # | ข้อที่พบ | ผล |
| --- | --- | --- |
| 1 | push token unique เฉพาะในองค์กรเดียว: โทรศัพท์ที่ย้ายไปใช้กับ member ขององค์กรอื่น (session หมดอายุโดยไม่ได้ออกจากระบบ) ยังรับ push ขององค์กรเดิม | แก้กฎ: BR-AUTH-12 ให้คำสั่งลงทะเบียนเพิกถอนแถวที่ยังใช้งานของ `tokenHash` เดียวกันทุกองค์กรด้วย SQL ใน `src/server/db/sql` ในธุรกรรมเดียวกัน โดยผลไม่บอกว่าองค์กรอื่นเคยมี token · โค้ดอยู่ใน S17-10 (สาย 1) |
| 2 | `textRetentionDays` (1–30 วัน) ไม่ครอบสำเนาที่ AI อ่านจากแชท (AgentAction subject `CHAT_INTAKE` ล้างที่ 7 วันตายตัว) จึงอยู่นานกว่าค่าที่องค์กรเลือกได้ | แก้กฎ: BR-LINE-11 ให้ `chat_intake.purge` ล้างเนื้อหาของ AgentAction ของร่างนั้นด้วย · โค้ดอยู่ใน S17-08 |
| 3 | ตั้ง `windowMinutes` ยาวกว่า `expireHours` × 60 ได้ ข้อความหลังร่างหมดอายุจึงอาจเติมร่างที่กำลังหมดอายุ | แก้: schema ของ settings และ `validate_inputs.py --profile p1` บังคับ `windowMinutes` ≤ `expireHours` × 60 (ค่าที่ไม่ใส่อ่านเป็นค่าเริ่มต้น) · BR-LINE-10 · เทสต์ใน `tests/unit/s17-settings.test.ts` |
| 4 | ด่านปิดแชทใน sandbox ขึ้นกับผู้เรียกเลือกใช้ `chatIntakeSettingsFor` ไม่ใช่ `chatIntakeSettingsOf` | ไม่แก้: BR-LINE-10 ระบุตัวอ่าน `chatIntakeSettingsFor` แล้ว และ S17-06 เป็นข้อ `xhigh` ที่รีวิวทันที · ค่าที่เก็บของ sandbox ใหม่ปิดแชทอยู่แล้ว (`sandboxSettingsOf`) |
| 5 | staging demo reset (ADR-056) ล้าง `LineRichMenuVariant` แต่คืนเฉพาะ id เมนูใน `LineChannelConfig` เมนูตามบทบาทจึงหายจนรัน `pnpm line:richmenu` ใหม่ และเมนูเก่าค้างบน LINE | ไม่แก้ในข้อนี้: ตารางยังไม่มีผู้เขียน · ทำใน S17-04 (สาย 3) ที่สร้างเมนูทุกชุด ให้ reset คืนหรือลบเมนูเก่า |
| 6 | seed เขียน `Organization.settings` เฉพาะตอนสร้างองค์กร SIMEC ที่ seed ไว้ก่อน S17-01 จึงยังไม่เปิดขอผ่านแชท | ไม่แก้: พฤติกรรมเดิมของ seed (ไม่ทับค่าที่ผู้ดูแลแก้) · ฐานของสาย reset ทุกครั้งที่มี migration ใหม่ และ staging ใช้ demo reset ใน P1-11 |
| 7 | `GoodsReceipt.offlineCapturedAt` ไม่มี CHECK กับเวลาที่ถึงระบบ | ไม่แก้ในข้อนี้: กฎตรวจใน `gr.post` ของ S17-12 (สาย 1 · ข้อเงิน รีวิวทันที) · แนะนำให้ S17-12 เพิ่ม CHECK `offlineCapturedAt` ≤ `postedAt` เมื่อบันทึกแล้วในข้อนั้น |

ผลก่อนส่งเข้า main (2026-10-16 · `5952d11`): `pnpm verify --strict --e2e` ผ่าน 19 ด่าน 0 FAIL · e2e 459 เคสผ่าน ไม่มีเคสที่ข้าม · ฉาก demo 9 เคสผ่าน · tag `p1-s17-start` ติดที่ `origin/main` ก่อนส่ง (ฐานรีวิวของ S17-18)

## S17-09 โครงแอป Capacitor และ workflow APK (สาย 1 · 2026-10-16 · รีวิวทันทีตาม ADR-072)

คำสั่ง: `/code-review xhigh 6574609...HEAD` ที่ commit a28f8f3 (ฐาน = commit ก่อน commit แรกของ S17-09) · พบ 5 ข้อ · แก้ 4 ข้อ · ไม่แก้ 1 ข้อ

| # | ข้อที่พบ | ผล |
| --- | --- | --- |
| 1 | KPI G-5 นับช่องทาง `APP` เป็นการตัดสินบนมือถือ ขัดกับนิยามของ §11 (แชท LINE หรือ LIFF) และป้าย "การตัดสินใน LINE" ของหน้า KPI | แก้: `MOBILE` ของ `src/server/services/reports/kpi.ts` กลับเป็น `LINE_CHAT` `LIFF` และแถว G-5 ใน §1 กลับเป็นข้อความเดิม · แอปมีแท่งของตัวเองในแผงการควบคุมของหน้า insights แทน (ADR-168) |
| 2 | `android:allowBackup="true"` ของแม่แบบ Capacitor ให้ Android สำรองข้อมูล WebView (cookie ของ session และคิวตรวจรับออฟไลน์ของ BR-APP-03) ขึ้น cloud หรือย้ายไปเครื่องใหม่ | แก้: `allowBackup="false"` และ `data_extraction_rules.xml` ตัดทุกโดเมนทั้ง cloud-backup และ device-transfer พร้อมเทสต์ใน `tests/unit/bcs-go-shell.test.ts` |
| 3 | แผงการควบคุมของหน้า insights มีแท่ง "แอป BCS Go" แต่แถวของ §9 ยังเขียนเฉพาะ เว็บ LIFF แชท LINE อีเมล | แก้: แถวใน spec เพิ่ม "แอป BCS Go" |
| 4 | workflow รัน `gradle-wrapper.jar` ที่ commit ไว้โดยไม่ตรวจกับ checksum ของ Gradle ขณะที่ secret ของ keystore อยู่ใน job | แก้: เพิ่ม `gradle/actions/wrapper-validation@v4` หลัง checkout |
| 5 | ความเห็นใน `.env.example` และ workflow ชี้ไป `docs/runbooks/bcs-go-demo.md` ที่ยังไม่มี | ไม่แก้: runbook เขียนใน S17-17 ของสายนี้ |

ตรวจเพิ่มในรอบนี้โดยไม่พบปัญหา: ช่องทาง `APP` ไม่เพิ่มสิทธิ์ใด (แทนที่เฉพาะ `WEB` ใน `ctxFromSession` · LIFF อีเมล และปุ่มแชทคงเดิม จึงปลอม user agent ได้แค่ป้ายใน audit) · ESLint ของ CI ไม่ต้องติดตั้งแพ็กเกจของ `mobile/` (ไม่มีกฎ no-unresolved) · `cap sync` เขียน `usesCleartextTraffic` ให้เองเมื่อ `server.cleartext` เปิด (เฉพาะ emulator)
