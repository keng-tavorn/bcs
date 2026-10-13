import { readFileSync } from 'node:fs'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import { toJsonSafe } from '@/lib/json'
import { OrgSettingsSchema, type OrgSettings } from '@/lib/org-settings'
import { deriveSeedBackupCodes, deriveSeedTotpSecret } from '@/lib/totp'
import { enableTotpWithSecret, upsertUserWithPassword } from '@/server/auth/provision'
import { requiresTwoFactor } from '@/server/auth/session'
import { STORED_ROLES, type StoredRole } from '@/server/authz/permissions'
import { systemCtx } from '@/server/context'
import { systemDb } from '@/server/db/system'
import { forTenant } from '@/server/db/tenant'
import { appendEvents, type EventDraft } from '@/server/events/append'
import { expressLayoutFromSheet } from './express-layout'
import { s6SettingsFromSheet } from './settings-s6'
import type { InputWorkbook } from './workbook'

// Demo organization loader (spec Appendix A, S1-13): sheets Org and Users of docs/inputs/BCS_inputs_v1_demo.xlsx
// plus prisma/seed/org-settings.demo.yaml, with the Express file layout of sheet Settings (S4-09, express-layout.ts:
// no columns until the customer's sample file, OQ-10). Runs only in local/preview/staging (prisma/seed.ts checks APP_ENV).
// Re-running changes nothing that already exists: rows and their events are created only when missing.
// Passwords come from SEED_DEV_PASSWORD. When SEED_TOTP_KEY is set, members who need 2FA get a TOTP secret derived
// from it so e2e tests (and a presenter on this machine) can produce codes (scripts/seed-totp.ts prints them); without
// it they set up their authenticator at first sign-in, so no extra secret has to be kept anywhere (staging).

export const ORG_SETTINGS_DEMO_PATH = 'prisma/seed/org-settings.demo.yaml'

const text = z.string().trim().min(1)
const list = (separator: string) =>
  z
    .string()
    .nullable()
    .transform((v) => (v ?? '').split(separator).map((s) => s.trim()).filter(Boolean))

const OrgSheet = z.object({
  code: z.string().regex(/^[A-Z0-9_-]{2,20}$/),
  legalNameTh: text,
  legalNameEn: text.nullable(),
  displayName: text.nullable(),
  taxId: z.string().regex(/^\d{13}$/),
  branchCode: z.string().regex(/^\d{5}$/),
  address: text.nullable(),
  timezone: text,
  fiscalYearStartMonth: z.coerce.number().int().min(1).max(12),
  contractSignatory: text,
  orgAdmins: list(','),
  currency: z.literal('THB'),
})

const UserRow = z.object({
  code: z.string().regex(/^[a-z0-9_]+$/),
  displayNameTh: text,
  email: z.email().transform((e) => e.toLowerCase()),
  department: text,
  roles: list(',').pipe(z.array(z.enum([...STORED_ROLES, 'REQUESTER']))),
  positions: list(';').pipe(z.array(z.string().regex(/^[A-Z_]+@[A-Za-z0-9_-]+$/))),
})

export type DemoUser = z.infer<typeof UserRow> & { readonly storedRoles: StoredRole[] }

export interface DemoOrgInput {
  readonly org: z.infer<typeof OrgSheet>
  readonly settings: OrgSettings
  readonly users: DemoUser[]
}

function issueText(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join('.') || '(row)'}: ${i.message}`).join('; ')
}

export function parseDemoOrgInput(workbook: InputWorkbook, settingsYaml: string): DemoOrgInput {
  const kv = workbook.keyValues('Org')
  const orgRaw = Object.fromEntries([...kv].map(([key, { value }]) => [key, value]))
  const org = OrgSheet.safeParse(orgRaw)
  if (!org.success) throw new Error(`Org sheet: ${issueText(org.error)}`)

  const users: DemoUser[] = []
  for (const { row, values } of workbook.table('Users')) {
    const parsed = UserRow.safeParse(values)
    if (!parsed.success) throw new Error(`Users row ${row}: ${issueText(parsed.error)}`)
    const storedRoles = parsed.data.roles.filter((r): r is StoredRole => r !== 'REQUESTER')
    users.push({ ...parsed.data, storedRoles })
  }
  const codes = new Set(users.map((u) => u.code))
  if (codes.size !== users.length) throw new Error('Users: duplicate code')
  if (new Set(users.map((u) => u.email)).size !== users.length) throw new Error('Users: duplicate e-mail')
  if (!codes.has(org.data.contractSignatory)) throw new Error(`Org.contractSignatory "${org.data.contractSignatory}" is not in Users`)
  for (const admin of org.data.orgAdmins) {
    const user = users.find((u) => u.code === admin)
    if (!user?.storedRoles.includes('ORG_ADMIN')) throw new Error(`Org.orgAdmins "${admin}" must be in Users with role ORG_ADMIN`)
  }

  const settings = OrgSettingsSchema.safeParse(parseYaml(settingsYaml))
  if (!settings.success) throw new Error(`${ORG_SETTINGS_DEMO_PATH}: ${issueText(settings.error)}`)
  // The Express columns are whatever the person filling in the workbook wrote, never a guess (§7.13, §17.3)
  const withExpress = { ...settings.data, express: expressLayoutFromSheet(workbook, settings.data.express) }
  return { org: org.data, settings: s6SettingsFromSheet(workbook, withExpress), users }
}

export function loadOrgSettingsYaml(path: string = ORG_SETTINGS_DEMO_PATH): string {
  return readFileSync(path, 'utf8')
}

export interface SeedOptions {
  readonly password: string
  /** Optional: pre-enroll TOTP from this key; omitted = members enroll at first sign-in */
  readonly totpKey?: string
  readonly now: Date
}

export interface SeedReport {
  readonly organizationId: string
  readonly organizationCreated: boolean
  readonly members: { readonly created: number; readonly existing: number }
  readonly rolesGranted: number
  readonly twoFactorEnabled: number
}

export async function seedDemoOrganization(input: DemoOrgInput, options: SeedOptions): Promise<SeedReport> {
  const { org, settings } = input

  // 1. The organization row is platform data (a tenant cannot create organizations)
  let organization = await systemDb.organization.findUnique({ where: { code: org.code } })
  const organizationCreated = !organization
  if (!organization) {
    organization = await systemDb.organization.create({
      data: {
        code: org.code,
        legalNameTh: org.legalNameTh,
        legalNameEn: org.legalNameEn,
        displayName: org.displayName,
        taxId: org.taxId,
        branchCode: org.branchCode,
        address: org.address,
        timezone: org.timezone,
        locale: settings.locale,
        settings: toJsonSafe(settings) as object,
      },
    })
  }
  const organizationId = organization.id

  // 2. Sign-in identities (Better Auth tables) and TOTP for everyone the 2FA policy covers (FR-AUTH-002 AC1)
  const identities = new Map<string, string>()
  const newlyEnrolled = new Set<string>()
  for (const user of input.users) {
    const userId = await upsertUserWithPassword({ email: user.email, name: user.displayNameTh, password: options.password })
    identities.set(user.code, userId)
    if (!options.totpKey || !requiresTwoFactor(user.storedRoles, user.positions.length > 0)) continue
    const before = await systemDb.user.findUniqueOrThrow({ where: { id: userId }, select: { twoFactorEnabled: true } })
    await enableTotpWithSecret(userId, deriveSeedTotpSecret(options.totpKey, user.code), deriveSeedBackupCodes(options.totpKey, user.code))
    if (!before.twoFactorEnabled) newlyEnrolled.add(user.code)
  }

  // 3. Members, roles, module and their events in one tenant transaction
  const ctx = systemCtx(organizationId, options.now, 'seed')
  const outcome = await forTenant(organizationId).$transaction(async (tx) => {
    const events: EventDraft[] = []
    const memberIds = new Map<string, string>()
    let created = 0
    let rolesGranted = 0

    if (!(await tx.orgModule.findFirst({ where: { module: 'CORE' } }))) {
      // Shown in the organization's history like any other reason, so it is written in Thai like the demo data
      const reason = 'ระบบหลักเปิดตั้งแต่สร้างองค์กรตัวอย่าง'
      await tx.orgModule.create({ data: { organizationId, module: 'CORE', enabled: true, enabledAt: options.now, contractRef: 'SEED', reason } })
      const comment = await tx.comment.create({ data: { organizationId, subjectType: 'Organization', subjectId: organizationId, authorMemberId: null, body: reason }, select: { id: true } })
      events.push({ type: 'organization.module_enabled', aggregateType: 'Organization', aggregateId: organizationId, data: { module: 'CORE', contractRef: 'SEED', reasonCommentId: comment.id } })
    }

    for (const user of input.users) {
      let member = await tx.member.findFirst({ where: { email: user.email } })
      if (!member) {
        member = await tx.member.create({
          data: {
            organizationId,
            email: user.email,
            displayNameTh: user.displayNameTh,
            employeeCode: user.code,
            status: 'ACTIVE',
            userId: identities.get(user.code)!,
          },
        })
        events.push({ type: 'member.activated', aggregateType: 'Member', aggregateId: member.id, data: { via: 'SEED' } })
        created++
      }
      memberIds.set(user.code, member.id)
      for (const role of user.storedRoles) {
        if (await tx.roleAssignment.findFirst({ where: { memberId: member.id, role, revokedAt: null } })) continue
        await tx.roleAssignment.create({ data: { organizationId, memberId: member.id, role, grantedAt: options.now } })
        events.push({ type: 'member.role_granted', aggregateType: 'Member', aggregateId: member.id, data: { role, scopeDepartmentId: null } })
        rolesGranted++
      }
      if (newlyEnrolled.has(user.code)) {
        events.push({ type: 'auth.2fa_enabled', aggregateType: 'Auth', aggregateId: member.id, data: { memberKnown: true, method: 'TOTP' } })
      }
    }

    // organization.created is written once, together with the contract signatory (BR-DOA-19, Appendix A: ceo)
    if (!(await tx.event.findFirst({ where: { type: 'organization.created', aggregateId: organizationId } }))) {
      const signatoryId = memberIds.get(org.contractSignatory) ?? null
      await tx.organization.update({
        where: { id: organizationId },
        data: { contractSignatoryMemberId: signatoryId, contractSignatoryVerifiedAt: signatoryId ? options.now : null },
      })
      events.unshift({
        type: 'organization.created',
        aggregateType: 'Organization',
        aggregateId: organizationId,
        data: { code: org.code, via: 'SEED', contractSignatoryMemberId: signatoryId },
      })
    }
    await appendEvents(tx, ctx, events)
    return { created, rolesGranted }
  })

  return {
    organizationId,
    organizationCreated,
    members: { created: outcome.created, existing: input.users.length - outcome.created },
    rolesGranted: outcome.rolesGranted,
    twoFactorEnabled: newlyEnrolled.size,
  }
}
