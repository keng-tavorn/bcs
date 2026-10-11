// Parallel lanes of round P1 (spec §16.13 lane table · ADR-066): each lane is a git worktree with its own branch,
// databases and ports, so up to three chats work at once against the shared Docker services of main.
import { parse } from 'dotenv'

export const LANES = [1, 2, 3] as const
export type Lane = (typeof LANES)[number]

/** Integration test workers of a lane: 3 lanes × 4 forks × DB_POOL_MAX stay under max_connections=300 with main */
export const LANE_TEST_WORKERS = 4

export interface LaneConfig {
  readonly lane: Lane
  readonly branch: string
  /** Folder relative to the repository root */
  readonly folder: string
  readonly webPort: number
  readonly e2ePort: number
  readonly fakeLinePort: number
  readonly db: { readonly dev: string; readonly test: string; readonly verify: string; readonly e2e: string }
}

export function isLane(value: unknown): value is Lane {
  return LANES.includes(Number(value) as Lane) && String(Number(value)) === String(value)
}

/** One row of the lane table in spec §16.13 */
export function laneConfig(lane: Lane): LaneConfig {
  return {
    lane,
    branch: `p1/l${lane}`,
    folder: `.worktrees/l${lane}`,
    webPort: 3000 + lane,
    e2ePort: 3100 + lane,
    fakeLinePort: 4180 + lane,
    db: { dev: `bcs_l${lane}`, test: `bcs_test_l${lane}`, verify: `bcs_verify_l${lane}`, e2e: `bcs_e2e_l${lane}` },
  }
}

/** Databases of main (spec §16.13 row "main"): a lane never resets them */
export const MAIN_DATABASES: readonly string[] = ['bcs', 'bcs_test', 'bcs_verify', 'bcs_e2e', 'bcs_e2e_demo']

/** A database of a lane (bcs_l1, bcs_test_l2 …): main never resets them */
export const isLaneDatabase = (name: string): boolean => /_l\d+$/.test(name)

/** The database a postgres URL names, or null when it cannot be read */
export function databaseOf(url: string): string | null {
  // `user:pw@/bcs` (no host: pg uses PGHOST) is no WHATWG URL; read it with a stand-in host as src/lib/env.ts does
  for (const candidate of [url, url.replace('@/', '@empty-host/')]) {
    try {
      const name = decodeURIComponent(new URL(candidate).pathname.replace(/^\//, ''))
      return name || null
    } catch {
      // try the next form
    }
  }
  return null
}

function withDatabase(url: string, database: string): string {
  const u = new URL(url)
  u.pathname = `/${database}`
  return u.toString()
}

/** A URL on this machine moved to another port (fake LINE of main → fake LINE of the lane) */
function withPort(url: string, port: number): string {
  const u = new URL(url)
  u.port = String(port)
  return u.toString().replace(/\/$/, url.endsWith('/') ? '/' : '')
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/** Keys the lane block sets; their lines in main's .env are left out of the lane's copy */
export const LANE_KEYS = [
  'DATABASE_URL',
  'DIRECT_URL',
  'APP_URL',
  'BETTER_AUTH_URL',
  'BCS_TEST_DB',
  'BCS_VERIFY_DB',
  'BCS_E2E_DB',
  'E2E_PORT',
  'E2E_FAKE_LINE_PORT',
  'FAKE_LINE_PORT',
  'BCS_TEST_WORKERS',
  'LINE_API_BASE_URL',
  'LINE_DATA_API_BASE_URL',
] as const

export const LANE_BLOCK_START = '# --- สาย'

/**
 * The lane's .env: main's .env without the lines of LANE_KEYS (and without an earlier lane block), then the lane
 * block. LINE API URLs move to the lane's fake LINE only when main points them at a fake on this machine.
 */
export function laneEnvText(mainEnv: string, lane: Lane): string {
  const values = parse(mainEnv)
  const cfg = laneConfig(lane)
  for (const key of ['DATABASE_URL', 'DIRECT_URL'] as const) {
    if (!values[key]) throw new Error(`.env ของ main ไม่มี ${key}`)
  }
  const web = `http://localhost:${cfg.webPort}`
  const block: Array<[string, string]> = [
    ['DATABASE_URL', withDatabase(values.DATABASE_URL!, cfg.db.dev)],
    ['DIRECT_URL', withDatabase(values.DIRECT_URL!, cfg.db.dev)],
    ['APP_URL', web],
    ['BETTER_AUTH_URL', web],
    ['BCS_TEST_DB', cfg.db.test],
    ['BCS_VERIFY_DB', cfg.db.verify],
    ['BCS_E2E_DB', cfg.db.e2e],
    ['E2E_PORT', String(cfg.e2ePort)],
    ['E2E_FAKE_LINE_PORT', String(cfg.fakeLinePort)],
    ['FAKE_LINE_PORT', String(cfg.fakeLinePort)],
    ['BCS_TEST_WORKERS', String(LANE_TEST_WORKERS)],
  ]
  for (const key of ['LINE_API_BASE_URL', 'LINE_DATA_API_BASE_URL'] as const) {
    const value = values[key]
    if (value === undefined) continue
    let local = false
    try {
      local = LOCAL_HOSTS.has(new URL(value).hostname)
    } catch {
      // not a URL: kept as it is
    }
    block.push([key, local ? withPort(value, cfg.fakeLinePort) : value])
  }
  const keyOf = (line: string) => /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1]
  const skip = new Set<string>(LANE_KEYS)
  const kept: string[] = []
  for (const line of mainEnv.replace(/\r\n/g, '\n').split('\n')) {
    if (line.startsWith(LANE_BLOCK_START)) break // an earlier lane block is the tail of the file
    const key = keyOf(line)
    if (key && skip.has(key)) continue
    kept.push(line)
  }
  while (kept.length > 0 && kept[kept.length - 1]!.trim() === '') kept.pop()
  return [
    ...kept,
    '',
    `${LANE_BLOCK_START} ${lane} (spec §16.13 · สร้างโดย pnpm lane:create ${lane} · ห้ามแก้ด้วยมือ ห้าม commit) ---`,
    ...block.map(([k, v]) => `${k}=${v}`),
    '',
  ].join('\n')
}

/** Lines that differ from the lane table, for a lane's .env (empty = matches). Never repeats a password. */
export function laneEnvProblems(envText: string, lane: Lane): string[] {
  const values = parse(envText)
  const cfg = laneConfig(lane)
  const web = `http://localhost:${cfg.webPort}`
  const expected: Record<string, string> = {
    APP_URL: web,
    BETTER_AUTH_URL: web,
    BCS_TEST_DB: cfg.db.test,
    BCS_VERIFY_DB: cfg.db.verify,
    BCS_E2E_DB: cfg.db.e2e,
    E2E_PORT: String(cfg.e2ePort),
    E2E_FAKE_LINE_PORT: String(cfg.fakeLinePort),
    FAKE_LINE_PORT: String(cfg.fakeLinePort),
  }
  const problems: string[] = []
  for (const key of ['DATABASE_URL', 'DIRECT_URL'] as const) {
    const db = values[key] ? databaseOf(values[key]) : null
    if (db !== cfg.db.dev) problems.push(`${key} ต้องชี้ฐาน ${cfg.db.dev} (ตอนนี้ ${db ?? 'ไม่ได้ตั้ง'})`)
  }
  for (const [key, want] of Object.entries(expected)) {
    if (values[key] !== want) problems.push(`${key} ต้องเป็น ${want} (ตอนนี้ ${values[key] ?? 'ไม่ได้ตั้ง'})`)
  }
  return problems
}
