'use client'

import { CircleAlert, X } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useCallback, useEffect, useId, useMemo, useReducer, useRef, useState, type Ref } from 'react'
import { v4 as uuidv4 } from 'uuid'
import { Button } from '../form/button'
import { Notice } from '../form/notice'
import { useSubmissionKey } from '../form/submission-key'
import { formatDateTime } from '../format'
import { Button as UiButton } from '../shadcn/button'
import { FORM_PAGE } from '../shell/form-page'
import { DOOR_ASIDE } from '../shell/new-request-door'
import type { StepProps } from './details-items'
import { kindLabelOf, type DocumentsProps } from './documents-step'
import { DropUploadButton } from './drop-upload'
import { fieldLabel } from './field-input'
import {
  applicableRules,
  compareFormQuotations,
  draftPayload,
  formInput,
  formReducer,
  initialValues,
  needsServiceEndDate,
  plainNumber,
  problemsOf,
  savableLine,
  totalsOf,
  visibleFieldIds,
  type FormAction,
} from './model'
import { planSteps, stepIndexOf, stepOfTarget, stopsNext, targetOfFailure, targetOfProblem, type PlannedStep } from './form-steps'
import { failureKey, failureTarget, toFormFailure, type ClosedWhy, type FormFailure, type FormOutcome } from './outcome'
import { failureText, ReviewStep, sendStateOf, type SaveStop, type StepLocator } from './review-step'
import type { Attachment, PreviewRequestInput, RequestFormData, ScreenLocale, SentView } from './types'
import { useAutosave, type SaveState } from './use-autosave'
import { usePreview, type PreviewAction } from './use-preview'
import type { UploadActions } from './upload-button'
import { BeforeSendPanel, StepBar, StepBody, StepList } from './wizard'

// The request form (S2-11, S2-17 screen, S3-06, the budget-line choice of S3-07): one form for a new request and for a
// draft or returned request, in four real steps — details, items, quotations and documents, check and send — so no page
// holds a long list of fields (§9.9). Everything the requester types is saved as a draft by itself (FR-INT-006), the
// budget line's balance and the expected route follow the amount (FR-INT-004, FR-DOA-003 AC2), fields show and hide as
// the requester answers (FR-INT-002 AC1) and the attachments the rules ask for are listed before sending (FR-INT-005).
// Once sent, the form says so in the button's own words — "ส่งขออนุมัติแล้ว" — with the number and who decides it now,
// and leads to the request's page (§9.9 rule 7). The form is the door's own content (DOOR_ASIDE): while it shows, at
// either of its addresses, the shell's "ขอซื้อ / ขอจ้าง" steps aside; the confirmation offers it again.

export interface RequestFormActions extends UploadActions {
  readonly preview: PreviewAction
  readonly attach: (requestId: string, fileId: string, kind: string, idempotencyKey: string) => Promise<FormOutcome>
  readonly detach: (requestId: string, fileId: string, idempotencyKey: string) => Promise<FormOutcome>
  readonly submit: (input: { requestId: string; expectedVersion: number; resubmit: boolean }, idempotencyKey: string) => Promise<FormOutcome<{ requestId: string; sent: SentView }>>
  readonly downloadUrl: (fileId: string) => Promise<string | null>
}

const linkClass = 'inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline'

/**
 * The notice above a form whose request was closed to it, by what closed it (§9.9 rule 7), in words of its own for each
 * cause: what happened, and that it happened elsewhere — sent or cancelled from another device, tab or the LIFF form;
 * not found for, or not editable by, the account signed in now (a sign-in in another tab changes this page's account
 * too) — that what was typed here after the last save of the draft is not saved, and what to do next. No guess: a
 * request that is not found is never said to be deleted (no service deletes one). Only when the server names no status
 * (ELSEWHERE) does it say "sent or cancelled elsewhere", all that is known then. The request's page, linked under the
 * notice when this account may open it, says where it stands, so the words never repeat the link.
 */
/** Room between the form's sticky header and a step's heading scrolled up to it */
const HEADING_GAP_PX = 16

const CLOSED_NOTICE = {
  SENT: 'save.closedBy.SENT',
  CANCELLED: 'save.closedBy.CANCELLED',
  NOT_FOUND: 'save.closedBy.NOT_FOUND',
  FORBIDDEN: 'save.closedBy.FORBIDDEN',
  ELSEWHERE: 'save.closedBy.ELSEWHERE',
} as const satisfies Record<ClosedWhy, string>

/** Whether the notice of a closed request links to the request's page: not when it is not found, or not this account's */
export const closedLinksToRequest = (why: ClosedWhy): boolean => why !== 'NOT_FOUND' && why !== 'FORBIDDEN'

/** The notice above the form for a request closed to it (exported for its tests) */
export const closedNoticeKey = (why: ClosedWhy) => CLOSED_NOTICE[why]

export function RequestForm({
  data,
  actions,
  autosaveUrl,
  locale,
}: {
  data: RequestFormData
  actions: RequestFormActions
  autosaveUrl: string
  locale: ScreenLocale
}) {
  const t = useTranslations('requestForm')
  const [values, dispatch] = useReducer(formReducer, data, initialValues)
  const valuesRef = useRef(values)
  useEffect(() => {
    valuesRef.current = values
  })
  const [attachments, setAttachments] = useState<readonly Attachment[]>(data.draft?.attachments ?? [])
  const [stepKey, setStepKey] = useState<string>('details')
  // Steps opened so far (those passed may be opened again, AC3), steps whose missing fields "ถัดไป" pointed out, and
  // whether the requester reached "ตรวจและส่ง" — from then on every step says what is missing, as before
  const [visited, setVisited] = useState<ReadonlySet<string>>(() => new Set(['details']))
  const [checked, setChecked] = useState<ReadonlySet<string>>(() => new Set())
  const [reviewed, setReviewed] = useState(false)
  // `at` counts the presses, so each press that stops moves the focus again
  const [stopped, setStopped] = useState<{ readonly count: number; readonly at: number } | null>(null)
  const [closing, setClosing] = useState<'saving' | 'failed' | null>(null)
  const router = useRouter()
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<FormFailure | null>(null)
  const [sent, setSent] = useState<{ requestId: string; view: SentView } | null>(null)
  const [fileBusy, setFileBusy] = useState(false)
  const [fileError, setFileError] = useState<string | null>(null)
  const submission = useSubmissionKey()
  const headingRef = useRef<HTMLHeadingElement>(null)
  const headerRef = useRef<HTMLElement>(null)
  const sectionRef = useRef<HTMLElement>(null)
  const stoppedRef = useRef<HTMLParagraphElement>(null)
  const sentRef = useRef<HTMLDivElement>(null)
  const purchase = data.type.documentType === 'PURCHASE_REQUEST'

  const autosave = useAutosave({
    url: autosaveUrl,
    requestTypeCode: data.type.code,
    initialRequestId: data.draft?.requestId ?? null,
    initialVersion: data.draft?.version ?? null,
    getPayload: (isNew) => draftPayload(valuesRef.current, data.type.name, isNew),
    // The draft has an address from now on: reloading or sharing the page opens it again
    onCreated: (id) => window.history.replaceState(null, '', `/requests/${id}/edit`),
    // Lines saved for the first time learn their ids, so the next save changes each one by its id
    onSaved: (parts) => dispatch({ type: 'saved', lines: parts.lines, quotations: parts.quotations }),
  })
  const { changed } = autosave
  const update = useCallback(
    (action: FormAction) => {
      dispatch(action)
      changed()
    },
    [changed],
  )

  // What the rules see now (core/forms and core/money, the same engines the server runs)
  const totals = purchase ? totalsOf(values, data.vatRateBp) : null
  const input = formInput(values, attachments, totals, data.type.code)
  const visible = visibleFieldIds(data.form, input)
  const endDateRequired = purchase && needsServiceEndDate(data.form, input)
  const rules = applicableRules(data.form, input)
  const { nets, lowest } = compareFormQuotations(values, data.vatRateBp)
  const problems = problemsOf(data, values, input, lowest)

  // The server's view: the chosen line's balance and the expected route, shortly after amounts or the line change
  const previewLines = values.lines.filter(savableLine).map((l) => ({ quantity: plainNumber(l.quantity), unitPrice: plainNumber(l.unitPrice), vatable: l.vatable }))
  const previewKey = JSON.stringify([autosave.requestId, values.budgetLineId, values.priceIncludesVat, previewLines])
  const previewInput = useMemo<PreviewRequestInput | null>(() => {
    if (!purchase) return null
    const [requestId, budgetLineId, priceIncludesVat, lines] = JSON.parse(previewKey) as [string | null, string, boolean, PreviewRequestInput['lines']]
    return { requestTypeCode: data.type.code, requestId, budgetLineId: budgetLineId || null, priceIncludesVat, lines }
  }, [purchase, previewKey, data.type.code])
  const { preview, loading: previewLoading } = usePreview(actions.preview, previewInput)
  // The balance shown is always the chosen line's: an answer about the line chosen before is not shown
  const budget = preview && (preview.budget.kind !== 'LINE' || preview.budget.budgetLineId === values.budgetLineId) ? preview.budget : null

  // The steps (./form-steps.ts): the form's own, or the six of §9.10, without those that have nothing to show now
  const stepInput = { form: data.form, purchase, filesAllowed: data.attachmentKinds.length > 0 || attachments.length > 0, applicableRules: rules.map((r) => r.id) }
  const plan = planSteps({ ...stepInput, visible })
  const nameOf = (s: PlannedStep) => (s.title ? (locale === 'en' ? s.title.en : s.title.th) : t(`wizard.${s.auto ?? 'details'}`))
  const named = plan.map((step) => ({ step, name: nameOf(step) }))
  // A step that has nothing to show any more (its only questions hidden by an answer) gives way to the one before it
  const index = stepIndexOf(plan, planSteps({ ...stepInput, visible: new Set(data.form.fields.map((f) => f.id)) }), stepKey)
  const current = plan[index]!
  const furthest = plan.reduce((max, s, i) => (visited.has(s.key) ? i : max), 0)
  const showErrors = reviewed || checked.has(current.key)
  const goTo = useCallback((next: string) => {
    setStepKey(next)
    setStopped(null)
    setVisited((v) => new Set(v).add(next))
    if (next === 'review') setReviewed(true)
  }, [])
  /** "ถัดไป" checks the step's own fields first and says what is missing under each (AC3); the server checks all on send */
  function next() {
    const missing = problems.filter((p) => stopsNext(p, data.budgetLines.length > 0) && stepOfTarget(plan, targetOfProblem(p)).key === current.key)
    if (missing.length > 0) {
      setChecked((c) => new Set(c).add(current.key))
      setStopped((was) => ({ count: missing.length, at: (was?.at ?? 0) + 1 }))
      return
    }
    const following = plan[index + 1]
    if (following) goTo(following.key)
  }
  const locate: StepLocator = {
    problem: (p) => {
      const s = stepOfTarget(plan, targetOfProblem(p))
      return { key: s.key, name: nameOf(s) }
    },
    failure: (f) => {
      const target = targetOfFailure(f)
      if (!target) return null
      const s = stepOfTarget(plan, target)
      return { key: s.key, name: nameOf(s) }
    },
  }
  // Moving between steps: the new step's heading takes focus, so keyboard and screen reader users start at the top
  const firstRender = useRef(true)
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false
      return
    }
    const heading = headingRef.current
    heading?.focus({ preventScroll: true })
    // Under the form's sticky header, whose height changes with the screen and the save line (S16-12)
    if (heading) window.scrollTo({ top: heading.getBoundingClientRect().top + window.scrollY - (headerRef.current?.offsetHeight ?? 0) - HEADING_GAP_PX })
  }, [current.key])
  // Stopped by "ถัดไป": the first field it points out takes focus, its error under it
  useEffect(() => {
    if (!stopped) return
    const first = sectionRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')
    if (first) first.focus()
    else stoppedRef.current?.focus()
  }, [stopped])

  /** Closes the form (AC1): the draft is saved first, then the requester goes back to where they came from */
  async function close() {
    const unsaved = autosave.state.kind === 'dirty' || autosave.state.kind === 'saving' || autosave.state.kind === 'error'
    if (unsaved) {
      setClosing('saving')
      const saved = await autosave.saveNow()
      if (!saved) return setClosing('failed')
    }
    setClosing(null)
    if (window.history.length > 1) router.back()
    else router.push('/requests')
  }
  // Sent: the confirmation takes focus, so it is the first thing read
  useEffect(() => {
    if (sent) sentRef.current?.focus()
  }, [sent])

  /** The draft must exist before a file is linked to it */
  async function draftId(): Promise<string | null> {
    if (autosave.requestId) return autosave.requestId
    await autosave.saveNow({ force: true })
    return autosave.id()
  }

  async function attach(file: { fileId: string; fileName: string }, kind: string) {
    setFileError(null)
    setFileBusy(true)
    try {
      const id = await draftId()
      // The first save of the draft failed, so the file has nothing to join yet: it is not in the request, why is said
      // at the top of the page (the save line, or the notice of a draft closed to this page), and it can be attached again
      if (!id) return setFileError(t('attachments.notAttachedDraft', { name: file.fileName }))
      const outcome = await actions.attach(id, file.fileId, kind, uuidv4())
      if (outcome.ok) setAttachments((list) => [...list, { fileId: file.fileId, fileName: file.fileName, kind }])
      else setFileError(failureText(t, outcome, data.form.fields, locale, (k) => kindLabelOf(t, k)))
    } finally {
      setFileBusy(false)
    }
  }

  async function detach(fileId: string) {
    const id = autosave.requestId
    if (!id) return
    setFileError(null)
    setFileBusy(true)
    try {
      const outcome = await actions.detach(id, fileId, uuidv4())
      if (outcome.ok) setAttachments((list) => list.filter((a) => a.fileId !== fileId))
      else setFileError(failureText(t, outcome, data.form.fields, locale, (k) => kindLabelOf(t, k)))
    } finally {
      setFileBusy(false)
    }
  }

  function openFile(fileId: string) {
    // A window opened by the click itself is not blocked; the short-lived address arrives a moment later (FR-PLT-004 AC2)
    const opened = window.open('', '_blank')
    if (opened) opened.opener = null
    void actions.downloadUrl(fileId).then((url) => {
      if (url && opened) opened.location.href = url
      else {
        opened?.close()
        setFileError(t('errors.fileNotOpened'))
      }
    })
  }

  async function submit() {
    setReviewed(true)
    setSubmitError(null)
    setSubmitting(true)
    try {
      const saved = await autosave.saveNow({ force: true })
      const id = autosave.id()
      const version = autosave.version()
      if (!saved || !id || version === null) {
        // Why the save failed is shown above the form (a conflict, a closed request or the connection). A request closed
        // to this page cannot be sent from it at all: its notice and the button's reason say so, never "try again"
        if (autosave.halted() !== 'closed') setSubmitError(toFormFailure({ code: 'DRAFT_NOT_SAVED' }))
        return
      }
      const outcome = await actions.submit({ requestId: id, expectedVersion: version, resubmit: data.draft?.status === 'RETURNED' }, submission.key)
      submission.next()
      if (outcome.ok) {
        autosave.stop()
        setSent({ requestId: outcome.requestId, view: outcome.sent })
        return
      }
      setSubmitError(outcome)
    } finally {
      setSubmitting(false)
    }
  }

  const fieldErrors: Record<string, string> = {}
  if (submitError && failureKey(submitError) === 'FORM_FIELD') {
    const target = failureTarget(submitError).fieldId
    if (target) fieldErrors[target] = t('errors.FORM_FIELD', { field: labelFor(target) })
  }
  function labelFor(id: string) {
    const def = data.form.fields.find((f) => f.id === id)
    return def ? fieldLabel(def, locale) : id
  }

  const title = values.title.trim() || data.type.name
  if (sent) {
    return <SentConfirmation ref={sentRef} sent={sent} title={title} kind={!purchase ? 'procurement' : data.draft?.status === 'RETURNED' ? 'resubmit' : 'send'} />
  }

  const stepProps: StepProps = { data, values, update, locale, input, visible, totals, showErrors, budget, previewLoading, fieldErrors }
  // Why saving is stopped, which the review step says in its "ตรวจก่อนส่ง" (sendBlockPoint)
  const saveStop: SaveStop | null = autosave.state.kind === 'conflict' ? 'conflict' : autosave.state.kind === 'closed' ? 'closed' : null
  const blockedSave = saveStop !== null
  const titleKey = data.draft?.status === 'RETURNED' ? 'page.returnedTitle' : data.draft ? 'page.draftTitle' : 'page.newTitle'
  const saveError = autosave.state.kind === 'error' ? (autosave.state.failure ? t('save.failed', { reason: failureText(t, autosave.state.failure, data.form.fields, locale, (k) => kindLabelOf(t, k)) }) : t('save.error')) : null

  const documentsProps: DocumentsProps = {
    ...stepProps,
    rules,
    nets,
    lowest,
    attachments,
    uploads: { requestUpload: actions.requestUpload, completeUpload: actions.completeUpload },
    onAttach: attach,
    onDetach: detach,
    onOpenFile: openFile,
    fileError,
    busy: fileBusy || blockedSave,
    Upload: DropUploadButton,
  }
  const send = sendStateOf(t, { data, values, totals, budget, problems, saveStop, ...(autosave.state.kind === 'closed' ? { closedWhy: autosave.state.why } : {}) })
  const review = current.auto === 'review'
  const previous = plan[index - 1]
  const following = plan[index + 1]

  // Full screen without the menu (AC1, §9.10): the shell steps aside while the page holds FORM_PAGE, and so does the door
  return (
    <div className="flex min-h-dvh flex-col bg-bg" {...FORM_PAGE} {...DOOR_ASIDE}>
      <header ref={headerRef} className="sticky top-0 z-20 border-b border-line bg-bg">
        <div className="mx-auto flex w-full max-w-[1280px] flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 lg:px-6">
          <UiButton type="button" variant="outline" className="h-11 gap-2 text-base md:text-sm" onClick={() => void close()} disabled={closing === 'saving'}>
            <X aria-hidden="true" />
            {closing === 'saving' ? t('save.saving') : t('wizard.close')}
          </UiButton>
          <div className="flex min-w-0 flex-1 flex-col">
            <h1 className="text-xl font-semibold break-words">{t(titleKey, { type: data.type.name })}</h1>
            {data.type.description ? <p className="hidden text-ink-muted md:block">{data.type.description}</p> : null}
          </div>
          <SaveLine state={autosave.state} errorText={saveError} isNew={!autosave.requestId} locale={locale} onSaveNow={() => void autosave.saveNow()} />
        </div>
        {closing === 'failed' ? (
          <p role="alert" className="mx-auto flex w-full max-w-[1280px] items-start gap-2 px-4 pb-3 font-medium text-danger lg:px-6">
            <CircleAlert className="mt-1 size-4 shrink-0" aria-hidden="true" />
            <span>{t('wizard.closeFailed')}</span>
          </p>
        ) : null}
      </header>

      <div className="mx-auto flex w-full max-w-[1280px] flex-1 gap-8 px-4 py-6 lg:px-6">
        <div className="hidden w-50 shrink-0 lg:block">
          <div className="sticky top-28">
            <StepList steps={named} current={index} furthest={furthest} onSelect={(i) => goTo(plan[i]!.key)} />
          </div>
        </div>

        <div className="flex max-w-160 min-w-0 flex-1 flex-col gap-6">
          <div className="lg:hidden">
            <StepBar current={index} total={plan.length} name={named[index]!.name} />
          </div>
          {autosave.state.kind === 'conflict' ? (
            <Notice tone="danger">
              <p>{t('save.conflict')}</p>
              <Button variant="secondary" className="mt-2" onClick={() => window.location.reload()}>
                {t('save.reload')}
              </Button>
            </Notice>
          ) : null}
          {autosave.state.kind === 'closed' ? (
            <Notice tone="warning">
              {/* What closed it, as the server said (§9.9 rule 7): where it happened, what was not saved, what to do next */}
              <p>{t(closedNoticeKey(autosave.state.why))}</p>
              {/* Its page says where it stands — a request not found, or not this account's, has none to open */}
              {autosave.requestId && closedLinksToRequest(autosave.state.why) ? (
                <a href={`/requests/${autosave.requestId}`} className={linkClass}>
                  {t('save.openRequest')}
                </a>
              ) : null}
            </Notice>
          ) : null}
          {data.draft?.status === 'RETURNED' ? <Notice tone="warning">{data.draft.returnReason ? t('page.returnedReason', { reason: data.draft.returnReason }) : t('page.returned')}</Notice> : null}

          <section ref={sectionRef} aria-labelledby="step-heading" className="flex flex-col gap-6">
            <h2 id="step-heading" ref={headingRef} tabIndex={-1} className="text-xl font-semibold outline-none">
              {t('steps.heading', { n: index + 1, total: plan.length, name: named[index]!.name })}
            </h2>
            {review ? (
              <ReviewStep
                {...stepProps}
                rules={rules}
                problems={problems}
                route={preview?.route ?? null}
                attachmentCount={attachments.length + values.quotations.filter((q) => q.fileId).length}
                onGoTo={goTo}
                locate={locate}
                submitInBar
                onSubmit={() => void submit()}
                onReload={() => window.location.reload()}
                submitting={submitting}
                submitError={submitError}
                saveStop={saveStop}
                {...(autosave.state.kind === 'closed' ? { closedWhy: autosave.state.why } : {})}
                requestHref={autosave.requestId ? `/requests/${autosave.requestId}` : null}
              />
            ) : (
              <StepBody step={current} props={stepProps} documents={documentsProps} endDateRequired={endDateRequired} />
            )}
            {stopped ? (
              <p ref={stoppedRef} tabIndex={-1} role="alert" className="flex items-start gap-2 font-medium text-danger outline-none">
                <CircleAlert className="mt-1 size-4 shrink-0" aria-hidden="true" />
                <span>{t('wizard.fixFirst', { count: stopped.count })}</span>
              </p>
            ) : null}
          </section>
        </div>

        {/* "ก่อนส่ง" beside every step of a wide screen; the check step says it all itself (AC4) */}
        {review ? null : (
          <div className="hidden w-80 shrink-0 xl:block">
            <div className="sticky top-28">
              <BeforeSendPanel props={stepProps} rules={rules} route={preview?.route ?? null} purchase={purchase} />
            </div>
          </div>
        )}
      </div>

      <footer className="sticky bottom-0 z-20 border-t border-line bg-bg">
        <div className="mx-auto flex min-h-18 w-full max-w-[1280px] items-center justify-between gap-3 px-4 py-3 lg:px-6">
          {previous ? (
            <UiButton type="button" variant="outline" className="h-11 text-base md:text-sm" aria-label={`${t('wizard.back')}: ${nameOf(previous)}`} onClick={() => goTo(previous.key)}>
              {t('wizard.back')}
            </UiButton>
          ) : (
            <span />
          )}
          {following ? (
            <UiButton type="button" className="h-11 px-5 text-base hover:bg-primary-hover md:text-sm" aria-label={`${t('wizard.next')}: ${nameOf(following)}`} onClick={next}>
              {t('wizard.next')}
            </UiButton>
          ) : (
            <UiButton
              type="button"
              className="h-11 px-5 text-base hover:bg-primary-hover md:text-sm"
              onClick={() => void submit()}
              disabled={Boolean(send.blockedReason) || submitting}
              aria-describedby={send.blockedReason ? 'submit-blocked' : 'submit-after'}
            >
              {submitting ? t('submit.sending') : send.submitLabel}
            </UiButton>
          )}
        </div>
      </footer>
    </div>
  )
}

/**
 * Sent (§9.9 rule 7): the confirmation repeats the button's words — "ส่งขออนุมัติแล้ว", "ส่งขออนุมัติอีกครั้งแล้ว",
 * "ส่งคำขอให้ฝ่ายจัดซื้อแล้ว" — with the number the request got and who decides it now, then leads to the request's page
 * where its status is followed, or to a new request. No form is left on the page, so the shell's door shows again.
 */
export function SentConfirmation({ ref, sent, title, kind }: { ref: Ref<HTMLDivElement>; sent: { requestId: string; view: SentView }; title: string; kind: 'send' | 'resubmit' | 'procurement' }) {
  const t = useTranslations('requestForm.sent')
  const names = sent.view.waitingFor.map((w) => (w.principalName ? t('acting', { name: w.name, principal: w.principalName }) : w.name)).join(t('namesJoin'))
  const headline = kind === 'procurement' ? t('procurement') : names ? t(kind === 'resubmit' ? 'resubmitWaiting' : 'sendWaiting', { names }) : t(kind === 'resubmit' ? 'resubmit' : 'send')
  return (
    <div ref={ref} tabIndex={-1} className="flex max-w-3xl flex-col gap-6 outline-none">
      <h1 className="text-2xl font-semibold break-words">{title}</h1>
      <Notice tone="success">
        <p className="font-semibold">{headline}</p>
        {sent.view.number ? <p>{t('number', { number: sent.view.number })}</p> : null}
      </Notice>
      <p className="text-ink-muted">{kind === 'procurement' ? t('nextProcurement') : t('next')}</p>
      <div className="flex flex-col gap-2 sm:flex-row sm:gap-8">
        <Link href={`/requests/${sent.requestId}`} className={linkClass}>
          {sent.view.number ? t('open', { number: sent.view.number }) : t('openNoNumber')}
        </Link>
        <Link href="/requests/new" className={linkClass}>
          {t('another')}
        </Link>
      </div>
    </div>
  )
}

/**
 * Where the draft stands, beside "บันทึกร่างตอนนี้" (FR-INT-006 AC1). A new form with nothing typed yet has nothing to
 * save — pressed, the button saved nothing and said nothing (§9.9 rule 7) — so it cannot be pressed until the requester
 * starts filling the form in; the line beside it says the draft then saves itself, and the button names that line.
 */
export function SaveLine({ state, errorText, isNew, locale, onSaveNow }: { state: SaveState; errorText: string | null; isNew: boolean; locale: ScreenLocale; onSaveNow: () => void }) {
  const t = useTranslations('requestForm.save')
  const id = useId()
  const nothingYet = isNew && state.kind === 'idle'
  const text =
    state.kind === 'idle'
      ? isNew
        ? t('idleNew')
        : t('idleSaved')
      : state.kind === 'dirty'
        ? t('dirty')
        : state.kind === 'saving'
          ? t('saving')
          : state.kind === 'saved'
            ? t('saved', { time: formatDateTime(locale, state.at) })
            : state.kind === 'error'
              ? errorText
              : null
  if (text === null) return null
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
      <p id={id} role="status" className={state.kind === 'error' ? 'flex items-start gap-2 font-medium text-danger' : 'text-ink-muted'}>
        {state.kind === 'error' ? <CircleAlert className="mt-1 size-4 shrink-0" aria-hidden="true" /> : null}
        <span>{text}</span>
      </p>
      <Button
        variant="secondary"
        className="shrink-0 self-start sm:self-auto"
        disabled={nothingYet || state.kind === 'saving'}
        aria-describedby={nothingYet ? id : undefined}
        onClick={onSaveNow}
      >
        {t('saveNow')}
      </Button>
    </div>
  )
}
