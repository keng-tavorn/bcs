import ExcelJS from 'exceljs'
import { beforeAll, describe, expect, it } from 'vitest'
import { getEnv } from '@/lib/env'
import { deriveSeedTotpSecret, totp } from '@/lib/totp'
import { auth } from '@/server/auth/auth'
import { resolveSession } from '@/server/auth/session'
import { STORED_ROLES } from '@/server/authz/permissions'
import { prisma } from '@/server/db/client'
import { loadOrgSettingsYaml, parseDemoOrgInput, seedDemoOrganization, type SeedReport } from '@/server/seed/demo-org'
import { INPUT_WORKBOOK_PATH, loadInputWorkbook } from '@/server/seed/workbook'

// S1-13: `pnpm db:seed` builds the demo organization of Appendix A from docs/inputs/BCS_inputs_v1_demo.xlsx (sheets Org
// and Users), creates nothing new when run again, and every seeded user signs in with the dev password. The expected
// numbers are counted here straight from the sheets, not taken from the loader under test.

const PASSWORD = 'seed-test-password-0001'
const TOTP_KEY = 'seed-test-totp-key-0000000000000001'

interface SheetCounts {
  readonly orgCode: string
  readonly users: ReadonlyArray<{ code: string; email: string; roles: string[]; positions: string[] }>
}

/** Org is a key/value sheet (column A key, column B value); Users is a table with keys on row 1 and data from row 3. */
async function countSheets(): Promise<SheetCounts> {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.readFile(INPUT_WORKBOOK_PATH)
  const org = workbook.getWorksheet('Org')!
  let orgCode = ''
  org.eachRow((row) => {
    if (String(row.getCell(1).value ?? '').trim() === 'code') orgCode = String(row.getCell(2).value ?? '').trim()
  })
  const sheet = workbook.getWorksheet('Users')!
  const header = (sheet.getRow(1).values as unknown[]).map((v) => String(v ?? '').trim())
  const col = (key: string) => header.indexOf(key)
  const users: Array<{ code: string; email: string; roles: string[]; positions: string[] }> = []
  for (let r = 3; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r)
    if (String(row.getCell(1).value ?? '').trim() === '') break
    const roles = String(row.getCell(col('roles')).value ?? '')
      .split(/[,;\s]+/)
      .map((s) => s.trim())
      .filter((s) => s && s !== 'REQUESTER')
    const positions = String(row.getCell(col('positions')).value ?? '')
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean)
    users.push({ code: String(row.getCell(col('code')).value ?? '').trim(), email: String(row.getCell(col('email')).value ?? '').trim().toLowerCase(), roles, positions })
  }
  return { orgCode, users }
}

async function seedOnce(): Promise<SeedReport> {
  const input = parseDemoOrgInput(await loadInputWorkbook(), loadOrgSettingsYaml())
  return seedDemoOrganization(input, { password: PASSWORD, totpKey: TOTP_KEY, now: new Date('2026-10-01T09:00:00+07:00') })
}

async function snapshot(orgId: string, emails: readonly string[]) {
  return {
    organizations: await prisma.organization.count({ where: { id: orgId } }),
    members: await prisma.member.count({ where: { organizationId: orgId } }),
    users: await prisma.user.count({ where: { email: { in: [...emails] } } }),
    roles: await prisma.roleAssignment.count({ where: { organizationId: orgId, revokedAt: null } }),
    modules: await prisma.orgModule.count({ where: { organizationId: orgId } }),
    events: await prisma.event.count({ where: { organizationId: orgId } }),
  }
}

let sheets: SheetCounts
let first: SeedReport
beforeAll(async () => {
  sheets = await countSheets()
  first = await seedOnce()
})

describe('[FR-PLT-001/AC1] pnpm db:seed creates the DEMO organization of Appendix A; running it again duplicates nothing', () => {
  it('creates one organization and one member per row of the Users sheet', async () => {
    expect(sheets.orgCode).not.toBe('')
    const org = await prisma.organization.findUniqueOrThrow({ where: { code: sheets.orgCode } })
    expect(org.id).toBe(first.organizationId)
    const emails = sheets.users.map((u) => u.email)
    const counts = await snapshot(org.id, emails)
    expect(counts).toMatchObject({ organizations: 1, members: sheets.users.length, users: sheets.users.length, modules: 1 })
    const members = await prisma.member.findMany({ where: { organizationId: org.id }, select: { email: true, status: true } })
    expect(members.map((m) => m.email).sort()).toEqual([...emails].sort())
    expect(new Set(members.map((m) => m.status))).toEqual(new Set(['ACTIVE']))
    expect(counts.roles).toBe(sheets.users.reduce((n, u) => n + u.roles.length, 0))
  })

  it('a second run reports and creates nothing new', async () => {
    const emails = sheets.users.map((u) => u.email)
    const before = await snapshot(first.organizationId, emails)
    const again = await seedOnce()
    expect(again).toMatchObject({
      organizationId: first.organizationId,
      organizationCreated: false,
      members: { created: 0, existing: sheets.users.length },
      rolesGranted: 0,
      twoFactorEnabled: 0,
    })
    expect(await snapshot(first.organizationId, emails)).toEqual(before)
  })
})

describe('[FR-PLT-007/AC1] the seed has users for every role of tier 1, and each signs in with the dev password', () => {
  it('covers every stored role and the requester (no role)', async () => {
    const assignments = await prisma.roleAssignment.findMany({ where: { organizationId: first.organizationId, revokedAt: null }, select: { role: true, memberId: true } })
    expect(new Set(assignments.map((a) => a.role))).toEqual(new Set(STORED_ROLES))
    const withRole = new Set(assignments.map((a) => a.memberId))
    const members = await prisma.member.findMany({ where: { organizationId: first.organizationId }, select: { id: true } })
    expect(members.some((m) => !withRole.has(m.id))).toBe(true)
  })

  it('signs every seeded user in to a member session; users whose role needs 2FA finish with their seeded code', async () => {
    const env = getEnv()
    const post = (path: string, body: unknown, cookie = '') =>
      auth.handler(
        new Request(`${env.BETTER_AUTH_URL}/api/auth${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: env.APP_URL, 'x-forwarded-for': '203.0.113.21', cookie },
          body: JSON.stringify(body),
        }),
      )
    const cookieOf = (res: Response) => res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
    expect(sheets.users.every((u) => u.code !== '')).toBe(true)
    for (const user of sheets.users) {
      const res = await post('/sign-in/email', { email: user.email, password: PASSWORD })
      expect(res.status, user.email).toBe(200)
      const body = (await res.json()) as { twoFactorRedirect?: boolean; user?: { email: string } }
      let cookie = cookieOf(res)
      // 2FA covers every stored role and every DOA position holder (FR-AUTH-002 AC1)
      if (user.roles.length > 0 || user.positions.length > 0) {
        expect(body.twoFactorRedirect, user.email).toBe(true)
        const verified = await post('/two-factor/verify-totp', { code: totp(deriveSeedTotpSecret(TOTP_KEY, user.code)) }, cookie)
        expect(verified.status, user.email).toBe(200)
        cookie = cookieOf(verified)
      } else {
        expect(body.user?.email, user.email).toBe(user.email)
      }
      const session = await resolveSession(new Headers({ cookie }))
      expect(session.kind, user.email).toBe('member')
    }
  })
})
