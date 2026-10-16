import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '@/server/db/client'
import { draftFormVersion, getFormBuilder, publishFormDraft, updateFormDraft } from '@/server/services/request-types/form-builder'
import { createDraft } from '../support/requests'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'

// S6-14 (FR-INT-104 · BR-FORM-09 · OQ-115): the no-code form builder against Postgres, on the demo forms (HIRE_SERVICE
// asks processesPersonalData, which ATT-DPA reads). ORG_ADMIN copies the form in use into one draft, edits it — a save
// that removes a field a rule reads is refused — and publishes: the version before it retires, a request made before
// keeps its version and a new one takes the new version; new attachment rules reach every AUDITOR. Every change of state
// has its event; another member is refused.

const NOW = new Date('2026-10-06T03:00:00Z')
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const ok = <T,>(r: { ok: true; data: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.data
}

let org: DoaOrg
const admin = () => org.ctxOf('admin', NOW)
const typeId = async () => (await prisma.requestType.findFirstOrThrow({ where: { organizationId: org.organizationId, code: 'HIRE_SERVICE' } })).id

beforeAll(async () => {
  org = await createDoaOrg()
  await prisma.roleAssignment.createMany({
    data: [
      { organizationId: org.organizationId, memberId: org.member.admin!, role: 'ORG_ADMIN', grantedAt: NOW },
      { organizationId: org.organizationId, memberId: org.member.auditor!, role: 'AUDITOR', grantedAt: NOW },
    ],
  })
})

describe('[FR-INT-104/AC1] [FR-INT-104/AC2] draft, edit and publish a form version (BR-FORM-09)', () => {
  it('drafts one copy of the form in use; a second draft is refused; another member is refused', async () => {
    expect(await draftFormVersion(org.ctxOf('req_con', NOW), { code: 'HIRE_SERVICE' }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    const draft = ok(await draftFormVersion(admin(), { code: 'HIRE_SERVICE' }, key()))
    const current = await prisma.formVersion.findFirstOrThrow({ where: { requestTypeId: await typeId(), status: 'PUBLISHED' } })
    expect(await prisma.formVersion.findUniqueOrThrow({ where: { id: draft.versionId } })).toMatchObject({ status: 'DRAFT', versionNo: current.versionNo + 1, schema: current.schema })
    expect(await draftFormVersion(admin(), { code: 'HIRE_SERVICE' }, key())).toMatchObject({ ok: false, error: { details: { reason: 'DRAFT_EXISTS', versionId: draft.versionId } } })
    expect(await prisma.event.findFirst({ where: { type: 'form_version.drafted', aggregateId: draft.versionId } })).toMatchObject({ data: { via: 'ADMIN', fromVersionNo: current.versionNo } })
  })

  it('a save that removes a field ATT-DPA reads is refused (GC-FORM-22); adding a question saves', async () => {
    const builder = ok(await getFormBuilder(admin(), 'HIRE_SERVICE'))
    const form = builder.draft!.form
    const removed = { ...form, fields: form.fields.filter((f) => f.id !== 'processesPersonalData') }
    expect(await updateFormDraft(admin(), { versionId: builder.draft!.id, json: JSON.stringify(removed) }, key())).toMatchObject({
      ok: false,
      error: { details: { reason: 'FORM_LINT_FAILED', errors: [{ code: 'FORM_LINT_REFERENCED_FIELD', field: 'processesPersonalData', by: expect.arrayContaining(['ATT-DPA']) }] } },
    })
    const added = { ...form, fields: [...form.fields, { id: 'siteContact', type: 'text', label: { th: 'ผู้ประสานงานหน้างาน', en: 'Site contact' } }] }
    ok(await updateFormDraft(admin(), { versionId: builder.draft!.id, json: JSON.stringify(added) }, key()))
    expect(await prisma.event.findFirst({ where: { type: 'form_version.updated', aggregateId: builder.draft!.id } })).toMatchObject({ data: { fields: added.fields.length } })
  })

  it('publishes: the version before it retires, a request made before keeps its version and a new one takes the new one', async () => {
    const before = ok(await createDraft(org.ctxOf('req_con', NOW), { requestTypeCode: 'HIRE_SERVICE', title: 'จ้างก่อนฉบับใหม่', lines: [{ description: 'งานบริการ', quantity: '1', uom: 'งาน', unitPrice: '1000.00' }] }, key()))
    const old = await prisma.formVersion.findFirstOrThrow({ where: { requestTypeId: await typeId(), status: 'PUBLISHED' } })
    const builder = ok(await getFormBuilder(admin(), 'HIRE_SERVICE'))
    const published = ok(await publishFormDraft(admin(), { versionId: builder.draft!.id }, key()))
    expect(await prisma.formVersion.findUniqueOrThrow({ where: { id: old.id } })).toMatchObject({ status: 'RETIRED' })
    expect(await prisma.formVersion.findUniqueOrThrow({ where: { id: published.versionId } })).toMatchObject({ status: 'PUBLISHED', publishedById: org.member.admin })
    expect(await prisma.event.findFirst({ where: { type: 'form_version.retired', aggregateId: old.id } })).toMatchObject({ data: { byVersionNo: published.versionNo } })
    expect(await prisma.event.findFirst({ where: { type: 'form_version.published', aggregateId: published.versionId } })).toMatchObject({ data: { via: 'ADMIN', attachmentRulesChanged: false } })
    expect(await prisma.request.findUniqueOrThrow({ where: { id: before.requestId } })).toMatchObject({ formVersionId: old.id })
    const after = ok(await createDraft(org.ctxOf('req_con', NOW), { requestTypeCode: 'HIRE_SERVICE', title: 'จ้างหลังฉบับใหม่', lines: [{ description: 'งานบริการ', quantity: '1', uom: 'งาน', unitPrice: '1000.00' }] }, key()))
    expect(await prisma.request.findUniqueOrThrow({ where: { id: after.requestId } })).toMatchObject({ formVersionId: published.versionId })
    // Only new questions: no attachment rule changed, nobody is told
    expect(await prisma.notification.count({ where: { organizationId: org.organizationId, templateKey: 'audit.policy_changed' } })).toBe(0)
    // A published version is not edited or published again
    expect(await updateFormDraft(admin(), { versionId: published.versionId, json: JSON.stringify(builder.draft!.form) }, key())).toMatchObject({ ok: false, error: { code: 'INVALID_STATE_TRANSITION' } })
    expect(await publishFormDraft(admin(), { versionId: published.versionId }, key())).toMatchObject({ ok: false, error: { code: 'INVALID_STATE_TRANSITION' } })
  })
})

describe('[FR-INT-104/AC3] new attachment rules reach every AUDITOR at once (OQ-115)', () => {
  it('a version whose attachment rules change tells the AUDITOR; the same form again is nothing to publish', async () => {
    const draft = ok(await draftFormVersion(admin(), { code: 'HIRE_SERVICE' }, key()))
    const form = ok(await getFormBuilder(admin(), 'HIRE_SERVICE')).draft!.form
    expect(await publishFormDraft(admin(), { versionId: draft.versionId }, key())).toMatchObject({ ok: false, error: { details: { reason: 'NO_CHANGE' } } })
    const stricter = { ...form, rules: [...form.rules, { id: 'ATT-SITE', when: { field: 'siteContact', op: 'notEmpty' }, require: { attachments: 'QUOTATION', min: 1 } }] }
    ok(await updateFormDraft(admin(), { versionId: draft.versionId, json: JSON.stringify(stricter) }, key()))
    ok(await publishFormDraft(admin(), { versionId: draft.versionId }, key()))
    expect(await prisma.notification.findMany({ where: { organizationId: org.organizationId, templateKey: 'audit.policy_changed' }, select: { recipientMemberId: true, data: true } })).toEqual([
      { recipientMemberId: org.member.auditor, data: expect.objectContaining({ change: 'FORM_ATTACHMENT_RULES', requestTypeCode: 'HIRE_SERVICE' }) },
    ])
    expect(await prisma.event.findFirst({ where: { type: 'form_version.published', aggregateId: draft.versionId } })).toMatchObject({ data: { attachmentRulesChanged: true } })
  })
})
