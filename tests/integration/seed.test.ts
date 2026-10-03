import ExcelJS from 'exceljs'
import { beforeAll, describe, expect, it } from 'vitest'
import { getEnv } from '@/lib/env'
import { deriveSeedTotpSecret, totp } from '@/lib/totp'
import { auth } from '@/server/auth/auth'
import { resolveSession } from '@/server/auth/session'
import { STORED_ROLES } from '@/server/authz/permissions'
import { prisma } from '@/server/db/client'
import { lintDoaVersion } from '@/core/doa'
import { orgSnapshotFromRows, versionSnapshotFromRows } from '@/server/doa/snapshot'
import { loadOrgSettingsYaml, parseDemoOrgInput, seedDemoOrganization, type SeedReport } from '@/server/seed/demo-org'
import { seedBudget } from '@/server/seed/budget'
import { parseOrgStructureInput, seedOrgStructure } from '@/server/seed/org-structure'
import { parseBudget } from '@/server/seed/sheets'
import { INPUT_WORKBOOK_PATH, loadInputWorkbook } from '@/server/seed/workbook'
import { loadYaml, versionSnapshots } from '../golden/doa-fixtures'

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

describe('[FR-PLT-007/AC3] the seed builds the organization structure and DOA version 1 of the §7.4 fixtures', () => {
  interface OrgFixture {
    departments: Array<{ code: string; nameTh: string; parent: string | null }>
    positions: Array<{ position: string; department: string; member: string }>
    members: Record<string, string>
  }
  const fixture = loadYaml<OrgFixture>('fixtures/org-demo.yaml')

  async function seedStructure() {
    const workbook = await loadInputWorkbook()
    const input = parseDemoOrgInput(workbook, loadOrgSettingsYaml())
    return seedOrgStructure(first.organizationId, input.users, parseOrgStructureInput(workbook), new Date('2026-10-01T09:00:00+07:00'))
  }

  it('has the fixture departments and position holders; demo-only users hold no position; a second run adds nothing', async () => {
    await seedStructure()
    const orgId = first.organizationId
    const departments = await prisma.department.findMany({ where: { organizationId: orgId }, select: { id: true, code: true, nameTh: true, parentId: true } })
    const codeOf = new Map(departments.map((d) => [d.id, d.code]))
    expect(departments.map((d) => ({ code: d.code, nameTh: d.nameTh, parent: d.parentId ? codeOf.get(d.parentId)! : null })).sort((a, b) => a.code.localeCompare(b.code))).toEqual(
      [...fixture.departments].sort((a, b) => a.code.localeCompare(b.code)),
    )
    const holders = await prisma.positionAssignment.findMany({
      where: { organizationId: orgId, validTo: null },
      select: { position: { select: { code: true } }, departmentId: true, member: { select: { employeeCode: true } } },
    })
    const key = (h: { position: string; department: string; member: string }) => `${h.position}@${h.department}=${h.member}`
    expect(holders.map((h) => key({ position: h.position.code, department: codeOf.get(h.departmentId)!, member: h.member.employeeCode! })).sort()).toEqual(fixture.positions.map(key).sort())
    const members = await prisma.member.findMany({ where: { organizationId: orgId }, select: { employeeCode: true, primaryDepartmentId: true } })
    for (const [code, department] of Object.entries(fixture.members)) {
      expect(codeOf.get(members.find((m) => m.employeeCode === code)!.primaryDepartmentId!), code).toBe(department)
    }
    expect(await seedStructure()).toEqual({ departments: 0, positions: 0, assignments: 0, doaVersions: 0, requestTypes: 0, forms: 0, holidays: 0 })
  })

  it('publishes DOA version 1 with the fixture rules and policy; only effectiveFrom differs (2026-01-01, ADR-038), and it passes the full lint', async () => {
    await seedStructure()
    const orgId = first.organizationId
    const row = await prisma.doaVersion.findFirstOrThrow({ where: { organizationId: orgId, versionNo: 1 } })
    const rules = await prisma.doaRule.findMany({ where: { organizationId: orgId, doaVersionId: row.id }, orderBy: { code: 'asc' } })
    const seeded = versionSnapshotFromRows(row, rules)
    const golden = versionSnapshots().find((v) => v.versionNo === 1)!
    const withoutText = (rs: typeof seeded.rules) => [...rs].map(({ descriptionTh: _d, ...r }) => r).sort((a, b) => a.code.localeCompare(b.code))
    expect(withoutText(seeded.rules)).toEqual(withoutText(golden.rules))
    expect({ ...seeded, id: '', rules: [], effectiveFrom: null }).toEqual({ ...golden, id: '', rules: [], effectiveFrom: null })
    expect(seeded.effectiveFrom.toISOString()).toBe('2025-12-31T17:00:00.000Z')
    expect(row).toMatchObject({ status: 'PUBLISHED', stepUpThresholdSatang: 10_000_000n, sodPolicy: { approverMayReceive: false, requesterMayReceive: true } })
    // The seeded structure lets every governance rule find its approver (BR-DOA-08), as pnpm verify checks too
    const departments = await prisma.department.findMany({ where: { organizationId: orgId } })
    const holders = await prisma.positionAssignment.findMany({ where: { organizationId: orgId }, include: { position: true } })
    const members = await prisma.member.findMany({ where: { organizationId: orgId } })
    const org = orgSnapshotFromRows({
      departments,
      holders: holders.map((h) => ({ positionCode: h.position.code, departmentId: h.departmentId, memberId: h.memberId, validFrom: h.validFrom, validTo: h.validTo })),
      members,
    })
    expect(lintDoaVersion(seeded, org, new Date('2026-10-01T02:00:00Z')).errors).toEqual([])
  })

  it('loads the five request types and the holidays used by the SLA cases', async () => {
    await seedStructure()
    const types = await prisma.requestType.findMany({ where: { organizationId: first.organizationId }, orderBy: { sortOrder: 'asc' } })
    expect(types.map((t) => [t.code, t.documentType])).toEqual([
      ['BUY_GOODS', 'PURCHASE_REQUEST'],
      ['HIRE_SERVICE', 'PURCHASE_REQUEST'],
      ['CONTRACT_WORK', 'PURCHASE_REQUEST'],
      ['IT_PURCHASE', 'PURCHASE_REQUEST'],
      ['NEW_SUPPLIER', 'SUPPLIER_REQUEST'],
    ])
    // Each type has version 1 of its form (prisma/seed/forms.yaml) published and in use
    const forms = await prisma.formVersion.findMany({ where: { organizationId: first.organizationId }, include: { requestType: true } })
    expect(forms.map((f) => [f.requestType.code, f.versionNo, f.status]).sort()).toEqual(types.map((t) => [t.code, 1, 'PUBLISHED']).sort())
    expect(types.every((t) => forms.some((f) => f.id === t.currentFormVersionId))).toBe(true)
    expect(await prisma.event.count({ where: { organizationId: first.organizationId, type: 'form_version.published' } })).toBe(types.length)
    const holidays = await prisma.holiday.findMany({ where: { organizationId: first.organizationId } })
    expect(holidays.map((h) => h.date.toISOString().slice(0, 10))).toEqual(expect.arrayContaining(['2026-10-13', '2026-10-23']))
  })
})

describe('[FR-BUD-001/AC2] the seed funds the budget lines of the Budget sheet through the ledger', () => {
  /** planned of every row of the Budget sheet, summed here from the cells (baht text → satang) */
  async function sheetTotal(): Promise<{ lines: number; satang: bigint }> {
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.readFile(INPUT_WORKBOOK_PATH)
    const sheet = workbook.getWorksheet('Budget')!
    const header = (sheet.getRow(1).values as unknown[]).map((v) => String(v ?? '').trim())
    let lines = 0
    let satang = 0n
    for (let r = 3; r <= sheet.rowCount; r++) {
      const row = sheet.getRow(r)
      if (!String(row.getCell(1).value ?? '').trim()) break
      const [whole, fraction = ''] = String(row.getCell(header.indexOf('planned')).value).split('.')
      satang += BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0'))
      lines++
    }
    return { lines, satang }
  }

  it('adds up to the sheet, line by line and in all, and a second run adds nothing', async () => {
    const workbook = await loadInputWorkbook()
    const input = parseDemoOrgInput(workbook, loadOrgSettingsYaml())
    await seedOrgStructure(first.organizationId, input.users, parseOrgStructureInput(workbook), new Date('2026-10-01T09:00:00+07:00'))
    const report = await seedBudget(first.organizationId, parseBudget(workbook), new Date('2026-10-01T09:00:00+07:00'))
    const expected = await sheetTotal()
    const lines = await prisma.budgetLine.findMany({ where: { organizationId: first.organizationId }, include: { balance: true } })
    expect(lines).toHaveLength(expected.lines)
    expect(lines.reduce((s, l) => s + l.plannedSatang, 0n)).toBe(expected.satang)
    expect(lines.reduce((s, l) => s + (l.balance?.availableSatang ?? 0n), 0n)).toBe(expected.satang)
    const ledger = await prisma.budgetLedgerEntry.findMany({ where: { organizationId: first.organizationId } })
    expect(ledger.every((e) => e.fromBucket === 'OUTSIDE' && e.toBucket === 'AVAILABLE')).toBe(true)
    expect(ledger.reduce((s, e) => s + e.amountSatang, 0n)).toBe(expected.satang)
    expect(report.lines === expected.lines || report.lines === 0).toBe(true)
    expect(await seedBudget(first.organizationId, parseBudget(workbook), new Date('2026-10-01T09:00:00+07:00'))).toEqual({ fiscalYears: 0, costCenters: 0, lines: 0 })
    const fy = await prisma.fiscalYear.findFirstOrThrow({ where: { organizationId: first.organizationId, code: 'FY2569' } })
    expect([fy.startsOn.toISOString().slice(0, 10), fy.endsOn.toISOString().slice(0, 10)]).toEqual(['2026-01-01', '2026-12-31'])
  })
})
