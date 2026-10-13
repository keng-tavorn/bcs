import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import internals from '@prisma/internals'
import { describe, expect, it } from 'vitest'
import { MODULES } from '@/core/modules'
import { makeCtx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { listModules, registerModuleUsageCheck, requireModule, setModule } from '@/server/services/modules'
import { createDoaOrg } from '../support/doa-org'
import { createMember, createOrg } from '../support/factory'
import { createP1Org } from '../support/p1-org'

// FR-PLT-011 (module gate and rules) and FR-ADM-006 AC1 (the BCS team switches modules; ORG_ADMIN sees and is told).

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const run = { sender: null } as const
const key = () => ({ idempotencyKey: randomUUID(), ...run })

async function setup() {
  const org = await createOrg()
  const admins = [await createMember(org.id, 'ผู้ดูแล หนึ่ง'), await createMember(org.id, 'ผู้ดูแล สอง')]
  for (const a of admins) await prisma.roleAssignment.create({ data: { organizationId: org.id, memberId: a.id, role: 'ORG_ADMIN', grantedAt: new Date() } })
  const plain = await createMember(org.id)
  const platformAdmin = await prisma.platformAdmin.create({ data: { displayName: 'ทีม BCS', active: true } })
  const now = new Date()
  return {
    org,
    admins,
    platform: makeCtx({ organizationId: org.id, actor: { type: 'PLATFORM_ADMIN', platformAdminId: platformAdmin.id }, channel: 'WEB', now }),
    adminCtx: makeCtx({ organizationId: org.id, actor: { type: 'USER', memberId: admins[0]!.id }, channel: 'WEB', now }),
    plainCtx: makeCtx({ organizationId: org.id, actor: { type: 'USER', memberId: plain.id }, channel: 'WEB', now }),
    platformAdmin,
  }
}
const change = (module: (typeof MODULES)[number], enabled: boolean) => ({ module, enabled, contractRef: 'CT-2569-001', reason: 'ตามสัญญาเพิ่มโมดูล' })

describe('[FR-PLT-011/AC1] a switched-off module refuses its services', () => {
  it('requireModule answers MODULE_DISABLED until the module is on; CORE is always on', async () => {
    const { platform } = await setup()
    expect(await requireModule(platform, 'CORE')).toMatchObject({ ok: true })
    expect(await requireModule(platform, 'CONTRACTS')).toMatchObject({ ok: false, error: { code: 'MODULE_DISABLED', details: { module: 'CONTRACTS' } } })
    expect(await setModule(platform, change('CONTRACTS', true), key())).toMatchObject({ ok: true })
    expect(await requireModule(platform, 'CONTRACTS')).toMatchObject({ ok: true })
    expect(await setModule(platform, change('CONTRACTS', false), key())).toMatchObject({ ok: true })
    expect(await requireModule(platform, 'CONTRACTS')).toMatchObject({ ok: false, error: { code: 'MODULE_DISABLED' } })
  })
})

describe('[FR-PLT-011/AC2] dependencies are respected both ways', () => {
  it('switching on SOURCING while SUPPLIER is off is refused and names SUPPLIER', async () => {
    const { platform } = await setup()
    expect(await setModule(platform, change('SOURCING', true), key())).toMatchObject({
      ok: false,
      error: { code: 'MODULE_DISABLED', details: { module: 'SUPPLIER', missing: ['SUPPLIER'] } },
    })
    expect(await setModule(platform, change('SUPPLIER', true), key())).toMatchObject({ ok: true })
    expect(await setModule(platform, change('SOURCING', true), key())).toMatchObject({ ok: true })
    // and SUPPLIER cannot be switched off while SOURCING depends on it
    expect(await setModule(platform, change('SUPPLIER', false), key())).toMatchObject({
      ok: false,
      error: { code: 'MODULE_IN_USE', details: { reason: 'REQUIRED_BY', modules: ['SOURCING'] } },
    })
  })

  it('a module with open documents cannot be switched off (OQ-33), and CORE cannot be switched off at all', async () => {
    const { platform, org } = await setup()
    registerModuleUsageCheck('CONTRACTS', async (_tx, ctx) => (ctx.organizationId === org.id ? ['CT-0001'] : []))
    await setModule(platform, change('CONTRACTS', true), key())
    expect(await setModule(platform, change('CONTRACTS', false), key())).toMatchObject({
      ok: false,
      error: { code: 'MODULE_IN_USE', details: { reason: 'OPEN_DOCUMENTS', documents: ['CT-0001'] } },
    })
    expect(await setModule(platform, change('CORE', false), key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'CORE_ALWAYS_ON' } } })
  })
})

describe('[FR-PLT-011/AC3] the gate is tested for every module, counted from the schema', () => {
  it('the module list matches the ModuleKey enum in prisma/schema.prisma', async () => {
    const dmmf = await internals.getDMMF({ datamodel: readFileSync(path.join(ROOT, 'prisma/schema.prisma'), 'utf8') })
    const moduleKey = (dmmf.datamodel.enums as unknown as Array<{ name: string; values: Array<{ name: string }> }>).find((e) => e.name === 'ModuleKey')!
    expect(moduleKey.values.map((v) => v.name).sort()).toEqual([...MODULES].sort())
  })

  it.each(MODULES.filter((m) => m !== 'CORE'))('%s is refused when off and allowed when on', async (module) => {
    const { platform } = await setup()
    expect(await requireModule(platform, module)).toMatchObject({ ok: false, error: { code: 'MODULE_DISABLED' } })
    await prisma.orgModule.create({ data: { organizationId: platform.organizationId, module, enabled: true, enabledAt: new Date(), contractRef: 'TEST' } })
    expect(await requireModule(platform, module)).toMatchObject({ ok: true })
  })
})

describe('[FR-ADM-006/AC1] the BCS team switches modules; ORG_ADMIN sees the state and is told at once', () => {
  it('records contractRef, the platform actor and the event, and notifies every ORG_ADMIN', async () => {
    const { platform, admins, platformAdmin, org } = await setup()
    expect(await setModule(platform, change('AI', true), key())).toMatchObject({ ok: true, data: { module: 'AI', enabled: true } })
    const row = await prisma.orgModule.findFirstOrThrow({ where: { organizationId: org.id, module: 'AI' } })
    expect(row).toMatchObject({ enabled: true, contractRef: 'CT-2569-001', changedByPlatformAdminId: platformAdmin.id })
    const event = await prisma.event.findFirstOrThrow({ where: { organizationId: org.id, type: 'organization.module_enabled' } })
    expect(event).toMatchObject({ actorType: 'PLATFORM_ADMIN', actorPlatformAdminId: platformAdmin.id })
    expect(event.data).toEqual({ module: 'AI', contractRef: 'CT-2569-001', reasonCommentId: expect.any(String) })
    const notified = await prisma.notification.findMany({ where: { organizationId: org.id, templateKey: 'admin.module_changed' }, select: { recipientMemberId: true, urgency: true } })
    expect(notified.map((n) => n.recipientMemberId).sort()).toEqual(admins.map((a) => a.id).sort())
    expect(notified.every((n) => n.urgency === 'IMMEDIATE')).toBe(true)
  })

  it('keeps the reason of every change: each event points to its own reason, also after the module is switched again', async () => {
    const { platform, org } = await setup()
    expect(await setModule(platform, { module: 'AI', enabled: true, contractRef: 'CT-A', reason: 'เปิดตามสัญญาเพิ่มโมดูล' }, key())).toMatchObject({ ok: true })
    expect(await setModule(platform, { module: 'AI', enabled: false, contractRef: 'CT-B', reason: 'ลูกค้าขอยกเลิกโมดูล' }, key())).toMatchObject({ ok: true })
    const events = await prisma.event.findMany({ where: { organizationId: org.id, type: { in: ['organization.module_enabled', 'organization.module_disabled'] }, data: { path: ['module'], equals: 'AI' } }, orderBy: { seq: 'asc' } })
    const reasons = await Promise.all(events.map(async (e) => (await prisma.comment.findUniqueOrThrow({ where: { id: (e.data as { reasonCommentId: string }).reasonCommentId } })).body))
    expect(events.map((e) => e.type)).toEqual(['organization.module_enabled', 'organization.module_disabled'])
    expect(reasons).toEqual(['เปิดตามสัญญาเพิ่มโมดูล', 'ลูกค้าขอยกเลิกโมดูล'])
    // The reason text itself is not in the event (it may hold personal data; it lives in Comment)
    expect(JSON.stringify(events.map((e) => e.data))).not.toContain('ลูกค้า')
  })

  it('a contract reference and a reason are required', async () => {
    const { platform } = await setup()
    expect(await setModule(platform, { module: 'AI', enabled: true, contractRef: '', reason: 'ตามสัญญา' }, key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
    expect(await setModule(platform, { module: 'AI', enabled: true, contractRef: 'CT-1', reason: '' }, key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
  })

  it('ORG_ADMIN may look but not switch; an inactive BCS account may not switch; members without the role may not look', async () => {
    const { adminCtx, plainCtx, platform, platformAdmin } = await setup()
    expect(await setModule(adminCtx, change('AI', true), key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    const view = await listModules(adminCtx)
    expect(view.ok && view.data.find((m) => m.module === 'CORE')?.enabled).toBe(true)
    expect(view.ok && view.data.length).toBe(MODULES.length)
    expect(await listModules(plainCtx)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    await prisma.platformAdmin.update({ where: { id: platformAdmin.id }, data: { active: false } })
    expect(await setModule(platform, change('AI', true), key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
  })
})

async function platformCtxFor(organizationId: string) {
  const platformAdmin = await prisma.platformAdmin.create({ data: { displayName: 'ทีม BCS', active: true } })
  return makeCtx({ organizationId, actor: { type: 'PLATFORM_ADMIN', platformAdminId: platformAdmin.id }, channel: 'WEB', now: new Date() })
}
const payTypes = ['INVOICE_EXCEPTION', 'PAYMENT_RUN', 'BANK_ACCOUNT_CHANGE']
const moduleEvents = (organizationId: string) => prisma.event.count({ where: { organizationId, type: 'organization.module_enabled' } })

describe('[FR-PLT-011/AC4] PAY is switched on only when the DOA has its rules (§4.11 rule 7, BR-DOA-24)', () => {
  it('a DOA in effect without the PAY rules: DOA_NOT_CONFIGURED naming the types and the version, nothing changes', async () => {
    const org = await createDoaOrg()
    const platform = await platformCtxFor(org.organizationId)
    const refused = await setModule(platform, change('PAY', true), key())
    expect(refused).toMatchObject({
      ok: false,
      error: { code: 'DOA_NOT_CONFIGURED', details: { reason: 'MODULE_RULES_MISSING', module: 'PAY', documentTypes: payTypes, versions: [{ code: 'DOA-DEMO', versionNo: 1 }] } },
    })
    expect(await prisma.orgModule.count({ where: { organizationId: org.organizationId, module: 'PAY' } })).toBe(0)
    expect(await moduleEvents(org.organizationId)).toBe(0)
    expect(await requireModule(platform, 'PAY')).toMatchObject({ ok: false, error: { code: 'MODULE_DISABLED' } })
  })

  it('an organization without a DOA cannot switch PAY on; one without the PAY rules may still switch on a module that needs none', async () => {
    const none = await createDoaOrg({ doa: false })
    const platform = await platformCtxFor(none.organizationId)
    expect(await setModule(platform, change('PAY', true), key())).toMatchObject({ ok: false, error: { code: 'DOA_NOT_CONFIGURED', details: { documentTypes: payTypes, versions: [] } } })
    expect(await setModule(platform, change('AI', true), key())).toMatchObject({ ok: true })
  })

  it('a version waiting for approval without the PAY rules blocks it too, though the version in effect has them', async () => {
    const org = await createP1Org({ modules: [] })
    const live = await prisma.doaVersion.findFirstOrThrow({ where: { organizationId: org.organizationId, status: 'PUBLISHED' }, include: { rules: true } })
    const pending = await prisma.doaVersion.create({
      data: {
        organizationId: org.organizationId,
        code: live.code,
        versionNo: 2,
        status: 'PENDING_APPROVAL',
        effectiveFrom: new Date('2027-01-01T00:00:00+07:00'),
        amountBasis: live.amountBasis,
        selfApprovalPolicy: live.selfApprovalPolicy,
        sodPolicy: live.sodPolicy as object,
      },
    })
    const keep = live.rules.filter((r) => !['PAYMENT_RUN'].includes(r.documentType))
    await prisma.doaRule.createMany({ data: keep.map((r) => ({ organizationId: org.organizationId, doaVersionId: pending.id, code: r.code, documentType: r.documentType, priority: r.priority, when: r.when as object, steps: r.steps as object })) })
    const platform = await platformCtxFor(org.organizationId)
    expect(await setModule(platform, change('PAY', true), key())).toMatchObject({
      ok: false,
      error: { code: 'DOA_NOT_CONFIGURED', details: { reason: 'MODULE_RULES_MISSING', documentTypes: ['PAYMENT_RUN'], versions: [{ code: live.code, versionNo: 2 }] } },
    })
  })
})

describe('[FR-PLT-011/AC5] with every rule in place PAY switches on as before', () => {
  it('records the module and the event organization.module_enabled', async () => {
    const org = await createP1Org({ modules: [] })
    const platform = await platformCtxFor(org.organizationId)
    expect(await setModule(platform, change('PAY', true), key())).toMatchObject({ ok: true, data: { module: 'PAY', enabled: true } })
    expect(await requireModule(platform, 'PAY')).toMatchObject({ ok: true })
    expect(await moduleEvents(org.organizationId)).toBe(1)
  })
})
