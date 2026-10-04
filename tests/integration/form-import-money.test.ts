import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { makeCtx, type Ctx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { checkFormImport, currentFormJson, publishFormVersion } from '@/server/services/request-types'
import { createDraft, submitRequest } from '@/server/services/requests'
import { getNewRequestForm } from '@/server/services/requests/form-view'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'

// FR-ADM-005 AC1 with BR-MONEY-01 (§7.0 (3), §7.9): a form compares money with baht text only. An import whose condition
// gives an amount as a JSON number is refused with the place of each one, so the admin does not publish a rule that
// would never apply; a form written with baht text publishes, and the server compares its field of type money in
// satang, as the requester's screen does (FR-INT-002 AC1).

const NOW = new Date('2026-10-05T03:00:00Z')
const key = () => ({ idempotencyKey: randomUUID(), sender: null })

async function setup() {
  const org = await createDoaOrg()
  await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: org.member.admin!, role: 'ORG_ADMIN', grantedAt: NOW } })
  const admin: Ctx = makeCtx({ organizationId: org.organizationId, actor: { type: 'USER', memberId: org.member.admin! }, channel: 'WEB', now: NOW })
  return { org, admin }
}

interface RuleJson {
  readonly id: string
  readonly when: Record<string, unknown>
  readonly require: unknown
}

/** The form of BUY_GOODS (tests/support/doa-org.ts: ATT-QUOTES above "100000.00") with a money field and a rule on it */
async function buyGoodsWithBudget(admin: Ctx, when: Record<string, unknown>) {
  const current = await currentFormJson(admin, 'BUY_GOODS')
  if (!current.ok) throw new Error('no current form')
  const form = JSON.parse(current.data.json) as { fields: unknown[]; rules: RuleJson[] }
  return {
    ...form,
    fields: [...form.fields, { id: 'budget', type: 'money', label: { th: 'งบที่ตั้งไว้', en: 'Budget set aside' } }],
    rules: [...form.rules, { id: 'ATT-BUDGET', when, require: { attachments: 'JUSTIFICATION', min: 1 } }],
  }
}

const versions = (org: DoaOrg) => prisma.formVersion.count({ where: { organizationId: org.organizationId, requestType: { code: 'BUY_GOODS' } } })

describe('[FR-ADM-005/AC1] an imported form whose money condition gives an amount as a number is refused', () => {
  it('reports each amount written as a number, on $amountGross and on a field of type money, and publishes nothing', async () => {
    const { org, admin } = await setup()
    const form = await buyGoodsWithBudget(admin, { field: 'budget', op: 'gt', value: 50000 })
    // ATT-QUOTES of the form in use, with its "100000.00" written as a number
    const numeric = { ...form, rules: form.rules.map((r) => (r.id === 'ATT-QUOTES' ? { ...r, when: { ...r.when, value: 100000 } } : r)) }
    const json = JSON.stringify(numeric)
    const problems = [
      { reason: 'SCHEMA', issue: 'TYPE', path: 'rules[0].when.value' },
      { reason: 'SCHEMA', issue: 'TYPE', path: 'rules[1].when.value' },
    ]
    expect(await checkFormImport(admin, { code: 'BUY_GOODS', json })).toEqual({ ok: true, data: { valid: false, problems } })
    expect(await publishFormVersion(admin, { code: 'BUY_GOODS', json, basedOnVersionNo: 1 }, key())).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_FAILED', details: { field: 'json', reason: 'FORM_INVALID', problems } },
    })
    expect(await versions(org)).toBe(1)

    // Other text that is not baht, and an "in" list holding a number, are refused the same way
    const text = JSON.stringify(await buyGoodsWithBudget(admin, { any: [{ field: 'budget', op: 'gte', value: '50,000.00' }, { field: '$amountNet', op: 'in', value: ['1.00', 2] }] }))
    expect(await checkFormImport(admin, { code: 'BUY_GOODS', json: text })).toEqual({
      ok: true,
      data: {
        valid: false,
        problems: [
          { reason: 'SCHEMA', issue: 'FORMAT', path: 'rules[1].when.any[0].value' },
          { reason: 'SCHEMA', issue: 'TYPE', path: 'rules[1].when.any[1].value[1]' },
        ],
      },
    })
    expect(await versions(org)).toBe(1)
  })
})

describe('[FR-INT-002/AC1] a field of type money is compared in satang on the server, as on the screen', () => {
  it('publishes a rule written in baht text, marks it in the form the requester gets, and applies it at submit', async () => {
    const { org, admin } = await setup()
    const json = JSON.stringify(await buyGoodsWithBudget(admin, { field: 'budget', op: 'eq', value: '60000' }))
    expect(await checkFormImport(admin, { code: 'BUY_GOODS', json })).toMatchObject({ ok: true, data: { valid: true, nextVersionNo: 2 } })
    expect(await publishFormVersion(admin, { code: 'BUY_GOODS', json, basedOnVersionNo: 1 }, key())).toEqual({ ok: true, data: { versionNo: 2 } })

    // The version is stored as imported; the form sent to the requester's screen marks the comparison as money
    const type = await prisma.requestType.findFirstOrThrow({ where: { organizationId: org.organizationId, code: 'BUY_GOODS' }, include: { currentFormVersion: true } })
    const stored = type.currentFormVersion!.schema as unknown as { rules: RuleJson[] }
    expect(stored.rules.find((r) => r.id === 'ATT-BUDGET')?.when).toEqual({ field: 'budget', op: 'eq', value: '60000' })
    const requester = org.ctxOf('req_con', NOW)
    const view = await getNewRequestForm(requester, 'BUY_GOODS', 'th')
    if (!view.ok) throw new Error(JSON.stringify(view.error))
    expect(view.data.form.rules.find((r) => r.id === 'ATT-BUDGET')?.when).toEqual({ field: 'budget', op: 'eq', value: '60000', money: true })

    const draftWith = async (budget: string) => {
      const draft = await createDraft(
        requester,
        { requestTypeCode: 'BUY_GOODS', title: 'วัสดุหน้างาน', priceIncludesVat: true, formData: { budget }, lines: [{ description: 'วัสดุ', quantity: '1', uom: 'งาน', unitPrice: '5000.00' }] },
        key(),
      )
      if (!draft.ok) throw new Error(JSON.stringify(draft.error))
      return draft.data.requestId
    }
    // "60000" in the rule is the answer "60000.00": the rule applies and asks for a justification file
    const requestId = await draftWith('60000.00')
    expect(await submitRequest(requester, { requestId }, key())).toMatchObject({ ok: false, error: { code: 'ATTACHMENT_RULE_FAILED', details: { rule: 'ATT-BUDGET' } } })
    const file = await prisma.fileObject.create({
      data: { organizationId: org.organizationId, storageKey: `test/${randomUUID()}.pdf`, fileName: 'เหตุผล.pdf', mimeType: 'application/pdf', sizeBytes: 1000, status: 'AVAILABLE', uploadedById: org.member.req_con! },
    })
    await prisma.fileLink.create({ data: { organizationId: org.organizationId, fileId: file.id, subjectType: 'Request', subjectId: requestId, kind: 'JUSTIFICATION' } })
    expect(await submitRequest(requester, { requestId }, key())).toMatchObject({ ok: true })

    // Another amount: the rule does not apply and the request goes without the file
    expect(await submitRequest(requester, { requestId: await draftWith('59999.99') }, key())).toMatchObject({ ok: true })
  })
})
