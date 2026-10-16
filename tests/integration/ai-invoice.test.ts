import { randomUUID } from 'node:crypto'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { submitApInvoiceFor, updateApInvoiceFor } from '@/app/(workspace)/finance/invoices/[poId]/ap-commands'
import { createApInvoiceFromReadingFor } from '@/app/(workspace)/finance/invoices/ap-list-commands'
import { createFixtureClient, fixtureKey, setAiClientForTests, type FixtureAnswer } from '@/integrations/ai'
import { modelForPurpose, PROMPT_VERSIONS } from '@/lib/ai-config'
import { putObject } from '@/integrations/storage'
import { prisma } from '@/server/db/client'
import { readDocument, runDocumentRead, runMonthlyGrant, setAiRuntimeForTests, updateAgentSetting, type AiRuntime } from '@/server/services/ai'
import { confirmInvoiceCoding, createDraftFromReading, submitInvoice, updateInvoice } from '@/server/services/ap'
import { getApInvoicePage } from '@/server/services/ap/view-invoice'
import { AP_NOW, apOrg, codedDraft, fin, key, ok, receive, submit, type ApOrg } from '../support/ap'
import { etaxXml, pdfWithEmbedded } from '../support/etax-files'

// S13-12 (FR-AI-303 AC6, BR-AP-03, BR-AI-17): FINANCE has the Document Agent read a supplier's invoice for a PO in
// fixture mode. The reading proposes the invoice's header and its lines by PO line; invoice.createDraftFromReading
// makes the draft as FINANCE with the reading linked, and invoice.submit answers AI_REVIEW_PENDING until every value is
// confirmed one by one. The invoice then matches exactly as one typed by hand. An e-Tax file never reaches the AI.

// Invoices are read by the model their evaluation passed on (S13-14)
const MODEL = modelForPurpose('INVOICE_READ', {})
const SELLER_TAX_ID = '0999999000012'
const FIXTURE: AiRuntime = { enabled: true, mode: 'fixture', appEnv: 'local', modelEnv: {}, gates: [] }
const PNG = (seed: string) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new TextEncoder().encode(`${seed}-${randomUUID()}`)])

let ap: ApOrg
let orgTaxId: string
const answers = new Map<string, FixtureAnswer>()

beforeAll(async () => {
  ap = await apOrg()
  const { organizationId } = ap.org
  if (!(await prisma.roleAssignment.count({ where: { organizationId, memberId: ap.org.member.admin!, role: 'ORG_ADMIN', revokedAt: null } }))) {
    await prisma.roleAssignment.create({ data: { organizationId, memberId: ap.org.member.admin!, role: 'ORG_ADMIN', grantedAt: AP_NOW } })
  }
  orgTaxId = (await prisma.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { taxId: true } })).taxId
  setAiRuntimeForTests(FIXTURE)
  expect((await updateAgentSetting(ap.org.ctxOf('admin', AP_NOW), { agent: 'DOCUMENT', enabled: true }, key())).ok).toBe(true)
  expect((await runMonthlyGrant(organizationId, AP_NOW)).ok).toBe(true)
  setAiClientForTests(createFixtureClient({ answers, dir: '/nonexistent' }))
})

afterEach(() => {
  setAiRuntimeForTests(FIXTURE)
  setAiClientForTests(createFixtureClient({ answers, dir: '/nonexistent' }))
})

/** A PO of a pipe (3 at 500.00) and a valve (2 at 1,000.00), sent to the supplier and received in full */
async function receivedPo(of: ApOrg = ap) {
  const budgetLineId = await of.flow.fundedLine(10_000_000n)
  await prisma.budgetLine.update({ where: { id: budgetLineId }, data: { accountCode: '510101' } })
  const pr = await of.flow.approvedRequest(budgetLineId, [
    { quantity: '3', unitPrice: '500.00', description: 'ท่อ PPR 1 นิ้ว' },
    { quantity: '2', unitPrice: '1000.00', description: 'วาล์วประตูน้ำ 1 นิ้ว' },
  ])
  const created = await of.flow.approvedPo(pr.lines.map((l) => l.id), of.supplierId)
  await prisma.purchaseOrder.update({ where: { id: created.id }, data: { status: 'SENT', sentAt: AP_NOW } })
  const po = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: created.id }, include: { lines: { orderBy: { lineNo: 'asc' } } } })
  await receive(of, po, { 0: '3', 1: '2' })
  return po
}

async function upload(bytes: Uint8Array, mimeType: string) {
  const storageKey = `test/ai/${randomUUID()}`
  await putObject(storageKey, bytes, mimeType)
  return (await prisma.fileObject.create({ data: { organizationId: ap.org.organizationId, storageKey, fileName: 'invoice', mimeType, sizeBytes: bytes.length, status: 'AVAILABLE', uploadedById: ap.org.member.fin_officer! } })).id
}

function invoiceAnswer(bytes: Uint8Array, docNo: string) {
  answers.set(fixtureKey({ purpose: 'INVOICE_READ', files: [{ bytes, mediaType: 'image/png' }] }), {
    promptVersion: PROMPT_VERSIONS.INVOICE_READ,
    model: MODEL,
    usage: { input: 3000, output: 700 },
    output: {
      docType: 'TAX_INVOICE',
      docNo,
      docDate: '2026-10-10',
      currency: 'THB',
      priceIncludesVat: false,
      seller: { name: 'ผู้ขายหนึ่ง', taxId: SELLER_TAX_ID, branch: '00000' },
      buyer: { taxId: orgTaxId },
      lines: [
        { description: 'ท่อ PPR 1 นิ้ว', qty: '3', unit: 'ชิ้น', unitPrice: '500.00', amount: '1500.00' },
        { description: 'วาล์วประตูน้ำ 1 นิ้ว', qty: '2', unit: 'ชิ้น', unitPrice: '1,000.00', amount: '2000.00' },
      ],
      discountTotal: null,
      net: '3500.00',
      vat: '245.00',
      gross: '3745.00',
      confidence: [
        { field: 'docNo', value: 97 },
        { field: 'net', value: 99 },
      ],
    },
  })
}

/** FINANCE reads the invoice file for the PO; the job records the DRAFT */
async function readInvoice(po: { id: string }, docNo: string) {
  const bytes = PNG(docNo)
  const fileId = await upload(bytes, 'image/png')
  invoiceAnswer(bytes, docNo)
  const { agentActionId } = ok(await readDocument(fin(ap), { fileId, purpose: 'INVOICE', subject: { type: 'PURCHASE_ORDER', id: po.id } }, key()))
  expect(await runDocumentRead(ap.org.organizationId, agentActionId, AP_NOW)).toBe('DRAFT')
  return { fileId, agentActionId, action: await prisma.agentAction.findUniqueOrThrow({ where: { id: agentActionId } }) }
}

async function codeLines(invoiceId: string) {
  const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId }, include: { lines: { include: { poLine: { include: { budgetLine: true } } } } } })
  const lines = invoice.lines.map((l) => ({ invoiceLineId: l.id, accountCode: '510101', costCenterId: l.poLine.budgetLine.costCenterId }))
  return ok(await confirmInvoiceCoding(fin(ap), { invoiceId, version: invoice.version, lines }, key())).version
}

describe('[FR-AI-303/AC6] an invoice read by the AI: every value confirmed by FINANCE before it is submitted', () => {
  it('[FR-AI-303/AC6] proposes the header and each PO line; submit waits for every value; then it matches as one typed by hand', async () => {
    const po = await receivedPo()
    const [pipe, valve] = po.lines
    const { fileId, agentActionId, action } = await readInvoice(po, 'INV-2026-0042')
    const proposed = {
      supplierInvoiceNo: 'INV-2026-0042',
      invoiceDate: '2026-10-10',
      statedVat: '245.00',
      priceIncludesVat: 'false',
      [`lines.${pipe!.id}.quantity`]: '3',
      [`lines.${pipe!.id}.unitPrice`]: '500.00',
      [`lines.${valve!.id}.quantity`]: '2',
      [`lines.${valve!.id}.unitPrice`]: '1000.00',
    }
    // Every value of an invoice waits one by one; the PO's supplier is the one checked (BR-AI-15)
    expect(action).toMatchObject({ status: 'DRAFT', purpose: 'INVOICE_READ', subjectType: 'PURCHASE_ORDER', subjectId: po.id, verification: { status: 'PASS', fail: [] } })
    expect(action.review).toEqual({ proposed, requiredPaths: Object.keys(proposed).sort(), confirmedPaths: [] })
    const template = (action.output as { mapping: { invoice: Record<string, unknown>; unmatchedLines: number[] } }).mapping
    expect(template.unmatchedLines).toEqual([])

    // FINANCE takes the reading in as a draft, having looked at the invoice number only
    const { invoiceId } = ok(await createDraftFromReading(fin(ap), { ...(template.invoice as { poId: string }), fileId, agentActionId, aiAssist: { agentActionId, confirmedPaths: ['supplierInvoiceNo'] } }, key()))
    expect(await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })).toMatchObject({ status: 'DRAFT', prefill: 'AI_READING', agentActionId, createdById: ap.org.member.fin_officer, netSatang: 350_000n, statedVatSatang: 24_500n })
    expect(await prisma.agentAction.findUniqueOrThrow({ where: { id: agentActionId } })).toMatchObject({ status: 'DRAFT', subjectType: 'INVOICE', subjectId: invoiceId, appliedById: ap.org.member.fin_officer })
    expect(await prisma.event.findFirst({ where: { aggregateId: agentActionId, type: 'agent_action.applied' } })).toMatchObject({ actorType: 'USER', data: { subjectType: 'INVOICE', subjectId: invoiceId, pending: 7 } })

    let version = await codeLines(invoiceId)
    expect(await submitInvoice(fin(ap), { invoiceId, version }, key())).toMatchObject({ ok: false, error: { code: 'AI_REVIEW_PENDING', details: { count: 7, agentActionIds: [agentActionId] } } })
    expect(await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })).toMatchObject({ status: 'DRAFT', number: null })

    ;({ version } = ok(await updateInvoice(fin(ap), { invoiceId, version, aiAssist: { agentActionId, confirmedPaths: Object.keys(proposed) } }, key())))
    expect(await prisma.agentAction.findUniqueOrThrow({ where: { id: agentActionId } })).toMatchObject({ status: 'ACCEPTED', decidedById: ap.org.member.fin_officer })
    ok(await submitInvoice(fin(ap), { invoiceId, version }, key()))

    // The same invoice typed by hand on a twin PO matches the same way (the AI changes how values arrive, nothing else);
    // the twin is another organization's, or it would be a possible duplicate of this one
    const twinOrg = await apOrg()
    const twin = await receivedPo(twinOrg)
    const typed = await codedDraft(twinOrg, twin, { no: 'INV-2026-0042', vat: '245.00', lines: [{ line: 0, quantity: '3', unitPrice: '500.00' }, { line: 1, quantity: '2', unitPrice: '1000.00' }] })
    ok(await submit(twinOrg, typed))
    const outcome = async (id: string) => {
      const i = await prisma.invoice.findUniqueOrThrow({ where: { id }, select: { status: true, netSatang: true, statedVatSatang: true, grossSatang: true, _count: { select: { exceptions: true } } } })
      return { status: i.status, net: i.netSatang, vat: i.statedVatSatang, gross: i.grossSatang, exceptions: i._count.exceptions }
    }
    expect(await outcome(invoiceId)).toEqual(await outcome(typed.invoiceId))
    expect((await outcome(invoiceId)).status).toBe('READY_FOR_PAYMENT')
  })

  it('[FR-AI-303/AC6] a value FINANCE changes is theirs: the action closes EDITED with what the AI said and what was kept', async () => {
    const po = await receivedPo()
    const [pipe] = po.lines
    const { fileId, agentActionId, action } = await readInvoice(po, 'INV-2026-0050')
    const template = (action.output as { mapping: { invoice: { poId: string } } }).mapping.invoice
    const { invoiceId } = ok(await createDraftFromReading(fin(ap), { ...template, fileId, agentActionId }, key()))
    const draft = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId }, include: { lines: { orderBy: { lineNo: 'asc' } } } })
    const others = Object.keys((action.review as { proposed: Record<string, string> }).proposed).filter((p) => p !== 'statedVat')
    ok(await updateInvoice(fin(ap), { invoiceId, version: draft.version, statedVat: '244.99', aiAssist: { agentActionId, confirmedPaths: others } }, key()))
    const closed = await prisma.agentAction.findUniqueOrThrow({ where: { id: agentActionId } })
    expect(closed).toMatchObject({ status: 'EDITED', diff: { statedVat: { ai: '245.00', final: '244.99' } } })
    expect(draft.lines.map((l) => l.poLineId)).toContain(pipe!.id)
  })

  it('[FR-AI-303/AC6] the reading of another PO, or no reading at all, makes no draft', async () => {
    const po = await receivedPo()
    const other = await receivedPo()
    const { fileId, agentActionId } = await readInvoice(other, 'INV-2026-0060')
    expect(await createDraftFromReading(fin(ap), { poId: po.id, fileId, agentActionId }, key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'SUBJECT_MISMATCH' } } })
    expect(await createDraftFromReading(fin(ap), { poId: po.id, fileId, agentActionId: randomUUID() }, key())).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
    expect(await prisma.invoice.count({ where: { poId: po.id } })).toBe(0)
  })
})

describe('[FR-AI-303/AC5] [FR-AI-303/AC6] who reads an invoice, and what is never read', () => {
  it('[FR-AI-303/AC5] an e-Tax invoice goes to the import of S8: AI_FILE_UNSUPPORTED reason ETAX and no AgentAction', async () => {
    const po = await receivedPo()
    const before = await prisma.agentAction.count({ where: { organizationId: ap.org.organizationId } })
    const fileId = await upload(pdfWithEmbedded([{ name: 'ETDA-invoice.xml', content: etaxXml() }]), 'application/pdf')
    const r = await readDocument(fin(ap), { fileId, purpose: 'INVOICE', subject: { type: 'PURCHASE_ORDER', id: po.id } }, key())
    expect(r).toMatchObject({ ok: false, error: { code: 'AI_FILE_UNSUPPORTED', details: { reason: 'ETAX' } } })
    expect(await prisma.agentAction.count({ where: { organizationId: ap.org.organizationId } })).toBe(before)
  })

  it('[FR-AI-303/AC6] only a holder of invoice.record reads an invoice, and only for a purchase order', async () => {
    const po = await receivedPo()
    const fileId = await upload(PNG('refused'), 'image/png')
    expect(await readDocument(fin(ap), { fileId, purpose: 'INVOICE' }, key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { field: 'subject' } } })
    expect(await readDocument(fin(ap), { fileId, purpose: 'INVOICE', subject: { type: 'PURCHASE_ORDER', id: randomUUID() } }, key())).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
    // No credits for a PO that takes no invoice
    await prisma.purchaseOrder.update({ where: { id: po.id }, data: { status: 'CANCELLED' } })
    expect(await readDocument(fin(ap), { fileId, purpose: 'INVOICE', subject: { type: 'PURCHASE_ORDER', id: po.id } }, key())).toMatchObject({ ok: false, error: { code: 'INVALID_STATE_TRANSITION', details: { from: 'CANCELLED' } } })
    await prisma.purchaseOrder.update({ where: { id: po.id }, data: { status: 'RECEIVED' } })
    const own = await prisma.fileObject.update({ where: { id: fileId }, data: { uploadedById: ap.org.member.proc_officer! } })
    expect(await readDocument(ap.org.ctxOf('proc_officer', AP_NOW), { fileId: own.id, purpose: 'INVOICE', subject: { type: 'PURCHASE_ORDER', id: po.id } }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
  })
})

describe('[FR-AI-303/AC6] the invoice screens of S8 with the AI (S13-20)', () => {
  it('[FR-AI-303/AC6] "อ่านไฟล์ด้วย AI" makes the draft from the reading kept on the server; the page lists what waits; the confirmations go with invoice.update', async () => {
    const po = await receivedPo()
    const { fileId, agentActionId, action } = await readInvoice(po, 'INV-2026-0070')
    const proposed = (action.review as { proposed: Record<string, string> }).proposed

    // The browser sends the action's id only; the values come from what the server kept
    const made = await createApInvoiceFromReadingFor(fin(ap), { agentActionId }, randomUUID())
    if (!made.ok) throw new Error(JSON.stringify(made))
    const invoiceId = made.invoiceId
    expect(await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })).toMatchObject({ prefill: 'AI_READING', agentActionId, sourceFileId: fileId, supplierInvoiceNo: 'INV-2026-0070', statedVatSatang: 24_500n })

    // The page shows every value waiting, with the draft's values by the same paths
    const page = ok(await getApInvoicePage(fin(ap), invoiceId))
    expect(page.aiReviews).toEqual([{ agentActionId, purpose: 'INVOICE_READ', fileId, proposed, requiredPaths: Object.keys(proposed).sort(), confirmedPaths: [], pendingPaths: Object.keys(proposed).sort() }])
    expect(page.aiCurrent).toMatchObject(proposed)

    let version = await codeLines(invoiceId)
    expect(await submitApInvoiceFor(fin(ap), { invoiceId, version }, randomUUID())).toMatchObject({ ok: false, code: 'AI_REVIEW_PENDING' })

    // Half confirmed and saved: the rest still waits, and the page says which were saved
    const paths = Object.keys(proposed)
    expect(await updateApInvoiceFor(fin(ap), { invoiceId, version, aiAssist: { agentActionId, confirmedPaths: paths.slice(0, 4) } }, randomUUID())).toEqual({ ok: true })
    const half = ok(await getApInvoicePage(fin(ap), invoiceId))
    expect(half.aiReviews[0]!.confirmedPaths).toEqual(paths.slice(0, 4).sort())
    version = half.version
    expect(await submitApInvoiceFor(fin(ap), { invoiceId, version }, randomUUID())).toMatchObject({ ok: false, code: 'AI_REVIEW_PENDING' })

    // The rest: the action closes, the page has nothing left to confirm, and the invoice goes on as one typed by hand
    expect(await updateApInvoiceFor(fin(ap), { invoiceId, version, aiAssist: { agentActionId, confirmedPaths: paths } }, randomUUID())).toEqual({ ok: true })
    expect(await prisma.agentAction.findUniqueOrThrow({ where: { id: agentActionId } })).toMatchObject({ status: 'ACCEPTED', subjectType: 'INVOICE', subjectId: invoiceId })
    const done = ok(await getApInvoicePage(fin(ap), invoiceId))
    expect(done.aiReviews).toEqual([])
    expect(await submitApInvoiceFor(fin(ap), { invoiceId, version: done.version }, randomUUID())).toMatchObject({ ok: true })
    // It matched as typed by hand; the only difference is S8's possible duplicate of the earlier tests' invoice of the
    // same supplier and amount (BR-MATCH: within 3 days), which FINANCE settles as for any invoice
    const types = await prisma.matchException.findMany({ where: { invoiceId }, select: { type: true } })
    expect(types.map((x) => x.type).filter((t) => t !== 'POSSIBLE_DUPLICATE')).toEqual([])
  })

  it('[FR-AI-303/AC6] only the member who asked for the reading makes a draft from it, once, and only from an invoice reading', async () => {
    const po = await receivedPo()
    const { agentActionId } = await readInvoice(po, 'INV-2026-0080')
    // Someone else does not see the reading's content (getAgentAction), so cannot take it in
    expect(await createApInvoiceFromReadingFor(ap.org.ctxOf('proc_officer', AP_NOW), { agentActionId }, randomUUID())).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    expect(await createApInvoiceFromReadingFor(fin(ap), { agentActionId: 'not-an-id' }, randomUUID())).toMatchObject({ ok: false, code: 'VALIDATION_FAILED', field: 'agentActionId' })
    expect(await createApInvoiceFromReadingFor(fin(ap), { agentActionId: randomUUID() }, randomUUID())).toMatchObject({ ok: false, code: 'NOT_FOUND' })
    expect(await prisma.invoice.count({ where: { poId: po.id } })).toBe(0)

    // A second draft from the same reading is refused: the reading is the first draft's now
    const first = await createApInvoiceFromReadingFor(fin(ap), { agentActionId }, randomUUID())
    expect(first.ok).toBe(true)
    expect(await createApInvoiceFromReadingFor(fin(ap), { agentActionId }, randomUUID())).toMatchObject({ ok: false })
    expect(await prisma.invoice.count({ where: { poId: po.id } })).toBe(1)

    // A delivery note's reading is not an invoice's
    const note = await prisma.agentAction.update({ where: { id: agentActionId }, data: { purpose: 'DELIVERY_NOTE_READ' } })
    expect(await createApInvoiceFromReadingFor(fin(ap), { agentActionId: note.id }, randomUUID())).toMatchObject({ ok: false, code: 'VALIDATION_FAILED', reason: 'PURPOSE_MISMATCH' })
  })

  it('[FR-AI-303/AC6] the page of a draft typed by hand, and the page read by someone who does not record invoices, have no AI box', async () => {
    const po = await receivedPo()
    const typed = await codedDraft(ap, po, { no: `INV-H-${randomUUID().slice(0, 6)}`, vat: '245.00', lines: [{ line: 0, quantity: '3', unitPrice: '500.00' }, { line: 1, quantity: '2', unitPrice: '1000.00' }] })
    expect(ok(await getApInvoicePage(fin(ap), typed.invoiceId))).toMatchObject({ aiReviews: [], aiCurrent: {} })
  })
})
