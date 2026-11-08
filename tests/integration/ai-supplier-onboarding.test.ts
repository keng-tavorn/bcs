import { randomUUID } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { PORTAL_PRIVACY_NOTICE_VERSION } from '@/lib/portal-limits'
import { createFixtureClient, fixtureKey, setAiClientForTests, type FixtureAnswer } from '@/integrations/ai'
import { PROMPT_VERSIONS } from '@/lib/ai-config'
import type { Ctx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { forTenant } from '@/server/db/tenant'
import { setDefaultOutboxSender } from '@/server/events/outbox'
import { aiAgentRunRun } from '@/server/jobs/ai-agent-run'
import { listPortalAiReadings } from '@/server/portal/queries-ai'
import { portalCtx } from '@/server/portal/session'
import { runMonthlyGrant, setAiRuntimeForTests, updateAgentSetting, type AiRuntime } from '@/server/services/ai'
import { requestSupplierDocumentRead } from '@/server/services/ai/agents/supplier-onboarding'
import { applyAiAssist } from '@/server/services/ai/assist-contract'
import { takeAiReading } from '@/server/services/suppliers/ai-take'
import { applicationSignedIn, inviteSupplier, submitApplication, updateApplication } from '@/server/services/suppliers/applications'
import { listApplicationAiReadings } from '@/server/services/suppliers/applications-view'
import { scanFile, uploadSupplierDocument } from '@/server/services/suppliers/documents'
import type { DoaOrg } from '../support/doa-org'
import { createP2Org } from '../support/p2-org'

// S7-14 (FR-AI-304 AC1–AC4 AC6 · BR-AI-29 BR-AI-30 · ADR-189): a document of an application scanned clean is read by the
// Supplier Onboarding Agent only for a type and payee the AI may read, with supplier.aiAssist and every gate on; the
// reading is checked and proposes values the supplier's contact takes in one by one on the portal (appliedByContactId);
// a value left waiting stops the submit (AI_REVIEW_PENDING); the AI never verifies, submits or approves anything; with
// the AI off the application is filled by hand. The fixture client answers by the file's sha256 (ADR-142).

const NOW = new Date('2026-11-02T03:00:00Z')
const SONNET = 'claude-sonnet-5-5'
const FIXTURE: AiRuntime = { enabled: true, mode: 'fixture', appEnv: 'local', modelEnv: {}, gates: [] }
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const PNG = (seed: string) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new TextEncoder().encode(`${seed}-${randomUUID()}`)])
const answers = new Map<string, FixtureAnswer>()
let org: DoaOrg

function taxId(prefix = '0'): string {
  const digits = Array.from({ length: 12 }, (_, i) => (i === 0 ? Number(prefix) : Math.floor(Math.random() * 10)))
  const sum = digits.reduce((s, d, i) => s + d * (13 - i), 0)
  return digits.join('') + String((11 - (sum % 11)) % 10)
}

beforeAll(async () => {
  setDefaultOutboxSender(null)
  org = await createP2Org()
  await prisma.roleAssignment.createMany({
    data: [
      { organizationId: org.organizationId, memberId: org.member.admin!, role: 'ORG_ADMIN', grantedAt: NOW },
      { organizationId: org.organizationId, memberId: org.member.dm_proc!, role: 'PROCUREMENT', grantedAt: NOW },
    ],
    skipDuplicates: true,
  })
  await prisma.supplierDocumentType.createMany({
    data: [
      { organizationId: org.organizationId, code: 'COMPANY_CERT', nameTh: 'หนังสือรับรองบริษัท', nameEn: 'Company certificate', appliesTo: ['JURISTIC'], required: true, validityDays: 180, aiReadable: true },
      { organizationId: org.organizationId, code: 'VAT_CERT', nameTh: 'ภ.พ.20', nameEn: 'VAT registration', appliesTo: ['JURISTIC', 'INDIVIDUAL'], required: false, validityDays: 3650, aiReadable: true, aiReadablePayeeTypes: ['JURISTIC'] },
      { organizationId: org.organizationId, code: 'BANK_BOOK', nameTh: 'หน้าสมุดบัญชี', nameEn: 'Bank book', appliesTo: ['JURISTIC', 'INDIVIDUAL'], required: false, validityDays: 3650 },
      { organizationId: org.organizationId, code: 'ID_CARD', nameTh: 'บัตรประชาชน', nameEn: 'ID card', appliesTo: ['INDIVIDUAL'], required: true, sensitive: true },
    ],
  })
  setAiRuntimeForTests(FIXTURE)
  const enabled = await updateAgentSetting(org.ctxOf('admin', NOW), { agent: 'SUPPLIER_ONBOARDING', enabled: true }, key())
  expect(enabled, JSON.stringify(enabled)).toMatchObject({ ok: true })
  expect((await runMonthlyGrant(org.organizationId, NOW)).ok).toBe(true)
  setAiClientForTests(createFixtureClient({ answers, dir: '/nonexistent' }))
})

afterEach(() => setAiRuntimeForTests(FIXTURE))

/** An application invited by procurement, its contact signed in with the privacy notice accepted */
async function application(payeeType: 'JURISTIC' | 'INDIVIDUAL' = 'JURISTIC') {
  const name = `บริษัท ทดสอบเอไอ ${randomUUID().slice(0, 6)} จำกัด`
  const r = await inviteSupplier(org.ctxOf('proc_officer', NOW), { kind: 'NEW', nameTh: name, taxId: taxId(payeeType === 'JURISTIC' ? '0' : '3'), branchCode: '00000', payeeType, contact: { nameTh: 'ผู้ติดต่อ', email: `ai-${randomUUID().slice(0, 8)}@supplier.test` } }, key())
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  const contact = await prisma.supplierContact.findUniqueOrThrow({ where: { id: r.data.contactId } })
  const ctx: Ctx = portalCtx(org.organizationId, contact, NOW)
  await forTenant(org.organizationId).$transaction((tx) => applicationSignedIn(tx, ctx, contact))
  await prisma.supplierContact.update({ where: { id: contact.id }, data: { privacyNoticeVersion: PORTAL_PRIVACY_NOTICE_VERSION } })
  const app = await prisma.supplierApplication.findUniqueOrThrow({ where: { id: r.data.applicationId } })
  return { app, ctx, contactId: contact.id, name }
}

async function upload(ctx: Ctx, applicationId: string, code: string, bytes: Uint8Array, scan = true) {
  const r = await uploadSupplierDocument(ctx, { applicationId, documentTypeCode: code, issuedOn: '2026-10-20', expiresOn: code === 'ID_CARD' ? '2030-01-01' : null, fileName: `${code}.png`, bytes }, key())
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  if (scan) await scanFile(org.organizationId, r.data.fileId, NOW)
  return r.data
}

function answerFor(bytes: Uint8Array, output: Record<string, unknown>) {
  answers.set(fixtureKey({ purpose: 'SUPPLIER_DOC_READ', text: '', files: [{ bytes, mediaType: 'image/png' }] } as never), { promptVersion: PROMPT_VERSIONS.SUPPLIER_DOC_READ, model: SONNET, output })
}

const read = (over: Record<string, unknown>) => ({
  docType: 'COMPANY_CERT',
  nameTh: null,
  nameEn: null,
  taxId: null,
  branchCode: '00000',
  registeredAddress: '99 หมู่ 4 ต.เจดีย์หัก อ.เมือง จ.ราชบุรี 70000',
  registrationDate: '2019-03-01',
  issuedOn: '2026-10-20',
  isVatRegistered: true,
  bankName: null,
  accountName: null,
  documentNumber: '0105562000001',
  confidence: [
    { field: 'nameTh', value: 95 },
    { field: 'taxId', value: 99 },
    { field: 'branchCode', value: 97 },
    { field: 'registeredAddress', value: 93 },
    { field: 'issuedOn', value: 96 },
    { field: 'isVatRegistered', value: 92 },
    { field: 'registrationDate', value: 95 },
    { field: 'documentNumber', value: 95 },
  ],
  ...over,
})

async function readOf(actionId: string) {
  return aiAgentRunRun({ data: { organizationId: org.organizationId, aggregateId: actionId, data: { purpose: 'SUPPLIER_DOC_READ' } } }, { run: (_id, fn) => fn() })
}

describe('[FR-AI-304/AC1] the agent reads a document of an application once it is clean, when every rule lets it', () => {
  it('a company certificate of a juristic application: one PENDING action for the contact who uploaded it, subject the application', async () => {
    const a = await application()
    const bytes = PNG('cert')
    const doc = await upload(a.ctx, a.app.id, 'COMPANY_CERT', bytes)
    expect(await requestSupplierDocumentRead(org.organizationId, doc.documentId, NOW)).toBe('REQUESTED')
    const action = await prisma.agentAction.findFirstOrThrow({ where: { subjectId: a.app.id } })
    expect(action).toMatchObject({ agent: 'SUPPLIER_ONBOARDING', purpose: 'SUPPLIER_DOC_READ', level: 'L1', status: 'PENDING', subjectType: 'SUPPLIER_APPLICATION', requestedById: null, requestedByContactId: a.contactId })
    // the job again: the same command, no second call
    expect(await requestSupplierDocumentRead(org.organizationId, doc.documentId, NOW)).toBe('REQUESTED')
    expect(await prisma.agentAction.count({ where: { subjectId: a.app.id } })).toBe(1)
  })

  it('[BR-AI-08] never a bank book, an ID card, or a VAT registration of an individual; never a file still being scanned; never with supplier.aiAssist off', async () => {
    const a = await application()
    expect(await requestSupplierDocumentRead(org.organizationId, (await upload(a.ctx, a.app.id, 'BANK_BOOK', PNG('bank'))).documentId, NOW)).toBe('SKIPPED_NOT_AI_READABLE')
    expect(await requestSupplierDocumentRead(org.organizationId, (await upload(a.ctx, a.app.id, 'COMPANY_CERT', PNG('pending'), false)).documentId, NOW)).toBe('SKIPPED_NOT_SCANNED')
    const i = await application('INDIVIDUAL')
    expect(await requestSupplierDocumentRead(org.organizationId, (await upload(i.ctx, i.app.id, 'VAT_CERT', PNG('vat-ind'))).documentId, NOW)).toBe('SKIPPED_PAYEE_TYPE_EXCLUDED')
    expect(await requestSupplierDocumentRead(org.organizationId, (await upload(i.ctx, i.app.id, 'ID_CARD', PNG('id'))).documentId, NOW)).toBe('SKIPPED_NOT_AI_READABLE')
    const settings = (await prisma.organization.findUniqueOrThrow({ where: { id: org.organizationId } })).settings as Record<string, unknown>
    await prisma.organization.update({ where: { id: org.organizationId }, data: { settings: { ...settings, supplier: { ...((settings.supplier as object) ?? {}), aiAssist: false } } } })
    try {
      expect(await requestSupplierDocumentRead(org.organizationId, (await upload(a.ctx, a.app.id, 'VAT_CERT', PNG('vat-off'))).documentId, NOW)).toBe('SKIPPED_AI_ASSIST_OFF')
    } finally {
      await prisma.organization.update({ where: { id: org.organizationId }, data: { settings: settings as object } })
    }
    expect(await prisma.agentAction.count({ where: { subjectId: { in: [a.app.id, i.app.id] } } })).toBe(0)
  })
})

describe('[FR-AI-304/AC2] [FR-AI-304/AC3] the reading, checked, and taken in one by one by the contact', () => {
  it('a DRAFT with the values for the application, the critical ones waiting one by one; no account number; the contact takes them (appliedByContactId)', async () => {
    const a = await application()
    const bytes = PNG('take')
    answerFor(bytes, read({ nameTh: a.name, taxId: a.app.taxId, accountName: null }))
    const doc = await upload(a.ctx, a.app.id, 'COMPANY_CERT', bytes)
    await requestSupplierDocumentRead(org.organizationId, doc.documentId, NOW)
    const actionId = (await prisma.agentAction.findFirstOrThrow({ where: { subjectId: a.app.id } })).id
    expect(await readOf(actionId)).toBe('DRAFT')
    const action = await prisma.agentAction.findUniqueOrThrow({ where: { id: actionId } })
    const review = action.review as { proposed: Record<string, string>; requiredPaths: string[] }
    expect(review.proposed).toMatchObject({ nameTh: a.name, taxId: a.app.taxId, branchCode: '00000', address: '99 หมู่ 4 ต.เจดีย์หัก อ.เมือง จ.ราชบุรี 70000', isVatRegistered: 'true' })
    expect(review.requiredPaths).toEqual(expect.arrayContaining(['nameTh', 'taxId', 'branchCode', 'isVatRegistered']))
    expect(review.requiredPaths).not.toContain('address')
    expect(JSON.stringify(action.output)).not.toMatch(/accountNo/)
    // the portal shows it to the contact; procurement's page too
    expect((await listPortalAiReadings(a.ctx)).map((r) => r.agentActionId)).toEqual([actionId])
    expect((await listApplicationAiReadings(org.ctxOf('proc_officer', NOW), a.app.id))[0]?.fields.find((f) => f.path === 'taxId')).toMatchObject({ mustConfirm: true, confirmed: false })
    // the address (not critical) by "confirm the rest", the tax id ticked: the rest stays as typed
    const v = (await prisma.supplierApplication.findUniqueOrThrow({ where: { id: a.app.id } })).version
    const taken = await takeAiReading(a.ctx, { applicationId: a.app.id, expectedVersion: v, agentActionId: actionId, paths: ['taxId', 'branchCode', 'nameTh', 'isVatRegistered'], rest: true }, key())
    expect(taken).toMatchObject({ ok: true, data: { taken: ['address', 'branchCode', 'isVatRegistered', 'nameTh', 'taxId'] } })
    const after = await prisma.agentAction.findUniqueOrThrow({ where: { id: actionId } })
    expect(after).toMatchObject({ status: 'ACCEPTED', appliedById: null, appliedByContactId: a.contactId })
    const app = await prisma.supplierApplication.findUniqueOrThrow({ where: { id: a.app.id } })
    expect(app.address).toBe('99 หมู่ 4 ต.เจดีย์หัก อ.เมือง จ.ราชบุรี 70000')
    expect((app.fieldSources as Record<string, string>).address).toBe('AI')
    // nothing was verified or sent by the AI (AC4)
    expect(await prisma.supplierDocument.findUniqueOrThrow({ where: { id: doc.documentId }, select: { status: true } })).toEqual({ status: 'PENDING' })
    expect(app.status).toBe('DRAFT')
  })

  it('[BR-AI-17] a value taken in without its confirmation waits: the submit is AI_REVIEW_PENDING until the contact confirms it', async () => {
    const a = await application()
    const bytes = PNG('pending')
    answerFor(bytes, read({ nameTh: a.name, taxId: a.app.taxId }))
    const doc = await upload(a.ctx, a.app.id, 'COMPANY_CERT', bytes)
    await requestSupplierDocumentRead(org.organizationId, doc.documentId, NOW)
    const actionId = (await prisma.agentAction.findFirstOrThrow({ where: { subjectId: a.app.id } })).id
    await readOf(actionId)
    // the address typed as the AI read it, only the tax id confirmed: the name (as invited, = the reading) still waits
    const v1 = (await prisma.supplierApplication.findUniqueOrThrow({ where: { id: a.app.id } })).version
    expect(await updateApplication(a.ctx, { applicationId: a.app.id, expectedVersion: v1, fields: { address: '99 หมู่ 4 ต.เจดีย์หัก อ.เมือง จ.ราชบุรี 70000', isVatRegistered: true }, aiAssist: { agentActionId: actionId, confirmedPaths: ['taxId', 'address'] } }, key())).toMatchObject({ ok: true })
    const v2 = (await prisma.supplierApplication.findUniqueOrThrow({ where: { id: a.app.id } })).version
    expect(await submitApplication(a.ctx, { applicationId: a.app.id, expectedVersion: v2 }, key())).toMatchObject({ ok: false, error: { code: 'AI_REVIEW_PENDING' } })
    const take = await takeAiReading(a.ctx, { applicationId: a.app.id, expectedVersion: v2, agentActionId: actionId, paths: ['nameTh', 'branchCode', 'isVatRegistered'] }, key())
    expect(take.ok).toBe(true)
    const v3 = (await prisma.supplierApplication.findUniqueOrThrow({ where: { id: a.app.id } })).version
    expect(await submitApplication(a.ctx, { applicationId: a.app.id, expectedVersion: v3 }, key())).toMatchObject({ ok: true })
  })

  it('[BR-AI-29] a tax id that is not the application’s fails its check: confidence 0, confirmed one by one, a FAIL shown', async () => {
    const a = await application()
    const bytes = PNG('mismatch')
    answerFor(bytes, read({ nameTh: a.name, taxId: '0999998020028' }))
    const doc = await upload(a.ctx, a.app.id, 'COMPANY_CERT', bytes)
    await requestSupplierDocumentRead(org.organizationId, doc.documentId, NOW)
    const actionId = (await prisma.agentAction.findFirstOrThrow({ where: { subjectId: a.app.id } })).id
    await readOf(actionId)
    const action = await prisma.agentAction.findUniqueOrThrow({ where: { id: actionId } })
    expect((action.fieldConfidence as Record<string, number>).taxId).toBe(0)
    expect((action.verification as { checks: { code: string; result: string }[] }).checks).toEqual(expect.arrayContaining([{ code: 'TAXID_MISMATCH', result: 'FAIL' }]))
    expect((await listPortalAiReadings(a.ctx))[0]?.fields.find((f) => f.path === 'taxId')).toMatchObject({ check: 'FAIL', mustConfirm: true })
  })
})

describe('[FR-AI-304/AC2] the reading as the review of S7-14 found it should be', () => {
  type Made = Awaited<ReturnType<typeof application>>
  async function readingOf(over: Record<string, unknown> | ((a: Made) => Record<string, unknown>), before?: (a: Made) => Promise<void>) {
    const a = await application()
    const bytes = PNG(`review-${randomUUID()}`)
    answerFor(bytes, read({ nameTh: a.name, taxId: a.app.taxId, ...(typeof over === 'function' ? over(a) : over) }))
    const doc = await upload(a.ctx, a.app.id, 'COMPANY_CERT', bytes)
    await requestSupplierDocumentRead(org.organizationId, doc.documentId, NOW)
    const actionId = (await prisma.agentAction.findFirstOrThrow({ where: { subjectId: a.app.id } })).id
    if (before) await before(a)
    const outcome = await readOf(actionId)
    return { a, actionId, outcome, action: await prisma.agentAction.findUniqueOrThrow({ where: { id: actionId } }) }
  }
  const checksOf = (action: { verification: unknown }) => Object.fromEntries(((action.verification as { checks?: { code: string; result: string }[] } | null)?.checks ?? []).map((c) => [c.code, c.result]))

  it('[BR-AI-29] the registries as the routing kept them (registryData = { mode, rd, dbd }): the name read is compared with DBD’s', async () => {
    const r = await readingOf({}, async (a) => {
      const record = { nameTh: 'บริษัท ชื่ออื่นตามทะเบียน จำกัด', address: '1 ถนนทะเบียน' }
      await prisma.supplierApplication.update({ where: { id: a.app.id }, data: { registryData: { mode: 'stub', rd: { status: 'FOUND', record }, dbd: { status: 'FOUND', record } } } })
    })
    expect(r.outcome).toBe('DRAFT')
    expect(checksOf(r.action)).toMatchObject({ REGISTRY_NAME_MISMATCH: 'WARN' })
  })

  it('[BR-AI-18] [OQ-186] a bank book sent as a company certificate: no bank, no account name, no number kept off it', async () => {
    const r = await readingOf({ docType: 'BANK_BOOK', bankName: 'ธนาคารกสิกรไทย', accountName: 'บริษัท ทดสอบ จำกัด', documentNumber: '1234567890' })
    expect(r.outcome).toBe('DRAFT')
    const review = r.action.review as { proposed: Record<string, string> }
    expect(review.proposed).not.toHaveProperty('bankCode')
    expect(review.proposed).not.toHaveProperty('accountName')
    expect((r.action.output as { reading: Record<string, unknown> }).reading).toMatchObject({ bankName: null, accountName: null, documentNumber: null })
    expect(JSON.stringify(r.action.output)).not.toContain('1234567890')
  })

  it('a date that is no date (day and month swapped) is read without a crash and without its date checks; an expired certificate is shown above the values', async () => {
    const swapped = await readingOf({ issuedOn: '2026-25-10' })
    expect(swapped.outcome).toBe('DRAFT')
    expect(checksOf(swapped.action)).not.toHaveProperty('DOC_EXPIRED')
    const expired = await readingOf({ issuedOn: '2026-01-05' })
    expect(checksOf(expired.action)).toMatchObject({ DOC_EXPIRED: 'FAIL' })
    expect((await listPortalAiReadings(expired.a.ctx))[0]?.documentChecks).toEqual(['DOC_EXPIRED'])
    expect((await listApplicationAiReadings(org.ctxOf('proc_officer', NOW), expired.a.app.id))[0]?.documentChecks).toEqual(['DOC_EXPIRED'])
  })

  it('values proposed as the form takes them: the tax id as 13 digits, a branch that is not 5 digits not proposed', async () => {
    const dashed = (d: string) => `${d[0]}-${d.slice(1, 5)}-${d.slice(5, 10)}-${d.slice(10, 12)}-${d[12]}`
    const r = await readingOf((a) => ({ taxId: dashed(a.app.taxId!), branchCode: 'สำนักงานใหญ่' }))
    expect(r.outcome).toBe('DRAFT')
    const review = r.action.review as { proposed: Record<string, string> }
    expect(review.proposed.taxId).toBe(r.a.app.taxId)
    expect(review.proposed).not.toHaveProperty('branchCode')
  })

  it('an application sent or closed before the run: the AI is not called and the action fails SUBJECT_CLOSED with no credits', async () => {
    const r = await readingOf({}, async (a) => {
      await prisma.supplierApplication.update({ where: { id: a.app.id }, data: { status: 'CANCELLED' } })
    })
    expect(r.outcome).toBe('FAILED')
    expect(r.action).toMatchObject({ status: 'FAILED', errorCode: 'SUBJECT_CLOSED', costCredits: 0, model: null })
  })
})

describe('[FR-AI-304/AC4] the AI never decides; only the supplier’s own subject takes a contact', () => {
  it('a contact cannot take AI values into a document that does not let a supplier (a request)', async () => {
    const a = await application()
    const r = await forTenant(org.organizationId).$transaction((tx) => applyAiAssist(tx, a.ctx, { type: 'REQUEST', id: randomUUID() }, { agentActionId: randomUUID(), confirmedPaths: [] }))
    expect(r).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
  })

  it('[INV-AI-05] the portal and the supplier services never import the AI adapter', () => {
    const root = path.resolve(import.meta.dirname, '..', '..', 'src', 'server')
    const files = [...readdirSync(path.join(root, 'portal')).map((f) => path.join(root, 'portal', f)), ...readdirSync(path.join(root, 'services', 'suppliers')).map((f) => path.join(root, 'services', 'suppliers', f))].filter((f) => f.endsWith('.ts'))
    for (const f of files) expect(readFileSync(f, 'utf8'), f).not.toMatch(/@\/integrations\/ai/)
  })
})

describe('[FR-AI-304/AC6] [EG-1] with the AI off, nothing is read and the application is filled by hand', () => {
  it('AI_ENABLED false: no action, no reading on the portal, the application sent as typed', async () => {
    setAiRuntimeForTests({ ...FIXTURE, enabled: false })
    const a = await application()
    const doc = await upload(a.ctx, a.app.id, 'COMPANY_CERT', PNG('off'))
    expect(await requestSupplierDocumentRead(org.organizationId, doc.documentId, NOW)).toMatch(/^SKIPPED_/)
    expect(await listPortalAiReadings(a.ctx)).toEqual([])
    const v = (await prisma.supplierApplication.findUniqueOrThrow({ where: { id: a.app.id } })).version
    expect(await updateApplication(a.ctx, { applicationId: a.app.id, expectedVersion: v, fields: { address: '1 ถนนทดสอบ', isVatRegistered: true } }, key())).toMatchObject({ ok: true })
    const v2 = (await prisma.supplierApplication.findUniqueOrThrow({ where: { id: a.app.id } })).version
    expect(await submitApplication(a.ctx, { applicationId: a.app.id, expectedVersion: v2 }, key())).toMatchObject({ ok: true })
  })
})
