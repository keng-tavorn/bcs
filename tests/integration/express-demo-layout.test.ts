import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import type { OrgSettings } from '@/lib/org-settings'
import { makeCtx, type Ctx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { loadOrgSettingsYaml, parseDemoOrgInput, seedDemoOrganization, type DemoOrgInput } from '@/server/seed/demo-org'
import { loadInputWorkbook, type InputWorkbook, type SheetRow } from '@/server/seed/workbook'
import { exportExpress } from '@/server/services/exports/express'
import { getExportOverview } from '@/server/services/exports/view'

// S4-09 (spec §7.13, BR-EXP-01, OQ-10, ADR-011): nobody guesses the Express file layout. The demo organization takes it
// from the express.* rows of sheet Settings in the inputs file, through the seed itself (parseDemoOrgInput, then
// seedDemoOrganization, as prisma/seed.ts runs them). The file as shipped has no column rows until the customer's
// sample import file arrives: the seeded organization has an empty mapping, the export screen shows no layout, and
// FINANCE's export is refused with MAPPING_NOT_SET before anything is written. When the person filling in the workbook
// adds rows after the last row of the sheet, the seeded organization has exactly the layout those rows give; a field
// name the system does not know stops the seed with a Thai message naming the row. Each organization is seeded from
// the real inputs file and settings file under its own code and e-mail addresses, so it never meets the one
// tests/integration/seed.test.ts seeds at the same time.

const NOW = new Date('2026-10-05T03:00:00Z')
const PASSWORD = 'express-test-password-0001'
/** Rows of the Express layout's columns, and every row of the layout, whatever their case (the reader takes them all) */
const COLUMN_ROW = /^express\.column\./i
const EXPRESS_ROW = /^express\./i

type Row = readonly [key: string, value: string]

/** `workbook` with sheet Settings made of `settings`, its other sheets as they are */
function withSettings(workbook: InputWorkbook, settings: readonly SheetRow[]): InputWorkbook {
  return {
    hasSheet: (sheet) => sheet === 'Settings' || workbook.hasSheet(sheet),
    table: (sheet) => (sheet === 'Settings' ? [...settings] : workbook.table(sheet)),
    keyValues: (sheet) => {
      if (sheet !== 'Settings') return workbook.keyValues(sheet)
      return new Map(settings.filter((r) => r.values.key).map(({ row, values }) => [values.key!, { value: values.value ?? null, row }]))
    },
  }
}

/** The inputs file as shipped: sheet Settings without express.column rows (a person may add some to try the export) */
function asShipped(workbook: InputWorkbook): InputWorkbook {
  return withSettings(workbook, workbook.table('Settings').filter((r) => !COLUMN_ROW.test(r.values.key ?? '')))
}

/** The first row a person adds: the one after the last row of sheet Settings (the sheet ends at its first empty row) */
function firstAddedRow(workbook: InputWorkbook): number {
  return Math.max(2, ...workbook.table('Settings').map((r) => r.row)) + 1
}

/**
 * The inputs file with the Express rows of sheet Settings replaced by `rows`, written after the sheet's last row as a
 * person adds them in Excel. The layout is then exactly what these rows say, whatever the sheet holds today.
 */
function withExpressRows(workbook: InputWorkbook, rows: readonly Row[]): InputWorkbook {
  const first = firstAddedRow(workbook)
  const kept = workbook.table('Settings').filter((r) => !EXPRESS_ROW.test(r.values.key ?? ''))
  const added = rows.map(([key, value], i): SheetRow => ({ row: first + i, values: { key, value, labelTh: 'เพิ่มในเทสต์ (ไม่ใช่รูปแบบไฟล์ Express จริง)', ref: 'OQ-10' } }))
  return withSettings(workbook, [...kept, ...added])
}

/** The demo organization of `workbook` under its own code, its users under their own addresses; FINANCE's context */
async function seedAs(workbook: InputWorkbook, code: string, emailPrefix: string): Promise<{ organizationId: string; finance: Ctx }> {
  const input = parseDemoOrgInput(workbook, loadOrgSettingsYaml())
  const own: DemoOrgInput = { ...input, org: { ...input.org, code }, users: input.users.map((u) => ({ ...u, email: `${emailPrefix}${u.email}` })) }
  const { organizationId } = await seedDemoOrganization(own, { password: PASSWORD, now: NOW })
  const user = own.users.find((u) => u.storedRoles.includes('FINANCE'))
  if (!user) throw new Error('sheet Users has no FINANCE member')
  const member = await prisma.member.findFirstOrThrow({ where: { organizationId, email: user.email }, select: { id: true } })
  return { organizationId, finance: makeCtx({ organizationId, actor: { type: 'USER', memberId: member.id }, channel: 'WEB', now: NOW }) }
}

const storedExpress = async (organizationId: string) =>
  ((await prisma.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { settings: true } })).settings as { express: unknown }).express

const exportNow = (finance: Ctx) => exportExpress(finance, {}, { idempotencyKey: randomUUID(), sender: null })

let workbook: InputWorkbook

beforeAll(async () => {
  workbook = await loadInputWorkbook()
})

describe('[FR-P2P-009/AC1] the demo organization has no Express layout until the customer’s sample file arrives (S4-09, OQ-10)', () => {
  let organizationId: string
  let finance: Ctx

  beforeAll(async () => {
    ;({ organizationId, finance } = await seedAs(asShipped(workbook), 'DEMO-EXPRESS', 'express.'))
  })

  it('is seeded with an empty mapping: the screen shows no layout and FINANCE’s export is refused with MAPPING_NOT_SET, writing nothing', async () => {
    expect(await storedExpress(organizationId)).toMatchObject({ mapping: [] })
    expect(await getExportOverview(finance)).toMatchObject({ ok: true, data: { layout: null } })
    expect(await exportNow(finance)).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'MAPPING_NOT_SET' } } })
    expect(await prisma.exportJob.count({ where: { organizationId } })).toBe(0)
    expect(await prisma.fileObject.count({ where: { organizationId } })).toBe(0)
    expect(await prisma.event.count({ where: { organizationId, type: 'export.generated' } })).toBe(0)
  })
})

describe('[FR-P2P-009/AC1] the seed takes the Express layout a person writes in sheet Settings, never a guess (S4-09, BR-EXP-01)', () => {
  // Out of key order on purpose, and every value unlike the settings file's (xlsx, UTF-8-BOM, BE), so each one is seen
  // to come from the sheet
  const ADDED: readonly Row[] = [
    ['express.column.02', 'วันที่=invoiceDate'],
    ['express.column.01', 'เลขที่=invoiceNo'],
    ['express.fileType', 'csv'],
    ['express.encoding', 'WINDOWS-874'],
    ['express.dateFormat', 'CE'],
  ]
  const EXPECTED: OrgSettings['express'] = {
    fileType: 'csv',
    encoding: 'WINDOWS-874',
    dateFormat: 'CE',
    mapping: [
      { header: 'เลขที่', field: 'invoiceNo' },
      { header: 'วันที่', field: 'invoiceDate' },
    ],
  }

  it('reads the rows added after the last row of the sheet: the columns in the order of their keys, then the file type, encoding and date format', () => {
    expect(parseDemoOrgInput(withExpressRows(workbook, ADDED), loadOrgSettingsYaml()).settings.express).toEqual(EXPECTED)
  })

  it('seeds the organization with that layout: the screen shows its columns and the export no longer waits for one', async () => {
    const { organizationId, finance } = await seedAs(withExpressRows(workbook, ADDED), 'DEMO-EXP-ROWS', 'express-rows.')
    expect(await storedExpress(organizationId)).toEqual(EXPECTED)
    expect(await getExportOverview(finance)).toMatchObject({
      ok: true,
      data: { layout: { fileType: 'csv', encoding: 'WINDOWS-874', dateFormat: 'CE', columns: EXPECTED.mapping, needsVendorCode: false } },
    })
    // Nothing is waiting in the new organization: the export says so instead of MAPPING_NOT_SET
    expect(await exportNow(finance)).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'NOTHING_TO_EXPORT' } } })
  })

  it('stops the seed with a Thai message naming the row for a field name it does not know', () => {
    const wrong = withExpressRows(workbook, [['express.column.01', 'เลขที่=invoiceNumber']])
    expect(() => parseDemoOrgInput(wrong, loadOrgSettingsYaml())).toThrow(
      new RegExp(`^ชีต Settings แถว ${firstAddedRow(workbook)} \\(express\\.column\\.01\\): "invoiceNumber" ไม่ใช่ชื่อข้อมูลที่ระบบรู้จัก`),
    )
  })
})
