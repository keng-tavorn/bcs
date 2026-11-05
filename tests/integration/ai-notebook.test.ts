import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { PROMPT_VERSIONS } from '@/lib/ai-config'
import { makeCtx, type Ctx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { confirmInvoiceCoding } from '@/server/services/ap'
import { suggestInvoiceCoding } from '@/server/services/ap/coding'
import { creditSummary, listAgentActivity, listAgentSettings, listSettingChanges, monthResults, updateAgentSetting } from '@/server/services/ai'
import { listNotebook, setAssistantLearning } from '@/server/services/assistants/notebook'
import { AP_NOW, apOrg, codedDraft, fin, key, ok, receive, sentPo, submit, type ApOrg } from '../support/ap'

// NEW-125 (ADR-083 · BR-AI-28 · BR-AI-04 · BR-AP-10): /admin/ai for ORG_ADMIN and AUDITOR — the assistants' notebook
// (the account codes learned from what FINANCE confirmed, switched off or forgotten by ORG_ADMIN, with an event), the
// history of the work from AgentAction (the values only for AUDITOR and the member who asked), the history of the
// settings from the events, and the month's results counted from AgentAction and Event.

const as = (ap: ApOrg, code: string) => ap.org.ctxOf(code, AP_NOW)
let dates = 0
// ten days apart, so the match never takes two of them for the same invoice (BR-MATCH-08)
const nextDate = () => new Date(Date.UTC(2026, 9, 10 - 10 * ++dates)).toISOString().slice(0, 10)

async function withAdmin(ap: ApOrg) {
  await prisma.roleAssignment.create({ data: { organizationId: ap.org.organizationId, memberId: ap.org.member.admin!, role: 'ORG_ADMIN', grantedAt: AP_NOW } })
  return ap
}

async function platformCtx(ap: ApOrg): Promise<Ctx> {
  const platformAdmin = await prisma.platformAdmin.create({ data: { displayName: 'ทีม BCS', active: true } })
  return makeCtx({ organizationId: ap.org.organizationId, actor: { type: 'PLATFORM_ADMIN', platformAdminId: platformAdmin.id }, channel: 'WEB', now: AP_NOW })
}

/** A ready invoice of `category` whose one line FINANCE confirmed as `code` (the history of BR-AP-10) */
async function readyInvoice(ap: ApOrg, category: string, code: string) {
  const po = await sentPo(ap, [{ quantity: '1', unitPrice: '1000.00' }])
  await prisma.poLine.updateMany({ where: { poId: po.id }, data: { categoryCode: category } })
  await receive(ap, po, { 0: '1' })
  const draft = await codedDraft(ap, po, { no: `NB-${randomUUID().slice(0, 6)}`, date: nextDate(), vat: '70.00', lines: [{ line: 0, quantity: '1', unitPrice: '1000.00' }] })
  const line = await prisma.invoiceLine.findFirstOrThrow({ where: { invoiceId: draft.invoiceId } })
  const version = (await prisma.invoice.findUniqueOrThrow({ where: { id: draft.invoiceId } })).version
  ok(await confirmInvoiceCoding(fin(ap), { invoiceId: draft.invoiceId, version, lines: [{ invoiceLineId: line.id, accountCode: code, costCenterId: line.costCenterId! }] }, key()))
  const v = (await prisma.invoice.findUniqueOrThrow({ where: { id: draft.invoiceId } })).version
  const submitted = ok(await submit(ap, { invoiceId: draft.invoiceId, version: v }))
  expect(submitted.exceptions).toEqual([])
  expect(submitted.status).toBe('READY_FOR_PAYMENT')
}

/** What the coding screen offers a new invoice of `category` (BR-AP-10) */
async function offered(ap: ApOrg, category: string) {
  const po = await sentPo(ap, [{ quantity: '1', unitPrice: '100.00' }])
  await prisma.poLine.updateMany({ where: { poId: po.id }, data: { categoryCode: category } })
  await receive(ap, po, { 0: '1' })
  const draft = await codedDraft(ap, po, { no: `OF-${randomUUID().slice(0, 6)}`, date: '2026-10-11', vat: '7.00', lines: [{ line: 0, quantity: '1', unitPrice: '100.00' }] })
  return ok(await suggestInvoiceCoding(fin(ap), draft.invoiceId))[0]!
}

const entryOf = async (ap: ApOrg, category: string) => ok(await listNotebook(as(ap, 'admin'))).entries.find((e) => e.categoryCode === category)

describe('[BR-AI-28] who reads /admin/ai', () => {
  it('[BR-AI-28] ORG_ADMIN and AUDITOR read every part; FINANCE, a plain member and PLATFORM_ADMIN are refused', async () => {
    const ap = await withAdmin(await apOrg())
    const parts = (ctx: Ctx) => Promise.all([listNotebook(ctx), listAgentActivity(ctx), listSettingChanges(ctx), monthResults(ctx), listAgentSettings(ctx), creditSummary(ctx)])
    for (const code of ['admin', 'auditor']) for (const r of await parts(as(ap, code))) expect(r.ok, code).toBe(true)
    expect(ok(await listNotebook(as(ap, 'admin'))).canManage).toBe(true)
    expect(ok(await listNotebook(as(ap, 'auditor'))).canManage).toBe(false)
    for (const ctx of [as(ap, 'fin_officer'), as(ap, 'req_con'), await platformCtx(ap)]) {
      for (const r of [await listNotebook(ctx), await listAgentActivity(ctx), await listSettingChanges(ctx), await monthResults(ctx), await listAgentSettings(ctx)]) {
        expect(r.ok ? null : r.error.code).toBe('FORBIDDEN')
      }
    }
  })
})

describe('[BR-AI-28] [BR-AP-10] the notebook: what was learned, switched off, forgotten', () => {
  let ap: ApOrg
  beforeAll(async () => {
    ap = await withAdmin(await apOrg())
    await readyInvoice(ap, 'SAFETY', '530101')
    await readyInvoice(ap, 'SAFETY', '530101')
  })

  it('[BR-AI-28] an entry is what the coding screen offers, with where it came from; no row until the admin acts', async () => {
    const entry = await entryOf(ap, 'SAFETY')
    const finName = (await prisma.member.findUniqueOrThrow({ where: { id: ap.org.member.fin_officer! } })).displayNameTh
    expect(entry).toMatchObject({ kind: 'ACCOUNT_CODE', supplierId: ap.supplierId, accountCode: '530101', accountName: 'ค่าใช้จ่ายสำนักงาน', uses: 2, lines: 2, disabled: false, version: -1, confirmedByCount: 1 })
    expect(entry!.confirmedBy).toEqual([{ th: finName, en: expect.anything() }].map((n) => expect.objectContaining({ th: n.th })))
    expect(await offered(ap, 'SAFETY')).toMatchObject({ accountCode: '530101', source: 'HISTORY', count: 2 })
    expect(await prisma.assistantLearning.count({ where: { organizationId: ap.org.organizationId } })).toBe(0)
  })

  it('[BR-AI-28] switched off, the screen offers the budget line’s code; on again, the history; each change is an event', async () => {
    const before = (await entryOf(ap, 'SAFETY'))!
    // only ORG_ADMIN changes the notebook, at the version it saw
    for (const code of ['auditor', 'fin_officer']) {
      for (const action of ['DISABLE', 'ENABLE', 'FORGET'] as const) {
        const r = await setAssistantLearning(as(ap, code), { kind: 'ACCOUNT_CODE', supplierId: ap.supplierId, categoryCode: 'SAFETY', action, expectedVersion: -1 }, key())
        expect(r.ok ? null : r.error.code, `${code} ${action}`).toBe('FORBIDDEN')
      }
    }
    const stale = await setAssistantLearning(as(ap, 'admin'), { kind: 'ACCOUNT_CODE', supplierId: ap.supplierId, categoryCode: 'SAFETY', action: 'DISABLE', expectedVersion: 3 }, key())
    expect(stale.ok ? null : stale.error.code).toBe('CONFLICT_VERSION')

    const off = ok(await setAssistantLearning(as(ap, 'admin'), { kind: 'ACCOUNT_CODE', supplierId: ap.supplierId, categoryCode: 'SAFETY', action: 'DISABLE', expectedVersion: before.version }, key()))
    expect(off).toMatchObject({ disabled: true, forgottenAt: null, version: 0 })
    expect(await offered(ap, 'SAFETY')).toMatchObject({ accountCode: '510101', source: 'BUDGET_LINE', count: 0 })
    // the notebook still shows it, off, with what it would offer once on again
    expect(await entryOf(ap, 'SAFETY')).toMatchObject({ accountCode: '530101', uses: 2, disabled: true, version: 0 })
    const again = await setAssistantLearning(as(ap, 'admin'), { kind: 'ACCOUNT_CODE', supplierId: ap.supplierId, categoryCode: 'SAFETY', action: 'DISABLE', expectedVersion: 0 }, key())
    expect(again.ok ? null : again.error.details?.reason).toBe('NO_CHANGE')

    ok(await setAssistantLearning(as(ap, 'admin'), { kind: 'ACCOUNT_CODE', supplierId: ap.supplierId, categoryCode: 'SAFETY', action: 'ENABLE', expectedVersion: 0 }, key()))
    expect(await offered(ap, 'SAFETY')).toMatchObject({ accountCode: '530101', source: 'HISTORY', count: 2 })

    const events = await prisma.event.findMany({ where: { organizationId: ap.org.organizationId, aggregateType: 'AssistantLearning' }, orderBy: { seq: 'asc' } })
    expect(events.map((e) => [e.type, e.actorMemberId])).toEqual([
      ['assistant_learning.disabled', ap.org.member.admin],
      ['assistant_learning.enabled', ap.org.member.admin],
    ])
    expect(events[0]!.data).toEqual({ kind: 'ACCOUNT_CODE', supplierId: ap.supplierId, categoryCode: 'SAFETY', accountCode: '530101', uses: 2 })
    // the supplier's tax id is never in an event (it is a person's id for a natural person)
    expect(JSON.stringify(events.map((e) => e.data))).not.toContain('0999999000012')
  })

  it('[BR-AI-28] deleted, the lines confirmed so far are never used again; a later confirmation teaches it anew', async () => {
    const before = (await entryOf(ap, 'SAFETY'))!
    ok(await setAssistantLearning(as(ap, 'admin'), { kind: 'ACCOUNT_CODE', supplierId: ap.supplierId, categoryCode: 'SAFETY', action: 'FORGET', expectedVersion: before.version }, key()))
    expect(await entryOf(ap, 'SAFETY')).toBeUndefined()
    expect(await offered(ap, 'SAFETY')).toMatchObject({ accountCode: '510101', source: 'BUDGET_LINE' })
    const forgotten = await prisma.event.findFirstOrThrow({ where: { organizationId: ap.org.organizationId, type: 'assistant_learning.forgotten' } })
    expect(forgotten).toMatchObject({ actorMemberId: ap.org.member.admin, data: { accountCode: '530101', uses: 2, forgottenAt: AP_NOW.toISOString() } })
    // nothing left to forget or switch off
    const nothing = await setAssistantLearning(as(ap, 'admin'), { kind: 'ACCOUNT_CODE', supplierId: ap.supplierId, categoryCode: 'SAFETY', action: 'DISABLE', expectedVersion: before.version + 1 }, key())
    expect(nothing.ok ? null : nothing.error.details?.reason).toBe('NOT_LEARNED')

    // a confirmation after the moment it was told to forget teaches it again, from that line only
    const later = makeCtx({ organizationId: ap.org.organizationId, actor: { type: 'USER', memberId: ap.org.member.fin_officer! }, channel: 'WEB', now: new Date(AP_NOW.getTime() + 60_000) })
    const po = await sentPo(ap, [{ quantity: '1', unitPrice: '1000.00' }])
    await prisma.poLine.updateMany({ where: { poId: po.id }, data: { categoryCode: 'SAFETY' } })
    await receive(ap, po, { 0: '1' })
    const draft = await codedDraft(ap, po, { no: `LT-${randomUUID().slice(0, 6)}`, date: nextDate(), vat: '70.00', lines: [{ line: 0, quantity: '1', unitPrice: '1000.00' }] })
    const line = await prisma.invoiceLine.findFirstOrThrow({ where: { invoiceId: draft.invoiceId } })
    const version = (await prisma.invoice.findUniqueOrThrow({ where: { id: draft.invoiceId } })).version
    ok(await confirmInvoiceCoding(later, { invoiceId: draft.invoiceId, version, lines: [{ invoiceLineId: line.id, accountCode: '530101', costCenterId: line.costCenterId! }] }, key()))
    const v = (await prisma.invoice.findUniqueOrThrow({ where: { id: draft.invoiceId } })).version
    expect(ok(await submit(ap, { invoiceId: draft.invoiceId, version: v })).status).toBe('READY_FOR_PAYMENT')
    expect(await entryOf(ap, 'SAFETY')).toMatchObject({ accountCode: '530101', uses: 1, lines: 1, disabled: false })
    expect(await offered(ap, 'SAFETY')).toMatchObject({ accountCode: '530101', source: 'HISTORY', count: 1 })
  })

  it('[BR-AI-28] two first changes of one entry at once: one is written, the other is told it changed in between', async () => {
    const two = await withAdmin(await apOrg())
    await readyInvoice(two, 'SAFETY', '530101')
    await prisma.roleAssignment.create({ data: { organizationId: two.org.organizationId, memberId: two.org.member.admin2!, role: 'ORG_ADMIN', grantedAt: AP_NOW } })
    const results = await Promise.all(
      (['admin', 'admin2'] as const).map((code, i) => setAssistantLearning(as(two, code), { kind: 'ACCOUNT_CODE', supplierId: two.supplierId, categoryCode: 'SAFETY', action: i === 0 ? 'DISABLE' : 'FORGET', expectedVersion: -1 }, key())),
    )
    expect(results.map((r) => (r.ok ? 'ok' : r.error.code)).sort()).toEqual(['CONFLICT_VERSION', 'ok'])
    expect(await prisma.assistantLearning.count({ where: { organizationId: two.org.organizationId } })).toBe(1)
    expect(await prisma.event.count({ where: { organizationId: two.org.organizationId, aggregateType: 'AssistantLearning' } })).toBe(1)
  })

  it('[BR-AI-28] the PAY module off: nothing is learned and nothing can change', async () => {
    const off = await withAdmin(await apOrg({ modules: ['AI'] }))
    expect(ok(await listNotebook(as(off, 'admin')))).toMatchObject({ payOn: false, entries: [] })
    const r = await setAssistantLearning(as(off, 'admin'), { kind: 'ACCOUNT_CODE', supplierId: off.supplierId, categoryCode: 'SAFETY', action: 'DISABLE', expectedVersion: -1 }, key())
    expect(r.ok ? null : r.error.code).toBe('MODULE_DISABLED')
  })
})

describe('[BR-AI-04] [BR-AI-28] the history of the work, the settings and the month', () => {
  let ap: ApOrg
  let edited: string
  let invoiceNumber: string
  beforeAll(async () => {
    ap = await withAdmin(await apOrg())
    const at = (minutes: number) => new Date(AP_NOW.getTime() + minutes * 60_000)
    // a reading FINANCE took in after changing one of the three values, the system's checks having warned
    edited = (
      await prisma.agentAction.create({
        data: {
          organizationId: ap.org.organizationId, agent: 'DOCUMENT', purpose: 'INVOICE_READ', level: 'L1', status: 'EDITED', channel: 'WEB',
          promptVersion: PROMPT_VERSIONS.INVOICE_READ, model: 'claude-opus-5-5', requestedById: ap.org.member.fin_officer!, inputRefs: { fileId: randomUUID() },
          inputText: 'ข้อความที่ไม่ควรแสดง', output: { reading: { docNo: 'INV-SECRET' } }, verification: { status: 'WARN', fail: [], warn: ['VAT_AMOUNT'], skip: [], flagged: ['statedVat'], computed: {} },
          review: { requiredPaths: [], confirmedPaths: ['invoiceDate'], proposed: { supplierInvoiceNo: 'IV-1', invoiceDate: '2026-10-09', statedVat: '70.00' } },
          diff: { statedVat: { ai: '70.00', final: '71.00' } }, decidedAt: at(5), decidedById: ap.org.member.fin_officer!, costCredits: 12, createdAt: at(1),
        },
      })
    ).id
    // a question the member found helpful, the tools it used kept as metadata
    await prisma.agentAction.create({
      data: {
        organizationId: ap.org.organizationId, agent: 'INSIGHT', purpose: 'QUESTION', level: 'L0', status: 'DRAFT', channel: 'WEB', promptVersion: PROMPT_VERSIONS.QUESTION, model: 'claude-haiku-5-5',
        requestedById: ap.org.member.req_con!, inputText: 'คำถามของผู้ขอ', output: { tools: ['my_requests'], kind: 'ANSWER' }, feedback: 'HELPFUL', costCredits: 3, createdAt: at(2),
      },
    })
    // a summary the system wrote, and a call of last month
    await prisma.agentAction.create({ data: { organizationId: ap.org.organizationId, agent: 'APPROVAL_BRIEF', purpose: 'BRIEF', level: 'L0', status: 'FAILED', channel: 'SYSTEM', promptVersion: PROMPT_VERSIONS.BRIEF, errorCode: 'TIMEOUT', inputRefs: { taskId: randomUUID() }, createdAt: at(3) } })
    await prisma.agentAction.create({ data: { organizationId: ap.org.organizationId, agent: 'INSIGHT', purpose: 'QUESTION', level: 'L0', status: 'DRAFT', channel: 'WEB', promptVersion: PROMPT_VERSIONS.QUESTION, requestedById: ap.org.member.req_con!, feedback: 'NOT_HELPFUL', createdAt: new Date('2026-09-20T03:00:00Z') } })
    // an invoice 10% over its PO's price: the match raises PRICE_OVER
    const po = await sentPo(ap, [{ quantity: '1', unitPrice: '1000.00' }])
    await receive(ap, po, { 0: '1' })
    const draft = await codedDraft(ap, po, { no: `EX-${randomUUID().slice(0, 6)}`, date: '2026-10-11', vat: '77.00', lines: [{ line: 0, quantity: '1', unitPrice: '1100.00' }] })
    const raised = ok(await submit(ap, draft))
    expect(raised.status).toBe('EXCEPTION')
    invoiceNumber = raised.number!
    // the reading was of that invoice
    await prisma.agentAction.update({ where: { id: edited }, data: { subjectType: 'INVOICE', subjectId: draft.invoiceId } })
    // the admin switched the Document Agent on, then set its confidence
    ok(await updateAgentSetting(as(ap, 'admin'), { agent: 'DOCUMENT', enabled: true }, key()))
    ok(await updateAgentSetting(as(ap, 'admin'), { agent: 'DOCUMENT', minConfidenceBp: 8500, expectedVersion: 0 }, key()))
  })

  it('[BR-AI-04] every call, the newest first: who asked, what for, what it used and what people changed; never the content', async () => {
    const page = ok(await listAgentActivity(as(ap, 'admin')))
    expect(page.rows.map((r) => r.purpose)).toEqual(['BRIEF', 'QUESTION', 'INVOICE_READ', 'QUESTION'])
    const [brief, question, reading] = page.rows
    expect(brief).toMatchObject({ requester: null, channel: 'SYSTEM', status: 'FAILED', errorCode: 'TIMEOUT', dataUsed: [{ kind: 'APPROVAL_TASK' }] })
    expect(question).toMatchObject({ level: 'L0', feedback: 'HELPFUL', dataUsed: [{ kind: 'TOOL', name: 'my_requests' }], costCredits: 3 })
    expect(reading).toMatchObject({ id: edited, status: 'EDITED', filled: 3, changedPaths: ['statedVat'], checks: 'WARN', dataUsed: [{ kind: 'FILES', count: 1 }], costCredits: 12 })
    // ORG_ADMIN reads metadata: which fields changed, not the values, and no number of a PO's invoice it may not read
    expect(reading!.changes).toBeNull()
    expect(reading!.subject).toEqual({ type: 'INVOICE', number: null })
    expect(JSON.stringify(page)).not.toMatch(/ไม่ควรแสดง|INV-SECRET|คำถามของผู้ขอ/)
    // AUDITOR, and the member who asked, see what the AI read and what the person kept
    const audit = ok(await listAgentActivity(as(ap, 'auditor'))).rows.find((r) => r.id === edited)!
    expect(audit.changes).toEqual([{ path: 'statedVat', ai: '70.00', final: '71.00' }])
    expect(audit.subject).toEqual({ type: 'INVOICE', number: invoiceNumber })
    expect(ok(await listAgentActivity(as(ap, 'auditor'))).access).toMatchObject({ canManage: false, content: true, moneyFound: true })
    // a page at a time: the older page starts after the id given
    const older = ok(await listAgentActivity(as(ap, 'admin'), { before: question!.id }))
    expect(older.rows.map((r) => r.purpose)).toEqual(['INVOICE_READ', 'QUESTION'])
    expect((await listAgentActivity(as(ap, 'admin'), { show: 'NOPE' as never })).ok).toBe(false)
  })

  it('[BR-AI-28] the month: every number counted by code, and each the size of the list its filter shows', async () => {
    const r = ok(await monthResults(as(ap, 'auditor')))
    expect(r).toMatchObject({
      periodMonth: '2026-10-01',
      month: '2026-10',
      calls: { total: 3, failed: 1 },
      fields: { documents: 1, filled: 3, kept: 2, changed: 1, editedDocuments: 1 },
      checks: { flagged: 1, decided: 1 },
      feedback: { helpful: 1, notHelpful: 0 },
    })
    expect(r.agents.find((a) => a.agent === 'DOCUMENT')).toEqual({ agent: 'DOCUMENT', calls: 1, credits: 12 })
    expect(r.agents.find((a) => a.agent === 'INSIGHT')).toEqual({ agent: 'INSIGHT', calls: 1, credits: 3 })
    const size = async (show: 'ALL' | 'FILLED' | 'EDITED' | 'FLAGGED' | 'HELPFUL' | 'FAILED') => ok(await listAgentActivity(as(ap, 'auditor'), { show, month: r.month })).rows.length
    expect([await size('ALL'), await size('FILLED'), await size('EDITED'), await size('FLAGGED'), await size('HELPFUL'), await size('FAILED')]).toEqual([3, 1, 1, 1, 1, 1])
    // OQ-41: what the invoice asked above its PO, for a reader of every PO; ORG_ADMIN reads no invoice
    expect(r.found).toMatchObject({ satang: 10_000n, invoices: 1 })
    expect(r.found!.list[0]).toMatchObject({ satang: 10_000n, types: ['PRICE_OVER'], supplier: { th: 'ผู้ขายหนึ่ง' } })
    expect(ok(await monthResults(as(ap, 'admin'))).found).toBeNull()
    // an ORG_ADMIN who also reads every PO (EXECUTIVE) still reads no invoice (BR-AP-13): no amount, no invoice number
    await prisma.roleAssignment.createMany({ data: (['ORG_ADMIN', 'EXECUTIVE'] as const).map((role) => ({ organizationId: ap.org.organizationId, memberId: ap.org.member.admin2!, role, grantedAt: AP_NOW })) })
    expect(ok(await monthResults(as(ap, 'admin2'))).found).toBeNull()
    expect(ok(await listAgentActivity(as(ap, 'admin2'))).rows.find((row) => row.id === edited)!.subject).toEqual({ type: 'INVOICE', number: null })
  })

  it('[BR-AI-28] the settings: their version and who saved them, and every change from the events, the newest first', async () => {
    const adminName = (await prisma.member.findUniqueOrThrow({ where: { id: ap.org.member.admin! } })).displayNameTh
    const doc = ok(await listAgentSettings(as(ap, 'auditor'))).find((a) => a.agent === 'DOCUMENT')!
    expect(doc).toMatchObject({ enabled: true, minConfidenceBp: 8500, version: 1, updatedBy: { th: adminName } })
    const changes = ok(await listSettingChanges(as(ap, 'auditor')))
    expect(changes.map((c) => [c.type, c.agent, c.version, c.minConfidenceBp, c.by?.th])).toEqual([
      ['ai_agent.updated', 'DOCUMENT', 1, 8500, adminName],
      ['ai_agent.enabled', 'DOCUMENT', 0, 9000, adminName],
    ])
  })
})
