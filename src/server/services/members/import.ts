import { createHash, randomBytes } from 'node:crypto'
import ExcelJS from 'exceljs'
import { z } from 'zod'
import { err, ok, type Result } from '@/core/result'
import { INVITATION_TTL_MS } from '@/lib/constants'
import { newId } from '@/lib/ids'
import { authorize } from '@/server/authz'
import { STORED_ROLES, type StoredRole } from '@/server/authz/permissions'
import { sendInvitationEmail } from '@/server/auth/emails'
import type { Ctx } from '@/server/context'
import { forTenant } from '@/server/db/tenant'
import type { EventDraft } from '@/server/events/append'
import { defineCommand, runCommand, type CommandOutcome, type RunOptions } from '../_pipeline'

// Import members from the Excel template (FR-ADM-001 AC3). Every row is checked first; if any row is wrong the
// answer lists each wrong row and field and nothing is saved. Otherwise all members are invited in one transaction
// (events member.invited and member.role_granted), and the invitation e-mails go out after the commit.

export const IMPORT_COLUMNS = ['email', 'displayNameTh', 'displayNameEn', 'employeeCode', 'roles'] as const
export type ImportColumn = (typeof IMPORT_COLUMNS)[number]
export const IMPORT_SHEET = 'Members'
export const IMPORT_MAX_ROWS = 500
const FIRST_DATA_ROW = 3

export type ImportRowReason =
  | 'REQUIRED'
  | 'INVALID_EMAIL'
  | 'TOO_LONG'
  | 'UNKNOWN_ROLE'
  | 'DUPLICATE_IN_FILE'
  | 'ALREADY_MEMBER'
  | 'EMPLOYEE_CODE_TAKEN'
  | 'NO_ROWS'
  | 'TOO_MANY_ROWS'
  | 'UNREADABLE'
  | 'MISSING_HEADER'

export interface ImportRowError {
  readonly row: number
  readonly field: ImportColumn | 'file'
  readonly reason: ImportRowReason
}

interface ImportRow {
  readonly row: number
  readonly email: string
  readonly displayNameTh: string
  readonly displayNameEn: string | null
  readonly employeeCode: string | null
  readonly roles: StoredRole[]
}

/** Names a role may be written with in the file besides its code: the screen's role names in Thai and English. */
export interface ImportRoleNames {
  readonly code: StoredRole | 'REQUESTER'
  readonly names: readonly string[]
}

/** The second sheet of the template, in the words of the screen (passed in by the caller): how to fill the file
 *  and every role with its code and name, so the roles column can be filled without guessing. */
export interface ImportTemplateGuide {
  readonly sheetName: string
  readonly lines: readonly string[]
  readonly roleHeaders: readonly [code: string, name: string]
  readonly roles: ReadonlyArray<{ readonly code: string; readonly name: string }>
}

/** The template: column keys on row 1, the screen's labels on row 2, data from row 3; then the guide sheet. */
export async function buildMemberImportTemplate(labels: Record<ImportColumn, string>, guide?: ImportTemplateGuide): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet(IMPORT_SHEET)
  sheet.addRow([...IMPORT_COLUMNS])
  sheet.addRow(IMPORT_COLUMNS.map((c) => labels[c]))
  sheet.getRow(1).font = { bold: true }
  sheet.views = [{ state: 'frozen', ySplit: 2 }]
  IMPORT_COLUMNS.forEach((_, i) => (sheet.getColumn(i + 1).width = 28))
  if (guide) {
    const help = workbook.addWorksheet(guide.sheetName)
    for (const line of guide.lines) help.addRow([line])
    help.addRow([])
    help.addRow([...guide.roleHeaders]).font = { bold: true }
    for (const role of guide.roles) help.addRow([role.code, role.name])
    help.getColumn(1).width = 28
    help.getColumn(2).width = 40
  }
  return Buffer.from(await workbook.xlsx.writeBuffer())
}

function text(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'object' && 'richText' in value) return value.richText.map((p) => p.text).join('').trim()
  if (typeof value === 'object' && 'text' in value && typeof value.text === 'string') return value.text.trim()
  if (typeof value === 'object' && 'result' in value) return text((value.result ?? null) as ExcelJS.CellValue)
  return String(value).trim()
}

const emailSchema = z.email()

// Roles in one cell are separated by a comma, a semicolon or a line break; a role name may contain spaces
const ROLE_SEPARATOR = /[,;\n]+/

/** Code or name (any case) → role; REQUESTER means no role. */
function roleLookup(roleNames: readonly ImportRoleNames[]): Map<string, StoredRole | 'REQUESTER'> {
  const lookup = new Map<string, StoredRole | 'REQUESTER'>([['requester', 'REQUESTER']])
  for (const role of STORED_ROLES) lookup.set(role.toLowerCase(), role)
  for (const { code, names } of roleNames) for (const name of names) if (name.trim()) lookup.set(name.trim().toLowerCase(), code)
  return lookup
}

/** Reads and checks the file; never throws on bad input. */
export async function parseMemberImport(bytes: ArrayBuffer, roleNames: readonly ImportRoleNames[] = []): Promise<{ rows: ImportRow[]; errors: ImportRowError[] }> {
  const lookup = roleLookup(roleNames)
  const workbook = new ExcelJS.Workbook()
  try {
    await workbook.xlsx.load(bytes)
  } catch {
    return { rows: [], errors: [{ row: 0, field: 'file', reason: 'UNREADABLE' }] }
  }
  const sheet = workbook.getWorksheet(IMPORT_SHEET) ?? workbook.worksheets[0]
  if (!sheet) return { rows: [], errors: [{ row: 0, field: 'file', reason: 'UNREADABLE' }] }
  const columns = new Map<ImportColumn, number>()
  sheet.getRow(1).eachCell((cell, col) => {
    const key = text(cell.value) as ImportColumn
    if ((IMPORT_COLUMNS as readonly string[]).includes(key)) columns.set(key, col)
  })
  // Row 1 holds the column codes of the template; without them no column can be found
  if (!columns.has('email') || !columns.has('displayNameTh')) return { rows: [], errors: [{ row: 1, field: 'file', reason: 'MISSING_HEADER' }] }

  const rows: ImportRow[] = []
  const errors: ImportRowError[] = []
  const seenEmails = new Set<string>()
  const seenCodes = new Set<string>()
  for (let r = FIRST_DATA_ROW; r <= sheet.rowCount; r++) {
    const cell = (c: ImportColumn) => (columns.has(c) ? text(sheet.getRow(r).getCell(columns.get(c)!).value) : '')
    const raw = Object.fromEntries(IMPORT_COLUMNS.map((c) => [c, cell(c)])) as Record<ImportColumn, string>
    if (IMPORT_COLUMNS.every((c) => raw[c] === '')) continue
    const before = errors.length
    const email = raw.email.toLowerCase()
    if (!email) errors.push({ row: r, field: 'email', reason: 'REQUIRED' })
    else if (!emailSchema.safeParse(email).success) errors.push({ row: r, field: 'email', reason: 'INVALID_EMAIL' })
    else if (seenEmails.has(email)) errors.push({ row: r, field: 'email', reason: 'DUPLICATE_IN_FILE' })
    if (!raw.displayNameTh) errors.push({ row: r, field: 'displayNameTh', reason: 'REQUIRED' })
    else if (raw.displayNameTh.length > 200) errors.push({ row: r, field: 'displayNameTh', reason: 'TOO_LONG' })
    if (raw.displayNameEn.length > 200) errors.push({ row: r, field: 'displayNameEn', reason: 'TOO_LONG' })
    if (raw.employeeCode.length > 50) errors.push({ row: r, field: 'employeeCode', reason: 'TOO_LONG' })
    else if (raw.employeeCode && seenCodes.has(raw.employeeCode)) errors.push({ row: r, field: 'employeeCode', reason: 'DUPLICATE_IN_FILE' })
    const named = raw.roles
      .split(ROLE_SEPARATOR)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => lookup.get(s.toLowerCase()))
    if (named.some((role) => role === undefined)) errors.push({ row: r, field: 'roles', reason: 'UNKNOWN_ROLE' })
    const roles = named.filter((role): role is StoredRole => role !== undefined && role !== 'REQUESTER')
    seenEmails.add(email)
    if (raw.employeeCode) seenCodes.add(raw.employeeCode)
    if (errors.length === before) {
      rows.push({ row: r, email, displayNameTh: raw.displayNameTh, displayNameEn: raw.displayNameEn || null, employeeCode: raw.employeeCode || null, roles: [...new Set(roles)] as StoredRole[] })
    }
  }
  if (rows.length + errors.length === 0) errors.push({ row: 0, field: 'file', reason: 'NO_ROWS' })
  if (rows.length > IMPORT_MAX_ROWS) errors.push({ row: 0, field: 'file', reason: 'TOO_MANY_ROWS' })
  return { rows, errors }
}

const ImportInput = z.object({
  rows: z.array(
    z.object({
      row: z.number().int(),
      email: z.email(),
      displayNameTh: z.string().min(1).max(200),
      displayNameEn: z.string().max(200).nullable(),
      employeeCode: z.string().max(50).nullable(),
      roles: z.array(z.enum(STORED_ROLES)),
    }),
  ),
})

function importCommand(tokenHashes: readonly string[]) {
  return defineCommand({
    name: 'member.import',
    capability: 'admin.members',
    input: ImportInput,
    async execute(tx, input, ctx): Promise<CommandOutcome<{ memberIds: string[]; tokenHashes: string[] }>> {
      const allowed = await authorize(tx, ctx, 'admin.members')
      if (!allowed.ok) return { ok: false, error: allowed.error }
      const actorId = ctx.actor.type === 'USER' ? ctx.actor.memberId : null
      const expiresAt = new Date(ctx.now.getTime() + INVITATION_TTL_MS)
      const events: EventDraft[] = []
      const memberIds: string[] = []
      for (const [i, row] of input.rows.entries()) {
        const memberId = newId()
        const invitationId = newId()
        await tx.member.create({
          data: {
            id: memberId,
            organizationId: ctx.organizationId,
            email: row.email,
            displayNameTh: row.displayNameTh,
            ...(row.displayNameEn ? { displayNameEn: row.displayNameEn } : {}),
            ...(row.employeeCode ? { employeeCode: row.employeeCode } : {}),
            status: 'INVITED',
          },
        })
        await tx.memberInvitation.create({ data: { id: invitationId, organizationId: ctx.organizationId, memberId, tokenHash: tokenHashes[i]!, expiresAt, createdById: actorId } })
        events.push({ type: 'member.invited', aggregateType: 'Member', aggregateId: memberId, data: { invitationId, roles: row.roles, resent: false } })
        for (const role of row.roles) {
          await tx.roleAssignment.create({ data: { organizationId: ctx.organizationId, memberId, role, grantedById: actorId, grantedAt: ctx.now } })
          events.push({ type: 'member.role_granted', aggregateType: 'Member', aggregateId: memberId, data: { role, scopeDepartmentId: null } })
        }
        memberIds.push(memberId)
      }
      return { ok: true, result: { memberIds, tokenHashes: [...tokenHashes] }, events }
    },
  })
}

/** emailsSent is null when the same file was imported before: nothing changed and nothing was e-mailed again.
 *  notSent lists the addresses whose invitation e-mail failed, for a resend from the member's page. */
export interface ImportOutcome {
  readonly invited: number
  readonly emailsSent: number | null
  readonly notSent: readonly string[]
}

export async function importMembers(
  ctx: Ctx,
  bytes: ArrayBuffer,
  options: Omit<RunOptions, 'idempotencyKey'> & { locale?: 'th' | 'en'; roleNames?: readonly ImportRoleNames[] } = {},
): Promise<Result<ImportOutcome>> {
  const db = forTenant(ctx.organizationId)
  const allowed = await db.$transaction((tx) => authorize(tx, ctx, 'admin.members'))
  if (!allowed.ok) return allowed
  const { rows, errors } = await parseMemberImport(bytes, options.roleNames)
  if (rows.length) {
    const existing = await db.member.findMany({
      where: { OR: [{ email: { in: rows.map((r) => r.email) } }, { employeeCode: { in: rows.flatMap((r) => (r.employeeCode ? [r.employeeCode] : [])) } }] },
      select: { email: true, employeeCode: true },
    })
    const emails = new Set(existing.map((m) => m.email))
    const codes = new Set(existing.flatMap((m) => (m.employeeCode ? [m.employeeCode] : [])))
    for (const r of rows) {
      if (emails.has(r.email)) errors.push({ row: r.row, field: 'email', reason: 'ALREADY_MEMBER' })
      if (r.employeeCode && codes.has(r.employeeCode)) errors.push({ row: r.row, field: 'employeeCode', reason: 'EMPLOYEE_CODE_TAKEN' })
    }
  }
  if (errors.length) {
    const sorted = [...errors].sort((a, b) => a.row - b.row)
    return err('VALIDATION_FAILED', 'the file has rows to fix; nothing was saved', { field: 'file', rows: sorted })
  }

  const tokens = rows.map(() => randomBytes(32).toString('base64url'))
  const tokenHashes = tokens.map((t) => createHash('sha256').update(t).digest('hex'))
  const fileHash = createHash('sha256').update(Buffer.from(bytes)).digest('hex')
  const { roleNames: _roleNames, locale: _locale, ...runOptions } = options
  const result = await runCommand(ctx, importCommand(tokenHashes), { rows }, { ...runOptions, idempotencyKey: `member-import:${fileHash}` })
  if (!result.ok) return result
  // A replay of the same file returns the stored result; its e-mails were handled the first time
  if (result.data.tokenHashes[0] !== tokenHashes[0]) return ok({ invited: result.data.memberIds.length, emailsSent: null, notSent: [] })
  const org = await db.organization.findUniqueOrThrow({ where: { id: ctx.organizationId }, select: { displayName: true, legalNameTh: true } })
  const inviter = ctx.actor.type === 'USER' ? await db.member.findUnique({ where: { id: ctx.actor.memberId }, select: { displayNameTh: true } }) : null
  const notSent: string[] = []
  for (const [i, row] of rows.entries()) {
    const sent = await sendInvitationEmail({ to: row.email, orgName: org.displayName ?? org.legalNameTh, inviterName: inviter?.displayNameTh ?? null, token: tokens[i]!, locale: options.locale ?? 'th' })
    if (!sent) notSent.push(row.email)
  }
  return ok({ invited: rows.length, emailsSent: rows.length - notSent.length, notSent })
}
