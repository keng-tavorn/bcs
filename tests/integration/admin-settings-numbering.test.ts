import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { OrgSettings } from '@/lib/org-settings'
import { makeCtx, type Ctx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { forTenant } from '@/server/db/tenant'
import { issueDocumentNumber } from '@/server/services/numbering'
import { getNumberingAdminView, patternRefusal, previewNumbering } from '@/server/services/numbering/admin'
import { saveNumberingRule } from '@/server/services/numbering/save-rule'
import { saveOrgSettings } from '@/server/services/organization/settings'
import { createDraft, submitRequest } from '@/server/services/requests'
import { createDoaOrg } from '../support/doa-org'

// S2-13 · FR-ADM-004 (BR-NUM-01..03, INV-NUM-01): the admin sees the next number of each document before saving a
// pattern (AC1); an unknown token or a pattern without exactly one {SEQn} is VALIDATION_FAILED (AC2); a change in the
// middle of the year opens a new counter scope that never re-issues a number (AC3).

// Monday 5 Oct 2026 10:00 Thai time: BE 2569, month 10
const NOW = new Date('2026-10-05T03:00:00Z')
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
type Numbering = OrgSettings['numbering']

async function setup() {
  const org = await createDoaOrg()
  await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: org.member.admin!, role: 'ORG_ADMIN', grantedAt: NOW } })
  const admin: Ctx = makeCtx({ organizationId: org.organizationId, actor: { type: 'USER', memberId: org.member.admin! }, channel: 'WEB', now: NOW })
  const numbering = async () => ((await prisma.organization.findUniqueOrThrow({ where: { id: org.organizationId } })).settings as { numbering: Numbering }).numbering
  const save = async (document: keyof Numbering, rule: Numbering['PR']) => saveOrgSettings(admin, { section: 'numbering', value: { ...(await numbering()), [document]: rule } }, key())
  /** A request of req_con submitted through the real flow, so its number is in Request.number */
  const submitted = async (grossBaht = '5000.00') => {
    const ctx = org.ctxOf('req_con', NOW)
    const draft = await createDraft(ctx, { requestTypeCode: 'BUY_GOODS', title: 'วัสดุ', priceIncludesVat: true, lines: [{ description: 'วัสดุ', quantity: '1', uom: 'งาน', unitPrice: grossBaht }] }, key())
    if (!draft.ok) throw new Error(`draft failed: ${draft.error.code}`)
    const sent = await submitRequest(ctx, { requestId: draft.data.requestId }, key())
    if (!sent.ok) throw new Error(`submit failed: ${sent.error.code}`)
    return sent.data.number
  }
  const issue = (document: keyof Numbering, department?: string) => forTenant(org.organizationId).$transaction((tx) => issueDocumentNumber(tx, makeCtx({ ...admin, now: NOW }), { document, department }))
  return { org, admin, numbering, save, submitted, issue }
}

describe('[FR-ADM-004/AC1] the next number shows before a pattern is saved', () => {
  it('shows the next number of every document, and of an edited pattern before it is saved', async () => {
    const { admin, save, submitted, issue } = await setup()
    const view = await getNumberingAdminView(admin)
    expect(view).toMatchObject({ ok: true })
    if (!view.ok) return
    expect(view.data.documents.map((d) => [d.document, d.pattern, d.reset, d.nextNumber, d.continues, d.refusal])).toEqual([
      ['PR', 'PR-{BE}-{SEQ5}', 'YEARLY', 'PR-2569-00001', false, null],
      ['PO', 'PO-{BE}-{SEQ5}', 'YEARLY', 'PO-2569-00001', false, null],
      ['GR', 'GR-{BE}-{SEQ5}', 'YEARLY', 'GR-2569-00001', false, null],
      ['RQ', 'RQ-{BE}-{SEQ5}', 'YEARLY', 'RQ-2569-00001', false, null],
    ])
    expect(view.data.departments).toEqual(['CON', 'FIN', 'HQ', 'IT', 'OPS', 'PROC', 'SUP'])

    expect(await submitted()).toBe('PR-2569-00001')
    expect(await previewNumbering(admin, { document: 'PR', pattern: 'PR-{BE}-{SEQ5}', reset: 'YEARLY' })).toMatchObject({ ok: true, data: { nextNumber: 'PR-2569-00002', continues: true, refusal: null } })
    // An edit before saving: a {DEPT} pattern shows the department asked for (or the first one)
    expect(await previewNumbering(admin, { document: 'GR', pattern: 'GR-{DEPT}-{YY}{MM}-{SEQ3}', reset: 'MONTHLY', department: 'IT' })).toMatchObject({
      ok: true,
      data: { nextNumber: 'GR-IT-6910-001', continues: false, department: 'IT', refusal: null },
    })
    expect(await previewNumbering(admin, { document: 'GR', pattern: 'GR-{DEPT}-{YY}{MM}-{SEQ3}', reset: 'MONTHLY', department: 'NOPE' })).toMatchObject({ ok: true, data: { nextNumber: 'GR-CON-6910-001', department: 'CON' } })

    // What the preview said is what is issued after the save
    const preview = await previewNumbering(admin, { document: 'PO', pattern: 'PO{YY}{MM}-{SEQ4}', reset: 'MONTHLY' })
    expect(preview).toMatchObject({ ok: true, data: { nextNumber: 'PO6910-0001', continues: false } })
    expect(await save('PO', { pattern: 'PO{YY}{MM}-{SEQ4}', reset: 'MONTHLY' })).toMatchObject({ ok: true })
    expect(await issue('PO')).toBe('PO6910-0001')
  })

  it('a member without admin.numbering sees neither the page nor a preview (deny)', async () => {
    const { org } = await setup()
    const member = org.ctxOf('proc_officer', NOW)
    expect(await getNumberingAdminView(member)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await previewNumbering(member, { document: 'PR', pattern: 'X-{SEQ3}', reset: 'NEVER' })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
  })
})

describe('[FR-ADM-004/AC2] a pattern without {SEQn} or with an unknown token is VALIDATION_FAILED', () => {
  it.each([
    ['PO-{BEE}-{SEQ5}', { reason: 'UNKNOWN_TOKEN', tokens: ['{BEE}'] }],
    ['PO-{BE-{SEQ5}', { reason: 'UNKNOWN_TOKEN', tokens: ['{BE-'] }],
    ['PO}-{BE}-{SEQ5}', { reason: 'UNKNOWN_TOKEN', tokens: ['}'] }],
    ['PO-{BE}', { reason: 'SEQ_MISSING' }],
    ['PO-{BE}-{SEQ3}-{SEQ2}', { reason: 'SEQ_REPEATED' }],
    ['PO-{BE}-{SEQ0}', { reason: 'SEQ_WIDTH' }],
  ])('refuses %s in the preview and when it is saved, and keeps the stored pattern', async (pattern, refusal) => {
    const { admin, numbering, save } = await setup()
    expect(await previewNumbering(admin, { document: 'PO', pattern, reset: 'YEARLY' })).toEqual({ ok: true, data: expect.objectContaining({ nextNumber: null, refusal }) })
    const before = await numbering()
    expect(await save('PO', { pattern, reset: 'YEARLY' })).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { field: 'settings.numbering.PO.pattern', ...refusal } } })
    expect(await numbering()).toEqual(before)
  })

  it('a member without admin.numbering cannot save a pattern (deny)', async () => {
    const { org, numbering } = await setup()
    const before = await numbering()
    const result = await saveOrgSettings(org.ctxOf('dm_proc', NOW), { section: 'numbering', value: { ...before, PO: { pattern: 'PO-{SEQ3}', reset: 'NEVER' } } }, key())
    expect(result).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await numbering()).toEqual(before)
  })
})

describe('[FR-ADM-004/AC1] [FR-ADM-004/AC2] the page saves one document’s rule at a time (saveNumberingRule)', () => {
  it('saves the rule of one document with an event and keeps the others as stored', async () => {
    const { org, admin, numbering, issue } = await setup()
    const before = await numbering()
    expect(await saveNumberingRule(admin, { document: 'PO', pattern: ' PO{YY}{MM}-{SEQ4} ', reset: 'MONTHLY' }, key())).toMatchObject({ ok: true })
    expect(await numbering()).toEqual({ ...before, PO: { pattern: 'PO{YY}{MM}-{SEQ4}', reset: 'MONTHLY' } })
    expect(await issue('PO')).toBe('PO6910-0001')
    const events = await prisma.event.findMany({ where: { organizationId: org.organizationId, type: 'organization.settings_updated' } })
    expect(events.map((e) => [e.data, e.actorMemberId])).toEqual([[{ section: 'numbering' }, org.member.admin]])
  })

  it('two admins saving different documents at the same time both keep their rule (no lost update)', async () => {
    const { org, admin, numbering } = await setup()
    await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: org.member.admin2!, role: 'ORG_ADMIN', grantedAt: NOW } })
    const other: Ctx = makeCtx({ organizationId: org.organizationId, actor: { type: 'USER', memberId: org.member.admin2! }, channel: 'WEB', now: NOW })
    // Both pages were opened on the same stored rules; each sends only its own document
    const before = await numbering()
    const [po, gr] = await Promise.all([
      saveNumberingRule(admin, { document: 'PO', pattern: 'PO-{BE}-{SEQ4}', reset: 'YEARLY' }, key()),
      saveNumberingRule(other, { document: 'GR', pattern: 'GR-{DEPT}-{YY}-{SEQ3}', reset: 'YEARLY' }, key()),
    ])
    expect([po.ok, gr.ok]).toEqual([true, true])
    // And one after the other from the same page state: the later save never puts back what the first changed
    expect(await saveNumberingRule(other, { document: 'RQ', pattern: 'SR-{BE}-{SEQ4}', reset: 'YEARLY' }, key())).toMatchObject({ ok: true })
    expect(await numbering()).toEqual({
      PR: before.PR,
      PO: { pattern: 'PO-{BE}-{SEQ4}', reset: 'YEARLY' },
      GR: { pattern: 'GR-{DEPT}-{YY}-{SEQ3}', reset: 'YEARLY' },
      RQ: { pattern: 'SR-{BE}-{SEQ4}', reset: 'YEARLY' },
    })
  })

  it('refuses an unknown code or a document it does not know, and keeps the stored rules', async () => {
    const { admin, numbering } = await setup()
    const before = await numbering()
    expect(await saveNumberingRule(admin, { document: 'PO', pattern: 'PO-{BEE}-{SEQ5}', reset: 'YEARLY' }, key())).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_FAILED', details: { field: 'settings.numbering.PO.pattern', reason: 'UNKNOWN_TOKEN', tokens: ['{BEE}'] } },
    })
    expect(await saveNumberingRule(admin, { document: 'XX' as 'PO', pattern: 'X-{SEQ3}', reset: 'NEVER' }, key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { field: 'document' } } })
    expect(await saveNumberingRule(admin, { document: 'PO', pattern: '   ', reset: 'NEVER' }, key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { field: 'pattern' } } })
    // A document rule belongs to the numbering section only
    expect(await saveOrgSettings(admin, { section: 'businessCalendar', document: 'PO', value: { pattern: 'PO-{SEQ3}', reset: 'NEVER' } }, key())).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_FAILED', details: { field: 'document' } },
    })
    expect(await numbering()).toEqual(before)
  })

  it('a member without admin.numbering cannot save a rule through the page’s path either (deny)', async () => {
    const { org, numbering } = await setup()
    const before = await numbering()
    expect(await saveNumberingRule(org.ctxOf('req_con', NOW), { document: 'PO', pattern: 'PO-{SEQ3}', reset: 'NEVER' }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await saveNumberingRule(org.ctxOf('dm_proc', NOW), { document: 'GR', pattern: 'GR-{BE}-{SEQ3}', reset: 'YEARLY' }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await numbering()).toEqual(before)
    expect(await prisma.event.count({ where: { organizationId: org.organizationId, type: 'organization.settings_updated' } })).toBe(0)
  })
})

describe('[FR-ADM-004/AC3] a change in the middle of the year opens a new scope and never re-issues a number (INV-NUM-01)', () => {
  it('numbers go on in a new monthly scope, and the yearly counter goes on where it stopped when it comes back', async () => {
    const { org, admin, save, submitted } = await setup()
    expect([await submitted(), await submitted()]).toEqual(['PR-2569-00001', 'PR-2569-00002'])

    // Monthly numbers carry the month, so their scope PR:2569-10 starts at 1 without meeting PR-2569-0000n
    expect(await previewNumbering(admin, { document: 'PR', pattern: 'PR-{BE}{MM}-{SEQ4}', reset: 'MONTHLY' })).toMatchObject({ ok: true, data: { nextNumber: 'PR-256910-0001', continues: false, refusal: null } })
    expect(await save('PR', { pattern: 'PR-{BE}{MM}-{SEQ4}', reset: 'MONTHLY' })).toMatchObject({ ok: true })
    expect([await submitted(), await submitted()]).toEqual(['PR-256910-0001', 'PR-256910-0002'])

    // Back to the yearly pattern: its scope PR:2569 goes on from 3
    expect(await previewNumbering(admin, { document: 'PR', pattern: 'PR-{BE}-{SEQ5}', reset: 'YEARLY' })).toMatchObject({ ok: true, data: { nextNumber: 'PR-2569-00003', continues: true } })
    expect(await save('PR', { pattern: 'PR-{BE}-{SEQ5}', reset: 'YEARLY' })).toMatchObject({ ok: true })
    expect(await submitted()).toBe('PR-2569-00003')

    const numbers = (await prisma.request.findMany({ where: { organizationId: org.organizationId, number: { not: null } }, select: { number: true } })).map((r) => r.number)
    expect(new Set(numbers).size).toBe(numbers.length)
    const scopes = await prisma.documentSequence.findMany({ where: { organizationId: org.organizationId }, orderBy: { scopeKey: 'asc' }, select: { scopeKey: true, nextValue: true } })
    expect(scopes).toEqual([
      { scopeKey: 'PR:2569', nextValue: 4 },
      { scopeKey: 'PR:2569-10', nextValue: 3 },
    ])
  })

  it('a new pattern in the same scope goes on with the same counter', async () => {
    const { admin, save, submitted } = await setup()
    expect(await submitted()).toBe('PR-2569-00001')
    // A narrower number in the same yearly scope: PR-2569-0002, never PR-2569-0001 again
    expect(await previewNumbering(admin, { document: 'PR', pattern: 'PR-{BE}-{SEQ4}', reset: 'YEARLY' })).toMatchObject({ ok: true, data: { nextNumber: 'PR-2569-0002', continues: true, refusal: null } })
    expect(await save('PR', { pattern: 'PR-{BE}-{SEQ4}', reset: 'YEARLY' })).toMatchObject({ ok: true })
    expect(await submitted()).toBe('PR-2569-0002')
  })

  it.each([
    ['monthly numbers that do not show the month', { pattern: 'PR-{BE}-{SEQ5}', reset: 'MONTHLY' }, { reason: 'MONTH_MISSING' }],
    ['yearly numbers that do not show the year', { pattern: 'PR-{SEQ5}', reset: 'YEARLY' }, { reason: 'YEAR_MISSING' }],
    ['a counter that starts again on numbers already issued', { pattern: 'PR-{BE}-{SEQ5}', reset: 'NEVER' }, { reason: 'NUMBER_COLLISION', example: 'PR-2569-00001' }],
  ] as const)('refuses %s', async (_label, rule, refusal) => {
    const { admin, numbering, save, submitted } = await setup()
    expect(await submitted()).toBe('PR-2569-00001')
    expect(await previewNumbering(admin, { document: 'PR', ...rule })).toMatchObject({ ok: true, data: { refusal } })
    const before = await numbering()
    expect(await save('PR', rule)).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { field: 'settings.numbering.PR.pattern', ...refusal } } })
    expect(await numbering()).toEqual(before)
  })

  it('refuses an RQ pattern that can issue PR numbers: both live in Request.number', async () => {
    const { admin, save } = await setup()
    expect(await previewNumbering(admin, { document: 'RQ', pattern: 'PR-{BE}-{SEQ5}', reset: 'YEARLY' })).toMatchObject({
      ok: true,
      data: { refusal: { reason: 'OVERLAPS_OTHER_DOCUMENT', other: 'PR', example: 'PR-2569-00001' } },
    })
    expect(await save('RQ', { pattern: 'PR-{BE}-{SEQ4}', reset: 'YEARLY' })).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_FAILED', details: { field: 'settings.numbering.RQ.pattern', reason: 'OVERLAPS_OTHER_DOCUMENT', other: 'PR' } },
    })
    // A pattern of its own is fine
    expect(await save('RQ', { pattern: 'SR-{BE}-{SEQ4}', reset: 'YEARLY' })).toMatchObject({ ok: true })
  })

  it('finds an issued number again when the pattern has characters SQL LIKE treats as special (_ % \\)', async () => {
    const { admin, numbering, save, submitted } = await setup()
    expect(await save('PR', { pattern: 'PR_{BE}%\\{SEQ5}', reset: 'YEARLY' })).toMatchObject({ ok: true })
    expect(await submitted()).toBe('PR_2569%\\00001')
    // Counting on without a reset would issue PR_2569%\00001 again: the database filter must not hide it
    const refusal = { reason: 'NUMBER_COLLISION', example: 'PR_2569%\\00001' }
    expect(await previewNumbering(admin, { document: 'PR', pattern: 'PR_{BE}%\\{SEQ5}', reset: 'NEVER' })).toMatchObject({ ok: true, data: { refusal } })
    const before = await numbering()
    expect(await save('PR', { pattern: 'PR_{BE}%\\{SEQ5}', reset: 'NEVER' })).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: refusal } })
    expect(await numbering()).toEqual(before)
  })

  it('checks a rule on its own the same way for every document', () => {
    expect(patternRefusal({ pattern: 'GR-{DEPT}-{YY}{MM}-{SEQ3}', reset: 'MONTHLY' })).toBeNull()
    expect(patternRefusal({ pattern: 'X-{SEQ6}', reset: 'NEVER' })).toBeNull()
    expect(patternRefusal({ pattern: 'X-{CE}-{SEQ6}', reset: 'YEARLY' })).toBeNull()
    expect(patternRefusal({ pattern: 'X-{seq6}', reset: 'NEVER' })).toEqual({ reason: 'UNKNOWN_TOKEN', tokens: ['{seq6}'] })
  })
})
