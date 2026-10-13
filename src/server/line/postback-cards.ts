import {
  approvalCard,
  decisionConfirmationCard,
  postbackRefusalMessage,
  type CardLocale,
  type FlexMessage,
  type PostbackRefusal,
  type TextMessage,
} from '@/channels/line/flex'
import { liffPathFor, liffTaskPath, type LiffTaskAction } from '@/channels/line/links'
import { stepUpNeeded } from '@/core/pin'
import type { AppError } from '@/core/result'
import { getEnv } from '@/lib/env'
import { forTenant } from '@/server/db/tenant'
import { liffLink } from './webhook/messages'

// What the LINE cards show, read from the database for the builders of src/channels/line/flex (which never read it):
// the approval card a task's assignee gets (spec §9.3, FR-LINE-002 AC1), the confirmation after an approval in the
// chat (AC2), and the answer to a tap that decided nothing (AC3). Also where their links go: the LIFF page of the same
// thing when the organization has a LIFF app (§9.4), otherwise the workspace (BR-NOTI-02). Reads only.

export interface CardContext {
  /** The organization's language (BR-NOTI-03: members have no language of their own yet) */
  readonly locale: CardLocale
  /** The organization's LIFF app; null: links open the workspace */
  readonly liffId: string | null
  /** APP_URL without a trailing slash */
  readonly appUrl: string
}

export async function cardContextOf(organizationId: string, liffId: string | null): Promise<CardContext> {
  const organization = await forTenant(organizationId).organization.findFirst({ select: { locale: true } })
  return { locale: organization?.locale === 'en' ? 'en' : 'th', liffId, appUrl: getEnv().APP_URL.replace(/\/+$/, '') }
}

/** A workspace page (a notification's href) as a LINE user opens it: its LIFF page when there is one */
export function documentLink(cards: CardContext, href: string | null): string {
  const page = href && href.startsWith('/') ? href : '/'
  const liffPath = cards.liffId ? liffPathFor(page) : null
  return cards.liffId && liffPath ? liffLink(cards.liffId, liffPath) : `${cards.appUrl}${page}`
}

/** The task's page: /liff/tasks/<taskId>[?action=…] (§9.3), or the workspace's /tasks/<taskId> */
export function taskLink(cards: CardContext, taskId: string, action?: LiffTaskAction): string {
  return cards.liffId ? liffLink(cards.liffId, liffTaskPath(taskId, action)) : `${cards.appUrl}/tasks/${encodeURIComponent(taskId)}`
}

type Db = ReturnType<typeof forTenant>

interface SubjectSummary {
  readonly label: string
  readonly typeName: string | null
  readonly requester: { readonly name: string; readonly department: string | null } | null
  readonly budget: 'RESERVED' | null
}

/** Whether anything is held on the budget for these document lines (BudgetAllocation, INV-BUD-03): reserved or committed */
async function budgetHeld(db: Db, lines: { readonly requestLineIds: readonly string[]; readonly poLineIds: readonly string[] }): Promise<boolean> {
  const sources = [
    ...(lines.requestLineIds.length ? [{ sourceType: 'REQUEST_LINE' as const, sourceId: { in: [...new Set(lines.requestLineIds)] } }] : []),
    ...(lines.poLineIds.length ? [{ sourceType: 'PO_LINE' as const, sourceId: { in: [...new Set(lines.poLineIds)] } }] : []),
  ]
  if (sources.length === 0) return false
  const held = await db.budgetAllocation.aggregate({ where: { OR: sources }, _sum: { reservedSatang: true, committedSatang: true } })
  return (held._sum.reservedSatang ?? 0n) + (held._sum.committedSatang ?? 0n) > 0n
}

/**
 * What a card says of the document: its number (or title), its type, the requester and their department — the only
 * person a LINE message may name (BR-NOTI-01) — and whether its budget is reserved.
 *  - A purchase request: all of it.
 *  - A PO: its number and whether its budget is held — reserved by its source requests' lines, committed on its own
 *    lines once approved. It names nobody: a PO gathers lines of several requests (consolidation), and its creator is a
 *    buyer, not a requester. Whether a PO card should name its requests' requesters is a personal-data decision left to
 *    the user.
 *  - A receiving variance: its PO's number, no person and no budget row.
 *  - Policy documents and others keep the label their notification carries.
 */
async function subjectSummary(db: Db, subjectType: string, subjectId: string, fallbackLabel: string, locale: CardLocale): Promise<SubjectSummary> {
  const pick = (th: string, en: string | null) => (locale === 'en' && en ? en : th)
  const none: SubjectSummary = { label: fallbackLabel, typeName: null, requester: null, budget: null }
  if (subjectType === 'REQUEST') {
    const request = await db.request.findFirst({
      where: { id: subjectId },
      select: {
        number: true,
        title: true,
        budgetLineId: true,
        requestType: { select: { nameTh: true, nameEn: true } },
        requester: { select: { displayNameTh: true, displayNameEn: true } },
        requesterDepartment: { select: { nameTh: true, nameEn: true } },
        lines: { select: { id: true } },
      },
    })
    if (!request) return none
    // What the request's lines hold on its budget line (BudgetAllocation, INV-BUD-03): reserved at submit (§7.7)
    const held =
      request.budgetLineId && request.lines.length > 0
        ? await db.budgetAllocation.aggregate({
            where: { budgetLineId: request.budgetLineId, sourceType: 'REQUEST_LINE', sourceId: { in: request.lines.map((l) => l.id) } },
            _sum: { reservedSatang: true, committedSatang: true },
          })
        : null
    const heldSatang = (held?._sum.reservedSatang ?? 0n) + (held?._sum.committedSatang ?? 0n)
    return {
      label: request.number ?? request.title,
      typeName: pick(request.requestType.nameTh, request.requestType.nameEn),
      requester: { name: pick(request.requester.displayNameTh, request.requester.displayNameEn), department: pick(request.requesterDepartment.nameTh, request.requesterDepartment.nameEn) },
      budget: heldSatang > 0n ? 'RESERVED' : null,
    }
  }
  if (subjectType === 'PURCHASE_ORDER') {
    const po = await db.purchaseOrder.findFirst({ where: { id: subjectId }, select: { number: true, lines: { select: { id: true, sources: { select: { requestLineId: true } } } } } })
    if (!po) return none
    const held = await budgetHeld(db, { requestLineIds: po.lines.flatMap((l) => l.sources.map((s) => s.requestLineId)), poLineIds: po.lines.map((l) => l.id) })
    return { ...none, label: po.number ?? fallbackLabel, budget: held ? 'RESERVED' : null }
  }
  if (subjectType === 'VARIANCE') {
    const variance = await db.variance.findFirst({ where: { id: subjectId }, select: { po: { select: { number: true } } } })
    return { ...none, label: variance?.po.number ?? fallbackLabel }
  }
  return none
}

/**
 * The approval card of an open task for its assignee (FR-LINE-002 AC1), with the in-chat approve button only when the
 * task may be decided there and the assignee holds a live LINE token (BR-TOK-05, BR-TOK-01). Null when the task is no
 * longer open or is not this member's: delivery then sends nothing (FR-NOTI-003 AC3).
 */
export async function approvalCardMessage(
  organizationId: string,
  task: { readonly taskId: string; readonly memberId: string; readonly fallbackLabel: string },
  now: Date,
  cards: CardContext,
): Promise<FlexMessage | null> {
  const db = forTenant(organizationId)
  const row = await db.approvalTask.findFirst({
    where: { id: task.taskId },
    select: {
      status: true,
      assigneeMemberId: true,
      principalMemberId: true,
      dueAt: true,
      overdueAt: true,
      escalatedAt: true,
      workflowRuleCodes: true,
      step: {
        select: {
          kind: true,
          route: {
            select: {
              subjectType: true,
              subjectId: true,
              amountSatang: true,
              amountBasis: true,
              ruleCode: true,
              doaVersion: { select: { code: true, versionNo: true, stepUpThresholdSatang: true } },
            },
          },
        },
      },
    },
  })
  if (!row || row.status !== 'OPEN' || row.assigneeMemberId !== task.memberId) return null
  const route = row.step.route
  const subject = await subjectSummary(db, route.subjectType, route.subjectId, task.fallbackLabel, cards.locale)
  const token = await db.actionToken.findFirst({
    where: { taskId: task.taskId, memberId: task.memberId, channel: 'LINE', usedAt: null, revokedAt: null, expiresAt: { gt: now } },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  })
  return approvalCard({
    locale: cards.locale,
    subjectType: route.subjectType,
    typeName: subject.typeName,
    label: subject.label,
    requester: subject.requester,
    amountSatang: route.amountSatang,
    amountBasis: route.amountSatang === null ? null : route.amountBasis,
    budget: subject.budget,
    dueAt: row.dueAt,
    overdue: row.overdueAt !== null || (row.dueAt !== null && row.dueAt.getTime() <= now.getTime()),
    doa: { code: route.doaVersion.code, versionNo: route.doaVersion.versionNo, ruleCode: route.ruleCode },
    acting: row.principalMemberId !== null,
    escalated: row.escalatedAt !== null,
    // A reviewer needs no PIN, whatever the amount (BR-WF-09)
    stepUp: row.step.kind !== 'REVIEW' && stepUpNeeded({ subjectType: route.subjectType, amountSatang: route.amountSatang, stepUpThresholdSatang: route.doaVersion.stepUpThresholdSatang }),
    review: row.step.kind === 'REVIEW' ? { ruleCodes: row.workflowRuleCodes } : null,
    tokenId: token?.id ?? null,
    links: { approve: taskLink(cards, task.taskId, 'approve'), decline: taskLink(cards, task.taskId, 'reject'), details: taskLink(cards, task.taskId) },
  })
}

/** The answer to an approval in the chat (FR-LINE-002 AC2): the document, its DOA reference and what comes next */
export async function decisionConfirmationMessage(organizationId: string, taskId: string, cards: CardContext): Promise<FlexMessage | null> {
  const db = forTenant(organizationId)
  const task = await db.approvalTask.findFirst({
    where: { id: taskId },
    select: { decidedAt: true, step: { select: { kind: true, route: { select: { status: true, subjectType: true, subjectId: true, ruleCode: true, doaVersion: { select: { code: true, versionNo: true } } } } } } },
  })
  if (!task?.decidedAt) return null
  const route = task.step.route
  const subject = await subjectSummary(db, route.subjectType, route.subjectId, '', cards.locale)
  return decisionConfirmationCard({
    locale: cards.locale,
    subjectType: route.subjectType,
    typeName: subject.typeName,
    label: subject.label,
    doa: { code: route.doaVersion.code, versionNo: route.doaVersion.versionNo, ruleCode: route.ruleCode },
    decidedAt: task.decidedAt,
    stage: route.status === 'ACTIVE' ? 'NEXT_STEP' : 'DONE',
    review: task.step.kind === 'REVIEW',
    detailsUrl: route.subjectType === 'REQUEST' ? documentLink(cards, `/requests/${route.subjectId}`) : taskLink(cards, taskId),
  })
}

/** What a refusal of the decision says (§14.2 codes, as the e-mail link answers them) */
function refusalOf(error: AppError, locale: CardLocale): PostbackRefusal {
  switch (error.code) {
    case 'TOKEN_USED': {
      const details = error.details ?? {}
      const name = locale === 'en' && typeof details.nameEn === 'string' ? details.nameEn : typeof details.name === 'string' ? details.name : null
      const time = typeof details.time === 'string' && !Number.isNaN(Date.parse(details.time)) ? new Date(details.time) : null
      return { kind: 'TOKEN_USED', name, time }
    }
    case 'TOKEN_EXPIRED':
    case 'TOKEN_INVALID':
    case 'FORBIDDEN':
    case 'STEP_UP_REQUIRED':
    case 'SOD_VIOLATION':
      return { kind: error.code }
    case 'INVALID_STATE_TRANSITION':
      return { kind: 'NOT_OPEN' }
    default:
      return { kind: 'NOT_DECIDED' }
  }
}

/**
 * The answer to a tap that decided nothing (FR-LINE-002 AC3), with where to go on: the task's page (to approve with the
 * PIN for STEP_UP_REQUIRED), the member's tasks, or — for someone not linked — the page that links LINE. The task is
 * named only to the member the button was sent to; a stranger learns nothing about it.
 */
export async function postbackRefusalFor(organizationId: string, error: AppError, button: { readonly tokenId: string; readonly memberId: string | null }, cards: CardContext): Promise<TextMessage> {
  const refusal = refusalOf(error, cards.locale)
  const token = button.memberId
    ? await forTenant(organizationId).actionToken.findFirst({ where: { id: button.tokenId, channel: 'LINE', memberId: button.memberId }, select: { taskId: true } })
    : null
  const taskId = token?.taskId ?? null
  const myTasks = button.memberId ? documentLink(cards, '/tasks') : null
  let url: string | null
  if (refusal.kind === 'STEP_UP_REQUIRED') url = taskId ? taskLink(cards, taskId, 'approve') : myTasks
  else if (refusal.kind === 'FORBIDDEN') url = myTasks ?? (cards.liffId ? liffLink(cards.liffId, '/link') : null)
  else if (refusal.kind === 'TOKEN_INVALID') url = myTasks
  else url = taskId ? taskLink(cards, taskId) : myTasks
  return postbackRefusalMessage(refusal, cards.locale, url)
}
