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
