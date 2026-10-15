import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { makeCtx, type Ctx } from '@/server/context'
import { prisma } from '@/server/db/client'
import {
  checkFormImport,
  currentFormJson,
  getRequestTypeForAdmin,
  listRequestTypesForAdmin,
  moveRequestType,
  publishFormVersion,
  setRequestTypeActive,
} from '@/server/services/request-types'
import { ATTACHMENT_KINDS, FINANCE_ONLY_KINDS, parseFormJson } from '@/server/services/request-types/form-import'
import { listRequestCatalog } from '@/server/queries/request-form'
import { getRequestView } from '@/server/queries/requests'
import { createDraft, submitRequest } from '@/server/services/requests'
import { getNewRequestForm, getRequestForEdit } from '@/server/services/requests/form-view'
import { createDoaOrg } from '../support/doa-org'

// S2-13 · FR-ADM-005 (§7.9): ORG_ADMIN imports a request form as JSON checked against the form schema and publishes it
// as the type's next version (AC1); switches types on and off and orders the catalog (AC2); requests made before keep
// the form version they were made with (AC3).

const NOW = new Date('2026-10-05T03:00:00Z')
const key = () => ({ idempotencyKey: randomUUID(), sender: null })

async function setup() {
  const org = await createDoaOrg()
  await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: org.member.admin!, role: 'ORG_ADMIN', grantedAt: NOW } })
  const admin: Ctx = makeCtx({ organizationId: org.organizationId, actor: { type: 'USER', memberId: org.member.admin! }, channel: 'WEB', now: NOW })
  return { org, admin }
}

/** The form of BUY_GOODS (tests/support/doa-org.ts) with one more required field */
async function buyGoodsWith(admin: Ctx, extraField: Record<string, unknown>) {
  const current = await currentFormJson(admin, 'BUY_GOODS')
  if (!current.ok) throw new Error('no current form')
  const form = JSON.parse(current.data.json) as { fields: unknown[] }
  return JSON.stringify({ ...form, fields: [...form.fields, extraField] })
}

const SITE = { id: 'deliverySiteNote', type: 'text', required: true, label: { th: 'สถานที่ส่งของ', en: 'Delivery place' } }

describe('[FR-ADM-005/AC1] a form is imported as JSON, checked against the form schema and published as the next version', () => {
  it('reports each problem with its place and publishes nothing until the JSON is right', async () => {
    const { org, admin } = await setup()
    const check = (json: string) => checkFormImport(admin, { code: 'BUY_GOODS', json })
    expect(await check('')).toEqual({ ok: true, data: { valid: false, problems: [{ reason: 'EMPTY' }] } })
    expect(await check('{ "fields": [ ')).toEqual({ ok: true, data: { valid: false, problems: [{ reason: 'JSON_SYNTAX' }] } })
    expect(await check(JSON.stringify({ fields: [{ id: 'a', type: 'colour' }], extra: 1 }))).toEqual({
      ok: true,
      data: {
        valid: false,
        problems: expect.arrayContaining([
          { reason: 'SCHEMA', issue: 'VALUE', path: 'fields[0].type' },
          { reason: 'SCHEMA', issue: 'UNKNOWN_KEY', path: '(form)', keys: ['extra'] },
        ]),
      },
    })
    const meaning = await check(
      JSON.stringify({
        fields: [
          { id: 'note', type: 'text' },
          { id: 'note', type: 'textarea' },
        ],
        visibility: [{ field: 'assetTag', when: { field: 'category', op: 'eq', value: 'HARDWARE' } }],
        rules: [
          { id: 'R1', when: { field: '$amountGross', op: 'gt', value: '1.00' }, require: { attachments: 'QUOTE', min: 1 } },
          { id: 'R1', when: { all: [] }, require: { field: 'note', op: 'notEmpty' } },
        ],
      }),
    )
    expect(meaning).toEqual({
      ok: true,
      data: {
        valid: false,
        problems: [
          { reason: 'DUPLICATE_FIELD', field: 'note', path: 'fields[1].id' },
          { reason: 'DUPLICATE_RULE', rule: 'R1', path: 'rules[1].id' },
          { reason: 'UNKNOWN_FIELD', field: 'assetTag', path: 'visibility[0].field' },
          { reason: 'UNKNOWN_FIELD', field: 'category', path: 'visibility[0].when.field' },
          { reason: 'UNKNOWN_ATTACHMENT', attachment: 'QUOTE', path: 'rules[0].require.attachments' },
        ],
      },
    })
    const refused = await publishFormVersion(admin, { code: 'BUY_GOODS', json: '{ "fields": 1 }', basedOnVersionNo: 1 }, key())
    expect(refused).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { field: 'json', reason: 'FORM_INVALID', problems: [{ reason: 'SCHEMA', issue: 'TYPE', path: 'fields' }] } } })
    expect(await prisma.formVersion.count({ where: { organizationId: org.organizationId, requestType: { code: 'BUY_GOODS' } } })).toBe(1)
  })

  it('checks a good form, says what changes, then publishes version 2 with form_version.published via ADMIN', async () => {
    const { org, admin } = await setup()
    const json = await buyGoodsWith(admin, SITE)
    const checked = await checkFormImport(admin, { code: 'BUY_GOODS', json })
    expect(checked).toMatchObject({
      ok: true,
      data: {
        valid: true,
        noChange: false,
        basedOnVersionNo: 1,
        nextVersionNo: 2,
        changes: { addedFields: ['deliverySiteNote'], removedFields: [], changedFields: [], addedRules: [], removedRules: [], changedRules: [], visibilityChanged: false, linesChanged: false },
        summary: { rules: ['ATT-QUOTES'], fields: [{ id: 'singleSourceJustification', type: 'textarea', required: false }, { id: 'deliverySiteNote', type: 'text', required: true, label: SITE.label }] },
      },
    })
    expect(await publishFormVersion(admin, { code: 'BUY_GOODS', json, basedOnVersionNo: 1 }, key())).toEqual({ ok: true, data: { versionNo: 2 } })
    const type = await prisma.requestType.findFirstOrThrow({ where: { organizationId: org.organizationId, code: 'BUY_GOODS' }, include: { currentFormVersion: true } })
    expect(type.currentFormVersion).toMatchObject({ versionNo: 2, status: 'PUBLISHED', publishedAt: NOW, publishedById: org.member.admin })
    const events = await prisma.event.findMany({ where: { organizationId: org.organizationId, type: 'form_version.published' } })
    expect(events.map((e) => [e.aggregateType, e.aggregateId, e.data])).toEqual([['FormVersion', type.currentFormVersionId, { requestTypeCode: 'BUY_GOODS', versionNo: 2, via: 'ADMIN' }]])

    // The same form again is nothing to publish; a check made against version 1 is stale now
    expect(await checkFormImport(admin, { code: 'BUY_GOODS', json })).toMatchObject({ ok: true, data: { valid: true, noChange: true, basedOnVersionNo: 2, nextVersionNo: 3 } })
    expect(await publishFormVersion(admin, { code: 'BUY_GOODS', json, basedOnVersionNo: 2 }, key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'NO_CHANGE' } } })
    const other = await buyGoodsWith(admin, { id: 'other', type: 'text' })
    expect(await publishFormVersion(admin, { code: 'BUY_GOODS', json: other, basedOnVersionNo: 1 }, key())).toMatchObject({ ok: false, error: { code: 'CONFLICT_VERSION', details: { currentVersionNo: 2 } } })

    const detail = await getRequestTypeForAdmin(admin, 'BUY_GOODS')
    expect(detail).toMatchObject({ ok: true, data: { current: { versionNo: 2 }, versions: [{ versionNo: 2, current: true, publishedByName: 'ผู้ใช้ admin' }, { versionNo: 1, current: false }] } })
    expect(await getRequestTypeForAdmin(admin, 'NOPE')).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
  })

  it('reports JSON nested deeper than any form instead of failing (TOO_DEEP)', async () => {
    const { admin } = await setup()
    // Thousands of nested conditions used to exhaust the call stack of the schema check (written as text: even
    // JSON.stringify cannot nest that deep)
    const when = `${'{"all":['.repeat(5000)}{"field":"$amountGross","op":"gt","value":"1.00"}${']}'.repeat(5000)}`
    const deep = `{"fields":[],"visibility":[],"rules":[{"id":"R1","when":${when},"require":{"attachments":"QUOTATION","min":1}}]}`
    expect(parseFormJson(deep)).toEqual({ ok: false, problems: [{ reason: 'TOO_DEEP' }] })
    expect(await checkFormImport(admin, { code: 'BUY_GOODS', json: deep })).toEqual({ ok: true, data: { valid: false, problems: [{ reason: 'TOO_DEEP' }] } })
    expect(await checkFormImport(admin, { code: 'BUY_GOODS', json: `${'['.repeat(20000)}${']'.repeat(20000)}` })).toEqual({ ok: true, data: { valid: false, problems: [{ reason: 'TOO_DEEP' }] } })
    // Real forms nest a few levels and pass
    let shallow: unknown = { field: '$amountGross', op: 'gt', value: '1.00' }
    for (let i = 0; i < 5; i++) shallow = { any: [shallow] }
    expect(parseFormJson(JSON.stringify({ fields: [], visibility: [], rules: [{ id: 'R1', when: shallow, require: { attachments: 'QUOTATION', min: 1 } }] }))).toMatchObject({ ok: true })
  })

  it('names in attachment rules only kinds of file that can be attached (FileLinkKind)', async () => {
    const rows = await prisma.$queryRaw<Array<{ kind: string }>>`SELECT unnest(enum_range(NULL::"FileLinkKind"))::text AS kind`
    expect([...ATTACHMENT_KINDS, ...FINANCE_ONLY_KINDS].sort()).toEqual(rows.map((r) => r.kind).sort())
    // S9-01 review: a form never asks a requester for a 50 ทวิ or a bank proof
    expect(parseFormJson(JSON.stringify({ fields: [], visibility: [], rules: [{ id: 'R1', when: { field: '$amountGross', op: 'gt', value: '1.00' }, require: { attachments: 'BANK_PROOF', min: 1 } }] }))).toMatchObject({ ok: false, problems: [expect.objectContaining({ reason: 'UNKNOWN_ATTACHMENT', attachment: 'BANK_PROOF' })] })
  })

  it('only an organization admin may read, check or publish forms (deny)', async () => {
    const { org, admin } = await setup()
    const member = org.ctxOf('proc_officer', NOW)
    const json = await buyGoodsWith(admin, SITE)
    expect(await listRequestTypesForAdmin(member)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await getRequestTypeForAdmin(member, 'BUY_GOODS')).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await currentFormJson(member, 'BUY_GOODS')).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await checkFormImport(member, { code: 'BUY_GOODS', json })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await publishFormVersion(member, { code: 'BUY_GOODS', json, basedOnVersionNo: 1 }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await prisma.formVersion.count({ where: { organizationId: org.organizationId, requestType: { code: 'BUY_GOODS' } } })).toBe(1)
  })
})

describe('[FR-ADM-005/AC2] the admin switches request types on and off and orders the catalog', () => {
  it('switches a type off and on with an event each; requesters do not see or start the type while it is off', async () => {
    const { org, admin } = await setup()
    const requester = org.ctxOf('req_con', NOW)
    const catalog = async () => (await listRequestCatalog(requester, 'th')).map((t) => t.code)
    expect(await catalog()).toEqual(['BUY_GOODS', 'HIRE_SERVICE', 'IT_PURCHASE', 'NEW_SUPPLIER'])
    expect(await setRequestTypeActive(admin, { code: 'HIRE_SERVICE', active: false }, key())).toEqual({ ok: true, data: { code: 'HIRE_SERVICE', active: false } })
    // The requester's catalog (the new request page) no longer lists it, and a draft of it is refused
    expect(await catalog()).toEqual(['BUY_GOODS', 'IT_PURCHASE', 'NEW_SUPPLIER'])
    expect(await getNewRequestForm(requester, 'HIRE_SERVICE', 'th')).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
    const draft = await createDraft(requester, { requestTypeCode: 'HIRE_SERVICE', title: 'จ้างทำความสะอาด' }, key())
    expect(draft).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { field: 'requestTypeCode' } } })
    expect(await setRequestTypeActive(admin, { code: 'HIRE_SERVICE', active: false }, key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'NO_CHANGE' } } })
    expect(await setRequestTypeActive(admin, { code: 'HIRE_SERVICE', active: true }, key())).toMatchObject({ ok: true })
    expect(await catalog()).toEqual(['BUY_GOODS', 'HIRE_SERVICE', 'IT_PURCHASE', 'NEW_SUPPLIER'])
    const type = await prisma.requestType.findFirstOrThrow({ where: { organizationId: org.organizationId, code: 'HIRE_SERVICE' } })
    const events = await prisma.event.findMany({ where: { organizationId: org.organizationId, aggregateId: type.id, type: 'request_type.updated' }, orderBy: { seq: 'asc' } })
    expect(events.map((e) => e.data)).toEqual([
      { code: 'HIRE_SERVICE', changed: ['active'], active: false, sortOrder: type.sortOrder },
      { code: 'HIRE_SERVICE', changed: ['active'], active: true, sortOrder: type.sortOrder },
    ])
    expect(await setRequestTypeActive(admin, { code: 'NOPE', active: true }, key())).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
  })

  it('does not switch on a type that has no published form', async () => {
    const { org, admin } = await setup()
    await prisma.requestType.create({ data: { organizationId: org.organizationId, code: 'EMPTY_TYPE', nameTh: 'ยังไม่มีฟอร์ม', documentType: 'PURCHASE_REQUEST', active: false } })
    expect(await setRequestTypeActive(admin, { code: 'EMPTY_TYPE', active: true }, key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'NO_PUBLISHED_FORM' } } })
  })

  it('moves a type one place up or down, writes the catalog order as 1..n and records each type that moved', async () => {
    const { org, admin } = await setup()
    const order = async () => {
      const r = await listRequestTypesForAdmin(admin)
      return r.ok ? r.data.map((t) => t.code) : []
    }
    // The fixture types all have sortOrder 0, so the catalog starts in code order
    expect(await order()).toEqual(['BUY_GOODS', 'HIRE_SERVICE', 'IT_PURCHASE', 'NEW_SUPPLIER'])
    expect(await moveRequestType(admin, { code: 'IT_PURCHASE', direction: 'UP' }, key())).toEqual({ ok: true, data: { order: ['BUY_GOODS', 'IT_PURCHASE', 'HIRE_SERVICE', 'NEW_SUPPLIER'] } })
    expect(await order()).toEqual(['BUY_GOODS', 'IT_PURCHASE', 'HIRE_SERVICE', 'NEW_SUPPLIER'])
    const rows = await prisma.requestType.findMany({ where: { organizationId: org.organizationId }, orderBy: { sortOrder: 'asc' }, select: { code: true, sortOrder: true } })
    expect(rows).toEqual([
      { code: 'BUY_GOODS', sortOrder: 1 },
      { code: 'IT_PURCHASE', sortOrder: 2 },
      { code: 'HIRE_SERVICE', sortOrder: 3 },
      { code: 'NEW_SUPPLIER', sortOrder: 4 },
    ])
    const events = await prisma.event.findMany({ where: { organizationId: org.organizationId, type: 'request_type.updated' }, orderBy: { seq: 'asc' } })
    expect(events.map((e) => e.data)).toEqual([
      { code: 'BUY_GOODS', changed: ['sortOrder'], active: true, sortOrder: 1 },
      { code: 'IT_PURCHASE', changed: ['sortOrder'], active: true, sortOrder: 2 },
      { code: 'HIRE_SERVICE', changed: ['sortOrder'], active: true, sortOrder: 3 },
      { code: 'NEW_SUPPLIER', changed: ['sortOrder'], active: true, sortOrder: 4 },
    ])
    // Once the order is 1..n, a move writes only the two types that swap places
    expect(await moveRequestType(admin, { code: 'BUY_GOODS', direction: 'DOWN' }, key())).toMatchObject({ ok: true, data: { order: ['IT_PURCHASE', 'BUY_GOODS', 'HIRE_SERVICE', 'NEW_SUPPLIER'] } })
    expect(await prisma.event.count({ where: { organizationId: org.organizationId, type: 'request_type.updated' } })).toBe(6)
    // Requesters see the new order on the new request page
    expect((await listRequestCatalog(org.ctxOf('req_con', NOW), 'th')).map((t) => t.code)).toEqual(['IT_PURCHASE', 'BUY_GOODS', 'HIRE_SERVICE', 'NEW_SUPPLIER'])
    expect(await moveRequestType(admin, { code: 'IT_PURCHASE', direction: 'UP' }, key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'AT_EDGE' } } })
    expect(await moveRequestType(admin, { code: 'NEW_SUPPLIER', direction: 'DOWN' }, key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'AT_EDGE' } } })
  })

  it('only an organization admin may switch or move types (deny)', async () => {
    const { org } = await setup()
    const member = org.ctxOf('dm_con', NOW)
    expect(await setRequestTypeActive(member, { code: 'HIRE_SERVICE', active: false }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await moveRequestType(member, { code: 'HIRE_SERVICE', direction: 'UP' }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await prisma.requestType.findFirstOrThrow({ where: { organizationId: org.organizationId, code: 'HIRE_SERVICE' } })).toMatchObject({ active: true, sortOrder: 0 })
    expect(await prisma.event.count({ where: { organizationId: org.organizationId, type: 'request_type.updated' } })).toBe(0)
  })
})

describe('[FR-ADM-005/AC3] requests made before a new form version keep the version they were made with', () => {
  it('an earlier request is shown and checked with version 1; a new draft gets version 2', async () => {
    const { org, admin } = await setup()
    const requester = org.ctxOf('req_con', NOW)
    const JUSTIFICATION = 'ผู้ขายรายเดียวในพื้นที่หน้างาน'
    const draftOf = (title: string) =>
      createDraft(
        requester,
        { requestTypeCode: 'BUY_GOODS', title, priceIncludesVat: true, formData: { singleSourceJustification: JUSTIFICATION }, lines: [{ description: 'วัสดุ', quantity: '1', uom: 'งาน', unitPrice: '5000.00' }] },
        key(),
      )
    const before = await draftOf('ก่อนฟอร์มใหม่')
    if (!before.ok) throw new Error('draft failed')
    const v1 = (await prisma.request.findUniqueOrThrow({ where: { id: before.data.requestId } })).formVersionId

    // Version 2 names the justification field and adds a required field
    const current = await currentFormJson(admin, 'BUY_GOODS')
    if (!current.ok) throw new Error('no current form')
    const form = JSON.parse(current.data.json) as { fields: Array<Record<string, unknown>> }
    const LABEL = { th: 'เหตุผลที่ซื้อจากผู้ขายรายเดียว', en: 'Why one supplier' }
    const v2 = { ...form, fields: [...form.fields.map((f) => (f.id === 'singleSourceJustification' ? { ...f, label: LABEL } : f)), SITE] }
    expect(await publishFormVersion(admin, { code: 'BUY_GOODS', json: JSON.stringify(v2), basedOnVersionNo: 1 }, key())).toMatchObject({ ok: true, data: { versionNo: 2 } })

    // The earlier draft opens with its own form: no label, no new field; the form for a new request has both
    const fieldsOf = (r: Awaited<ReturnType<typeof getRequestForEdit>>) => (r.ok ? r.data.form.fields.map((f) => [f.id, f.label ?? null]) : r.error.code)
    expect(fieldsOf(await getRequestForEdit(requester, before.data.requestId, 'th'))).toEqual([['singleSourceJustification', null]])
    expect(fieldsOf(await getNewRequestForm(requester, 'BUY_GOODS', 'th'))).toEqual([
      ['singleSourceJustification', LABEL],
      ['deliverySiteNote', SITE.label],
    ])

    const after = await draftOf('หลังฟอร์มใหม่')
    if (!after.ok) throw new Error('draft failed')
    expect(fieldsOf(await getRequestForEdit(requester, after.data.requestId, 'th'))).toEqual([
      ['singleSourceJustification', LABEL],
      ['deliverySiteNote', SITE.label],
    ])
    const [oldRequest, newRequest] = await Promise.all([
      prisma.request.findUniqueOrThrow({ where: { id: before.data.requestId }, include: { formVersion: true } }),
      prisma.request.findUniqueOrThrow({ where: { id: after.data.requestId }, include: { formVersion: true } }),
    ])
    expect(oldRequest.formVersionId).toBe(v1)
    expect(oldRequest.formVersion.versionNo).toBe(1)
    expect(newRequest.formVersion.versionNo).toBe(2)
    // The earlier draft is sent with its own form (no new required field); the new one needs the field version 2 added
    expect(await submitRequest(requester, { requestId: before.data.requestId }, key())).toMatchObject({ ok: true })
    expect(await submitRequest(requester, { requestId: after.data.requestId }, key())).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_FAILED', details: { field: 'formData.deliverySiteNote', reason: 'FORM' } },
    })
    // The sent request is shown with version 1: its field without the label version 2 gave it
    const shown = await getRequestView(requester, before.data.requestId)
    expect(shown?.fields.map((f) => [f.id, f.label])).toEqual([['singleSourceJustification', null]])
    // The page counts the requests of each version
    const detail = await getRequestTypeForAdmin(admin, 'BUY_GOODS')
    expect(detail).toMatchObject({ ok: true, data: { versions: [{ versionNo: 2, requestCount: 1 }, { versionNo: 1, requestCount: 1 }] } })
  })
})
