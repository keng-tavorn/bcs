import { randomUUID } from 'node:crypto'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { setAiClientForTests, type AiClient } from '@/integrations/ai'
import { putObject } from '@/integrations/storage'
import { PROMPT_VERSIONS } from '@/lib/ai-config'
import { makeCtx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { runDoaDraft, runMonthlyGrant, setAiRuntimeForTests, startDoaDraft, updateAgentSetting, type AiRuntime } from '@/server/services/ai'
import { importDoaDraft } from '@/server/services/doa'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'

// S13-11 (FR-AI-308 AC1–AC4, BR-AI-22, NG-12, OQ-146): the DOA drafter turns a regulation into one draft version, each
// rule with its source sentence and page, checked by code and linted with BR-DOA-08; the person confirms every rule and
// creates the draft with doa.import_draft and aiAssist. PLATFORM_ADMIN and members without admin.doa.draft are refused.

const NOW = new Date('2026-10-05T03:00:00Z')
const FIXTURE: AiRuntime = { enabled: true, mode: 'fixture', appEnv: 'local', modelEnv: {}, gates: [] }
const key = () => ({ idempotencyKey: randomUUID(), sender: null })

let org: DoaOrg

beforeAll(async () => {
  org = await createDoaOrg()
  await prisma.orgModule.create({ data: { organizationId: org.organizationId, module: 'AI', enabled: true, enabledAt: new Date('2026-01-01T00:00:00+07:00'), contractRef: 'TEST-S13', reason: 'ทดสอบร่าง DOA' } })
  await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: org.member.admin!, role: 'ORG_ADMIN', grantedAt: NOW } })
  setAiRuntimeForTests(FIXTURE)
  expect((await updateAgentSetting(org.ctxOf('admin', NOW), { agent: 'DOA_DRAFTER', enabled: true }, key())).ok).toBe(true)
  expect((await runMonthlyGrant(org.organizationId, NOW)).ok).toBe(true)
})

afterEach(() => {
  setAiRuntimeForTests(FIXTURE)
  setAiClientForTests(null)
})

type Rule = { code: string; documentType: string; gt: string | null; lte: string | null; approverKind: string; approverPosition: string | null; sourceText: string; page: number }
const rule = (code: string, documentType: string, gt: string | null, lte: string | null, kind: string, position: string, page = 1): Rule => ({ code, documentType, gt, lte, approverKind: kind, approverPosition: position, sourceText: `ข้อ ${code} ของระเบียบ`, page })
/** REG-A: the organization's DOA as its regulation words it */
const REG_A = [
  rule('PR-01', 'PURCHASE_REQUEST', '0.00', '20,000.00', 'POSITION_OF_DEPARTMENT', 'DM'),
  rule('PR-02', 'PURCHASE_REQUEST', '20000.00', '100000.00', 'POSITION_OF_DEPARTMENT', 'VP'),
  rule('PR-03', 'PURCHASE_REQUEST', '100000.00', null, 'POSITION_OF_ORG', 'CEO', 2),
  rule('PO-01', 'PURCHASE_ORDER', '0.00', '1000000.00', 'POSITION_OF_ORG', 'COO', 2),
  rule('PO-02', 'PURCHASE_ORDER', '1000000.00', null, 'POSITION_OF_ORG', 'CEO', 2),
  rule('GRV-01', 'GR_VARIANCE', null, null, 'POSITION_OF_DEPARTMENT', 'DM', 3),
  rule('DOA-CHG-01', 'DOA_CHANGE', null, null, 'POSITION_OF_ORG', 'CEO', 3),
  rule('ORG-CHG-01', 'ORG_AUTHORITY_CHANGE', null, null, 'POSITION_OF_ORG', 'CEO', 3),
]

function drafting(rules: Rule[]) {
  const client: AiClient = {
    mode: 'fixture',
    extract: async (request) => ({ ok: true, promptVersion: PROMPT_VERSIONS[request.purpose], model: request.model, output: request.schema.parse({ rules }), usage: { input: 9000, output: 1500, cacheRead: 0, cacheWrite: 0 }, latencyMs: 2000 }),
    write: async () => {
      throw new Error('not used')
    },
  }
  setAiClientForTests(client)
}

async function regulation(by = 'admin') {
  const bytes = new TextEncoder().encode(`%PDF-1.7\nระเบียบอำนาจอนุมัติ ${randomUUID()}\n%%EOF\n`)
  const storageKey = `test/ai/${randomUUID()}`
  await putObject(storageKey, bytes, 'application/pdf')
  return (await prisma.fileObject.create({ data: { organizationId: org.organizationId, storageKey, fileName: 'ระเบียบ.pdf', mimeType: 'application/pdf', sizeBytes: bytes.length, status: 'AVAILABLE', uploadedById: org.member[by]! } })).id
}

async function drafted(rules: Rule[]) {
  drafting(rules)
  const started = await startDoaDraft(org.ctxOf('admin', NOW), { fileId: await regulation() }, key())
  if (!started.ok) throw new Error(JSON.stringify(started.error))
  expect(await runDoaDraft(org.organizationId, started.data.agentActionId, NOW)).toBe('DRAFT')
  return prisma.agentAction.findUniqueOrThrow({ where: { id: started.data.agentActionId } })
}

type DraftOutput = { yaml: string; versionCode: string; versionNo: number; rules: Array<Rule & { problems: string[] }>; lint: { errors: Array<{ code: string }>; warnings: unknown[] } }

describe('[FR-AI-308/AC1] [FR-AI-308/AC2] a draft of one version, each rule with its source, checked and linted', () => {
  it('[FR-AI-308/AC1] REG-A: every rule with its sentence and page, the next version number, no lint finding', async () => {
    const action = await drafted(REG_A)
    const out = action.output as unknown as DraftOutput
    expect(out.rules.map((r) => [r.code, r.page, r.problems])).toEqual(REG_A.map((r) => [r.code, r.page, []]))
    expect(out.rules[0]).toMatchObject({ gt: '0.00', lte: '20000.00', sourceText: 'ข้อ PR-01 ของระเบียบ' })
    expect(out.versionNo).toBeGreaterThan(1)
    expect(out.yaml).toContain(`version: ${out.versionNo}`)
    expect(out.lint.errors).toEqual([])
    expect(Object.keys((action.review as { proposed: object }).proposed).sort()).toEqual(REG_A.map((r) => `rules.${r.code}`).sort())
  })

  it('[FR-AI-308/AC2] REG-B: a band that starts at 20,001 leaves a gap the lint shows', async () => {
    const out = (await drafted(REG_A.map((r) => (r.code === 'PR-02' ? { ...r, gt: '20001.00' } : r)))).output as unknown as DraftOutput
    expect(out.lint.errors).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'DOA_LINT_GAP', documentType: 'PURCHASE_REQUEST', gt: '20000.00', lte: '20001.00' })]))
  })

  it('[FR-AI-308/AC1] a limit that is not baht, an unknown position or a member: shown with why, left out of the draft', async () => {
    const out = (await drafted([...REG_A, rule('X-1', 'PURCHASE_REQUEST', 'หนึ่งแสน', null, 'POSITION_OF_ORG', 'CEO'), rule('X-2', 'PURCHASE_ORDER', null, null, 'POSITION_OF_ORG', 'NOBODY'), { ...rule('X-3', 'GR_VARIANCE', null, null, 'MEMBER', 'DM'), approverPosition: null }])).output as unknown as DraftOutput
    expect(Object.fromEntries(out.rules.filter((r) => r.code.startsWith('X-')).map((r) => [r.code, r.problems]))).toEqual({ 'X-1': ['GT_NOT_BAHT'], 'X-2': ['UNKNOWN_POSITION'], 'X-3': ['MEMBER_APPROVER'] })
    expect(out.yaml).not.toContain('X-1')
  })
})

describe('[FR-AI-308/AC3] the person confirms every rule and creates the draft themselves', () => {
  it('[FR-AI-308/AC3] not every rule confirmed: nothing created; all confirmed: one DRAFT version named by the event, never submitted', async () => {
    const action = await drafted(REG_A)
    const out = action.output as unknown as DraftOutput
    const paths = REG_A.map((r) => `rules.${r.code}`)
    const before = await prisma.doaVersion.count({ where: { organizationId: org.organizationId } })
    const waiting = await importDoaDraft(org.ctxOf('admin', NOW), { yaml: out.yaml, aiAssist: { agentActionId: action.id, confirmedPaths: paths.slice(1) } }, key())
    expect(waiting).toMatchObject({ ok: false, error: { code: 'AI_REVIEW_PENDING', details: { count: 1 } } })
    expect(await prisma.doaVersion.count({ where: { organizationId: org.organizationId } })).toBe(before)

    const made = await importDoaDraft(org.ctxOf('admin', NOW), { yaml: out.yaml, changeReason: 'ปรับตามระเบียบใหม่', aiAssist: { agentActionId: action.id, confirmedPaths: paths } }, key())
    if (!made.ok) throw new Error(JSON.stringify(made.error))
    expect(made.data.versionIds).toHaveLength(1)
    expect(await prisma.doaVersion.findUniqueOrThrow({ where: { id: made.data.versionIds[0]! } })).toMatchObject({ status: 'DRAFT', versionNo: out.versionNo })
    const event = await prisma.event.findFirstOrThrow({ where: { aggregateId: made.data.versionIds[0]!, type: 'doa_version.drafted' } })
    expect(event).toMatchObject({ actorType: 'USER', actorMemberId: org.member.admin, data: { agentActionId: action.id } })
    expect(await prisma.agentAction.findUniqueOrThrow({ where: { id: action.id } })).toMatchObject({ status: 'ACCEPTED', subjectType: 'DOA_VERSION', subjectId: made.data.versionIds[0] })
  })

  it('[FR-AI-308/AC3] a YAML of two versions with aiAssist is refused', async () => {
    const action = await drafted(REG_A)
    const out = action.output as unknown as DraftOutput
    const second = out.yaml.replace(/^versions:\n/, '').replace(`version: ${out.versionNo}`, `version: ${out.versionNo + 1}`)
    const r = await importDoaDraft(org.ctxOf('admin', NOW), { yaml: `${out.yaml}${second}`, aiAssist: { agentActionId: action.id, confirmedPaths: [] } }, key())
    expect(r).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'ONE_VERSION' } } })
  })
})

describe('[FR-AI-308/AC4] only a member holding admin.doa.draft drafts (NG-12, OQ-146)', () => {
  it('[FR-AI-308/AC4] PLATFORM_ADMIN and a member without the right are refused, and nothing is called', async () => {
    const fileId = await regulation()
    const platformAdmin = await prisma.platformAdmin.create({ data: { displayName: 'ทีม BCS', active: true } })
    const platform = makeCtx({ organizationId: org.organizationId, actor: { type: 'PLATFORM_ADMIN', platformAdminId: platformAdmin.id }, channel: 'WEB', now: NOW })
    expect(await startDoaDraft(platform, { fileId }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    const own = await regulation('req_con')
    expect(await startDoaDraft(org.ctxOf('req_con', NOW), { fileId: own }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await prisma.agentAction.count({ where: { organizationId: org.organizationId, purpose: 'DOA_DRAFT', requestedById: org.member.req_con } })).toBe(0)
  })
})
