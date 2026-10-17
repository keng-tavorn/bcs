# ร่าง P1-09 — รายการหน้าใหม่ของระยะ 1 สำหรับตรวจดีไซน์

> **สถานะ: ร่างล่วงหน้าตาม ADR-073 (สาย l3)** · เขียนเมื่อ 2026-10-17 บนฐาน `152bc40c` · ไม่ใช่โค้ด ไม่ติ๊ก ไม่ได้ถ่ายภาพหรือรัน axe
> ช่วงที่นับ: `git diff --name-status p1-start..HEAD -- 'src/app/**/page.tsx'` = **60 หน้า** (เพิ่มใหม่ 33 · แก้ 27) · ถ้า P1-08 ถึง P1-10 เพิ่มหน้า ให้รันคำสั่งเดิมซ้ำแล้วเติมแถว
> สิทธิ์ในตารางมาจาก `src/server/authz/permissions.ts` (ตรวจใน service ผ่าน `authorize()`) · เมนูจาก `src/app/(workspace)/_shell/menu.ts` · โมดูลจาก `requireModule()` · AI จาก `src/server/services/ai/gate.ts` · ผู้ใช้จากชีต Users ของ `BCS_inputs_p1.xlsx` (`<รหัส>@simec.bcs.local` · seed ด้วย `pnpm db:reset:p1` ซึ่งเปิดโมดูล PAY AI BCS_GO ให้ SIMEC)
> "เสร็จเมื่อ" ของ P1-09: ตารางเดียว (หน้า · สิ่งที่ห้ามใช้ที่พบ · แก้แล้วหรือยัง) ไม่มีข้อค้าง · axe ไม่มี violation ระดับ serious หรือ critical · `pnpm verify` ผ่าน

## 1. วิธีตรวจ (ตามแบบ S16-12 · `docs/design-review/a2.md`)

- **ภาพ:** ทุกหน้าที่ 1440×900 และ 375×812 แบบเต็มหน้า ถ่ายในชื่อผู้ใช้ที่ใช้หน้านั้นจริง (คอลัมน์ "ถ่ายเป็น") · ชื่อไฟล์ `docs/design-review/p1/pages/<ผู้ใช้>_<path โดยแทน / ด้วย _>-<ความกว้าง>.png` · สถานะที่ต้องกดจึงเห็น ต่อท้าย `_<ชื่อ>` เช่น `_tab_invoices` `_dialog` `_sheet` (แบบ `_k` `_new` `_menu` ของ A2)
- **axe:** `@axe-core/playwright` ล้มเฉพาะ `serious` และ `critical` (`expectNoBlockingAxe`) · ตรวจไม่มี scroll ด้านข้างที่ 375 px · หน้า LIFF และ `/go/receive` ตรวจเป้ากดอย่างน้อย 44 px แบบ `checkScreen` ใน `tests/e2e/liff-support.ts`
- **ตรวจด้วยตา:** รายการ "สิ่งที่ห้ามใช้" ของ §9.9 และตารางคอมโพเนนต์ §9.10 (สีตายตัวแทน token · สีไล่เฉด · ม่วงเป็นสีหลัก · การ์ดเงาเดียวกันทุกใบ · ป้ายตัวพิมพ์ใหญ่เหนือหัวข้อ · animation ตกแต่ง · emoji เป็นไอคอน · pop-up ที่เด้งเอง NG-13 · คอมโพเนนต์ที่ shadcn/ui มีแต่เขียนเอง) · หน้า LIFF ห้ามใช้คอมโพเนนต์หรือไลบรารีของ Workspace (ADR-052)
- **ภาพที่ได้จาก e2e:** ฉาก `@p1demo` ของ P1-08 ถ้าเรียก `checkWebScreen` / `checkLiffScreen` (`tests/e2e/demo/support.ts`) จะได้ `design-review.jsonl` แล้วใช้ `node scripts/design-review-shots.mjs <E2E_OUTPUT_DIR> docs/design-review/p1/demo` แบบ A2 · spec ของระยะ 1 ที่รัน axe อยู่แล้ว: go-receive · s17 · review-step · policy-withdrawal · form-builder · notifications · receiving · request-form · finance-support · insight-support (ยังต้องมีภาพของทุกหน้าในตาราง 3 แม้ spec รัน axe แล้ว)
- **ผลลัพธ์:** `docs/design-review/p1.md` · ตารางผลหัว `| # | หน้า | สิ่งที่ห้ามใช้ที่พบ | แก้แล้วหรือยัง |` (แบบ A2) นำด้วยตาราง "ภาพอยู่ที่ไหน" `| โฟลเดอร์ | อะไร | ถ่ายอย่างไร |`

## 2. การแบ่งกลุ่มหน้า (Ultracode เปิดได้ · แยก subagent ต่อกลุ่ม · ADR-072 ADR-073)

| กลุ่ม | หน้า (# ในตาราง 3) | จำนวน | ผู้ใช้หลัก | เหตุที่จัดกลุ่มนี้ |
| --- | --- | --- | --- | --- |
| G1 ผู้ดูแลและแพลตฟอร์ม | 1–14 | 14 | admin · admin2 · ผู้ดูแลแพลตฟอร์ม | ตารางกับฟอร์มตั้งค่า dialog สร้างฟอร์มและกฎ workflow |
| G2 คำขอ งบ แคตตาล็อก งานตัดสิน | 15–21 · 44–46 · 50 | 11 | fm_p02 · pm_p07 · fin_bud1 · ceo · dm_qse | ฟอร์มทีละขั้น แผงเตือน แถบตัดสิน step-up |
| G3 การเงิน AP รอบจ่าย จัดซื้อ | 22–34 · 36–39 | 17 | fin_ap1 · fin_tre1 · cfo · proc_officer | ตารางเงิน ตัวเลขชิดขวา ป้ายสถานะ ไฟล์ |
| G4 ตรวจรับ รายงาน ตั้งค่าตัวเอง ผู้ขาย | 35 · 40–43 · 47–49 | 8 | store_p07 · ceo · dm_fin · fin_ap1 | กราฟ (ตามสีของ §9.9) กล่อง AI อ่านใบส่งของ passkey |
| G5 LINE แอป และหน้าสาธารณะ | 51–60 | 10 | store_p07 · se_p01a · proc_officer · ceo · ไม่ login | ชุดเบาของ LIFF (ADR-052) · 375 px เป็นหลัก · ออฟไลน์ |

agent หลักถ่ายและรัน axe เอง (ใช้ฐานและพอร์ตเดียว) แล้วแจกภาพให้ subagent ตรวจด้วยตาตามกลุ่ม · ตรวจภาพเองก่อนรับผล (ข้อ "แยกงาน" ของ P1-09) · subagent เขียนเฉพาะไฟล์ผลของกลุ่มตัวเอง การแก้โค้ดทำโดย agent หลักทีละกลุ่ม

## 3. รายการหน้า

คอลัมน์ "ข้อมูลที่ต้องมี" คือสิ่งที่ทำให้หน้าไม่ว่าง · ถ่ายทั้งสถานะมีข้อมูลและสถานะว่างเมื่อหน้ามีข้อความว่าง (§9.9 หน้าว่าง) · ⚑ = ต้องตรวจตอนทำว่ามีหลัง `pnpm db:reset:p1` หรือต้องเล่นฉากก่อน

| # | หน้า (เส้นทาง) | A/M | ขั้น | ใครเปิดได้ (สิทธิ์ → บทบาท · โมดูล) | ถ่ายเป็น | ข้อมูลที่ต้องมี | สิ่งที่เปลี่ยน (หน้า M) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `/platform/tenants/[orgId]/ai` | A | S13-04 | PLATFORM_ADMIN เท่านั้น (`platform.ai.credits`) | ผู้ดูแลแพลตฟอร์ม ⚑ (ข้อ 4.1) | SIMEC ที่เปิดโมดูล AI | — |
| 2 | `/platform/tenants/[orgId]/modules` | M | P1-07 | PLATFORM_ADMIN (`platform.modules.manage`) | ผู้ดูแลแพลตฟอร์ม | องค์กรใดก็ได้ | สวิตช์บอกชนิดเอกสาร DOA ที่โมดูลต้องมี |
| 3 | `/platform/tenants/[orgId]` | A | S6-21 | PLATFORM_ADMIN (`platform.sandbox.manage`) | ผู้ดูแลแพลตฟอร์ม | องค์กร + UAT sandbox (SIMEC-UAT ⚑) | — |
| 4 | `/platform/tenants` | M | S13-04 | PLATFORM_ADMIN | ผู้ดูแลแพลตฟอร์ม | อย่างน้อย 1 องค์กร | ลิงก์หน้าองค์กรและ credits AI |
| 5 | `/admin/ai` | A | S13-04 | `admin.ai.manage` → ORG_ADMIN · เมนูต้องเปิดโมดูล AI (ปิดแล้วหน้าบอกสถานะ) | admin | agent และ credits จาก seed `p1-ai` | — |
| 6 | `/admin/config` | A | S6-21 | `config.export` / `config.import` → ORG_ADMIN DOA_ADMIN | admin | DOA และ workflow ที่เผยแพร่แล้ว | — |
| 7 | `/admin/doa/[versionId]` | M | S6-07 | `admin.doa.draft` → ORG_ADMIN DOA_ADMIN (ORG_ADMIN เสียสิทธิ์ถ้า `sodPolicy.doaAdminSeparated`) | admin | ฉบับร่างหรือรออนุมัติ (ย้อนทดสอบ) · ฉบับอนุมัติล่วงหน้า (ถอน) ⚑ | แผงย้อนทดสอบ 90 วัน · ส่วนถอนฉบับ |
| 8 | `/admin/doa/[versionId]/simulate` | M | S6-02 | `admin.doa.simulate` | admin | ฉบับ DOA | ผลแบบคณะกรรมการและองค์ประชุม · ซ่อนช่องเงินของชนิดที่ไม่มียอด |
| 9 | `/admin/doa/ai-draft` | A | S13-11 | `admin.doa.draft` + `ai.doaDraft` (ORG_ADMIN · ไม่ใช่ PLATFORM_ADMIN) + ด่าน AI ครบ · ไม่ผ่านขึ้นข้อความ "ใช้ไม่ได้" | admin | AI เปิด (บนเครื่อง `AI_MODE=fixture`) | — |
| 10 | `/admin/doa` | M | S13-11 | `admin.doa.draft` | admin | ฉบับ DOA | ลิงก์ไปตัวร่าง DOA ด้วย AI |
| 11 | `/admin/request-types/[code]/form` | A | S6-14 | `admin.requestTypes` → ORG_ADMIN | admin | ประเภทที่มีฟอร์ม เช่น BUY_GOODS · ถ่าย dialog ของตัวสร้างฟอร์มด้วย | — |
| 12 | `/admin/request-types/[code]` | M | S6-14 | `admin.requestTypes` | admin | ประเภทคำขอ | ปุ่มเปิดตัวสร้างฟอร์ม |
| 13 | `/admin/workflows/[id]` | A | S6-06 | `admin.workflow.draft` (+ simulate submitForPublish) → ORG_ADMIN DOA_ADMIN | admin2 | WF-SIMEC ฉบับ 1 และร่างฉบับ 2 · dialog กฎ · แผงส่ง · แผงย้อนทดสอบ | — |
| 14 | `/admin/workflows` | A | S6-06 | `admin.workflow.draft` | admin2 | WF-SIMEC | — |
| 15 | `/budgets/overruns/[id]` | A | S6-16 | `request.view` + `budget.view` (ผู้ขอ OWN · ผู้อนุมัติ ASSIGNED · หัวหน้าแผนก · FINANCE BUDGET_ADMIN EXECUTIVE AUDITOR) · ขอเกินงบต้องมี `budget.overrun.submit` | mkt_01 · cfo | คำขอเกินงบ (ฉาก 6 ⚑) | — |
| 16 | `/budgets` | M | S6-15 | `budget.view` (เมนูเห็นเมื่อ scope แผนกหรือองค์กร) | fin_bud1 | บรรทัดงบของปีงบปัจจุบัน | ปุ่มโอนงบ · ลิงก์โอน นำเข้า สิทธิ์ · คอลัมน์การเปลี่ยน |
| 17 | `/budgets/transfers/[id]` | A | S6-15 | `budget.view` (รวมผู้อนุมัติ) หรือ `budget.transfer.submit` | fin_bud1 · vp_ops | คำขอโอนงบ (ฉาก 4 ⚑) | — |
| 18 | `/budgets/transfers/new` | A | S6-15 | `budget.transfer.submit` → BUDGET_ADMIN หัวหน้าแผนก · DOA ต้องมีข้อ BUDGET_TRANSFER | fin_bud1 | บรรทัดงบ | — |
| 19 | `/budgets/transfers` | A | S6-15 | `budget.view` / `budget.transfer.submit` | fin_bud1 | คำขอโอน · สถานะว่างด้วย | — |
| 20 | `/catalog/manage` | A | S6-10 | `catalog.manage` → PROCUREMENT | proc_officer | รายการแคตตาล็อกและราคาตกลง (ชีต Items) | — |
| 21 | `/catalog` | A | S6-10 | `catalog.view` → ทุกคน | se_p06a | รายการแคตตาล็อก | — |
| 22 | `/finance/bank-accounts/changes/[id]` | A | S9-09 | `bankAccount.view` (FINANCE PROCUREMENT AUDITOR) หรือผู้อนุมัติ · โมดูล PAY | fin_tre1 · ผู้อนุมัติ | คำขอเปลี่ยนบัญชี ⚑ | — |
| 23 | `/finance/bank-accounts/changes/new` | A | S9-09 | `bankAccountChange.propose` → FINANCE · PAY | fin_tre1 | ผู้ขาย | — |
| 24 | `/finance/bank-accounts` | A | S9-09 | `bankAccount.view` · PAY | fin_tre1 | บัญชีจ่ายของบริษัท (ชีต CompanyBankAccounts) · แท็บคำขอเปลี่ยน | — |
| 25 | `/finance/invoices/[poId]` | M | S8-13 | id เป็น PO: `invoiceConfirmation.record` → FINANCE · id เป็นใบแจ้งหนี้ AP: `invoice.record` → FINANCE + PAY | fin_ap1 | ใบแจ้งหนี้ร่างและ exception (H162 H167 ⚑) · กล่องตรวจค่าที่ AI อ่าน | หน้าใบแจ้งหนี้ AP (ปุ่มดำเนินการ กล่อง AI) |
| 26 | `/finance/invoices/inbox` | A | S8-13 | `invoice.inbox.manage` → FINANCE · PAY | fin_ap1 | อีเมลหรือไฟล์ที่รอจับ PO ⚑ | — |
| 27 | `/finance/invoices/new` | A | S8-13 | `invoice.record` · PAY | fin_ap1 | PO ที่ออกใบแจ้งหนี้ได้ | — |
| 28 | `/finance/invoices` | M | S8-13 | `invoiceConfirmation.record` · เปิด PAY แล้วเป็นรายการใบแจ้งหนี้ AP | fin_ap1 | ใบแจ้งหนี้ AP | เปิด PAY แสดงรายการ AP แทน |
| 29 | `/finance/payments/[id]` | A | S9-09 | `paymentRun.view` → FINANCE AUDITOR ผู้อนุมัติ · PAY | fin_tre1 · cfo | รอบจ่าย (ฉาก 11 ⚑) · แถบตัดสิน · แผงผล | — |
| 30 | `/finance/payments/new` | A | S9-09 | `paymentRun.prepare` → FINANCE · PAY | fin_tre1 | ใบอนุมัติแล้วที่ครบกำหนด + บัญชีจ่าย · sheet เพิ่มรายการ · dialog ยืนยัน | — |
| 31 | `/finance/payments` | A | S9-09 | `paymentRun.view` (เมนู scope องค์กร: FINANCE AUDITOR) · PAY | fin_tre1 | รอบจ่ายแยกแท็บสถานะ ⚑ | — |
| 32 | `/finance/retentions` | A | S8-13 | `retention.release` → FINANCE · PAY | fin_ap1 | เงินประกันผลงานบนใบแจ้งหนี้ ⚑ | — |
| 33 | `/finance/wht` | A | S8-13 | `wht.view` → FINANCE AUDITOR · PAY | fin_ap1 · auditor | หนังสือรับรอง 50 ทวิ (รอบจ่ายที่มีภาษีหัก ⚑) | — |
| 34 | `/finance/wht/types` | A | S8-13 | `wht.view` (แก้ต้องมี `wht.configure` → FINANCE) · PAY | fin_ap1 | ประเภทเงินได้ (ชีต WHT_Types) | — |
| 35 | `/insights` | M | S6-05 | `report.view` → FINANCE PROCUREMENT EXECUTIVE AUDITOR หัวหน้าแผนก | ceo | ประวัติการตัดสินและ PO | ร้อยละในกราฟช่องทางคิดจากการตัดสินผ่านช่องทาง |
| 36 | `/procurement/invoice-exceptions` | A | S8-13 | `invoice.variance.request` → PROCUREMENT · PAY | proc_officer | ใบแจ้งหนี้ที่มี exception ส่วนต่าง | — |
| 37 | `/procurement/pos/[id]/change` | A | S8-13 | `po.change` → PROCUREMENT · DOA ต้องมีข้อ PO_CHANGE | proc_officer | PO ที่ส่งแล้ว | — |
| 38 | `/procurement/pos/[id]` | M | S8-13 | `po.view` (PROCUREMENT FINANCE EXECUTIVE AUDITOR OWN ASSIGNED) | proc_officer | PO ที่มีใบแจ้งหนี้และการแก้ ⚑ | แท็บใบแจ้งหนี้ AP และการแก้ PO · งวดงานและเงินประกัน · แถบแก้ PO |
| 39 | `/procurement/pos` | M | S8-13 | `po.view` scope องค์กร | proc_officer | PO | ปุ่มใบแจ้งหนี้ไม่ตรง |
| 40 | `/receiving/[poId]` | M | S13-07 | `gr.post` → RECEIVER (แผนกหรือ ASSIGNED) · ผู้ขอถ้า sodPolicy ยอม | store_p07 | PO ที่ส่งแล้วใน scope ผู้ตรวจรับ (H042) | กล่อง AI อ่านใบส่งของ |
| 41 | `/receiving` | M | S17-13 | `gr.post` | store_p07 | PO ที่รอตรวจรับ | ลิงก์ไป `/go/receive` เมื่อเปิด BCS_GO |
| 42 | `/reports` | M | S6-20 | `report.view` | dm_fin | ประวัติคำขอ | รายงาน workflow ย้ายไป `/reports/workflow` |
| 43 | `/reports/workflow` | A | S6-20 | `report.view` | dm_fin · ceo | ประวัติขั้นผู้ตรวจ · แท็บและกราฟ | — |
| 44 | `/requests/[id]/edit` | M | S13-07 | `request.create` (ผู้ขอเท่านั้น) | fm_p02 | คำขอร่าง | ตัวเลือกแคตตาล็อก · AI อ่านใบเสนอราคาและแชต |
| 45 | `/requests/[id]` | M | S6-12 | `request.view` (OWN ASSIGNED หัวหน้าแผนก PROCUREMENT FINANCE EXECUTIVE AUDITOR ORG_ADMIN) | pm_p07 · se_p06a · mkt_01 | คำขอที่มีธงซ้ำ (ฉาก 5) · เกินงบ (ฉาก 6) · บรรทัดบริการต่ออายุ · แยกบรรทัดงบ ⚑ | ขอซ้ำ ต่ออายุ ธงคำขอซ้ำ แผงเกินงบ แยกบรรทัดงบ |
| 46 | `/requests/new/[type]` | M | S13-07 | `request.create` → ทุกคน | fm_p02 | ประเภทคำขอ · dialog แยกบรรทัดงบ | ตัวเลือกแคตตาล็อก · AI อ่านใบเสนอราคา |
| 47 | `/settings/notifications` | M | S17-10 | `self.notificationPrefs` / `self.pushDevices` → ตัวเอง | ceo | เปิด BCS_GO · อุปกรณ์ push ⚑ | แผง push ของ BCS Go และรายการอุปกรณ์ |
| 48 | `/settings/pin` | M | S17-15 | `self.pin` `self.passkeys` → ตัวเอง | ceo | passkey ที่ลงทะเบียน ⚑ · สถานะว่างด้วย | แผง passkey |
| 49 | `/suppliers/[id]` | M | S9-09 | `supplier.view` (ทุกคนเห็นพื้นฐาน · PROCUREMENT FINANCE AUDITOR เห็นเต็ม) | fin_ap1 · se_p06a | ผู้ขายที่มีบัญชีรับเงิน (การ์ดบัญชีต้อง PAY + `bankAccount.view`) | การ์ดบัญชีรับเงิน |
| 50 | `/tasks/[id]` | M | S6-06 | ผู้รับงานตาม DOA หรือผู้รักษาการ (`approval.decide` / `review.decide`) · step-up ด้วย PIN หรือ passkey · งานรอบจ่ายและเปลี่ยนบัญชีพาไปหน้าของตัวเอง | ceo · dm_qse · vp_ops · ผู้อนุมัติ IE-01 | งานเปิดของทุกชนิด: ขั้นผู้ตรวจ โอนงบ เกินงบ ส่วนต่างใบแจ้งหนี้ แก้ PO ราคาอ้างอิง ธง สรุป AI ย้อนทดสอบ passkey ⚑ | ขั้นผู้ตรวจ งานชนิดใหม่ แผงราคาอ้างอิง ธง สรุป AI ยืนยันด้วย passkey |
| 51 | `/go/receive` | A | S17-13 | หน้าเปล่าไม่อ่าน session · `/api/go/*` ใช้ cookie ของเว็บ + `gr.post` · เตรียมสำเนาต้องเปิด BCS_GO | store_p07 | PO ที่รอรับในเครื่อง (IndexedDB) · สถานะออฟไลน์และคิว | — |
| 52 | `/liff/gr` | A | S17-04 | session LIFF (LINE ID token) หรือ session เว็บ · `gr.post` | store_p07 | PO ที่รอตรวจรับ | — |
| 53 | `/liff/home` | A | S17-02 | สมาชิกที่ผูก LINE · ปุ่มคำขอใหม่ต้องมี `request.create` | ceo · se_p01a | งานที่ต้องทำ งานอนุมัติ ที่ติดตาม | — |
| 54 | `/liff` | M | S17-02 | ด่าน LIFF | — (redirect) | — | สมาชิกที่ผูกแล้วไป `/liff/home` · ไม่ต้องถ่าย ตรวจแค่ไม่ค้างหน้าเปล่า |
| 55 | `/liff/procurement` | A | S17-04 | `procurement.pool.view` → PROCUREMENT | proc_officer | บรรทัดรอจัดซื้อ PO ตามขั้น | — |
| 56 | `/liff/requests/[id]` | M | S6-12 | `request.view` | se_p06a | คำขอที่ส่งแล้วของตัวเอง | ส่วนขอซ้ำ |
| 57 | `/liff/requests/[id]/edit` | M | S17-07 | `request.create` (ผู้ขอเท่านั้น) | se_p01a | ร่างจากแชตที่มีค่าที่ AI เสนอ (ฉาก 15 ⚑) | อ้างแชต · ยืนยันค่าที่ AI เสนอทีละช่อง |
| 58 | `/liff/requests/new` | M | S17-07 | `request.create` | se_p01a | แผงขอผ่านแชต และรายการร่าง (`?intake=`) | แผงขอผ่านแชต |
| 59 | `/liff/tasks/[id]` | M | S6-06 | ผู้รับงานตาม DOA · step-up PIN | vp_ops · cfo | งานเปิดของแต่ละชนิด ⚑ | ราคาอ้างอิง ธง ส่วนต่างใบแจ้งหนี้ แก้ PO รอบจ่าย เปลี่ยนบัญชี · ขั้นผู้ตรวจดูได้อย่างเดียว |
| 60 | `/verify/[token]` | A | S6-19 | สาธารณะ ไม่ต้อง login · token ของ DocumentVerification · จำกัดอัตราตาม IP · ผู้ login ที่มีสิทธิ์เห็นลิงก์เอกสาร | ไม่ login และ pm_p07 | PR หรือ PO ที่พิมพ์ QR แล้ว ⚑ · token ผิด (หน้าไม่พบ) | — |

**ส่วนร่วมที่เปลี่ยน (ถ่ายครั้งเดียวในหน้าแรกหรือหน้าที่เปิดได้):**

- `src/app/(workspace)/layout.tsx` (M): แถบ UAT เมื่อองค์กรเป็น SANDBOX (ถ่ายด้วย SIMEC-UAT ⚑) · sheet "ถาม BCS AI" จาก ⌘K (เห็นเมื่อ agent INSIGHT ใช้ได้ · `ai-chat/ask-sheet.tsx`) · ชื่อเมนูการเงินเป็น "ใบแจ้งหนี้" เมื่อเปิด PAY
- `src/app/go/layout.tsx` (A): โครง BCS Go แคบ ลงทะเบียน PWA ไม่มี session
- `src/app/liff/layout.tsx` (M): แถบ UAT
- ไม่มีไฟล์ `loading` `error` `not-found` `template` ใหม่ และไม่มี route group ใหม่

**dialog sheet และแผงใหญ่ที่ต้องเปิดแล้วถ่าย (อยู่ใน `src/ui`):** ตัวสร้างฟอร์ม (`admin-settings/form-builder-dialogs.tsx` → #11) · กฎและแผงส่ง workflow (`admin-workflow/rule-dialog.tsx` `submit-panel.tsx` → #13) · ถอนฉบับ (`policy-withdrawal/request-withdrawal.tsx` → #7) · ย้อนทดสอบ (`backtest/panel.tsx` → #7 #13 #50) · ร่าง DOA ด้วย AI (`admin-doa/ai-draft.tsx` → #9) · exception และเหตุผล (`ap/invoice/exception-actions.tsx` `reason-dialog.tsx` → #25 #36) · กล่องรับ (`ap/list/inbox.tsx` → #26) · ตัดสินและยกเลิกเปลี่ยนบัญชี (`bank-accounts/change-decision.tsx` `cancel-change.tsx` → #22) · ขอเกินงบ (`budgets/overrun-ask.tsx` `overrun-cancel.tsx` → #45 #15) · ดำเนินการโอนงบ (`budgets/transfer-actions.tsx` → #17) · จัดการแคตตาล็อก (`catalog/manage.tsx` → #20) · รอบจ่าย (`add-sheet.tsx` `confirm-dialog.tsx` → #30 · `run-decision.tsx` `results-panel.tsx` → #29) · แก้ PO (`po-change/draft-pay.tsx` `open-change.tsx` `send-revision.tsx` → #37 #38) · ตัวเลือกแคตตาล็อกและแยกบรรทัด (`request-form/catalog-picker.tsx` `split-line-dialog.tsx` → #44 #46) · เงินประกันและประเภทภาษี (`retention/retention-list.tsx` `wht/income-types.tsx` → #32 #34) · passkey (`settings-pin/passkey-setup.tsx` → #48 · `tasks/passkey-proof.tsx` → #50) · กล่องตรวจค่าที่ AI อ่าน (`ai/ai-review.tsx` → #25 #40 #46) · แอปตรวจรับ (`go-receive/go-receive-app.tsx` → #51) · สวิตช์โมดูล (`ModuleSwitch` → #2)

## 4. เรื่องที่ P1-09 ต้องรู้ก่อนเริ่ม (พบตอนร่าง)

| # | เรื่อง | หลักฐาน | ข้อเสนอ |
| --- | --- | --- | --- |
| 1 | **ไม่มีผู้ดูแลแพลตฟอร์มใน seed บนเครื่อง** · มีแค่ `platform-e2e@bcs.local` ในฐาน `bcs_e2e` | `tests/e2e/seed-platform-admin.ts` | ถ่ายหน้า #1–4 ด้วย project e2e (ใช้ตัวช่วยเดิมของ e2e) หรือ seed ผู้ดูแลแพลตฟอร์มลงฐานของเครื่องด้วยสคริปต์ใน `scratch/` · ห้ามเพิ่มผู้ดูแลแพลตฟอร์มใน seed ถาวรโดยไม่ถาม (สิทธิ์ข้ามองค์กร) |
| 2 | **สคริปต์ถ่ายหน้าของ A2 ไม่ได้ commit** (เขียนเฉพาะกิจบน `pnpm dev`) | `docs/design-review/a2.md` · ไม่มีใน `scripts/` หรือ `tests/` | P1-09 เขียนสคริปต์ถ่ายหน้า + axe ใหม่ ถ้าเก็บถาวร วางใน `scripts/` พร้อมอ่านรายการหน้าจากตาราง 3 (เสนอ NEW `[go-live]` ถ้าไม่ทำในข้อ) · ภาพเต็มหน้าวาดแถบ sticky ซ้ำ และ `pnpm dev` มีปุ่ม "N" ของ Next.js ให้ซ่อนก่อนถ่ายหรือถ่ายบน build |
| 3 | **หลายหน้าต้องเล่นฉากก่อนจึงมีข้อมูล** (⚑ ในตาราง 3: โอนงบ เกินงบ รอบจ่าย 50 ทวิ ร่างจากแชต passkey QR) | seed ระยะ 1 สร้างประวัติแต่ไม่รู้ว่าสร้างรอบจ่ายหรือ 50 ทวิด้วยหรือไม่ | ถ่ายสองรอบ: (ก) หลัง `pnpm db:reset:p1` สำหรับหน้าที่ seed มีข้อมูล (ข) หลังรัน `@p1demo` (ฐานของ e2e ที่ฉากเล่นจบ) ด้วย `checkWebScreen` ในฉาก สำหรับหน้าที่ฉากสร้างข้อมูล · บันทึกว่าแต่ละภาพมาจากรอบไหนในตาราง "ภาพอยู่ที่ไหน" |
| 4 | **ไม่มีผู้ใช้บทบาท DOA_ADMIN ใน SIMEC** | ชีต Users | ถ่ายหน้า DOA และ workflow ด้วย ORG_ADMIN · ถ้า DOA_Policy ของ SIMEC ตั้ง `sodPolicy.doaAdminSeparated` ORG_ADMIN จะเปิดไม่ได้ ⚑ ตรวจก่อน |
| 5 | **ceo ถือตำแหน่ง CEO@HQ ไม่ใช่ DM หรือ VP** จึงไม่แน่ว่านับเป็นหัวหน้าแผนกในหน้างบ | `permissions.ts` (หัวหน้าแผนก = ตำแหน่ง DM หรือ VP) | ถ่ายหน้างบด้วย fin_bud1 ไม่ใช่ ceo · ไม่ใช่ประเด็นดีไซน์ ถ้าพบว่า ceo ควรเห็นแต่ไม่เห็น ให้ส่งเป็นงานแยก |
| 6 | **หน้า AI ต้องเปิด AI** · บนเครื่องใช้ `AI_ENABLED=true` `AI_MODE=fixture` | `gate.ts` · `.env.example` | ถ่ายทั้งสถานะเปิดและปิด AI ของหน้า #5 #9 #44 #46 #57 (ปิดแล้วต้องไม่มีช่องว่างหรือปุ่มตาย · EG-1) |
| 7 | **หน้า LIFF ถ่ายบนเครื่องด้วย mock** | `src/app/liff/layout.tsx` (`APP_ENV=local` + `LIFF_MOCK=1`) | ใช้ mock cookie แบบ e2e ของ LIFF · `pnpm test:e2e --project=mobile tests/e2e/liff-` ถ่ายหน้า LIFF เดิมได้อยู่แล้ว ให้เพิ่มหน้า #52 #53 #55 #57 #58 |
| 8 | Playwright ทั้งเครื่องพร้อมกันไม่เกิน 2 ชุด (ADR-073 ข้อ 5) · ห้ามรันระหว่างรอบจบของ P1-08 | ADR-073 | P1-09 เริ่มหลัง P1-08 จึงไม่ชน · ถ้าสาย l1 l2 รัน `--grep` อยู่ ให้รอ |
