import { randomUUID } from 'node:crypto'
import ExcelJS from 'exceljs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { setEmailProvider, type EmailMessage } from '@/integrations/email-provider'
import { makeCtx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { deactivateMember, inviteMember } from '@/server/services/members'
import { buildMemberImportTemplate, IMPORT_COLUMNS, IMPORT_SHEET, importMembers, parseMemberImport } from '@/server/services/members/import'
import { grantRole, revokeRole } from '@/server/services/members/roles'
import { createMember, createOrg } from '../support/factory'

// FR-ADM-001: ORG_ADMIN manages members and roles; every change is an event; no self-granting; Excel import is
// all-or-nothing with a row-by-row report.

const outbox: EmailMessage[] = []
beforeAll(() => setEmailProvider({ async send(m) { outbox.push(m); return { messageId: randomUUID() } } }))
afterAll(() => setEmailProvider(null))
const key = () => ({ idempotencyKey: randomUUID(), sender: null })

async function orgWithAdmins(count = 1) {
  const org = await createOrg()
  const admins = []
  for (let i = 0; i < count; i++) {
    const a = await createMember(org.id, `ผู้ดูแล ${i + 1}`)
    await prisma.roleAssignment.create({ data: { organizationId: org.id, memberId: a.id, role: 'ORG_ADMIN', grantedAt: new Date() } })
    admins.push(a)
  }
  const ctxOf = (memberId: string) => makeCtx({ organizationId: org.id, actor: { type: 'USER', memberId }, channel: 'WEB', now: new Date() })
  return { org, admins, ctx: ctxOf(admins[0]!.id), ctxOf }
}

describe('[FR-ADM-001/AC1] ORG_ADMIN invites, deactivates, grants and revokes roles; every change is an event', () => {
  it('records an event for each change', async () => {
    const { ctx, org } = await orgWithAdmins()
    const invited = await inviteMember(ctx, { email: `${randomUUID()}@test.bcs.local`, displayNameTh: 'พนักงาน ใหม่' }, key())
    if (!invited.ok) throw new Error('invite failed')
    const memberId = invited.data.memberId
    expect(await grantRole(ctx, { memberId, role: 'FINANCE' }, key())).toMatchObject({ ok: true })
    expect(await revokeRole(ctx, { memberId, role: 'FINANCE' }, key())).toMatchObject({ ok: true })
    expect(await deactivateMember(ctx, { memberId, reason: 'ย้ายไปบริษัทในเครือ' }, key())).toMatchObject({ ok: true })
    const types = (await prisma.event.findMany({ where: { organizationId: org.id, aggregateId: memberId }, orderBy: { seq: 'asc' } })).map((e) => e.type)
    expect(types).toEqual(['member.invited', 'member.role_granted', 'member.role_revoked', 'member.deactivated'])
    const assignment = await prisma.roleAssignment.findFirstOrThrow({ where: { memberId, role: 'FINANCE' } })
    expect(assignment.revokedAt).not.toBeNull()
  })

  it('granting a role the member already has, or revoking one they do not have, is refused', async () => {
    const { ctx, org } = await orgWithAdmins()
    const m = await createMember(org.id)
    await grantRole(ctx, { memberId: m.id, role: 'AUDITOR' }, key())
    expect(await grantRole(ctx, { memberId: m.id, role: 'AUDITOR' }, key())).toMatchObject({ ok: false, error: { details: { reason: 'ALREADY_GRANTED' } } })
    expect(await revokeRole(ctx, { memberId: m.id, role: 'FINANCE' }, key())).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
  })
})

describe('[FR-ADM-001/AC2] an administrator cannot grant a role to themselves', () => {
  it('refuses self-granting, keeps the last ORG_ADMIN, and refuses non-admins', async () => {
    const { ctx, admins, org, ctxOf } = await orgWithAdmins()
    expect(await grantRole(ctx, { memberId: admins[0]!.id, role: 'FINANCE' }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN', details: { reason: 'SELF_GRANT' } } })
    expect(await revokeRole(ctx, { memberId: admins[0]!.id, role: 'ORG_ADMIN' }, key())).toMatchObject({ ok: false, error: { details: { reason: 'LAST_ORG_ADMIN' } } })
    const plain = await createMember(org.id)
    expect(await grantRole(ctxOf(plain.id), { memberId: plain.id, role: 'ORG_ADMIN' }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await prisma.roleAssignment.count({ where: { memberId: plain.id } })).toBe(0)
  })

  it('with two administrators, one may remove the other', async () => {
    const { ctx, admins } = await orgWithAdmins(2)
    expect(await revokeRole(ctx, { memberId: admins[1]!.id, role: 'ORG_ADMIN' }, key())).toMatchObject({ ok: true })
  })
})

const LABELS = Object.fromEntries(IMPORT_COLUMNS.map((c) => [c, `label:${c}`])) as Record<(typeof IMPORT_COLUMNS)[number], string>

async function importFile(rows: Array<Partial<Record<(typeof IMPORT_COLUMNS)[number], string>>>): Promise<ArrayBuffer> {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(new Uint8Array(await buildMemberImportTemplate(LABELS)).buffer as ArrayBuffer)
  const sheet = workbook.getWorksheet(IMPORT_SHEET)!
  for (const row of rows) sheet.addRow(IMPORT_COLUMNS.map((c) => row[c] ?? ''))
  const buffer = await workbook.xlsx.writeBuffer()
  return new Uint8Array(buffer).buffer as ArrayBuffer
}

describe('[FR-ADM-001/AC3] Excel import reports every wrong row and saves nothing unless all rows are right', () => {
  it('lists each wrong row and field, and creates no member', async () => {
    const { ctx, org } = await orgWithAdmins()
    const taken = await createMember(org.id)
    const file = await importFile([
      { email: `ok-${randomUUID()}@test.bcs.local`, displayNameTh: 'ถูกต้อง หนึ่ง', roles: 'FINANCE' },
      { email: 'not-an-email', displayNameTh: 'อีเมลผิด' },
      { email: `role-${randomUUID()}@test.bcs.local`, displayNameTh: 'บทบาทผิด', roles: 'APPROVER' },
      { email: 'dup@test.bcs.local', displayNameTh: 'ซ้ำ หนึ่ง' },
      { email: 'dup@test.bcs.local', displayNameTh: 'ซ้ำ สอง' },
      { email: taken.email, displayNameTh: 'มีอยู่แล้ว' },
    ])
    const before = await prisma.member.count({ where: { organizationId: org.id } })
    const r = await importMembers(ctx, file, { sender: null })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('VALIDATION_FAILED')
    expect(r.error.details?.rows).toEqual([
      { row: 4, field: 'email', reason: 'INVALID_EMAIL' },
      { row: 5, field: 'roles', reason: 'UNKNOWN_ROLE' },
      { row: 7, field: 'email', reason: 'DUPLICATE_IN_FILE' },
      { row: 8, field: 'email', reason: 'ALREADY_MEMBER' },
    ])
    expect(await prisma.member.count({ where: { organizationId: org.id } })).toBe(before)
  })

  it('invites every row with its roles in one go, e-mails each, and re-uploading the same file invites nobody twice', async () => {
    const { ctx, org } = await orgWithAdmins()
    const emails = [`a-${randomUUID()}@test.bcs.local`, `b-${randomUUID()}@test.bcs.local`]
    const file = await importFile([
      { email: emails[0], displayNameTh: 'นำเข้า หนึ่ง', roles: 'FINANCE, BUDGET_ADMIN', employeeCode: 'E-001' },
      { email: emails[1], displayNameTh: 'นำเข้า สอง', displayNameEn: 'Import Two', roles: 'REQUESTER' },
    ])
    const sentBefore = outbox.length
    expect(await importMembers(ctx, file, { sender: null })).toEqual({ ok: true, data: { invited: 2, emailsSent: 2, notSent: [] } })
    expect(outbox.slice(sentBefore).map((m) => m.to).sort()).toEqual([...emails].sort())
    const members = await prisma.member.findMany({ where: { organizationId: org.id, email: { in: emails } }, include: { roleAssignments: true } })
    expect(members.map((m) => m.status)).toEqual(['INVITED', 'INVITED'])
    expect(members.find((m) => m.email === emails[0])!.roleAssignments.map((a) => a.role).sort()).toEqual(['BUDGET_ADMIN', 'FINANCE'])
    // The same file again: every row is reported as already a member and nothing is created or e-mailed twice
    const again = await importMembers(ctx, file, { sender: null })
    expect(again).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
    if (!again.ok) expect((again.error.details?.rows as Array<{ reason: string }>).filter((r) => r.reason === 'ALREADY_MEMBER')).toHaveLength(2)
    expect(await prisma.member.count({ where: { organizationId: org.id, email: { in: emails } } })).toBe(2)
    expect(outbox.length - sentBefore).toBe(2)
  })

  it('accepts the role names shown on screen, in Thai or English, separated by a comma, a semicolon or a line break', async () => {
    const roleNames = [
      { code: 'PROCUREMENT' as const, names: ['จัดซื้อ', 'Procurement'] },
      { code: 'FINANCE' as const, names: ['บัญชีและการเงิน', 'Finance'] },
      { code: 'REQUESTER' as const, names: ['ผู้ขอ', 'Requester'] },
    ]
    const file = await importFile([
      { email: `th-${randomUUID()}@test.bcs.local`, displayNameTh: 'ชื่อไทย', roles: 'จัดซื้อ; บัญชีและการเงิน' },
      { email: `en-${randomUUID()}@test.bcs.local`, displayNameTh: 'ชื่ออังกฤษ', roles: 'procurement,\nFinance' },
      { email: `rq-${randomUUID()}@test.bcs.local`, displayNameTh: 'ผู้ขอ', roles: 'ผู้ขอ' },
      { email: `bad-${randomUUID()}@test.bcs.local`, displayNameTh: 'บทบาทผิด', roles: 'ผู้อนุมัติ' },
    ])
    const { rows, errors } = await parseMemberImport(file, roleNames)
    expect(rows.map((r) => [...r.roles].sort())).toEqual([['FINANCE', 'PROCUREMENT'], ['FINANCE', 'PROCUREMENT'], []])
    expect(errors).toEqual([{ row: 6, field: 'roles', reason: 'UNKNOWN_ROLE' }])
  })

  it('says when row 1 (the column codes) was removed, instead of calling the file unreadable', async () => {
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load(new Uint8Array(await buildMemberImportTemplate(LABELS)).buffer as ArrayBuffer)
    const sheet = workbook.getWorksheet(IMPORT_SHEET)!
    sheet.spliceRows(1, 1)
    sheet.addRow([`x-${randomUUID()}@test.bcs.local`, 'ไม่มีหัวตาราง'])
    const file = new Uint8Array(await workbook.xlsx.writeBuffer()).buffer as ArrayBuffer
    expect(await parseMemberImport(file)).toEqual({ rows: [], errors: [{ row: 1, field: 'file', reason: 'MISSING_HEADER' }] })
  })

  it('the template carries a guide sheet with every role code and name', async () => {
    const guide = { sheetName: 'วิธีกรอก', lines: ['บรรทัดหนึ่ง'], roleHeaders: ['รหัสบทบาท', 'ชื่อบทบาท'] as const, roles: [{ code: 'FINANCE', name: 'บัญชีและการเงิน' }] }
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load(new Uint8Array(await buildMemberImportTemplate(LABELS, guide)).buffer as ArrayBuffer)
    const help = workbook.getWorksheet('วิธีกรอก')!
    const values = help.getSheetValues().flatMap((row) => (Array.isArray(row) ? [row.filter((v) => v !== undefined && v !== null)] : []))
    expect(values).toEqual([['บรรทัดหนึ่ง'], ['รหัสบทบาท', 'ชื่อบทบาท'], ['FINANCE', 'บัญชีและการเงิน']])
  })

  it('a member without admin.members cannot import', async () => {
    const { org, ctxOf } = await orgWithAdmins()
    const plain = await createMember(org.id)
    const file = await importFile([{ email: `x-${randomUUID()}@test.bcs.local`, displayNameTh: 'ใคร' }])
    expect(await importMembers(ctxOf(plain.id), file, { sender: null })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
  })
})

describe('[FR-ADM-001/AC1] the screen is told whether invitation e-mails really went out', () => {
  it('reports a failed invitation e-mail, and every address an import could not e-mail', async () => {
    const { ctx } = await orgWithAdmins()
    setEmailProvider({
      async send() {
        throw new Error('smtp down')
      },
    })
    try {
      const invited = await inviteMember(ctx, { email: `down-${randomUUID()}@test.bcs.local`, displayNameTh: 'อีเมลล่ม' }, key())
      expect(invited).toMatchObject({ ok: true, data: { emailSent: false } })
      const emails = [`d1-${randomUUID()}@test.bcs.local`, `d2-${randomUUID()}@test.bcs.local`]
      const file = await importFile(emails.map((email, i) => ({ email, displayNameTh: `นำเข้า ${i}` })))
      expect(await importMembers(ctx, file, { sender: null })).toEqual({ ok: true, data: { invited: 2, emailsSent: 0, notSent: emails } })
    } finally {
      setEmailProvider({ async send(m) { outbox.push(m); return { messageId: randomUUID() } } })
    }
  })
})

describe('[FR-PLT-012/AC1] a form submission sent twice with its key invites once', () => {
  it('runs the invitation once: one member.invited event and one e-mail; the repeat says it was already saved', async () => {
    const { ctx, org } = await orgWithAdmins()
    const email = `twice-${randomUUID()}@test.bcs.local`
    const submission = { idempotencyKey: randomUUID(), sender: null }
    const sentBefore = outbox.filter((m) => m.to === email).length
    const first = await inviteMember(ctx, { email, displayNameTh: 'กดสองครั้ง' }, submission)
    const second = await inviteMember(ctx, { email, displayNameTh: 'กดสองครั้ง' }, submission)
    expect(first).toMatchObject({ ok: true, data: { emailSent: true } })
    expect(second).toMatchObject({ ok: true, data: { emailSent: null } })
    if (!first.ok || !second.ok) return
    expect(second.data.memberId).toBe(first.data.memberId)
    expect(await prisma.event.count({ where: { organizationId: org.id, aggregateId: first.data.memberId, type: 'member.invited' } })).toBe(1)
    expect(outbox.filter((m) => m.to === email).length - sentBefore).toBe(1)
  })
})
