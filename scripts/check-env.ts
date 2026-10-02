// pnpm verify gate "env": .env must pass the Zod schema in src/lib/env.ts (spec §15.5 gate 1).
import { config } from 'dotenv'
import { EnvError, parseEnv } from '../src/lib/env'

const loaded = config({ path: '.env', quiet: true })
if (loaded.error) {
  console.error('อ่านไฟล์ .env ไม่ได้ — cp .env.example .env แล้วเติมค่า')
  process.exit(1)
}
try {
  const env = parseEnv({ ...loaded.parsed })
  console.log(`.env ผ่าน schema (APP_ENV=${env.APP_ENV})`)
} catch (error) {
  if (error instanceof EnvError) {
    console.error(error.issues.join('\n'))
    process.exit(1)
  }
  throw error
}
