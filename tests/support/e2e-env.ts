// Environment for end-to-end runs (plan: runtime partitioning): its own database (bcs_e2e), its own port (3100)
// and build folder, so it never touches the developer database or the `next dev` server on :3000.
export const E2E_DB = process.env.BCS_E2E_DB ?? 'bcs_e2e'
export const E2E_PORT = Number(process.env.E2E_PORT ?? 3100)
export const E2E_BASE_URL = `http://localhost:${E2E_PORT}`
/** The transaction PIN the e2e seed gives every demo approver (SEED_DEV_PIN; passes the PIN rules of FR-AUTH-005 AC1) */
export const E2E_PIN = '739164'

export function withDatabase(url: string, database: string): string {
  const u = new URL(url)
  u.pathname = `/${database}`
  return u.toString()
}

/** Variables the e2e server and its setup run with (on top of .env). */
export function e2eEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  if (!env.DATABASE_URL || !env.DIRECT_URL) throw new Error('DATABASE_URL and DIRECT_URL must be set (.env)')
  return {
    APP_ENV: 'local',
    DATABASE_URL: withDatabase(env.DATABASE_URL, E2E_DB),
    DIRECT_URL: withDatabase(env.DIRECT_URL, E2E_DB),
    APP_URL: E2E_BASE_URL,
    BETTER_AUTH_URL: E2E_BASE_URL,
    // A parallel run (one per agent) builds into its own folder under .e2e-runs/ (E2E_DIST_DIR)
    NEXT_DIST_DIR: env.E2E_DIST_DIR ?? '.next-e2e',
    SEED_DEV_PIN: E2E_PIN,
  }
}
