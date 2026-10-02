// Connection strings for the local databases (bcs, bcs_test, bcs_verify, bcs_e2e, bcs_tpl) derived from .env.
import { config } from 'dotenv'

config({ path: '.env', quiet: true })

export function withDatabase(url: string, database: string): string {
  const u = new URL(url)
  u.pathname = `/${database}`
  return u.toString()
}

export function migratorUrl(database?: string): string {
  const base = process.env.DIRECT_URL
  if (!base) throw new Error('DIRECT_URL ไม่ได้ตั้งใน .env')
  return database ? withDatabase(base, database) : base
}

export function appUrl(database?: string): string {
  const base = process.env.DATABASE_URL
  if (!base) throw new Error('DATABASE_URL ไม่ได้ตั้งใน .env')
  return database ? withDatabase(base, database) : base
}
