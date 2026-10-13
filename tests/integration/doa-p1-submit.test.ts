import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { prisma } from '@/server/db/client'
import { importDoaDraft, submitDoaVersion } from '@/server/services/doa'
import { createP1Org } from '../support/p1-org'

// FR-DOA-002 AC5 AC6 (BR-DOA-22, BR-DOA-23): a DOA version is sent for approval only when it has a rule for every type
// the modules that are on require, and a type without an amount has no amount band. The organizations come from the
// phase-1 fixtures (createP1Org, ADR-070).

const NOW = new Date('2026-10-05T03:00:00Z')
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const FIXTURE = readFileSync(path.resolve(import.meta.dirname, '../golden/fixtures/doa-versions-p1.yaml'), 'utf8')
const PAY_RULES = /^ {6}- \{ code: (IE-0\d|PAY-0\d|BA-01),.*\n/gm
/** Version 1 of the phase-1 fixture as version 2, from 1 Nov, changed by `edit` */
const version2 = (edit: (text: string) => string = (t) => t) => edit(FIXTURE.replace('version: 1', 'version: 2').replace('"2026-10-01T00:00:00+07:00"', '"2026-11-01T00:00:00+07:00"'))

async function orgWithAdmin(modules?: readonly ('PAY' | 'AI' | 'BCS_GO')[]) {
  const org = await createP1Org(modules ? { modules } : {})
  await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: org.member.admin!, role: 'ORG_ADMIN', grantedAt: NOW } })
  return org
}

async function submit(org: Awaited<ReturnType<typeof orgWithAdmin>>, yaml: string) {
  const imported = await importDoaDraft(org.ctxOf('admin', NOW), { yaml }, key())
  if (!imported.ok) throw new Error(`import failed: ${JSON.stringify(imported.error)}`)
  return submitDoaVersion(org.ctxOf('admin', NOW), { versionId: imported.data.versionIds[0]!, boundaryTableConfirmed: true }, key())
}

describe('[FR-DOA-002/AC5] the rules a module requires (BR-DOA-23)', () => {
  it('an organization with PAY on cannot send a version without the PAY rules: DOA_LINT_MISSING_DOCTYPE for each type', async () => {
    const org = await orgWithAdmin()
    const r = await submit(org, version2((t) => t.replace(PAY_RULES, '')))
    expect(r).toMatchObject({
      ok: false,
      error: {
        code: 'DOA_LINT_FAILED',
        details: {
          errors: [
            { code: 'DOA_LINT_MISSING_DOCTYPE', documentType: 'INVOICE_EXCEPTION' },
            { code: 'DOA_LINT_MISSING_DOCTYPE', documentType: 'PAYMENT_RUN' },
            { code: 'DOA_LINT_MISSING_DOCTYPE', documentType: 'BANK_ACCOUNT_CHANGE' },
          ],
        },
      },
    })
  })

  it('an organization without PAY sends the same version', async () => {
    const org = await orgWithAdmin([])
    expect(await submit(org, version2((t) => t.replace(PAY_RULES, '')))).toMatchObject({ ok: true, data: { assigneeMemberId: org.member.ceo } })
  })

  it('with PAY on, the full phase-1 version goes to the DOA_CHANGE approver', async () => {
    const org = await orgWithAdmin()
    expect(await submit(org, version2())).toMatchObject({ ok: true, data: { assigneeMemberId: org.member.ceo } })
  })
})

describe('[FR-DOA-002/AC6] a bank account change has no amount band (BR-DOA-22)', () => {
  it('a BA rule with an amount band is DOA_LINT_FAILED with DOA_LINT_AMOUNT_NOT_ALLOWED', async () => {
    const org = await orgWithAdmin()
    const r = await submit(org, version2((t) => t.replace('{ code: BA-01, documentType: BANK_ACCOUNT_CHANGE, priority: 100, when: {}', '{ code: BA-01, documentType: BANK_ACCOUNT_CHANGE, priority: 100, when: { amount: { gt: "0.00" } }')))
    expect(r).toMatchObject({ ok: false, error: { code: 'DOA_LINT_FAILED', details: { errors: [{ code: 'DOA_LINT_AMOUNT_NOT_ALLOWED', rule: 'BA-01' }] } } })
  })
})
