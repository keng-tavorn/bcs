// pnpm db:migrate (spec §5.4): local → prisma migrate dev; CI/staging/production → prisma migrate deploy.
// Prisma 7 no longer runs `generate` inside migrate, so it is chained explicitly.
import { spawnSync } from 'node:child_process'
import { config } from 'dotenv'

config({ path: '.env', quiet: true })
const local = (process.env.APP_ENV ?? 'local') === 'local' && !process.env.CI
const steps = [local ? 'prisma migrate dev' : 'prisma migrate deploy', 'prisma generate']
for (const step of steps) {
  const r = spawnSync(`pnpm exec ${step}`, { stdio: 'inherit', shell: true })
  if (r.status !== 0) process.exit(r.status ?? 1)
}
