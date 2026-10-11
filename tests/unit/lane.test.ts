import { parse } from 'dotenv'
import { describe, expect, it } from 'vitest'
import { databaseOf, isLane, laneConfig, laneEnvProblems, laneEnvText, LANES } from '../../scripts/lib/lane'

// P1-01: each parallel lane of round P1 gets the databases and ports of its row in the lane table (spec §16.13),
// written into a copy of main's .env by pnpm lane:create, so lanes never share a database or a port.

const MAIN_ENV = [
  'APP_ENV=local',
  'APP_URL=http://localhost:3000',
  'SEED_DEV_PASSWORD=dev-only-password',
  'DATABASE_URL=postgresql://bcs_app:app-pw@localhost:5432/bcs',
  'DIRECT_URL=postgresql://bcs_migrator:mig-pw@localhost:5432/bcs?connect_timeout=5',
  'BETTER_AUTH_URL=http://localhost:3000',
  'LINE_API_BASE_URL=https://api.line.me',
  'SWC_NATIVE_BINDING_CACHE=C:\\Users\\User\\.swc-native-cache',
  '',
].join('\r\n')

describe('lane table (spec §16.13)', () => {
  it('gives each lane the folder, branch, ports and databases of its row', () => {
    expect(laneConfig(2)).toEqual({
      lane: 2,
      branch: 'p1/l2',
      folder: '.worktrees/l2',
      webPort: 3002,
      e2ePort: 3102,
      fakeLinePort: 4182,
      db: { dev: 'bcs_l2', test: 'bcs_test_l2', verify: 'bcs_verify_l2', e2e: 'bcs_e2e_l2' },
    })
  })

  it('shares no port or database between lanes or with main', () => {
    const ports = [3000, 3100, 4180, ...LANES.flatMap((n) => [laneConfig(n).webPort, laneConfig(n).e2ePort, laneConfig(n).fakeLinePort])]
    const dbs = ['bcs', 'bcs_test', 'bcs_verify', 'bcs_e2e', ...LANES.flatMap((n) => Object.values(laneConfig(n).db))]
    expect(new Set(ports).size).toBe(ports.length)
    expect(new Set(dbs).size).toBe(dbs.length)
  })

  it('knows only lanes 1 to 3', () => {
    expect(['1', '2', '3'].every(isLane)).toBe(true)
    expect(['0', '4', '01', 'l1', '', undefined].some(isLane)).toBe(false)
  })
})

describe("lane's .env", () => {
  const lane = laneEnvText(MAIN_ENV, 3)
  const values = parse(lane)

  it('points the app, the tests and e2e at the databases and ports of the lane', () => {
    expect(values.DATABASE_URL).toBe('postgresql://bcs_app:app-pw@localhost:5432/bcs_l3')
    expect(values.DIRECT_URL).toBe('postgresql://bcs_migrator:mig-pw@localhost:5432/bcs_l3?connect_timeout=5')
    expect(values.APP_URL).toBe('http://localhost:3003')
    expect(values.BETTER_AUTH_URL).toBe('http://localhost:3003')
    expect(values).toMatchObject({
      BCS_TEST_DB: 'bcs_test_l3',
      BCS_VERIFY_DB: 'bcs_verify_l3',
      BCS_E2E_DB: 'bcs_e2e_l3',
      E2E_PORT: '3103',
      E2E_FAKE_LINE_PORT: '4183',
      FAKE_LINE_PORT: '4183',
      BCS_TEST_WORKERS: '4',
    })
    expect(laneEnvProblems(lane, 3)).toEqual([])
  })

  it('keeps every other line of main, and each lane key once', () => {
    expect(values.SEED_DEV_PASSWORD).toBe('dev-only-password')
    expect(values.SWC_NATIVE_BINDING_CACHE).toBe('C:\\Users\\User\\.swc-native-cache')
    expect(values.LINE_API_BASE_URL).toBe('https://api.line.me')
    expect(lane.match(/^APP_URL=/gm)).toHaveLength(1)
    expect(lane.match(/^DATABASE_URL=/gm)).toHaveLength(1)
  })

  it('moves a fake LINE on this machine to the fake LINE port of the lane', () => {
    const fake = laneEnvText(`${MAIN_ENV}LINE_API_BASE_URL=http://127.0.0.1:4100\nLINE_DATA_API_BASE_URL=http://127.0.0.1:4100/\n`, 1)
    expect(parse(fake).LINE_API_BASE_URL).toBe('http://127.0.0.1:4181')
    expect(parse(fake).LINE_DATA_API_BASE_URL).toBe('http://127.0.0.1:4181/')
  })

  it('gives the same file when made again from its own output', () => {
    expect(laneEnvText(lane, 3)).toBe(lane)
  })

  it('reports a lane .env that does not match the table without repeating a password', () => {
    const problems = laneEnvProblems(lane, 1)
    expect(problems.join('\n')).toMatch(/DATABASE_URL ต้องชี้ฐาน bcs_l1 \(ตอนนี้ bcs_l3\)/)
    expect(problems.join('\n')).toMatch(/E2E_PORT ต้องเป็น 3101/)
    expect(problems.join('\n')).not.toMatch(/app-pw|mig-pw/)
    expect(laneEnvProblems(MAIN_ENV, 1).length).toBeGreaterThan(0)
  })

  it('refuses a main .env without database URLs', () => {
    expect(() => laneEnvText('APP_ENV=local\n', 1)).toThrow(/DATABASE_URL/)
  })
})

describe('databaseOf', () => {
  it('reads the database of the URL forms pg accepts', () => {
    expect(databaseOf('postgresql://u:p@localhost:5432/bcs_l1?sslmode=disable')).toBe('bcs_l1')
    expect(databaseOf('postgresql://u:p@/bcs')).toBe('bcs')
    expect(databaseOf('postgresql:///bcs')).toBe('bcs')
    expect(databaseOf('postgresql://u:p@localhost:5432/')).toBeNull()
  })
})
