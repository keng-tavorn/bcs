# GitHub · repo ส่วนตัว push ครั้งแรก และกฎกัน merge

| รายการ | ค่า |
| --- | --- |
| สถานะ | คุณตัดสินเมื่อ 2026-10-02 ว่ายังไม่สร้าง repo (commit บนเครื่องอย่างเดียว) ทำคู่มือนี้เมื่อพร้อม |
| ใช้กับ | S1-14 และ FR-PLT-006: ทุก PR รัน `pnpm verify` และ merge ไม่ได้ถ้ามี FAIL · merge `main` แล้ว deploy staging อัตโนมัติ |
| ระหว่างที่ยังไม่มี repo | agent deploy staging จากเครื่องด้วย Vercel CLI ได้ แต่ CI และการ deploy อัตโนมัติยังทำไม่ได้ |
| เวลา | ประมาณ 20 นาที (ไม่รวมขั้นที่ 5 ซึ่งทำทีหลัง) |

## ค่าใช้จ่าย (ตรวจ ต.ค. 2026)

- **GitHub Free:** สร้าง repo ส่วนตัวได้ไม่จำกัด · GitHub Actions 2,000 นาทีต่อเดือนสำหรับ repo ส่วนตัว · **แต่กฎป้องกัน branch (ruleset) ใช้กับ repo ส่วนตัวไม่ได้**
- **GitHub Pro** (บัญชีบุคคล ราว US$4 ต่อเดือน) หรือ **GitHub Team** (บัญชีองค์กร US$4 ต่อคนต่อเดือน): ใช้ ruleset กับ repo ส่วนตัวได้ · Actions 3,000 นาทีต่อเดือน
- ถ้าไม่ซื้อ: CI ยังรันได้ แต่ GitHub จะไม่กัน merge เมื่อ CI ไม่ผ่าน (FR-PLT-006 AC1 จะยังไม่ครบ) ต้องให้คุณตัดสิน
- CI ของโปรเจกต์รัน `pnpm verify` พร้อมฐานข้อมูลจริง ใช้เวลาหลายนาทีต่อครั้ง agent จะแจ้งถ้านาทีใกล้หมด

## ขั้นที่ 1 · บัญชี GitHub

1. ถ้ายังไม่มีบัญชี สมัครที่ <https://github.com/signup> ด้วยอีเมลของบริษัท
2. แนะนำให้เปิด two-factor authentication ที่หน้า Settings ของบัญชี (หัวข้อ Password and authentication)
3. ถ้าจะใช้กฎกัน merge (ขั้นที่ 5) ให้อัปเกรดบัญชีเป็น Pro ที่หน้า Billing ของบัญชี หรือสร้าง organization ของ BCS แบบ Team ถ้าจะมีคนร่วมงานหลายคน

## ขั้นที่ 2 · สร้าง repo ว่าง

1. ที่มุมขวาบนของ GitHub กด **+** → **New repository**
2. **Owner:** บัญชีของคุณ (หรือ organization ของ BCS)
3. **Repository name:** `bcs`
4. **Visibility:** **Private** ห้ามเลือก Public เพราะใน repo มี spec และข้อมูลธุรกิจ
5. **ไม่ต้อง** เพิ่ม README, .gitignore หรือ license เพราะโปรเจกต์มีไฟล์อยู่แล้ว ถ้าเพิ่มจะชนกับประวัติบนเครื่อง
6. กด **Create repository**
7. หน้าถัดไป (Quick setup) คัดลอก URL แบบ **HTTPS** เช่น `https://github.com/<ชื่อบัญชี>/bcs.git` ค่านี้ไม่ใช่ค่าลับ
8. พิมพ์บอก agent: "สร้าง GitHub repo แล้ว URL คือ https://github.com/<ชื่อบัญชี>/bcs.git ให้ตั้ง remote"

agent จะรัน `git remote add origin <URL>` แล้วบอกคำสั่ง push ที่คุณต้องพิมพ์

## ขั้นที่ 3 · push ครั้งแรกด้วยตัวเอง (เพื่อ login)

ครั้งแรกต้อง login ผ่านเบราว์เซอร์ agent จึงทำแทนไม่ได้

1. เปิด PowerShell แล้วพิมพ์ `cd E:\BCS`
2. พิมพ์คำสั่ง push ที่ agent ให้ ปกติคือ `git push -u origin main`
3. จะมีหน้าต่างของ Git Credential Manager ขึ้นมา กด **Sign in with your browser** → login GitHub (และใส่รหัส 2FA ถ้ามี) → กดอนุญาต
4. ถ้าเห็นข้อความว่า branch `main` ตั้งให้ติดตาม `origin/main` แล้ว แปลว่าสำเร็จ Windows จะจำการ login ไว้ใน Credential Manager ครั้งต่อไป agent push เองได้
5. พิมพ์บอก agent: "push ครั้งแรกแล้ว"

ห้ามใช้ `git push --force` และ agent ก็ห้ามทำโดยไม่ถามคุณ

## ขั้นที่ 4 · ให้ agent เปิด PR ได้ (GitHub CLI)

กฎในขั้นที่ 5 บังคับให้แก้ `main` ผ่าน pull request (PR) agent จึงต้องใช้ GitHub CLI (`gh`)

1. เปิด PowerShell แล้วรัน:

   ```powershell
   winget install --id GitHub.cli --source winget
   ```

2. ปิดหน้าต่าง PowerShell หรือ Windows Terminal ทั้งหน้าต่างแล้วเปิดใหม่ (เปิดแท็บใหม่ไม่พอ)
3. รัน `gh auth login` แล้วตอบคำถาม: **GitHub.com** → **HTTPS** → ยืนยันให้ใช้ login นี้กับ git (ตอบ Y) → **Login with a web browser** → คัดลอกรหัส 8 ตัวที่แสดง → กด Enter → วางรหัสในหน้าเบราว์เซอร์ → **Authorize**
4. ตรวจด้วย `gh auth status` ต้องเห็นว่า login อยู่ที่ github.com แล้ว
5. พิมพ์บอก agent: "ติดตั้ง gh และ login แล้ว"

`gh` เก็บ token ไว้ใน Windows Credential Manager เอง ไม่ต้องคัดลอกไปที่ไหน

## ขั้นที่ 5 · ruleset ของ `main` (ทำหลัง agent บอกว่า CI รันครั้งแรกแล้ว)

ต้องใช้ Pro หรือ Team (ดูค่าใช้จ่าย) และต้องทำหลัง CI มีผลอย่างน้อย 1 ครั้ง จึงจะเลือกชื่อ check ได้

1. หน้า repo → **Settings** → แถบซ้ายหัวข้อ **Rules** → **Rulesets** → **New ruleset** → **New branch ruleset**
2. **Ruleset name:** `main`
3. **Enforcement status:** **Active**
4. **Bypass list:** เว้นว่าง ไม่ให้ใครข้ามกฎ รวมถึง agent ที่ใช้บัญชีของคุณ
5. **Target branches:** กด **Add target** → **Include default branch**
6. ติ๊กกฎเหล่านี้:
   - **Restrict deletions**
   - **Block force pushes**
   - **Require a pull request before merging** ตั้ง Required approvals เป็น **0** (ดูหัวข้อ CODEOWNERS ด้านล่าง)
   - **Require status checks to pass** → ในช่องใส่ชื่อ status check พิมพ์ชื่อที่ agent บอก (เช่น `verify`) แล้วกดเครื่องหมาย **+** หรือเลือกจากรายการที่ขึ้นมา
7. กด **Create**
8. พิมพ์บอก agent: "ตั้ง ruleset ของ main แล้ว" agent จะทดสอบด้วย PR

## ขั้นที่ 6 · ค่าสำหรับ deploy staging อัตโนมัติ (ทำหลังมีโปรเจกต์ Vercel ตาม p0-08)

ไฟล์ `.github/workflows/ci.yml` deploy staging เองทุกครั้งที่ merge เข้า `main` แล้วตรวจว่า `/api/health` ตอบ 200 พร้อม commit ที่ deploy (FR-PLT-006 AC2) จึงต้องมีค่า 3 ตัวใน GitHub · ห้ามวางค่าเหล่านี้ในแชท

1. ที่ Vercel: มุมขวาบน → **Account Settings** → **Tokens** → **Create** ตั้งชื่อ `bcs-github-deploy` · Scope เลือกทีมที่มีโปรเจกต์ `bcs-staging` · Expiration เลือก 90 วัน → **Create** แล้วคัดลอก token ไว้ก่อน (ใช้ token แยกจากของเครื่องคุณ เพื่อยกเลิกทีละตัวได้)
2. ที่ Vercel: เปิดโปรเจกต์ `bcs-staging` → **Settings** → **General** → คัดลอก **Project ID** · แล้วไปที่ทีม → **Settings** → **General** → คัดลอก **Team ID**
3. ที่ GitHub: หน้า repo → **Settings** → แถบซ้าย **Environments** → **New environment** → ชื่อ `staging` → **Configure environment**
4. ในหน้า environment `staging` ส่วน **Environment secrets** กด **Add environment secret** ทีละตัว:
   - Name `VERCEL_TOKEN` · Value = token จากข้อ 1
   - Name `VERCEL_ORG_ID` · Value = Team ID จากข้อ 2
   - Name `VERCEL_PROJECT_ID` · Value = Project ID จากข้อ 2
5. ส่วน **Environment variables** กด **Add environment variable** · Name `STAGING_URL` · Value = โดเมน staging เช่น `https://bcs-staging.example.com` (ไม่มี `/` ท้าย)
6. พิมพ์บอก agent: "ตั้งค่า deploy staging ใน GitHub แล้ว"

การ migrate ฐานข้อมูล staging เกิดตอน Vercel build (`vercel.json` สั่ง `pnpm db:migrate` ก่อน build) ด้วย `DIRECT_URL` ซึ่งเป็น role migrator ส่วนเว็บที่รันอยู่ใช้ `DATABASE_URL` ซึ่งเป็น role app (FR-PLT-006 AC3) GitHub จึงไม่ต้องรู้รหัสฐานข้อมูล

## รอคุณตัดสิน · ผู้ตรวจโค้ดส่วนเงินและสิทธิ์ (CODEOWNERS)

- spec §15.8 ให้ "คนที่ระบุชื่อ" ใน `CODEOWNERS` อนุมัติ PR ที่แตะ `src/core/**` `src/server/authz/**` `src/server/services/budget/**` `prisma/migrations/**` และ `tests/golden/**` และห้าม auto-merge เส้นทางเหล่านี้
- spec ไม่ได้ระบุว่าคนนั้นคือใคร และ GitHub ไม่ให้เจ้าของ PR อนุมัติ PR ของตัวเอง ถ้า agent สร้าง PR ด้วยบัญชีของคุณ คุณจะอนุมัติ PR นั้นไม่ได้
- ทางเลือกที่เป็นไปได้: (ก) เพิ่มผู้ตรวจอีกคน เช่น นักพัฒนาของ BCS เป็น code owner แล้วเปิด **Require review from Code Owners** ใน ruleset (ข) ให้ agent ใช้บัญชี GitHub แยกสำหรับเครื่องมือ (machine account) แล้วให้คุณเป็นผู้อนุมัติ
- ระหว่างยังไม่ตัดสิน ยังไม่ต้องติ๊ก Require review from Code Owners

## ข้อควรระวัง

- repo ต้องเป็น Private เสมอ
- ไฟล์ `.env` อยู่ใน `.gitignore` จึงไม่ถูก push ถ้าเห็นค่าลับใน commit ให้แจ้ง agent และสร้างค่าลับนั้นใหม่ทันที
- งาน verify ใน CI ไม่ใช้ secret ของ GitHub (สร้างค่าสุ่มใหม่ทุกครั้ง) · งาน deploy staging ใช้ค่าในขั้นที่ 6 ซึ่งอยู่ใน environment `staging` เท่านั้น

## เอกสารอ้างอิงที่ใช้ตรวจ (ต.ค. 2026)

- <https://docs.github.com/en/repositories/creating-and-managing-repositories/creating-a-new-repository>
- <https://docs.github.com/en/get-started/git-basics/caching-your-github-credentials-in-git>
- <https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets>
- <https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/creating-rulesets-for-a-repository>
- <https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches>
- <https://docs.github.com/en/get-started/learning-about-github/githubs-plans>
- <https://github.com/pricing>
- <https://cli.github.com/manual/gh_auth_login>
- <https://github.com/cli/cli/blob/trunk/docs/install_windows.md>
