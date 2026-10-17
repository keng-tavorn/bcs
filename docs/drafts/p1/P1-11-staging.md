# ร่าง P1-11 — staging ด้วยข้อมูลสังเคราะห์ระยะ 1

> **สถานะ: ร่างล่วงหน้าตาม ADR-073 (สาย l3)** · เขียนเมื่อ 2026-10-17 บนฐาน `152bc40c` (main หลัง ADR-073) · ไม่ใช่โค้ด ไม่ติ๊ก ไม่ deploy และไม่ reset staging
> ข้อ P1-11 ทำบน main หลัง P1-10 ติ๊ก · ส่วนโค้ด (reset เลือกชุดข้อมูล · seed แบบแบ่งช่วง · guard ยอม `SIMEC` และ `SIMEC-UAT`) ทำในสาย l2 · ตอนร่าง l2 ยังไม่ได้ push งาน ชื่อช่องของ event ชื่อ step และค่าใน Output ข้างล่างจึงเป็น**ข้อเสนอ** ให้ main แก้ให้ตรงโค้ดของ l2 ก่อนใช้ (ทุกจุดที่ต้องตรวจมีเครื่องหมาย ⚑)
> ที่มา: ADR-056 (ปุ่ม reset ใน Inngest) · ADR-055 (seed ครั้งแรก) · `docs/DEMO_RUNBOOK.md` ข้อ 1–2 · `docs/runbooks/p0-08-vercel.md` · `line-demo-setup.md` ส่วนที่ 3 · `bcs-go-demo.md` · `.github/workflows/ci.yml` job `deploy-staging` · `src/server/services/health.ts`

## 1. "เสร็จเมื่อ" ของ P1-11 กับสิ่งที่ต้องพิสูจน์

| เสร็จเมื่อ | พิสูจน์ด้วย | ใครทำ |
| --- | --- | --- |
| ผู้ใช้กด reset แล้ว staging มีองค์กร SIMEC ครบตามชีต | Output ของ run `staging-demo-reset` (จำนวนแถวที่ seed ต่อชีต) + เปิดหน้าเว็บด้วย `admin@simec.bcs.local` เห็นแผนก ผู้ใช้ งบ ผู้ขายครบ (ข้อ 5) | ผู้ใช้กด · agent อ่านผล |
| `/api/health` ตอบ 200 พร้อม commit ของรอบนี้ | `curl https://<staging>/api/health` → `"status":"ok"` และ `"commit":"<sha ของ main หลัง P1-10>"` | agent |
| เล่นฉาก `@p1demo` บน staging ด้วยมือตาม runbook ได้ 1 รอบ | ผู้ใช้หรือ agent เดินตามร่าง runbook ของ P1-12 (`P1-12-runbook-p1.md`) บนเว็บ staging · จดผลต่อฉากในตารางข้อ 7 | ผู้ใช้ (มือถือ LINE และแอป) · agent (ฉากบนเว็บที่ทำผ่าน built-in browser ได้) |

## 2. ก่อนเริ่ม (ตรวจทุกข้อ ถ้าไม่ครบให้หยุดและบอกผู้ใช้ในหัวข้อ "รอคุณ")

1. **P1-10 ติ๊กแล้ว** และโค้ดของ l2 อยู่ใน main (`git log --oneline origin/main --grep=ADR-073` เห็น commit ของ l2)
2. **CI บน main เขียว** ที่ commit ล่าสุด: `gh run list --workflow ci.yml --branch main -L 1` → `success` ทั้ง job `verify` และ `deploy-staging`
3. **LINE บน staging** — D-03 (`[คน]`) ยังเป็น `[ ]` ใน spec ตอนร่าง · ต้องทำ `line-demo-setup.md` ส่วนที่ 1–3 ให้จบก่อนฉาก LINE (ฉาก 15 และการ์ดอนุมัติ) · ถ้ายังไม่จบ ฉากเว็บยังเล่นได้ ให้บอกผู้ใช้และจดว่าฉาก LINE ยังไม่ได้ลอง
4. **BCS Go บนมือถือจริง** — S17-18 ขอให้ผู้ใช้ทำ `docs/runbooks/bcs-go-demo.md` ก่อน P1-11 (Firebase keystore APK) · ไม่จบ = ฉาก 2 และ 7 เล่นในเบราว์เซอร์มือถือแทน (PWA ตาม ADR-166) และจดไว้
5. **ค่าตัวแปรของระยะ 1 ใน Vercel ครบ** ตามข้อ 3 (ผู้ใช้ใส่เอง ห้ามวางในแชต)
6. **วันที่ demo อยู่ในปีงบของชีต** — ปีงบ SIMEC เริ่มมกราคม ชีต Budget มีปี 2569 และ 2570 · daysAgo ของประวัติย้อนได้ราว 5 เดือน ถ้า reset ระหว่างมกราคมถึงพฤษภาคม 2027 คำขอประวัติกระจายสองปีงบและเรื่อง "งบการตลาดใกล้หมด" อาจไม่จริง (ร่าง P1-08 ข้อ 1.5) · step `check` ควรปฏิเสธพร้อมเหตุผลถ้าวันนี้อยู่นอกช่วงที่ชีตรองรับ ⚑

## 3. ตัวแปรของ staging ที่ระยะ 1 ต้องเพิ่ม

ใส่ใน Vercel → project `bcs-staging` → Settings → Environment Variables (Environment = **Production** ของ project staging · ค่าลับเลือกชนิด **Secret** ตาม `p0-08-vercel.md` หัวข้อ "วิธีเพิ่ม environment variable") · เปลี่ยนค่าแล้วต้อง deploy ใหม่ (ข้อ 4)

| ตัวแปร | ค่า | ชนิด | ที่มาของค่า | ถ้าไม่ใส่ |
| --- | --- | --- | --- | --- |
| `AI_ENABLED` | `true` | Config | — | ฉาก AI 12 13 14 16 และการอ่านรูปในฉาก 15 ไม่ขึ้น (ฟีเจอร์อื่นยังทำงาน · EG-1) |
| `AI_MODE` | `live` | Config | staging ปฏิเสธ `fixture` ตอนเริ่มแอป (BR-AI-11 · ADR-142) | แอปเริ่มไม่ได้ถ้า `AI_ENABLED=true` |
| `ANTHROPIC_API_KEY` | key dev ของ BCS (OQ-143 · ตัวเดียวกับที่ใช้วัดผล S13-13 S13-14) | **Secret** | Claude Console → API keys · ตั้งวงเงินรายเดือนของ key ไว้ด้วย | `live` ไม่มี key แอปเริ่มไม่ได้ |
| `AI_MODEL_DEFAULT` และ `AI_MODEL_*` | **ไม่ต้องสร้าง** | — | ค่าเริ่มต้นตาม OQ-145 ใน `src/lib/ai-config.ts` · gate `SYNTHETIC` บันทึกกับรุ่นเหล่านี้ | ถ้าสร้างเป็นค่าว่างหรือรุ่นอื่น ชุดนั้นจะได้ `AI_NOT_EVALUATED` |
| `INVOICE_INBOX_PROVIDER` | **ไม่ต้องสร้าง** (ค่าว่าง = `disabled` นอกเครื่อง) | — | S8.md: staging ใช้อีเมลที่ seed ไว้และการอัปโหลด | — |
| `BCS_GO_ANDROID_PACKAGE` · `BCS_GO_ANDROID_CERT_SHA256` | ตาม `bcs-go-demo.md` ส่วนที่ 2 และ 5 | Config | keystore ของ demo | `/.well-known/assetlinks.json` ตอบ 404 · passkey ในแอปใช้ไม่ได้ (ใช้ PWA แทน) |
| `PUSH_PROVIDER` · `FCM_PROJECT_ID` | `fcm` · id ของ Firebase project | Config | `bcs-go-demo.md` ส่วนที่ 1 | ไม่มี push ในแอป (การ์ด LINE และอีเมลยังมา) |
| `FCM_SERVICE_ACCOUNT_JSON_B64` | ไฟล์ key ของ service account แปลง base64 | **Secret** | `bcs-go-demo.md` ส่วนที่ 1 | เหมือนบรรทัดบน |
| `APP_COMMIT_SHA` | **ห้ามใส่เอง** | — | CI ใส่ตอน deploy (`--build-env` และ `--env`) | — |

ตัวแปรเดิมที่ฉากระยะ 1 ใช้ต่อ (มีแล้วตั้งแต่เส้นชัย A · ตรวจว่ายังอยู่): `SEED_DEV_PASSWORD` (รหัสผ่านของผู้ใช้ตัวอย่างทุกองค์กร) · `SEED_TOTP_KEY` · `SEED_DEV_PIN` (ฉากที่ยอดถึงเกณฑ์ PIN) · ค่า LINE ของ D-02

## 4. deploy commit ของรอบนี้

- **ความจริงตอนร่าง:** job `deploy-staging` ใน `.github/workflows/ci.yml` deploy staging **อัตโนมัติทุกครั้งที่ push เข้า main แล้ว `verify` ผ่าน** (FR-PLT-006 AC2 · environment `staging` บน GitHub ไม่มี protection rule · run ล่าสุดที่ `4fb8d05c` deploy แล้ว) · build ของ Vercel apply migration ที่ค้างด้วย role migrator ก่อน build
- ผลคือ "deploy commit ของรอบนี้" เกิดเองหลัง push ของ P1-10 และ "ขออนุญาตผู้ใช้ก่อน deploy" ในข้อ P1-11 ไม่ตรงกับทางที่ระบบทำอยู่ (ดูข้อ 8.1) · ร่างนี้เสนอให้ P1-11 ทำแบบนี้:
  1. ถามผู้ใช้ก่อน push ครั้งแรกของ P1-11 (หรือยืนยันว่า deploy จาก push ของ P1-10 นับเป็น deploy ของรอบนี้) และบอกว่า push นั้นจะ apply migration ของระยะ 1 บน staging
  2. หลังผู้ใช้ใส่ตัวแปรข้อ 3 แล้ว deploy ใหม่ด้วยการ rerun job `deploy-staging` ของ run ล่าสุดบน main: `gh run rerun <run-id> --job <job-id>` (ไม่ต้องสร้าง commit · ถามก่อนทุกครั้ง)
  3. รอ job จบ แล้วตรวจข้อ 6.1 · ถ้า job ล้มที่ build (migration หรือ `db:check-role`) เว็บเดิมยังทำงาน ให้อ่าน log ของ Vercel ก่อนลองใหม่
- **sync แอปกับ Inngest หลังทุก deploy (agent ทำ):** staging ไม่ใช้ Vercel integration ของ Inngest (`p0-07-inngest.md` ส่วนที่ 2 ห้ามติดตั้ง) และ job `deploy-staging` ใน CI **ไม่ได้ sync** (ค้น `inngest` ใน `ci.yml` ไม่เจอ) · หลัง deploy จึงต้องส่ง `PUT https://<staging>/api/inngest` (ไม่ใช้ค่าลับ) แล้วให้ผู้ใช้ดูหน้า Inngest → staging → **Apps** ว่าเห็น function ใหม่ของระยะ 1 (เช่น `line-rich-menu` `line-rich-menu-versions` งานกวาดแชตทุกสามชั่วโมงของ ADR-175 งานของ S8 S9 S13) และ `staging-demo-reset` รุ่นใหม่ของ l2 · ถ้าไม่ sync ปุ่ม reset จะยังเป็นรุ่นเดิมที่ไม่รู้จักชุดระยะ 1 (ดูข้อ 8.6)

## 5. reset staging ให้เป็นข้อมูลระยะ 1 (ผู้ใช้กดเอง · อนุมัติทุกครั้ง)

agent ถามผู้ใช้ก่อนทุกครั้ง แม้ผู้ใช้เคยอนุมัติในรอบก่อน (CLAUDE.md หัวข้อ 2 · ADR-056) · การพิมพ์คำยืนยันของวันนั้นคือการอนุมัติ

**ข้อความที่ agent ส่งให้ผู้ใช้ (ร่าง):**

1. เปิด <https://app.inngest.com> → environment **staging** → **Functions** → `staging-demo-reset`
2. กด **Invoke** → ลบข้อความเดิมในช่องข้อมูล แล้วพิมพ์ ⚑
   `{"data": {"inputs": "p1", "confirm": "SIMEC-<วันที่วันนี้ตามเวลาไทย>"}}` เช่น `{"data": {"inputs": "p1", "confirm": "SIMEC-2026-10-25"}}`
   - คำยืนยันคือ `<รหัสองค์กรของชุดข้อมูลที่เลือก>-<วันที่>` แบบเดิมของ ADR-056 · ชุด demo ยังพิมพ์ `{"data": {"confirm": "DEMO-<วันที่>"}}` ได้เหมือนเดิม (ไม่ระบุ `inputs` = demo) ⚑
3. กด **Invoke function** → หน้า **Runs** รอจนเป็น **Completed** · seed แบ่งเป็นหลาย step (เช่น `check` → `reset` → `base` → `history-1` … `history-n`) แต่ละ step จบในเวลาของ Inngest · ทั้ง run ใช้เวลานานกว่าชุด demo (บนเครื่อง `pnpm db:reset:p1` ราว 2 นาที บน Vercel ไกลฐานข้อมูลกว่า คาดหลายนาที) ⚑
4. อ่าน Output:
   - `"reset": true` และจำนวนแถวต่อชีต (ผู้ใช้ราว 120 · แผนก 27 · ผู้ขายราว 196 · ประวัติราว 240 คำขอ) ตรงกับชีต ⚑
   - `"line": "KEPT"` = ค่า LINE ย้ายมาอยู่กับองค์กร SIMEC แล้ว · `"NONE"` = ยังไม่เคยตั้ง LINE · `"NOT_OPENED"` = ต้องตั้ง LINE ใหม่ตาม `line-demo-setup.md` ส่วนที่ 3 ⚑
   - `"refusal": "CONFIRMATION_MISMATCH"` = พิมพ์ไม่ตรง Output บอกคำที่ถูก ไม่มีอะไรถูกลบ
   - `"refusal": "OTHER_ORGANIZATIONS"` = มีองค์กรอื่นนอกจาก DEMO SIMEC SIMEC-UAT · ไม่มีอะไรถูกลบ ให้บอก agent (อย่าลบองค์กรนั้นเอง เพราะอาจเป็นของใครบางคน)
   - **Failed:** ส่งข้อความ error ให้ agent อย่ากดซ้ำ · ล้มที่ `check` ยังไม่มีอะไรถูกลบ · ล้มหลัง `reset` ข้อมูลอาจว่างหรือครึ่งเดียว ให้ถาม agent ก่อนกดใหม่ (กดซ้ำด้วยคำยืนยันเดิมในวันเดียวกันได้ตาม ADR-056)
5. ทุกคน login ใหม่ (session ถูกล้าง) · ผูก LINE ของมือถือ demo ใหม่ (การผูกถูกล้าง) · ลงทะเบียน passkey ในแอปใหม่ถ้าตาราง passkey ถูกล้างด้วย ⚑

**สิ่งที่ต้องบอกผู้ใช้ก่อนกด:** reset ชุดระยะ 1 ล้างทุกตารางแบบเดิม องค์กร DEMO ของฉาก demo เดิมจะหายไปจนกว่าจะ reset กลับด้วยชุด demo ⚑ (ถ้า l2 ทำให้ seed ทั้งสององค์กรพร้อมกัน ให้ตัดย่อหน้านี้)

## 6. หลัง reset (agent ทำ ยกเว้นข้อที่บอกว่าผู้ใช้กด)

1. **`/api/health`** — `curl -s https://<staging>/api/health` → HTTP 200 · `"status":"ok"` · `"commit":"<sha ของ main ตอนนี้>"` (ตรงกับ `git rev-parse origin/main`) · ทุกส่วน (database storage inngest) เป็น ok
2. **rich menu ใหม่ทุกชุด (ผู้ใช้กด)** — login เป็น `admin@simec.bcs.local` → เมนู "ผู้ดูแลองค์กร" → ช่องทาง LINE (`/admin/line`) → กด **ทดสอบการเชื่อมต่อ** ต้องผ่านทุกข้อ → กด **สร้าง rich menu ใหม่ทุกชุด** → ข้อความ "สร้าง rich menu ใหม่ทุกชุดแล้ว" และสถานะ "LINE มี rich menu ครบทุกชุด ทั้งชุดสำหรับคนที่ยังไม่ผูกบัญชีและชุดตามบทบาทของคนที่ผูกแล้ว"
   - ทำไมต้องกดใหม่: S17 เพิ่ม rich menu ตามบทบาท (`LineRichMenuVariant` · `LINKED:APPROVER:RECEIVER` เป็นต้น) ชุดที่องค์กร SIMEC ต้องใช้อาจไม่มีในองค์กร DEMO เดิม · reset คงชุดที่มีไว้ (`line-channel-restore.ts`) แต่ไม่สร้างชุดที่ขาด · หน้าเดียวกันบอก "LINE ไม่มี rich menu ชุด … แล้ว" ถ้ายังขาด
   - บน staging ห้ามใช้ `pnpm line:richmenu` (สคริปต์หยุดเองนอก `APP_ENV=local`)
3. **TOTP ของผู้ใช้ SIMEC** — secret ได้จาก `SEED_TOTP_KEY` กับรหัสผู้ใช้ จึงตรงกับผู้ใช้รหัสเดียวกันของ DEMO (เช่น `ceo`) · ผู้ใช้ที่ demo ใช้แต่ไม่มีใน DEMO ให้ผู้ใช้รันคำสั่งใน `DEMO_RUNBOOK.md` ข้อ 1.5 เพิ่ม `$env:SEED_EMAIL_DOMAIN = "simec.bcs.local";` ก่อน `pnpm exec tsx scripts/seed-totp.ts` แล้วตามด้วยรหัสในตารางบัญชีของ runbook ระยะ 1
4. **ผูก LINE และแอปบนมือถือ demo (ผู้ใช้)** — ตาม `DEMO_RUNBOOK.md` ข้อ 1.4 ด้วยบัญชี SIMEC ของแต่ละเครื่อง (ตารางบัญชีในร่าง runbook ระยะ 1) · หลังผูกต้องเห็น rich menu ตามบทบาท เช่น `store_p07` เห็นปุ่มตรวจรับ `ceo` เห็นปุ่มงานอนุมัติ
5. **ข้อมูลครบตามชีต** — agent เปิด staging ใน built-in browser ด้วย `admin@simec.bcs.local` (รหัสผ่านผู้ใช้พิมพ์เองในหน้าต่าง ไม่ส่งในแชต) ตรวจ: หน้าผู้ใช้นับได้ตามชีต Users · `/budgets` มีปีงบของวันนี้ · `/suppliers` ค้น `SP0029` เจอ · `/admin/workflows` มี WF-SIMEC ฉบับ 1 · `/admin/doa` มี DOA ฉบับ 1 ของ SIMEC · กระดานค้างเห็น H229 ค้างที่ ceo
6. **AI บน staging** — login `fm_p02` → ขอซื้อ → แนบ DOC-049 → ค่าที่ AI เติมขึ้นพร้อมป้าย "เติมโดย AI โปรดตรวจ" (ฉาก 12) · ถ้าได้ `AI_NOT_EVALUATED` ให้ตรวจข้อ 3 แถว `AI_MODEL_*` · หน้า `/admin/ai` เห็น credits ที่ใช้

## 7. ซ้อมฉาก `@p1demo` บน staging 1 รอบ (เสร็จเมื่อข้อ 3)

เดินตามลำดับฉากในร่าง runbook ระยะ 1 (`P1-12-runbook-p1.md` ข้อ 4) · ฉากต่อกัน จึงเล่นตามลำดับบน staging ที่เพิ่ง reset · จดผลในตารางนี้ แล้วคัดลงรายงาน `p1-demo-ready.md`

| ฉาก | ผล (ผ่าน · ผ่านทางสำรอง · ไม่ผ่าน) | ช่องทางที่ใช้จริง | หมายเหตุ |
| --- | --- | --- | --- |
| 1–16 | | | |

- ฉากบนมือถือ (LINE แอป และตรวจรับออฟไลน์) ผู้ใช้ทำ · agent เดินฉากเว็บด้วย built-in browser ได้ แต่ห้ามพิมพ์รหัสผ่าน PIN หรือ TOTP แทนผู้ใช้
- ฉากใบแจ้งหนี้ทางอีเมล (ฉาก 8) บน staging ใช้อีเมลที่ seed ไว้ใน `/finance/invoices/inbox` ไม่มีการส่งอีเมลเข้าจริง (S8.md)
- ไม่ผ่าน: แก้ที่ main ตามปกติ (NEW `[demo]` ถ้าทำให้ฉากผิด) แล้ว reset ใหม่หลังถามผู้ใช้

## 8. เรื่องที่ main ต้องตัดสินตอนทำ P1-11 (พบตอนร่าง)

1. **deploy อัตโนมัติขัดกับ "ขออนุญาตผู้ใช้ก่อน deploy"** — CI deploy staging ทุก push เข้า main (ข้อ 4) รวม push ของสาย l1 l2 และของ P1-08 ถึง P1-10 · staging จึงได้โค้ดและ migration ของระยะ 1 ก่อนถึง P1-11 · ข้อเสนอ: ถือว่าการอนุมัติของ P1-11 คุมเฉพาะ reset และการ rerun deploy ที่ agent สั่ง แล้วเขียนเหตุผลใน "สิ่งที่พบ" · ถ้าผู้ใช้ต้องการคุม deploy จริง ให้เพิ่ม required reviewer ที่ environment `staging` ของ GitHub (ผู้ใช้กดเองใน Settings → Environments · เปลี่ยนค่าตั้งนอก repo ต้องถามก่อน)
2. **migration ของระยะ 1 บนข้อมูล demo เดิมของ staging** — push แรกหลัง S6 เข้า main apply migration บน staging ที่ยังมีข้อมูล DEMO แล้ว · CI เขียวจึงน่าจะผ่าน แต่ให้ตรวจ log ของ build ก่อน reset ว่าไม่มี migration ค้าง
3. **ชื่อช่องของ event และ Output** — ทุกจุด ⚑ ในข้อ 5 และ 6 ต้องตรงโค้ดของ l2 · แก้ `DEMO_RUNBOOK.md` ข้อ 2 ให้มีชุดระยะ 1 ใน P1-12
4. **องค์กร DEMO หายหลัง reset ชุดระยะ 1** (ถ้า l2 ทำแบบล้างทั้งหมด) — ซ้อม demo เดิมบน staging ต้อง reset กลับ · บอกผู้ใช้ก่อนกด
5. **SIMEC-UAT** — seed ระยะ 1 สร้างองค์กร UAT sandbox ของ S6 ด้วยหรือไม่ ⚑ · ถ้าสร้าง หน้าองค์กรของ PLATFORM_ADMIN จะเห็นสององค์กร ซึ่งเป็นปกติ
6. **CI deploy แต่ไม่ sync Inngest** — ตั้งแต่ CI deploy เอง (P1-03) ไม่มีใครส่ง `PUT /api/inngest` หลัง deploy อัตโนมัติ · function ที่ระยะ 1 เพิ่มอาจยังไม่ลงทะเบียนบน staging ตอนนี้ (งานเบื้องหลัง เช่น เปลี่ยน rich menu ตามบทบาท กวาดแชต SLA ของ S6 ไม่ทำงาน) · ข้อเสนอ: เพิ่ม step `curl -fsS -X PUT "$base/api/inngest"` ต่อจาก step `/api/health` ใน job `deploy-staging` เป็นงานของ P1-11 หรือ NEW `[demo]` · จนกว่าจะแก้ ทุก deploy ต้อง sync เอง
