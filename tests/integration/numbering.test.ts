import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { toJsonSafe } from '@/lib/json'
import { OrgSettingsSchema } from '@/lib/org-settings'
import { makeCtx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { forTenant } from '@/server/db/tenant'
import { loadOrgSettingsYaml } from '@/server/seed/demo-org'
import { issueDocumentNumber, type NumberedDocument } from '@/server/services/numbering'
import { createOrg } from '../support/factory'

// FR-DOA-008 (BR-NUM-01..03, INV-NUM-01): numbers come from a locked DocumentSequence row inside the issuing
// transaction, so concurrent issues never collide or skip, and a rolled-back issue gives its value back.

// 2026-10-03 10:00 Thai time = BE 2569
const NOW = new Date('2026-10-03T03:00:00Z')

async function orgWithNumbering(numbering?: Record<string, { pattern: string; reset: 'YEARLY' | 'MONTHLY' | 'NEVER' }>) {
  const org = await createOrg()
  const settings = OrgSettingsSchema.parse(parseYaml(loadOrgSettingsYaml()))
  await prisma.organization.update({ where: { id: org.id }, data: { settings: toJsonSafe({ ...settings, numbering: { ...settings.numbering, ...numbering } }) as object } })
  const ctx = makeCtx({ organizationId: org.id, actor: { type: 'SYSTEM', job: 'test' }, channel: 'SYSTEM', now: NOW })
  const issue = (document: NumberedDocument, department?: string) => forTenant(org.id).$transaction((tx) => issueDocumentNumber(tx, ctx, { document, department }))
  return { org, ctx, issue }
}

describe('[FR-DOA-008/AC2] 50 numbers issued at the same moment are 1 to 50, each once (INV-NUM-01)', () => {
  it('serializes concurrent issuers on the scope row', async () => {
    const { issue } = await orgWithNumbering()
    const numbers = await Promise.all(Array.from({ length: 50 }, () => issue('PR')))
    expect([...numbers].sort()).toEqual(Array.from({ length: 50 }, (_, i) => `PR-2569-${String(i + 1).padStart(5, '0')}`))
  }, 60_000)
})

describe('[FR-DOA-008/AC3] a number is never issued twice', () => {
  it('a rolled-back issue gives its value back, so the next number does not skip; a used number never comes back', async () => {
    const { org, ctx, issue } = await orgWithNumbering()
    expect(await issue('PO')).toBe('PO-2569-00001')
    // The command that issued the next number fails: its transaction rolls back and the value is free again
    await expect(
      forTenant(org.id).$transaction(async (tx) => {
        expect(await issueDocumentNumber(tx, ctx, { document: 'PO' })).toBe('PO-2569-00002')
        throw new Error('the command failed after taking a number')
      }),
    ).rejects.toThrow('the command failed')
    expect(await issue('PO')).toBe('PO-2569-00002')
    // A cancelled document keeps 00001 and 00002: the counter only grows
    expect(await issue('PO')).toBe('PO-2569-00003')
  })

  it('keeps one counter per document type, period and department (BR-NUM-03)', async () => {
    const { org, issue } = await orgWithNumbering({ GR: { pattern: 'GR-{DEPT}-{YY}{MM}-{SEQ3}', reset: 'MONTHLY' } })
    expect(await issue('GR', 'OPS')).toBe('GR-OPS-6910-001')
    expect(await issue('GR', 'IT')).toBe('GR-IT-6910-001')
    expect(await issue('GR', 'OPS')).toBe('GR-OPS-6910-002')
    expect(await issue('PR')).toBe('PR-2569-00001')
    const scopes = await prisma.documentSequence.findMany({ where: { organizationId: org.id }, select: { scopeKey: true, nextValue: true }, orderBy: { scopeKey: 'asc' } })
    expect(scopes).toEqual([
      { scopeKey: 'GR:2569-10:IT', nextValue: 2 },
      { scopeKey: 'GR:2569-10:OPS', nextValue: 3 },
      { scopeKey: 'PR:2569', nextValue: 2 },
    ])
  })
})
