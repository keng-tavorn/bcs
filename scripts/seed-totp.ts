// Prints the authenticator setup and the current code for seeded demo users (local/staging only), so the presenter
// can add them to an authenticator app once, and testers can sign in. Secrets derive from SEED_TOTP_KEY.
//   pnpm exec tsx --env-file-if-exists=.env scripts/seed-totp.ts            → every user who needs 2FA
//   pnpm exec tsx --env-file-if-exists=.env scripts/seed-totp.ts ceo admin  → only these codes
import { deriveSeedTotpSecret, otpauthUri, totp } from '../src/lib/totp'

if (!['local', 'staging'].includes(process.env.APP_ENV ?? '')) {
  console.error('seed-totp: ใช้ได้เฉพาะ APP_ENV=local หรือ staging')
  process.exit(1)
}
const key = process.env.SEED_TOTP_KEY
if (!key) {
  console.error('seed-totp: ไม่มี SEED_TOTP_KEY ใน .env')
  process.exit(1)
}
const domain = process.env.SEED_EMAIL_DOMAIN ?? 'demo.bcs.local'
const codes = process.argv.slice(2)
if (codes.length === 0) {
  console.error('ระบุรหัสผู้ใช้ เช่น: ceo admin fin_officer (ดูคอลัมน์ code ในชีต Users)')
  process.exit(1)
}
for (const code of codes) {
  const secret = deriveSeedTotpSecret(key, code)
  console.log(`${code}\tรหัสตอนนี้ ${totp(secret)}\t${otpauthUri(secret, `${code}@${domain}`)}`)
}
