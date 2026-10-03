import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { toJsonSafe } from '@/lib/json'
import { OrgSettingsSchema } from '@/lib/org-settings'
import { makeCtx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { loadOrgSettingsYaml } from '@/server/seed/demo-org'
import { saveOrgSettings } from '@/server/services/organization/settings'
import { createMember, createOrg } from '../support/factory'

// FR-PLT-001 AC2: every save of Organization.settings must pass OrgSettingsSchema; a failing save is VALIDATION_FAILED
// and leaves the stored value as it was.

const key = () => ({ idempotencyKey: randomUUID() })

async function orgWithSettings() {
  const org = await createOrg()
  const settings = OrgSettingsSchema.parse(parseYaml(loadOrgSettingsYaml()))
  await prisma.organization.update({ where: { id: org.id }, data: { settings: toJsonSafe(settings) as object } })
  const admin = await createMember(org.id, 'ผู้ดูแล')
  await prisma.roleAssignment.create({ data: { organizationId: org.id, memberId: admin.id, role: 'ORG_ADMIN', grantedAt: new Date() } })
  const ctxOf = (memberId: string) => makeCtx({ organizationId: org.id, actor: { type: 'USER', memberId }, channel: 'WEB', now: new Date() })
  return { org, settings, ctx: ctxOf(admin.id), ctxOf }
}

const stored = async (orgId: string) => (await prisma.organization.findUniqueOrThrow({ where: { id: orgId } })).settings

describe('[FR-PLT-001/AC2] settings that fail OrgSettingsSchema are VALIDATION_FAILED and the stored value does not change', () => {
  it('refuses a business calendar that ends before it starts', async () => {
    const { org, settings, ctx } = await orgWithSettings()
    const result = await saveOrgSettings(ctx, { section: 'businessCalendar', value: { workdays: ['MON'], start: '17:30', end: '08:30' } }, key())
    expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { field: 'settings.businessCalendar.end' } } })
    expect(await stored(org.id)).toEqual(settings)
    expect(await prisma.event.count({ where: { organizationId: org.id, type: 'organization.settings_updated' } })).toBe(0)
  })

  it('refuses unknown keys and wrong types inside a section', async () => {
    const { org, settings, ctx } = await orgWithSettings()
    const extra = await saveOrgSettings(ctx, { section: 'numbering', value: { ...settings.numbering, XX: { pattern: 'X', reset: 'NEVER' } } }, key())
    expect(extra).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
    const wrong = await saveOrgSettings(ctx, { section: 'numbering', value: { ...settings.numbering, PR: { pattern: 'PR', reset: 'WEEKLY' } } }, key())
    expect(wrong).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { field: 'settings.numbering.PR.reset' } } })
    expect(await stored(org.id)).toEqual(settings)
  })

  it('refuses a section that has no admin capability in §2.4', async () => {
    const { org, settings, ctx } = await orgWithSettings()
    const result = await saveOrgSettings(ctx, { section: 'budgetBasis' as 'numbering', value: 'GROSS' }, key())
    expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { field: 'section' } } })
    expect(await stored(org.id)).toEqual(settings)
  })

  it('saves a valid section and records organization.settings_updated', async () => {
    const { org, settings, ctx } = await orgWithSettings()
    const calendar = { workdays: ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'], start: '08:00', end: '17:00' }
    expect(await saveOrgSettings(ctx, { section: 'businessCalendar', value: calendar }, key())).toMatchObject({ ok: true })
    expect(await stored(org.id)).toEqual({ ...settings, businessCalendar: calendar })
    const events = await prisma.event.findMany({ where: { organizationId: org.id, type: 'organization.settings_updated' } })
    expect(events.map((e) => e.data)).toEqual([{ section: 'businessCalendar' }])
  })

  it('only an organization admin may save (BR-AUTH-05)', async () => {
    const { org, settings, ctxOf } = await orgWithSettings()
    const member = await createMember(org.id, 'สมาชิกทั่วไป')
    const result = await saveOrgSettings(ctxOf(member.id), { section: 'businessCalendar', value: settings.businessCalendar }, key())
    expect(result).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await stored(org.id)).toEqual(settings)
  })
})
