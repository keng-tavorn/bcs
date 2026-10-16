import { TZDate } from '@date-fns/tz'
import { z } from 'zod'
import { BP_PER_WHOLE } from '@/core/money/constants'
import type { AppError } from '@/core/result'
import { businessMinutesBetween, WEEKDAYS, type BusinessCalendar } from '@/core/sla'
import { OrgSettingsSchema } from '@/lib/org-settings'
import { loadPrincipal } from '@/server/authz'
import { makeCtx, systemCtx } from '@/server/context'
import { forTenant, type TenantTx } from '@/server/db/tenant'
import { loadBusinessCalendar } from '@/server/doa/policy'
import type { EventDraft } from '@/server/events/append'
import type { NotificationDraft } from '@/server/notifications/create'
import { defineCommand, runCommand, type CommandOutcome } from '../_pipeline'
import { digestEnabled } from '../self/notification-prefs'
import { throwIfTransient } from './step-result'
import { burnContext, burnOf } from '../budget/burn'
import { BUDGET_LINE_AMOUNTS, lineAmounts } from '../budget/dashboard'

// The daily summary (spec §10.3, FR-LINE-006, §4.7 rule 3): at 08:00 on the organization's business days — never on its
// holidays (AC2) — each member with something to report gets one summary, by LINE when they are linked, else by e-mail:
//  · whoever has approval tasks waiting: how many, the five that waited longest with their age in business time, and
//    how many are past their SLA;
//  · DEPT_HEAD and EXECUTIVE: the approvals waiting and past their SLA in their scope (EXECUTIVE the organization, a
//    department head the requests charged to the departments they head, as the board shows them; an escalated step,
//    with its two open tasks, is one approval), and the budget lines whose available amount is below
//    digest.budgetLowPct of the planned amount (FR-LINE-006 AC1), with a link to /board/pending;
//  · S6-18 (FR-BUD-104 AC2 · BR-BUD-17): with the low lines, the lines whose use reached a threshold of
//    budget.alertThresholdsBp or whose forecast is above the budget — each line once with every reason; BUDGET_ADMIN
//    gets these lines of the whole organization (scope BUDGET: budget lines only, no approvals);
//  · the notifications that wait for the summary (urgency DIGEST), counted and marked as summarized.
// Nobody with nothing to report gets one (AC2), and a member who turned their summary off gets none (AC3,
// Member.notificationPrefs.digest). The content is counts, document numbers, ages and budget line codes: no items,
// prices, files or personal data (BR-NOTI-01). One command per organization and day: the date is the idempotency key.
// Each summary is recorded with notification.digest_sent (NEW-34) on the recipient's notification box.

export const DIGEST_JOB = 'daily-digest'
/** §10.3: the five tasks that waited longest */
export const DIGEST_OLDEST_SHOWN = 5
/** Budget line codes named in a summary; the rest are counted */
export const DIGEST_LINES_SHOWN = 5
const PERCENT_TO_BP = 100

export interface DigestTaskItem {
  readonly taskId: string
  readonly subjectType: string
  readonly subjectId: string
  /** Document number, or the code of a policy document; never free text */
  readonly label: string | null
  /** An authority change's kind (it has no number); the template names it in words */
  readonly changeKind?: string
  /** Business minutes since the task was assigned (§7.8 calendar) */
  readonly ageMinutes: number
  readonly overdue: boolean
}

export interface DigestData {
  readonly date: string
  readonly mine: { readonly pending: number; readonly overdue: number; readonly oldest: readonly DigestTaskItem[] } | null
  readonly scope: {
    readonly kind: 'ORG' | 'DEPT' | 'BUDGET'
    readonly pending: number
    readonly overdue: number
    readonly lowBudgetLines: number
    readonly lowLineCodes: readonly string[]
    readonly lowPct: number
    /** S6-18: the lines low or with an alert, each once; the first DIGEST_LINES_SHOWN named with their reasons */
    readonly budgetLines: number
    readonly budgetLineFlags: ReadonlyArray<{ readonly code: string; readonly reasons: readonly string[] }>
  } | null
  /** Notifications of urgency DIGEST folded into this summary (§4.7 rule 3) */
  readonly updates: number
}

const refuse = (code: 'VALIDATION_FAILED' | 'NOT_FOUND', reason: string, message = reason): CommandOutcome<never> => ({ ok: false, error: { code, message, details: { reason } } })

/** The calendar day of an instant in the organization's time zone */
export function localDay(at: Date, timezone: string): { key: string; weekday: (typeof WEEKDAYS)[number] } {
  const local = new TZDate(at.getTime(), timezone)
  const key = `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, '0')}-${String(local.getDate()).padStart(2, '0')}`
  return { key, weekday: WEEKDAYS[local.getDay()]! }
}

/** A business day of the organization: one of its working weekdays and not one of its holidays (BR-SLA-01) */
export function businessDayReason(day: { key: string; weekday: (typeof WEEKDAYS)[number] }, calendar: BusinessCalendar): 'HOLIDAY' | 'NOT_BUSINESS_DAY' | null {
  if (calendar.holidays.includes(day.key)) return 'HOLIDAY'
  return calendar.workdays.includes(day.weekday) ? null : 'NOT_BUSINESS_DAY'
}

type OpenTask = { id: string; stepId: string; assigneeMemberId: string; assignedAt: Date; dueAt: Date | null; step: { route: { subjectType: string; subjectId: string } } }

/** How a summary names a document: its number or a policy document's code, or an authority change's kind */
type Label = { readonly label: string | null; readonly changeKind?: string }

/** Numbers and codes of the documents the tasks are on (BR-NOTI-01: no titles, which are free text) */
async function labelsOf(tx: TenantTx, tasks: readonly OpenTask[]): Promise<{ labels: Map<string, Label>; chargedTo: Map<string, string> }> {
  const ids = (type: string) => [...new Set(tasks.filter((t) => t.step.route.subjectType === type).map((t) => t.step.route.subjectId))]
  const [requests, pos, variances, versions, changes] = await Promise.all([
    tx.request.findMany({ where: { id: { in: ids('REQUEST') } }, select: { id: true, number: true, chargedDepartmentId: true } }),
    tx.purchaseOrder.findMany({ where: { id: { in: ids('PURCHASE_ORDER') } }, select: { id: true, number: true } }),
    tx.variance.findMany({ where: { id: { in: ids('VARIANCE') } }, select: { id: true, po: { select: { number: true } } } }),
    tx.doaVersion.findMany({ where: { id: { in: ids('DOA_VERSION') } }, select: { id: true, code: true, versionNo: true } }),
    tx.orgAuthorityChange.findMany({ where: { id: { in: ids('ORG_AUTHORITY_CHANGE') } }, select: { id: true, kind: true } }),
  ])
  const labels = new Map<string, Label>([
    ...requests.map((r) => [r.id, { label: r.number }] as const),
    ...pos.map((p) => [p.id, { label: p.number }] as const),
    ...variances.map((v) => [v.id, { label: v.po.number }] as const),
    ...versions.map((v) => [v.id, { label: `${v.code} #${v.versionNo}` }] as const),
    ...changes.map((c) => [c.id, { label: null, changeKind: c.kind }] as const),
  ])
  return { labels, chargedTo: new Map(requests.map((r) => [r.id, r.chargedDepartmentId])) }
}

/**
 * Approvals waiting and past their SLA, counted per step: an escalated step has two open tasks (the assignee's and
 * the co-assignee's, BR-SLA-04) but is one approval waiting
 */
function stepCounts(tasks: readonly OpenTask[], isOverdue: (t: OpenTask) => boolean): { pending: number; overdue: number } {
  const steps = new Map<string, boolean>()
  for (const t of tasks) steps.set(t.stepId, (steps.get(t.stepId) ?? false) || isOverdue(t))
  return { pending: steps.size, overdue: [...steps.values()].filter(Boolean).length }
}

/** BUDGET_ADMIN who is neither EXECUTIVE nor a department head: the organization's budget lines, no approvals */
const BUDGET_SCOPE = { kind: 'BUDGET', departments: new Set<string>() } as const

interface Scope {
  readonly kind: 'ORG' | 'DEPT' | 'BUDGET'
  readonly departments: ReadonlySet<string>
}

/** §10.3: EXECUTIVE sees the organization, a department head the departments they head (§2.2 DEPT_HEAD), others none */
async function scopeOf(tx: TenantTx, organizationId: string, memberId: string, now: Date): Promise<Scope | null> {
  const principal = await loadPrincipal(tx, makeCtx({ organizationId, actor: { type: 'USER', memberId }, channel: 'SYSTEM', now }))
  if (principal.kind !== 'member') return null
  if (principal.roles.has('EXECUTIVE')) return { kind: 'ORG', departments: new Set() }
  return principal.headOfDepartmentIds.size > 0 ? { kind: 'DEPT', departments: principal.headOfDepartmentIds } : null
}

const SendInput = z.strictObject({ date: z.iso.date() })

export const sendDailyDigestCommand = defineCommand({
  name: 'digest.send_daily',
  capability: 'board.pending.view',
  input: SendInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ date: string; sent: number }>> {
    if (ctx.actor.type !== 'SYSTEM') return { ok: false, error: { code: 'FORBIDDEN', message: 'only the daily-digest job sends summaries', details: { reason: 'SYSTEM_ONLY' } } }
    const org = await tx.organization.findUniqueOrThrow({ where: { id: ctx.organizationId }, select: { settings: true } })
    const settings = OrgSettingsSchema.shape.digest.safeParse((org.settings as { digest?: unknown } | null)?.digest)
    if (!settings.success || !settings.data.enabled) return refuse('VALIDATION_FAILED', 'DIGEST_OFF', 'the organization does not send daily summaries')
    const calendar = await loadBusinessCalendar(tx, ctx.organizationId)
    const today = localDay(ctx.now, calendar.timezone)
    if (input.date !== today.key) return refuse('VALIDATION_FAILED', 'NOT_TODAY', 'a summary is sent for its own day')
    const off = businessDayReason(today, calendar)
    if (off) return refuse('VALIDATION_FAILED', off, 'not a business day of the organization')

    const members = await tx.member.findMany({ where: { status: 'ACTIVE' }, select: { id: true, notificationPrefs: true }, orderBy: { id: 'asc' } })
    const wants = new Set(members.filter((m) => digestEnabled(m.notificationPrefs)).map((m) => m.id))
    const tasks: OpenTask[] = await tx.approvalTask.findMany({
      where: { status: 'OPEN', step: { route: { status: 'ACTIVE' } } },
      select: { id: true, stepId: true, assigneeMemberId: true, assignedAt: true, dueAt: true, step: { select: { route: { select: { subjectType: true, subjectId: true } } } } },
      orderBy: [{ assignedAt: 'asc' }, { id: 'asc' }],
    })
    const { labels, chargedTo } = await labelsOf(tx, tasks)
    const overdue = (t: OpenTask) => t.dueAt !== null && t.dueAt.getTime() < ctx.now.getTime()

    // Budget lines of the fiscal year today falls in, with what is available (the ledger's balance projection)
    const day = new Date(`${today.key}T00:00:00Z`)
    const year = await tx.fiscalYear.findFirst({ where: { startsOn: { lte: day }, endsOn: { gte: day } }, select: { id: true, startsOn: true, endsOn: true } })
    const lowBp = BigInt(Math.round(settings.data.budgetLowPct * PERCENT_TO_BP))
    const lines = year
      ? await tx.budgetLine.findMany({ where: { fiscalYearId: year.id, status: 'OPEN' }, select: { code: true, departmentId: true, ...BUDGET_LINE_AMOUNTS }, orderBy: { code: 'asc' } })
      : []
    // FR-BUD-005: low when what is available is below budgetLowPct of the planned amount
    const isLow = (l: (typeof lines)[number]) => l.plannedSatang > 0n && (l.balance?.availableSatang ?? 0n) * BP_PER_WHOLE < l.plannedSatang * lowBp
    const lowLines = lines.filter(isLow)
    // S6-18 (BR-BUD-17): every reason of a line, so a line low and with an alert is named once
    const pace = year ? burnContext(year, ctx.now, calendar.timezone, org.settings) : null
    const flagged = lines
      .map((l) => ({ line: l, reasons: [...(isLow(l) ? ['LOW'] : []), ...(pace ? burnOf(lineAmounts(l), pace).alerts : [])] }))
      .filter((f) => f.reasons.length > 0)

    // DIGEST notifications wait for this summary (§4.7 rule 3)
    const waiting = await tx.notification.findMany({ where: { urgency: 'DIGEST', status: 'PENDING', readAt: null, recipientMemberId: { in: [...wants] } }, select: { id: true, recipientMemberId: true } })

    const executives = await tx.roleAssignment.findMany({ where: { role: 'EXECUTIVE', revokedAt: null }, select: { memberId: true } })
    const heads = await tx.positionAssignment.findMany({
      where: { validFrom: { lte: ctx.now }, OR: [{ validTo: null }, { validTo: { gt: ctx.now } }], position: { scope: 'DEPARTMENT' } },
      select: { memberId: true },
    })
    // S6-18 (OQ-113): BUDGET_ADMIN reads the budget lines of the organization
    const budgetAdmins = await tx.roleAssignment.findMany({ where: { role: 'BUDGET_ADMIN', revokedAt: null }, select: { memberId: true } })
    // Only EXECUTIVE, BUDGET_ADMIN and the holders of a department's position can have a scope: nobody else needs their principal read
    const mayHaveScope = new Set([...executives.map((e) => e.memberId), ...heads.map((h) => h.memberId), ...budgetAdmins.map((b) => b.memberId)])
    const candidates = new Set([...tasks.map((t) => t.assigneeMemberId), ...mayHaveScope, ...waiting.map((w) => w.recipientMemberId)])

    const events: EventDraft[] = []
    const notifications: NotificationDraft[] = []
    const summarized: string[] = []
    for (const memberId of [...candidates].filter((m) => wants.has(m)).sort()) {
      const own = tasks.filter((t) => t.assigneeMemberId === memberId)
      const mine: DigestData['mine'] = own.length
        ? {
            pending: own.length,
            overdue: own.filter(overdue).length,
            oldest: own.slice(0, DIGEST_OLDEST_SHOWN).map((t) => {
              const named = labels.get(t.step.route.subjectId)
              return {
                taskId: t.id,
                subjectType: t.step.route.subjectType,
                subjectId: t.step.route.subjectId,
                label: named?.label ?? null,
                ...(named?.changeKind ? { changeKind: named.changeKind } : {}),
                ageMinutes: businessMinutesBetween(t.assignedAt, ctx.now, calendar),
                overdue: overdue(t),
              }
            }),
          }
        : null
      const scope = mayHaveScope.has(memberId) ? ((await scopeOf(tx, ctx.organizationId, memberId, ctx.now)) ?? (budgetAdmins.some((b) => b.memberId === memberId) ? BUDGET_SCOPE : null)) : null
      let scopeData: DigestData['scope'] = null
      if (scope) {
        const wholeOrg = scope.kind !== 'DEPT'
        const inScope = scope.kind === 'ORG' ? tasks : scope.kind === 'BUDGET' ? [] : tasks.filter((t) => t.step.route.subjectType === 'REQUEST' && scope.departments.has(chargedTo.get(t.step.route.subjectId) ?? ''))
        const low = wholeOrg ? lowLines : lowLines.filter((l) => scope.departments.has(l.departmentId))
        const flags = wholeOrg ? flagged : flagged.filter((f) => scope.departments.has(f.line.departmentId))
        scopeData = {
          kind: scope.kind,
          ...stepCounts(inScope, overdue),
          lowBudgetLines: low.length,
          lowLineCodes: low.slice(0, DIGEST_LINES_SHOWN).map((l) => l.code),
          lowPct: settings.data.budgetLowPct,
          budgetLines: flags.length,
          budgetLineFlags: flags.slice(0, DIGEST_LINES_SHOWN).map((f) => ({ code: f.line.code, reasons: f.reasons })),
        }
      }
      const updates = waiting.filter((w) => w.recipientMemberId === memberId)
      const reportable = (mine?.pending ?? 0) > 0 || (scopeData !== null && scopeData.pending + scopeData.overdue + scopeData.budgetLines > 0) || updates.length > 0
      // FR-LINE-006 AC2: nothing to report, no summary
      if (!reportable) continue
      const data: DigestData = { date: today.key, mine, scope: scopeData, updates: updates.length }
      notifications.push({ recipientMemberId: memberId, templateKey: 'digest.daily', data: { ...data }, urgency: 'IMMEDIATE', dedupeKey: `digest.daily:${today.key}:${memberId}` })
      // NEW-34: on the recipient's notification box, like notification.read; counts only (BR-NOTI-01)
      events.push({
        type: 'notification.digest_sent',
        aggregateType: 'Notification',
        aggregateId: memberId,
        data: {
          date: today.key,
          pending: mine?.pending ?? 0,
          overdue: mine?.overdue ?? 0,
          scope: scopeData?.kind ?? null,
          scopePending: scopeData?.pending ?? 0,
          scopeOverdue: scopeData?.overdue ?? 0,
          lowBudgetLines: scopeData?.lowBudgetLines ?? 0,
          updates: updates.length,
        },
      })
      summarized.push(...updates.map((u) => u.id))
    }
    if (events.length === 0) return refuse('NOT_FOUND', 'NOTHING_TO_REPORT', 'nobody has anything to report today')
    // Folded into today's summary: the bell still shows them until they are read
    if (summarized.length) await tx.notification.updateMany({ where: { id: { in: summarized }, status: 'PENDING' }, data: { status: 'SENT', sentAt: ctx.now } })
    return { ok: true, result: { date: today.key, sent: events.length }, events, notifications }
  },
})

export type DigestRunResult = { readonly date: string; readonly sent: number; readonly reason: string | null }

const reasonOf = (error: AppError) => (typeof error.details?.reason === 'string' ? error.details.reason : error.code)

/**
 * Handler of the daily-digest job for one organization: the day of `now` in its time zone is the idempotency key. A
 * busy database or an unexpected error throws (RetryableStepError), so Inngest retries the organization's step instead
 * of the day passing without its summaries.
 */
export async function runDailyDigest(organizationId: string, now: Date): Promise<DigestRunResult> {
  const org = await forTenant(organizationId).organization.findUniqueOrThrow({ where: { id: organizationId }, select: { timezone: true } })
  const date = localDay(now, org.timezone).key
  const r = await runCommand(systemCtx(organizationId, now, DIGEST_JOB), sendDailyDigestCommand, { date }, { idempotencyKey: `${DIGEST_JOB}:${date}` })
  if (r.ok) return { date, sent: r.data.sent, reason: null }
  throwIfTransient(r.error)
  return { date, sent: 0, reason: reasonOf(r.error) }
}
