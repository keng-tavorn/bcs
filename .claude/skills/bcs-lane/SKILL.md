---
name: bcs-lane
description: Procedure for BCS parallel lanes of round P1 (git worktrees .worktrees/l1 l2 l3, branches p1/l1 p1/l2 p1/l3) — use before starting any checklist item inside a lane, when syncing main into a lane, when merging a finished step into main, and when resolving merge conflicts between lanes. ใช้เมื่อทำงานในสายขนาน รวม main เข้าสาย ส่งงานของขั้นเข้า main หรือแก้ conflict ระหว่างสาย
---

# สายขนานของรอบ P1 (spec §16.13 · ADR-066)

ใช้ร่วมกับ CLAUDE.md และส่วน "เริ่มที่นี่" ของ spec · ถ้าขัดกัน ยึด spec

## 1. รู้ก่อนว่าอยู่สายไหน (ทุกครั้งที่เริ่มแชต)

- `git rev-parse --abbrev-ref HEAD` และ `git rev-parse --show-toplevel`
  - `p1/l1` ใน `.worktrees/l1` = สาย 1: S6 (§16.14) แล้ว S17 (§16.18) · เส้นชัย D แล้ว G
  - `p1/l2` ใน `.worktrees/l2` = สาย 2: S8 (§16.15) แล้ว S9 (§16.16) · เส้นชัย E
  - `p1/l3` ใน `.worktrees/l3` = สาย 3: S13 (§16.17) · เส้นชัย F
  - `main` ใน `E:\BCS` = ข้อ P1-nn (§16.13) · ไม่ใช่แชตของสาย
  - อย่างอื่น (เช่น branch ของสายแต่อยู่ใน `E:\BCS` หรือโฟลเดอร์ที่ app สร้างใน `.claude/worktrees`) → หยุดถามผู้ใช้
- `pnpm lane:check` ตรวจว่า branch โฟลเดอร์ และ `.env` (ฐานข้อมูล พอร์ต) ตรงตารางสาย โดยไม่พิมพ์ค่าลับ · ล้ม → หยุดและบอกผู้ใช้ให้แชต main รัน `pnpm lane:create <เลขสาย>` (`docs/runbooks/parallel-lanes.md`)
- ก่อน P1-07 เสร็จ ถ้าผู้ใช้สั่ง `ทำ P1-02` `ทำ P1-03` หรือ `ทำ P1-04` ในโฟลเดอร์ของสาย → ทำตามหัวข้อ 7 (สายชั่วคราว) ไม่ต้องให้ไปเปิดแชตที่ main
- แชตหนึ่งทำสายเดียว · ถ้าผู้ใช้สั่งงานของขั้นอื่นในแชตนี้ ให้บอกว่าต้องเปิดแชตในโฟลเดอร์ของสายนั้น

## 2. ก่อนเริ่มทุกข้อ: รวม main เข้าสาย

1. `git status --short` ต้องว่าง (ถ้ามีงานค้างของข้อก่อน ให้ commit ให้จบก่อน)
2. `git fetch origin` แล้ว `git merge --no-edit origin/main` · ห้าม rebase ห้าม squash (เลข commit ในบรรทัดติ๊กต้องคงอยู่)
3. conflict → หัวข้อ 5
4. ถ้า merge นำ migration ใหม่มา: `pnpm db:reset` (ฐานของสายเท่านั้น) · ถ้าข้อความหน้าจอเปลี่ยน: `pnpm messages:build`
5. `pnpm verify` (ไม่ต้อง `--e2e` ทุกครั้ง)

## 3. ระหว่างทำข้อ

- commit ใส่รหัสข้อ · `git push origin HEAD` (branch ของสายเป็นสำรอง CI ไม่รันบน branch นี้)
- งานที่พบ → ข้อใหม่ท้ายส่วนของขั้นนี้ใน spec (เลขต่อจากข้อสุดท้ายของขั้น · ไม่ใช้ NEW) · ADR และ OQ ใหม่ใช้ช่วงเลขของขั้นในตารางสาย · OQ ใหม่ต้องเพิ่มคำถามใน `scripts/inputs_p1/p1_texts.py` แล้วรัน `node scripts/py.mjs scripts/inputs_p1/make.py` และ `pnpm inputs:check`
- แก้ spec เฉพาะส่วนของขั้นตัวเอง แถว ADR OQ ของช่วงตัวเอง และตารางที่ข้อของตัวเองต้องเพิ่ม (§2.4 §10 §14.2 §7 เมื่อสร้างโค้ดนั้น)
- `pnpm verify --e2e` และ `pnpm test:e2e` เต็มชุด รันได้ทีละสาย: ถ้าไม่แน่ใจว่าสายอื่นรันอยู่ ให้ถามผู้ใช้ก่อน · `pnpm test:e2e --grep @demo` รันพร้อมกันได้
- `pnpm dev` เปิดที่พอร์ตของสายเอง (อ่านจาก `APP_URL` ใน `.env`) · ห้ามปิดโปรเซสบนพอร์ตของสายอื่นหรือของ main

## 4. ส่งงานของขั้นเข้า main (ข้อรีวิวท้ายขั้น)

1. รวม main เข้าสาย (หัวข้อ 2) → `pnpm verify` ผ่าน → `pnpm test:e2e --grep @demo` ผ่าน
2. เรียก skill `code-review` ด้วย `high main...HEAD` (เห็นเฉพาะงานของสายที่ยังไม่เข้า main) รอผล แล้วแก้ข้อที่กระทบความถูกต้อง เงิน สิทธิ์ หรือ "เสร็จเมื่อ" · ข้ออื่นเป็นข้อท้ายขั้นแท็ก `[go-live]` หรือเหตุผลใน "สิ่งที่พบ" · บันทึกผลใน `docs/reports/p1-review-<ขั้น>.md`
3. `pnpm verify --strict --e2e` ผ่าน (ทีละสาย)
4. ติ๊กข้อรีวิวแล้ว commit · `git fetch origin && git merge --no-edit origin/main` · ถ้า main ขยับ ให้ `pnpm verify` อีกครั้ง
5. `git push origin HEAD:main` (fast-forward เท่านั้น · ถูกปฏิเสธ = main ขยับ → กลับไปข้อ 4 · ห้าม `--force`)
6. ใน "รอคุณ" บอกผู้ใช้ว่าแชตบน main ต้องเริ่มด้วย `git pull --ff-only` และสายอื่นจะได้งานนี้ตอนรวม main ครั้งถัดไป
- ส่งบางส่วนก่อนจบขั้นได้เมื่อสายอื่นต้องใช้ (เช่น entity ใบแจ้งหนี้ของ S8 ให้สาย 3): ทำข้อ 1 ถึง 5 โดยรีวิวส่วนนั้น แล้วบอกในสรุปว่าสายไหนรอ

## 5. แก้ conflict

- เพิ่มต่อท้ายทั้งสองฝั่ง → เก็บทั้งคู่ เรียงตามเลข: บรรทัดติ๊กใน spec · แถว ADR และ OQ · แถวใน §2.4 §10 §14.2 · entry ใน `docs/feature-status.yaml` (`updatedAt` ใช้วันที่ใหม่กว่า) · คีย์ใน `messages/src/**` · model ใหม่ใน `prisma/schema.prisma`
- ไฟล์ที่สร้างอัตโนมัติ → เลือกฝั่งใดก็ได้แล้วสร้างใหม่: `pnpm messages:build` · `pnpm exec tsx scripts/verify-db.ts lock` (`scripts/migrations.lock.json`) · `pnpm exec tsx scripts/gen-db-relations.ts` · `node scripts/py.mjs scripts/inputs_p1/make.py` (ไฟล์ข้อมูลระยะ 1)
- migration: ห้ามแก้ไฟล์ migration ที่ apply แล้ว · ถ้าสองฝั่งแก้ตารางเดียวกัน หรือด่าน prisma ของ `pnpm verify` เจอ drift หลังรวม → หยุดถาม
- โค้ดเงิน สิทธิ์ DOA (`src/core/**` `permissions.ts` service ที่แตะเงินหรือการอนุมัติ) ที่ไม่ใช่การเพิ่มต่อท้ายทั้งสองฝั่ง → หยุดถาม ห้ามเลือกฝั่งเอง
- หลังแก้ทุกครั้ง `pnpm verify` ต้องผ่านก่อน commit merge

## 6. ห้าม

- `docker compose up` ในโฟลเดอร์ของสาย (บริการ Docker เปิดจาก `E:\BCS` เท่านั้น)
- แตะฐานข้อมูล พอร์ต หรือโฟลเดอร์ของสายอื่นหรือของ main
- `git push --force` · rebase · ลบ worktree branch หรือฐานข้อมูลของสาย (ถามผู้ใช้)
- ใช้เลข NEW หรือเลข ADR และ OQ นอกช่วงของขั้น

## 7. สายชั่วคราว: ทำ P1-02 P1-03 P1-04 พร้อมกันก่อน P1-07 (spec §16.13)

ใช้เมื่อผู้ใช้พิมพ์ `ทำ P1-02` `ทำ P1-03` หรือ `ทำ P1-04` ในโฟลเดอร์ของสาย และ P1-07 ยังเป็น `[ ]` · ถ้า P1-07 ติ๊กแล้ว หรือข้อที่สั่งไม่ใช่สามข้อนี้ → บอกผู้ใช้ให้ทำที่ main

1. หัวข้อ 1 (`pnpm lane:check`) และหัวข้อ 2 (รวม main เข้าสาย · `pnpm verify`) เหมือนเดิม · ถ้าข้อที่สั่งติ๊กแล้วใน main → หยุดและบอกผู้ใช้
2. ทำข้อนั้นตามส่วน "เริ่มที่นี่" และ §16.13 เหมือนแชตบน main (อ่าน "เสร็จเมื่อ" ของข้อนั้น · commit ใส่รหัสข้อ · `git push origin HEAD` เป็นสำรอง) · ใช้ฐานข้อมูลและพอร์ตของสายเท่านั้น
3. เลข: งานที่พบจดไว้ก่อน แล้วออกเลข NEW ตอนส่งงานในข้อ 5 (ต่อจากเลขล่าสุดใน main หลังรวม) · ADR และ OQ ของ main ทำแบบเดียวกัน · ADR และ OQ ของ sub-spec ใน P1-04 ใช้ช่วงของขั้นในตารางสาย
4. e2e เต็มชุด (`pnpm test:e2e` ไม่มี `--grep` หรือ `pnpm verify --e2e`) รันได้ทีละแชต: P1-03 เป็นเจ้าของ · ข้ออื่นใช้ `pnpm test:e2e --grep @demo` ได้ · ถ้าข้ออื่นต้องรันเต็มชุด ให้ถามผู้ใช้ก่อน
5. ส่งงานเข้า main เมื่อ "เสร็จเมื่อ" ผ่าน (หรือเมื่อ P1-03 ต้องให้ CI บน GitHub รัน เพราะ CI รันเฉพาะ `main`): commit ให้ครบ → `git fetch origin && git merge --no-edit origin/main` (conflict → หัวข้อ 5) → `pnpm verify` (และ `pnpm test:e2e --grep @demo` เมื่อแก้โค้ด) → ติ๊กข้อพร้อมเลข commit ตามปกติ แล้ว commit → `git push origin HEAD:main` · ถูกปฏิเสธ = main ขยับ ให้ทำข้อนี้ซ้ำ · ห้าม `--force`
6. สรุป 3 หัวข้อตามปกติ · บรรทัด "ตรวจก่อน:" ให้รันในแชตนี้ได้เลย (`/code-review high <ฐาน>...HEAD`) และงานที่แก้ตามผลตรวจส่งเข้า main ด้วยข้อ 5 อีกครั้ง · บอกใน "รอคุณ" ว่าแชตบน main ต้องเริ่มด้วย `git pull --ff-only`
7. หลังส่งงานแล้ว สายนี้ใช้ต่อได้: P1-07 รัน `pnpm lane:create` ซ้ำเพื่อตั้งสายใหม่ก่อนเริ่มขั้นของสาย (branch เดิมเก็บไว้ งานที่ส่งแล้วอยู่ใน main)
