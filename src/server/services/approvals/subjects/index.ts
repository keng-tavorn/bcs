import type { z } from 'zod'
import type { AppError } from '@/core/result'
import type { ApprovalSubject } from '@/core/sod'
import type { Ctx } from '@/server/context'
import type { TenantTx } from '@/server/db/tenant'
import type { EventDraft } from '@/server/events/append'
import type { NotificationDraft } from '@/server/notifications/create'
import type { SubjectFacts } from '../../sla/subject'
import { bankAccountChangeSubject } from './bank-account-change'
import { budgetOverrunSubject } from './budget-overrun'
import { budgetTransferSubject } from './budget-transfer'
import { invoiceSubject } from './invoice'
import { paymentRunSubject } from './payment-run'
import { poChangeSubject } from './po-change'
import { workflowVersionSubject } from './workflow-version'

// The subject registry (ADR-068, P1-07, docs/sub-specs/P1.md "ทะเบียน subject step-up และสัญญากลาง"): the approval
// subjects of phase 1 decide through approval.decide, approval.decide_by_link and approval.decide_by_line, which call
// the subject's adapter and name no subject themselves (FR-DOA-004 AC4 AC5). Each lane fills only its own files —
// budget-transfer.ts budget-overrun.ts workflow-version.ts (S6) · invoice.ts po-change.ts (S8) · payment-run.ts
// bank-account-change.ts (S9) — and never this file, the SubjectAdapter type or the decide flow. The five tier-1
// subjects keep their own flows (decide.ts, policy-decide.ts, purchase-orders/decide.ts, receiving/variance-decide.ts).

/** The tier-1 subjects, decided by their own flows */
export const TIER1_SUBJECTS = ['REQUEST', 'PURCHASE_ORDER', 'VARIANCE', 'DOA_VERSION', 'ORG_AUTHORITY_CHANGE'] as const satisfies readonly ApprovalSubject[]
export type RegisteredSubject = Exclude<ApprovalSubject, (typeof TIER1_SUBJECTS)[number]>

/** The task an adapter decides on, locked by the decide flow */
export interface SubjectTask {
  readonly id: string
  readonly stepId: string
  readonly principalMemberId: string | null
  readonly step: {
    readonly route: { readonly id: string; readonly subjectType: string; readonly subjectId: string; readonly doaVersionId: string; readonly ruleCode: string; readonly amountSatang: bigint | null }
  }
}

/** What the route came to, handed to the adapter once (the last step approved, or a step returned or rejected) */
export interface SubjectDecision {
  readonly outcome: 'APPROVED' | 'RETURNED' | 'REJECTED'
  readonly reason: string | null
  /** The Comment that keeps the reason of a return or a rejection */
  readonly reasonCommentId: string | null
  /** subjectInput as the adapter's decisionInput parsed it; undefined when it has none */
  readonly subjectInput: unknown
  readonly facts: SubjectFacts
}

/**
 * The document moved, with its events; or a refusal, which rolls the whole decision back and leaves the task open (for
 * example BUDGET_INSUFFICIENT when an invoice exception is approved, S8).
 */
export type SubjectDecided =
  | { readonly ok: true; readonly documentStatus: string; readonly events: readonly EventDraft[]; readonly notifications?: readonly NotificationDraft[] }
  | { readonly ok: false; readonly error: AppError }

/** Who may not decide: requesterMemberIds as BR-SOD-01, and the subject's own rules in extra (rule, members) */
export interface SubjectSod {
  readonly requesterMemberIds: readonly string[]
  readonly extra?: readonly { readonly rule: string; readonly memberIds: readonly string[] }[]
}

export interface SubjectAdapter {
  /** SubjectFacts for the SLA jobs, delegation windows, notices and the next step (subjectFacts, assignNextStep) */
  facts(tx: TenantTx, id: string): Promise<SubjectFacts>
  /** The number or name of the document for cards, lists and links; never a unit price or an account number (BR-NOTI-01) */
  labels(facts: SubjectFacts): { readonly label: string; readonly title: string | null }
  /** The page of the document */
  href(facts: SubjectFacts): string
  /**
   * Zod of DecideInput.subjectInput; without it, a subjectInput sent is VALIDATION_FAILED. A subject the chat button
   * may decide must accept none, because the button sends none.
   */
  readonly decisionInput?: z.ZodType
  /** Called once the route has its result: moves the document. Runs after SoD and the step-up are checked */
  decide(tx: TenantTx, ctx: Ctx, task: SubjectTask, decision: SubjectDecision): Promise<SubjectDecided>
  /** Questions go to a request's requester only (FR-INT-009 AC3): approval.requestInfo refuses every other subject */
  readonly allowsRequestInfo: false
  /**
   * Where the task may be decided besides the web and the BCS Go app (BR-DOA-25): chatButton and emailLink off → no
   * button in the chat and no link in the e-mail, and using one is STEP_UP_REQUIRED; liff off → LIFF is refused
   * FORBIDDEN reason CHANNEL (a workflow version is decided on the web only). On, a task that needs a step-up is still
   * refused in the chat and by e-mail (stepUpNeeded, checked by the central files).
   */
  readonly channels: { chatButton(facts: SubjectFacts): boolean; readonly emailLink: boolean; readonly liff: boolean }
  sodContext(facts: SubjectFacts): SubjectSod
}

export const SUBJECT_ADAPTERS: Readonly<Record<RegisteredSubject, SubjectAdapter>> = {
  BUDGET_TRANSFER: budgetTransferSubject,
  BUDGET_OVERRUN: budgetOverrunSubject,
  WORKFLOW_VERSION: workflowVersionSubject,
  INVOICE: invoiceSubject,
  PO_CHANGE: poChangeSubject,
  PAYMENT_RUN: paymentRunSubject,
  BANK_ACCOUNT_CHANGE: bankAccountChangeSubject,
}

export function isRegisteredSubject(type: string): type is RegisteredSubject {
  return Object.hasOwn(SUBJECT_ADAPTERS, type)
}

export interface OutsideChannels {
  readonly chatButton: boolean
  readonly emailLink: boolean
}

/**
 * Whether a task of this document may be decided from the chat or an e-mail link (BR-DOA-25): a tier-1 subject may
 * (the step-up rule still holds it back, stepUpNeeded); a registered subject as its adapter says; nothing else may.
 */
export async function outsideChannels(tx: TenantTx, type: string, id: string): Promise<OutsideChannels> {
  if ((TIER1_SUBJECTS as readonly string[]).includes(type)) return { chatButton: true, emailLink: true }
  if (!isRegisteredSubject(type)) return { chatButton: false, emailLink: false }
  const adapter = SUBJECT_ADAPTERS[type]
  return { chatButton: adapter.channels.chatButton(await adapter.facts(tx, id)), emailLink: adapter.channels.emailLink }
}
