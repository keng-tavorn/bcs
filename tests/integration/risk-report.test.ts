import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '@/server/db/client'
import { setDefaultOutboxSender } from '@/server/events/outbox'
import { exportReport, riskReport, runReport } from '@/server/services/reports'
import { reportCatalog } from '@/server/services/reports/screens'
import type { DoaOrg } from '../support/doa-org'
import { createP2Org } from '../support/p2-org'

// S11-11 (FR-RSK-204 AC2 AC3 · BR-RSK-15 · §11.4 G-9) against Postgres: /reports/risk counts the suppliers whose first PO
// (by submittedAt, a cancelled PO aside) was sent in the period and met the gate at HIGH — the gate of the PO's first
// po.risk_gate_passed of trigger SUBMIT, else PurchaseOrder.riskGate — and of them the ones that passed with an
// assessment (an override counts below the line only): GC-RSK-69's 4 of 5 = 8000 bp. A supplier with an earlier PO,
// a MEDIUM gate and a PO without a gate are not counted. Beside it, as of now: suppliers by tier with "never assessed"
// apart from LOW, assessments open past applicationEscalateBusinessDays, OVERDUE suppliers, overrides open, expired
// and used, registry flags. A head reads the suppliers their departments have a PO with; a member without report.view
// is refused; an organization without RISK has no such report. The Excel file has the G-9 rows and a checksum.

const NOW = new Date('2026-11-02T03:00:00Z')
const PERIOD = { from: '2026-10-01', to: '2026-10-31' }
const at = new Date('2025-01-01T00:00:00+07:00')
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
let org: DoaOrg
let conLine: string
let otherLine: string
const sup: Record<string, string> = {}
let poSeq = 0

async function supplier(code: string, extra: Record<string, unknown> = {}) {
  sup[code] = (await prisma.supplier.create({ data: { organizationId: org.organizationId, code, nameTh: `ผู้ขาย ${code}`, isForeign: true, ...extra } })).id
  return sup[code]
}

type Gate = { tier: 'LOW' | 'MEDIUM' | 'HIGH'; source: 'NOT_REQUIRED' | 'ASSESSMENT' | 'OVERRIDE'; trigger: 'SUBMIT' | 'SEND' }
/** A PO written directly (G-9 only reads POs, their gate and its events), with one line on a department's budget */
async function po(code: string, submittedAt: string, options: { status?: 'SENT' | 'CANCELLED'; stored?: Gate; events?: Gate[]; line?: string } = {}) {
  poSeq++
  const net = 100_000n
  const row = await prisma.purchaseOrder.create({
    data: {
      organizationId: org.organizationId,
      number: `PO-2569-${String(7000 + poSeq).padStart(5, '0')}`,
      status: options.status ?? 'SENT',
      supplierId: sup[code]!,
      netSatang: net,
      vatSatang: 7_000n,
      grossSatang: 107_000n,
      vatRateBp: 700,
      submittedAt: new Date(submittedAt),
      ...(options.stored ? { riskGate: { ...options.stored, assessmentId: null, overrideId: null, at: submittedAt, warnings: [] } } : {}),
    },
  })
  await prisma.poLine.create({ data: { organizationId: org.organizationId, poId: row.id, lineNo: 1, description: 'ของ', quantity: '1', uom: 'ชิ้น', unitPriceSatang: net, netSatang: net, budgetLineId: options.line ?? otherLine } })
  for (const g of options.events ?? []) {
    await prisma.event.create({
      data: {
        organizationId: org.organizationId,
        type: 'po.risk_gate_passed',
        aggregateType: 'PurchaseOrder',
        aggregateId: row.id,
        occurredAt: new Date(submittedAt),
        actorType: 'USER',
        actorMemberId: org.member.proc_officer!,
        channel: 'WEB',
        correlationId: randomUUID(),
        requestId: randomUUID(),
        schemaVersion: 1,
        data: { tier: g.tier, inherentTier: g.tier, source: g.source, trigger: g.trigger, assessmentId: null, overrideId: null, warnings: [], grossSatang: '107000', reasonCommentId: null },
      },
    })
  }
  return row.id
}

const HIGH_ASSESSED: Gate = { tier: 'HIGH', source: 'ASSESSMENT', trigger: 'SUBMIT' }

beforeAll(async () => {
  setDefaultOutboxSender(null)
  org = await createP2Org()
  await prisma.orgModule.create({ data: { organizationId: org.organizationId, module: 'RISK', enabled: true, enabledAt: at, contractRef: 'TEST-P2', reason: 'องค์กรทดสอบระยะ 2' } })
  conLine = (await prisma.budgetLine.findFirstOrThrow({ where: { organizationId: org.organizationId, code: 'CON-OPEX-2569' } })).id
  otherLine = (await prisma.budgetLine.findFirstOrThrow({ where: { organizationId: org.organizationId, code: { not: 'CON-OPEX-2569' } } })).id

  // G-9's five HIGH suppliers: four assessed, one by override (GC-RSK-69's 4 of 5)
  await supplier('G9-A', { riskTier: 'HIGH', riskStatus: 'CURRENT' })
  // the SUBMIT event says ASSESSMENT; the stored gate was overwritten at po.send by an override: the SUBMIT one counts
  await po('G9-A', '2026-10-05T03:00:00Z', { line: conLine, stored: { tier: 'HIGH', source: 'OVERRIDE', trigger: 'SEND' }, events: [HIGH_ASSESSED, { tier: 'HIGH', source: 'OVERRIDE', trigger: 'SEND' }] })
  await supplier('G9-B', { riskTier: 'HIGH', riskStatus: 'CURRENT' })
  await po('G9-B', '2026-10-06T03:00:00Z', { stored: HIGH_ASSESSED }) // no event (written before the gate's event): the stored gate
  await supplier('G9-C', { riskTier: 'HIGH', riskStatus: 'CURRENT' })
  await po('G9-C', '2026-10-07T03:00:00Z', { events: [HIGH_ASSESSED] })
  await po('G9-C', '2026-10-20T03:00:00Z', { events: [{ tier: 'HIGH', source: 'OVERRIDE', trigger: 'SUBMIT' }] }) // a later PO: not its first
  await supplier('G9-D', { riskTier: 'HIGH', riskStatus: 'CURRENT' })
  await po('G9-D', '2026-10-02T03:00:00Z', { status: 'CANCELLED', events: [{ tier: 'HIGH', source: 'OVERRIDE', trigger: 'SUBMIT' }] }) // cancelled: not counted
  await po('G9-D', '2026-10-09T03:00:00Z', { events: [HIGH_ASSESSED] })
  await supplier('G9-E', { riskTier: 'MEDIUM', riskStatus: 'CURRENT' }) // HIGH at the gate from the PO's own screening
  await po('G9-E', '2026-10-12T03:00:00Z', { events: [{ tier: 'HIGH', source: 'OVERRIDE', trigger: 'SUBMIT' }] })
  // not in the denominator: a MEDIUM gate, a first PO before the period, a PO without a gate
  await supplier('NO-MED', { riskTier: 'MEDIUM', riskStatus: 'CURRENT' })
  await po('NO-MED', '2026-10-13T03:00:00Z', { events: [{ tier: 'MEDIUM', source: 'NOT_REQUIRED', trigger: 'SUBMIT' }] })
  await supplier('NO-OLD', { riskTier: 'HIGH', riskStatus: 'CURRENT' })
  await po('NO-OLD', '2026-09-20T03:00:00Z', { events: [HIGH_ASSESSED] })
  await po('NO-OLD', '2026-10-14T03:00:00Z', { events: [{ tier: 'HIGH', source: 'OVERRIDE', trigger: 'SUBMIT' }] })
  await supplier('NO-GATE')
  await po('NO-GATE', '2026-10-15T03:00:00Z')

  // as of now: an OVERDUE supplier, a flagged one, overrides
  await supplier('LATE', { riskTier: 'LOW', riskStatus: 'OVERDUE', riskValidUntil: new Date('2026-09-30') })
  await supplier('FLAG', { registryFlag: 'CEASED', registryFlaggedAt: new Date('2026-10-20T03:00:00Z') })
  const override = (number: string, status: 'APPROVED' | 'EXPIRED', expiresOn: string, usedCount: number) =>
    prisma.riskOverride.create({
      data: { organizationId: org.organizationId, number, supplierId: sup['G9-E']!, reason: 'งานด่วนต้องสั่งก่อนประเมินเสร็จ', capGrossSatang: 1_000_000n, usedCount, usedGrossSatang: BigInt(usedCount) * 107_000n, expiresOn: new Date(expiresOn), requestedById: org.member.proc_officer!, submittedAt: at, decidedAt: at, status },
    })
  await override('RO-T-00001', 'APPROVED', '2026-12-01', 1)
  await override('RO-T-00002', 'APPROVED', '2026-11-01', 0) // past its last day, the daily job not run yet: expired
  await override('RO-T-00003', 'EXPIRED', '2026-10-01', 2)
})

const ok = <T>(r: { ok: true; data: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.data
}

describe('[FR-RSK-204/AC2] G-9 and the risk report on /reports/risk (S11-11 · BR-RSK-15)', () => {
  it('[GC-RSK-69] 4 of the 5 HIGH suppliers whose first PO was sent in October passed with an assessment: 8000 bp', async () => {
    const r = ok(await riskReport(org.ctxOf('proc_officer', NOW), PERIOD))
    expect(r.scope).toBe('ORG')
    expect({ bp: r.g9.bp, numerator: r.g9.numerator, denominator: r.g9.denominator }).toEqual({ bp: 8000, numerator: 4, denominator: 5 })
    expect(r.g9.rows.map((x) => [x.supplierCode, x.source])).toEqual([
      ['G9-A', 'ASSESSMENT'],
      ['G9-B', 'ASSESSMENT'],
      ['G9-C', 'ASSESSMENT'],
      ['G9-D', 'ASSESSMENT'],
      ['G9-E', 'OVERRIDE'],
    ])
  })

  it('[GC-RSK-71] a period without a HIGH first PO: no figure', async () => {
    const r = ok(await riskReport(org.ctxOf('proc_officer', NOW), { from: '2026-08-01', to: '2026-08-31' }))
    expect(r.g9).toEqual({ bp: null, numerator: 0, denominator: 0, rows: [] })
  })

  it('by tier with "never assessed" apart from LOW; overdue, overrides open/expired/used and registry flags as of now', async () => {
    const r = ok(await riskReport(org.ctxOf('proc_officer', NOW), PERIOD))
    expect(r.tiers).toEqual([
      { tier: 'HIGH', suppliers: 5 },
      { tier: 'MEDIUM', suppliers: 2 },
      { tier: 'LOW', suppliers: 1 },
      { tier: null, suppliers: 2 },
    ])
    expect(r.overdue.map((s) => [s.code, s.validUntil])).toEqual([['LATE', '2026-09-30']])
    expect(r.flagged.map((s) => [s.code, s.registryFlag])).toEqual([['FLAG', 'CEASED']])
    expect({ open: r.overrides.open, expired: r.overrides.expired, used: r.overrides.used }).toEqual({ open: 1, expired: 2, used: 2 })
    expect(r.overrides.rows.find((o) => o.number === 'RO-T-00001')).toMatchObject({ status: 'OPEN', usedCount: 1, usedGrossSatang: 107_000n, requestedBy: expect.any(String) })
  })

  it('an assessment open past applicationEscalateBusinessDays is pending; a fresh one is not', async () => {
    const q = await prisma.riskQuestionnaire.create({ data: { organizationId: org.organizationId, code: 'RQ-RPT', versionNo: 1, status: 'PUBLISHED', effectiveFrom: at, submittedById: org.member.admin!, submittedAt: at, publishedById: org.member.admin2!, publishedAt: at, checksum: 'test' } })
    const open = (supplierId: string, createdAt: string) =>
      prisma.riskAssessment.create({
        data: { organizationId: org.organizationId, supplierId, questionnaireId: q.id, screening: { processesPersonalData: 'Y', accessesSystems: 'N', accessesPremises: 'N' }, categoryCodes: [], payeeType: 'JURISTIC', workScopes: [], inherentTier: 'HIGH', lastActivityAt: new Date(createdAt), openedById: org.member.proc_officer!, createdAt: new Date(createdAt) },
      })
    const old = await open(sup['NO-GATE']!, '2026-10-01T03:00:00Z')
    await open(sup.FLAG!, '2026-10-30T03:00:00Z')
    const r = ok(await riskReport(org.ctxOf('proc_officer', NOW), PERIOD))
    expect(r.pending.map((p) => p.assessmentId)).toEqual([old.id])
  })

  it('[FR-VIS-002/AC3] a head reads the suppliers their departments have a PO with; a member without report.view is refused', async () => {
    const head = ok(await riskReport(org.ctxOf('dm_con', NOW), PERIOD))
    expect(head.scope).toBe('DEPT')
    expect({ bp: head.g9.bp, rows: head.g9.rows.map((x) => x.supplierCode) }).toEqual({ bp: 10000, rows: ['G9-A'] })
    expect(head.tiers).toEqual([
      { tier: 'HIGH', suppliers: 1 },
      { tier: 'MEDIUM', suppliers: 0 },
      { tier: 'LOW', suppliers: 0 },
      { tier: null, suppliers: 0 },
    ])
    expect([head.overdue, head.flagged, head.overrides.rows, head.pending]).toEqual([[], [], [], []])
    expect(await riskReport(org.ctxOf('req_con', NOW), PERIOD)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await riskReport(org.ctxOf('proc_officer', NOW), { from: '2026-10-31', to: 'x' })).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
  })

  it('[FR-RSK-204/AC3] the Excel report RSK_G9 has the G-9 rows and a checksum; it is offered only where RISK is on', async () => {
    const file = ok(await runReport(org.ctxOf('proc_officer', NOW), 'RSK_G9', PERIOD))
    expect(file.rows.map((x) => [x.supplierCode, x.source, x.counted])).toEqual([
      ['G9-A', 'ASSESSMENT', 'ใช่'],
      ['G9-B', 'ASSESSMENT', 'ใช่'],
      ['G9-C', 'ASSESSMENT', 'ใช่'],
      ['G9-D', 'ASSESSMENT', 'ใช่'],
      ['G9-E', 'OVERRIDE', 'ไม่'],
    ])
    const exported = ok(await exportReport(org.ctxOf('proc_officer', NOW), { reportCode: 'RSK_G9', params: PERIOD, format: 'xlsx' }, key()))
    expect(exported.rowCount).toBe(5)
    expect(exported.checksum).toMatch(/^[0-9a-f]{64}$/)
    const catalog = ok(await reportCatalog(org.ctxOf('proc_officer', NOW)))
    expect(catalog.reports.map((r) => r.code)).toContain('RSK_G9')

    const off = await createP2Org()
    expect(await riskReport(off.ctxOf('proc_officer', NOW), PERIOD)).toMatchObject({ ok: false, error: { code: 'MODULE_DISABLED' } })
    expect(ok(await reportCatalog(off.ctxOf('proc_officer', NOW))).reports.map((r) => r.code)).not.toContain('RSK_G9')
    expect(await runReport(off.ctxOf('proc_officer', NOW), 'RSK_G9', PERIOD)).toMatchObject({ ok: true, data: { rows: [] } })
  })
})
