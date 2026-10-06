'use client'

import { CircleAlert, CircleCheck } from 'lucide-react'
import { useTranslations } from 'next-intl'
import type { FieldDef } from '@/core/forms/fields'
import { amountToSatang } from '@/core/money/dto'
import type { Satang } from '@/core/money/math'
import { Button } from '../form/button'
import { Notice } from '../form/notice'
import type { StepProps } from './details-items'
import { documentFieldIds } from './document-fields'
import { kindLabelOf } from './documents-step'
import { fieldLabel } from './field-input'
import { problemStep, savableLine, type Problem, type RuleStatus } from './model'
import { showMoney, showSatang } from './money'
import { adminsWereTold, failureKey, failureStep, failureTarget, type FormFailure, type StepId } from './outcome'
import { placeAndSupplierText } from './place-supplier'
import { BudgetStatus, RoutePreview, TotalsList } from './summary'
import type { RouteView } from './types'
import type { SaveState } from './use-autosave'

/** Refusals because the DOA names nobody who can approve (FR-DOA-003 AC3) */
const DOA_GAPS: ReadonlySet<string> = new Set(['DOA_NOT_CONFIGURED', 'APPROVER_NOT_FOUND', 'NO_HIGHER_AUTHORITY'])

// Step 4, "check and send" (§9.9 principle 3, FR-INT-004, FR-INT-005 AC1, FR-DOA-003 AC2): the request in short, the
// budget line against its amount, the approval route the DOA expects with its explanation, the attachments the rules ask
// for, what still needs fixing and the button that sends it. A request over budget cannot be sent and the button says
// why (FR-INT-004 AC2); everything else is checked again by the server, whose answer is shown next to the button with how
// to fix it (§9.9 rule 7, never only in a toast). "ตรวจก่อนส่ง" says it can be sent only when the button can send (§9.9
// principle 3, sendBlockPoint): what stops the button comes first, then each problem with a way to the step that fixes
// it. The budget point has no such way: its two fixes, a lower amount (items) or another line (details), are in its words.

/** Problems that would send something other than what is on screen: an unfinished line or quotation is not saved */
const BLOCKING: ReadonlySet<Problem['kind']> = new Set(['TITLE', 'NO_LINES', 'LINE_INCOMPLETE', 'QUOTATION_INCOMPLETE'])

/** Saving is stopped: the draft was changed elsewhere (a version conflict), or the request was sent or cancelled elsewhere */
export type SaveStop = Extract<SaveState['kind'], 'conflict' | 'closed'>

/**
 * Why the send button cannot send now, the reason it names first (FR-INT-004 AC2): the amount before VAT is above what
 * is left on the budget line (BR-BUD-03), by `shortfall`; a problem that must be fixed first (BLOCKING); or saving is
 * stopped, and why. The LIFF form works it out in its shell, where its button is (src/ui/liff/requests/request-form.tsx),
 * and hands it to its review step.
 */
export type SendBlock =
  | { readonly kind: 'BUDGET'; readonly available: Satang; readonly shortfall: Satang }
  | { readonly kind: 'PROBLEMS' }
  | { readonly kind: 'SAVE'; readonly stop: SaveStop }

/**
 * What stops the send button, as the first point of "ตรวจก่อนส่ง" — which says the request can be sent only when nothing
 * is left to fix and nothing stops the button (§9.9 principle 3: told before sending, one message, never the opposite of
 * the button). Over budget: the button's words after "ส่งไม่ได้เพราะ", with its figures and its advice, marked as the
 * list marks every point to fix before sending. Saving stopped: what stopped it and what that leaves to do, in words of
 * its own, so that the button's sentence stays the only one on the page. For a request sent or cancelled elsewhere the
 * point says so, as the notice above the form and the workspace's button do: loading the latest version cannot make it
 * sendable. A problem that must be fixed is a point of the list already (null).
 */
export function sendBlockPoint(t: T, block: SendBlock | null): { readonly text: string; readonly mustFix: boolean } | null {
  switch (block?.kind) {
    case 'BUDGET':
      return { text: t('review.budgetShort', { available: showSatang(block.available), shortfall: showSatang(block.shortfall) }), mustFix: true }
    case 'SAVE':
      return { text: t(block.stop === 'conflict' ? 'review.saveConflict' : 'review.saveClosed'), mustFix: false }
    default:
      return null
  }
}

export interface ReviewProps extends StepProps {
  readonly rules: readonly RuleStatus[]
  readonly problems: readonly Problem[]
  readonly route: RouteView | null
  readonly attachmentCount: number
  readonly onGoTo: (step: StepId) => void
  readonly onSubmit: () => void
  /** Load the latest version of the draft (after CONFLICT_VERSION) */
  readonly onReload: () => void
  readonly submitting: boolean
  readonly submitError: FormFailure | null
  /** Why saving is stopped (a version conflict, or the request was sent or cancelled elsewhere); null while it goes on */
  readonly saveStop: SaveStop | null
}

export function ReviewStep(props: ReviewProps) {
  const t = useTranslations('requestForm')
  const { data, values, totals, budget, previewLoading, rules, problems, route, onGoTo, locale, submitError } = props
  const purchase = data.type.documentType === 'PURCHASE_REQUEST'
  const line = data.budgetLines.find((l) => l.id === values.budgetLineId) ?? null
  const place = placeAndSupplierText(data, values)
  const kindLabel = (kind: string) => kindLabelOf(t, kind)
  const stepName = (s: StepId) => t(`steps.${s}`)
  const blocking = problems.filter((p) => BLOCKING.has(p.kind))
  // FR-INT-004 AC2: over budget (before VAT, BR-BUD-03) the button cannot send and says why and by how much
  const available = budget?.kind === 'LINE' && budget.budgetLineId === values.budgetLineId ? amountToSatang(budget.available.amount) : null
  const shortfall = available !== null && totals !== null && totals.net > available ? totals.net - available : null
  const block: SendBlock | null =
    available !== null && shortfall !== null
      ? { kind: 'BUDGET', available, shortfall }
      : blocking.length
        ? { kind: 'PROBLEMS' }
        : props.saveStop
          ? { kind: 'SAVE', stop: props.saveStop }
          : null
  // Saving stopped: load the latest version (a conflict), or nothing to do on this page (sent or cancelled elsewhere,
  // where loading would not make the request sendable, as its point and the notice above the form say)
  const blockedReason =
    block?.kind === 'BUDGET'
      ? t('submit.blockedBudget', { available: showSatang(block.available), shortfall: showSatang(block.shortfall) })
      : block?.kind === 'PROBLEMS'
        ? t('submit.blockedProblems')
        : block?.kind === 'SAVE'
          ? block.stop === 'closed'
            ? t('submit.blockedClosed')
            : t('submit.blockedSave')
          : null
  // "ตรวจก่อนส่ง" leads with what stops the button, and is ready only when nothing does (§9.9 principle 3)
  const blockPoint = sendBlockPoint(t, block)
  const submitLabel = !purchase ? t('submit.toProcurement') : data.draft?.status === 'RETURNED' ? t('submit.resubmit') : t('submit.send')
  const reported = submitError !== null && DOA_GAPS.has(submitError.code) && adminsWereTold(submitError)
  // A question the attachment rules ask for is fixed beside the documents, in step 3 (./document-fields.ts)
  const documentFields = documentFieldIds(data.form.rules)
  const failedStep = submitError ? failureStep(submitError, documentFields) : null

  return (
    <div className="flex flex-col gap-10">
      <section aria-labelledby="review-summary" className="flex flex-col gap-3">
        <h3 id="review-summary" className="text-lg font-semibold">
          {t('review.summary')}
        </h3>
        <dl className="grid grid-cols-1 gap-y-1 sm:grid-cols-[12rem_minmax(0,1fr)] sm:gap-x-6">
          <dt className="text-ink-muted">{t('review.type')}</dt>
          <dd className="mb-2 sm:mb-0">{data.type.name}</dd>
          <dt className="text-ink-muted">{t('review.title')}</dt>
          <dd className="mb-2 break-words sm:mb-0">{values.title.trim() || t('review.noTitle')}</dd>
          {purchase ? (
            <>
              <dt className="text-ink-muted">{t('review.budgetLine')}</dt>
              <dd className="mb-2 sm:mb-0">{line ? t('budget.option', { code: line.code, name: line.name }) : t('review.noBudgetLine')}</dd>
              <dt className="text-ink-muted">{t('review.department')}</dt>
              <dd className="mb-2 sm:mb-0">{line?.departmentName ?? data.requesterDepartmentName ?? t('budget.dash')}</dd>
              <dt className="text-ink-muted">{t('review.site')}</dt>
              <dd className="mb-2 break-words sm:mb-0">{place.site ? t('site.option', place.site) : t('review.noSite')}</dd>
              <dt className="text-ink-muted">{t('review.supplier')}</dt>
              <dd className="mb-2 break-words sm:mb-0">{place.supplier ? t('supplier.option', place.supplier) : t('review.noSupplier')}</dd>
              <dt className="text-ink-muted">{t('review.lines')}</dt>
              <dd className="mb-2 sm:mb-0">{t('review.lineCount', { count: values.lines.filter(savableLine).length })}</dd>
            </>
          ) : null}
          <dt className="text-ink-muted">{t('review.files')}</dt>
          <dd>{t('review.fileCount', { count: props.attachmentCount })}</dd>
        </dl>
        {purchase ? <TotalsList totals={totals} rateBp={data.vatRateBp} /> : null}
      </section>

      {purchase ? (
        <section aria-labelledby="review-budget" className="flex flex-col gap-3">
          <h3 id="review-budget" className="text-lg font-semibold">
            {t('budget.title')}
          </h3>
          <BudgetStatus lineChosen={Boolean(values.budgetLineId)} budget={budget} need={totals?.net ?? null} loading={previewLoading} />
        </section>
      ) : null}

      <section aria-labelledby="review-route" className="flex flex-col gap-3">
        <h3 id="review-route" className="text-lg font-semibold">
          {t('route.title')}
        </h3>
        <RoutePreview route={purchase ? route : { kind: 'NO_ROUTE' }} loading={previewLoading} locale={locale} reported={reported} />
      </section>

      <section aria-labelledby="review-documents" className="flex flex-col gap-3">
        <h3 id="review-documents" className="text-lg font-semibold">
          {t('documents.requiredTitle')}
        </h3>
        {rules.length === 0 ? (
          <p className="text-ink-muted">{t('documents.noneRequired')}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {rules.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-x-3">
                <span>{t('documents.rule', { rule: r.id })}</span>
                {r.met ? (
                  <span className="inline-flex items-center gap-1 text-primary">
                    <CircleCheck className="size-4" aria-hidden="true" />
                    {t('documents.met')}
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-danger">
                    <CircleAlert className="size-4" aria-hidden="true" />
                    {t('documents.notMet')}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="review-problems" className="flex flex-col gap-3">
        <h3 id="review-problems" className="text-lg font-semibold">
          {t('review.problemsTitle')}
        </h3>
        {problems.length === 0 && block === null ? (
          <p className="flex items-start gap-2">
            <CircleCheck className="mt-1 size-4 shrink-0 text-primary" aria-hidden="true" />
            <span>{t('review.ready')}</span>
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-line border-y border-line">
            {blockPoint ? (
              <li className="py-2">
                <p className="flex items-start gap-2">
                  <CircleAlert className="mt-1 size-4 shrink-0 text-danger" aria-hidden="true" />
                  <span>
                    {blockPoint.text}
                    {blockPoint.mustFix ? <span className="text-ink-muted"> {t('review.mustFix')}</span> : null}
                  </span>
                </p>
              </li>
            ) : null}
            {problems.map((p, i) => {
              const step = problemStep(p, documentFields)
              return (
                <li key={i} className="flex flex-col gap-1 py-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                  <p className="flex items-start gap-2">
                    <CircleAlert className="mt-1 size-4 shrink-0 text-danger" aria-hidden="true" />
                    <span>
                      {problemText(t, p, data.form.fields, locale)}
                      {BLOCKING.has(p.kind) ? <span className="text-ink-muted"> {t('review.mustFix')}</span> : null}
                    </span>
                  </p>
                  <Button variant="link" className="shrink-0 self-start sm:self-auto" onClick={() => onGoTo(step)}>
                    {t('review.goTo', { step: stepName(step) })}
                  </Button>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      <div className="flex flex-col gap-3 border-t border-line pt-6">
        {submitError ? (
          <Notice tone="danger">
            <p>{failureText(t, submitError, data.form.fields, locale, kindLabel)}</p>
            {failedStep ? (
              <Button variant="link" onClick={() => onGoTo(failedStep)}>
                {t('review.goTo', { step: stepName(failedStep) })}
              </Button>
            ) : null}
            {/* FR-INT-006 AC2: saved elsewhere since this page opened — offer the latest version right here */}
            {submitError.code === 'CONFLICT_VERSION' ? (
              <Button variant="secondary" className="mt-2" onClick={props.onReload}>
                {t('save.reload')}
              </Button>
            ) : null}
          </Notice>
        ) : null}
        {blockedReason ? (
          <p id="submit-blocked" className="flex items-start gap-2 font-medium text-danger">
            <CircleAlert className="mt-1 size-4 shrink-0" aria-hidden="true" />
            <span>{blockedReason}</span>
          </p>
        ) : null}
        <Button className="self-start" onClick={props.onSubmit} disabled={Boolean(blockedReason) || props.submitting} aria-describedby={blockedReason ? 'submit-blocked' : 'submit-after'}>
          {props.submitting ? t('submit.sending') : submitLabel}
        </Button>
        <p id="submit-after" className="text-base text-ink-muted md:text-sm">
          {purchase ? t('submit.after') : t('submit.afterSupplier')}
        </p>
      </div>
    </div>
  )
}

type T = ReturnType<typeof useTranslations<'requestForm'>>

function problemText(t: T, p: Problem, fields: readonly FieldDef[], locale: 'th' | 'en'): string {
  switch (p.kind) {
    case 'TITLE':
    case 'BUDGET_LINE':
    case 'NO_LINES':
    case 'QUOTATION_CHOOSE':
    case 'QUOTATION_REASON':
      return t(`problems.${p.kind}`)
    case 'LINE_INCOMPLETE':
    case 'SERVICE_END_DATE':
      return t(`problems.${p.kind}`, { n: p.lineNo })
    case 'QUOTATION_INCOMPLETE':
    case 'QUOTATION_FILE':
      return t(`problems.${p.kind}`, { n: p.quotationNo })
    case 'FIELD_REQUIRED': {
      const def = fields.find((f) => f.id === p.fieldId)
      return t('problems.FIELD_REQUIRED', { field: def ? fieldLabel(def, locale) : p.fieldId })
    }
    case 'ATTACHMENTS':
      return t('problems.ATTACHMENTS', { rule: p.ruleId })
  }
}

/**
 * The server's refusal in words, with what to do (§9.9 rule 7). A DOA gap says whom to contact by their role, and that
 * they were told only when the report reached at least one of them (FR-DOA-003 AC3).
 */
export function failureText(t: T, f: FormFailure, fields: readonly FieldDef[], locale: 'th' | 'en', kindLabel: (kind: string) => string): string {
  const key = failureKey(f)
  const told = DOA_GAPS.has(f.code) ? ` ${adminsWereTold(f) ? t('errors.adminsTold') : t('errors.adminsNotTold')}` : ''
  switch (key) {
    case 'BUDGET_INSUFFICIENT':
      return t('errors.BUDGET_INSUFFICIENT', { available: f.available ? showMoney(f.available) : '-', shortfall: f.shortfall ? showMoney(f.shortfall) : '-' })
    case 'ATTACHMENT_RULE_FAILED': {
      const missing = (f.failures ?? [])
        .flatMap((x) => x.missing)
        .map((m) => (m.kind === 'ATTACHMENT' ? t('errors.missingFiles', { kind: kindLabel(m.attachment), need: m.need, have: m.have }) : t('errors.missingField', { field: labelOf(fields, m.field, locale) })))
      return t('errors.ATTACHMENT_RULE_FAILED', { rule: f.rule ?? f.failures?.[0]?.rule ?? '-', missing: missing.join(t('errors.join')) || '-' })
    }
    case 'FORM_FIELD': {
      const target = failureTarget(f)
      return t('errors.FORM_FIELD', { field: target.fieldId ? labelOf(fields, target.fieldId, locale) : '-' })
    }
    case 'SERVICE_END_DATE':
      return t('errors.SERVICE_END_DATE', { n: failureTarget(f).lineNo ?? 1 })
    case 'QUOTE_FILE':
      return t('errors.QUOTE_FILE', { n: (Number((f.field ?? '').split('.')[1]) || 0) + 1 })
    case 'APPROVER_NOT_FOUND':
      return t('errors.APPROVER_NOT_FOUND', { position: f.position ?? '-', departments: f.departments?.join(', ') || '-' }) + told
    case 'NO_HIGHER_AUTHORITY':
    case 'DOA_NOT_CONFIGURED':
      return t(`errors.${key}`) + told
    case 'DOA_AMBIGUOUS':
      return t('errors.DOA_AMBIGUOUS')
    case 'TAX_RATE_NOT_CONFIGURED':
      return t('errors.TAX_RATE_NOT_CONFIGURED', { date: f.date ?? '-' })
    case 'INTERNAL':
      return t('errors.INTERNAL', { requestId: f.requestId ?? '-' })
    default:
      return t(`errors.${key}`)
  }
}

function labelOf(fields: readonly FieldDef[], id: string, locale: 'th' | 'en'): string {
  const def = fields.find((f) => f.id === id)
  return def ? fieldLabel(def, locale) : id
}
