// pnpm db:migrate (spec §5.4): local → prisma migrate dev; CI/staging/production → prisma migrate deploy.
// Prisma 7 no longer runs `generate` inside migrate, so it is chained explicitly.
// Outside APP_ENV=local (unset counts as local) the whole environment must pass src/lib/env.ts before the Prisma CLI
// starts. The app never connects with DIRECT_URL, so this is where its host, role and password rules run
// (FR-PLT-006 AC3, §4.12, NFR-SEC-07); prisma.config.ts repeats the check for a Prisma CLI command started directly.
import { spawnSync } from 'node:child_process'
import { config } from 'dotenv'
import { envIssuesOutsideLocal } from '../src/lib/env'

config({ path: '.env', quiet: true })
const issues = envIssuesOutsideLocal(process.env)
if (issues.length > 0) {
  console.error(
    `db:migrate หยุดก่อนเชื่อมต่อฐานข้อมูล (APP_ENV=${process.env.APP_ENV ?? ''}): ค่าใน environment ไม่ผ่านการตรวจของ src/lib/env.ts ` +
      'แก้ตามรายการนี้ใน Environment Variables ของ hosting หรือในไฟล์ .env แล้วรันใหม่',
  )
  console.error(issues.map((i) => `- ${i}`).join('\n'))
  process.exit(1)
}
const local = (process.env.APP_ENV ?? 'local') === 'local' && !process.env.CI
// gen-db-relations refreshes the relation map the tenant guard follows (src/server/db/relations.generated.ts)
const steps = [local ? 'prisma migrate dev' : 'prisma migrate deploy', 'prisma generate', 'tsx scripts/gen-db-relations.ts']
for (const step of steps) {
  const r = spawnSync(`pnpm exec ${step}`, { stdio: 'inherit', shell: true })
  if (r.status !== 0) process.exit(r.status ?? 1)
}
