import { randomUUID } from 'node:crypto'
import ExcelJS from 'exceljs'
import { satangToAmount } from '@/core/money/dto'
import { systemClock } from '@/lib/clock'
import { deriveSeedTotpSecret } from '@/lib/totp'
import { enableTotpWithSecret, upsertUserWithPassword } from '@/server/auth/provision'
import { makeCtx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { BUDGET_IMPORT_COLUMNS, buildBudgetImportTemplate, importBudget } from '@/server/services/budget/import'
import { grantRole } from '@/server/services/members/roles'

// Room on a budget line of the demo organization, for the scene scripts of the e2e database (budget-room-scene.ts,
// liff-requests-scene.ts, request-form-scene.ts, receiving-scene.ts, liff-budget-scene.ts). Both Playwright projects and
// many specs spend the same budget lines in one database (tests/e2e/prepare-db.ts seeds it once per run), so by the time
// a test runs its line may have less left than the test asks for. Then the line is topped up as an administrator does
// it: a BUDGET_ADMIN made for the purpose (a fresh member of FIN with the TOTP every role holder of the seed has, given
// the role by the seed's ORG_ADMIN through the members service) imports the missing amount onto the line through the
// budget import — a known code adds to its line, OUTSIDE → AVAILABLE, with its own event (FR-BUD-001 AC2) — never by
// writing a balance. A line with room is left as it is.

const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const must = <T,>(what: string, r: { ok: true; data: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(`${what} failed: ${JSON.stringify(r.error)}`)
  return r.data
}

export interface Room {
  readonly code: string
  readonly budgetLineId: string
  /** What the line has left now, in satang */
  readonly available: bigint
  /** What the import added, in satang (0 when the line had room) */
  readonly added: bigint
}

const demoOrganization = () => prisma.organization.findFirstOrThrow({ where: { code: 'DEMO' }, select: { id: true, timezone: true } })

/** The line `code` a new request takes on `now`: open, in the fiscal year open that day (a calendar day in the organization's time zone) */
async function openLine(org: { id: string; timezone: string }, code: string, now: Date) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: org.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
  const day = new Date(`${today}T00:00:00Z`)
  return prisma.budgetLine.findFirstOrThrow({
    where: { organizationId: org.id, code, status: 'OPEN', fiscalYear: { status: 'OPEN', startsOn: { lte: day }, endsOn: { gte: day } } },
    select: { id: true, code: true, nameTh: true, accountCode: true, fiscalYear: { select: { code: true } }, department: { select: { code: true } }, costCenter: { select: { code: true } } },
  })
}

const availableOn = async (budgetLineId: string) => (await prisma.budgetLineBalance.findUniqueOrThrow({ where: { budgetLineId }, select: { availableSatang: true } })).availableSatang

/** The demo organization's budget line `code` in the open fiscal year of today has at least `needSatang` left */
export async function makeRoom(code: string, needSatang: bigint): Promise<Room> {
  const now = systemClock.now()
  const org = await demoOrganization()
  const memberCtx = (memberId: string) => makeCtx({ organizationId: org.id, actor: { type: 'USER', memberId }, channel: 'WEB', now })
  const line = await openLine(org, code, now)

  const missing = needSatang - (await availableOn(line.id))
  if (missing > 0n) {
    const password = process.env.SEED_DEV_PASSWORD
    const totpKey = process.env.SEED_TOTP_KEY
    if (!password || !totpKey) throw new Error('SEED_DEV_PASSWORD and SEED_TOTP_KEY are needed to make a budget admin')
    const adminCode = `e2e-roomadm-${randomUUID().slice(0, 8)}`
    const nameTh = 'ผู้ดูแลงบ ทดสอบเติมงบ'
    const email = `${adminCode}@demo.bcs.local`
    const fin = await prisma.department.findFirstOrThrow({ where: { organizationId: org.id, code: 'FIN' }, select: { id: true } })
    const userId = await upsertUserWithPassword({ email, name: nameTh, password })
    const budgetAdmin = await prisma.member.create({
      data: { organizationId: org.id, userId, email, displayNameTh: nameTh, employeeCode: adminCode, status: 'ACTIVE', primaryDepartmentId: fin.id },
      select: { id: true },
    })
    await enableTotpWithSecret(userId, deriveSeedTotpSecret(totpKey, adminCode), [])
    const orgAdmin = await prisma.member.findFirstOrThrow({ where: { organizationId: org.id, employeeCode: 'admin' }, select: { id: true } })
    must('grant BUDGET_ADMIN', await grantRole(memberCtx(orgAdmin.id), { memberId: budgetAdmin.id, role: 'BUDGET_ADMIN' }, key()))

    // The import template with one row: the line's own year, department, cost center and code, and the missing amount
    const labels = Object.fromEntries(BUDGET_IMPORT_COLUMNS.map((c) => [c, c])) as Record<(typeof BUDGET_IMPORT_COLUMNS)[number], string>
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load(new Uint8Array(await buildBudgetImportTemplate(labels)).buffer as ArrayBuffer)
    workbook.getWorksheet('Budget')!.addRow([line.fiscalYear.code, line.department.code, line.costCenter.code, line.code, line.nameTh, line.accountCode ?? '', satangToAmount(missing)])
    const bytes = new Uint8Array((await workbook.xlsx.writeBuffer()) as ArrayBuffer).slice().buffer as ArrayBuffer
    // Two top-ups of the same amount in the same second write the same bytes: the administrator confirms adding it again
    // (FR-BUD-001 AC3), as the line needs it
    must('import', await importBudget(memberCtx(budgetAdmin.id), { bytes, fileName: `${line.code}-${adminCode}.xlsx` }, { ...key(), confirmDuplicate: true }))
  }
  const available = await availableOn(line.id)
  if (available < needSatang) throw new Error(`${line.code} has ${satangToAmount(available)} left after the import, not ${satangToAmount(needSatang)}`)
  return { code: line.code, budgetLineId: line.id, available, added: missing > 0n ? missing : 0n }
}

/**
 * The first of the demo organization's budget lines `codes` (open, in the open fiscal year of today) with at least
 * `needSatang` left, as a requester picks a line that still has the money; when none of them has, the first is topped up
 * through the budget import (makeRoom). A line with room is never changed.
 */
export async function lineWithRoom(codes: readonly [string, ...string[]], needSatang: bigint): Promise<{ id: string; code: string }> {
  const now = systemClock.now()
  const org = await demoOrganization()
  for (const code of codes) {
    const line = await openLine(org, code, now)
    if ((await availableOn(line.id)) >= needSatang) return { id: line.id, code: line.code }
  }
  const room = await makeRoom(codes[0], needSatang)
  return { id: room.budgetLineId, code: room.code }
}
