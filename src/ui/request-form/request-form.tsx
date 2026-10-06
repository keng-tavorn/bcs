'use client'

import { CircleAlert } from 'lucide-react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { useCallback, useEffect, useId, useMemo, useReducer, useRef, useState, type Ref } from 'react'
import { v4 as uuidv4 } from 'uuid'
import { Button } from '../form/button'
import { Notice } from '../form/notice'
import { useSubmissionKey } from '../form/submission-key'
import { formatDateTime } from '../format'
import { DOOR_ASIDE } from '../shell/new-request-door'
import { DetailsStep, ItemsStep, type StepProps } from './details-items'
import { DocumentsStep, kindLabelOf } from './documents-step'
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
import { failureKey, failureTarget, STEP_IDS, toFormFailure, type ClosedWhy, type FormFailure, type FormOutcome, type StepId } from './outcome'
import { failureText, ReviewStep, type SaveStop } from './review-step'
import { Stepper } from './stepper'
import type { Attachment, PreviewRequestInput, RequestFormData, ScreenLocale, SentView } from './types'
import { useAutosave, type SaveState } from './use-autosave'
import { usePreview, type PreviewAction } from './use-preview'
import type { UploadActions } from './upload-button'

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
  backLink,
}: {
  data: RequestFormData
  actions: RequestFormActions
  autosaveUrl: string
  locale: ScreenLocale
  /** The link above the form back to the catalog: "choose another type" on a new form, "back to the types" on a draft */
  backLink: 'otherType' | 'toCatalog'
}) {
  const t = useTranslations('requestForm')
  const [values, dispatch] = useReducer(formReducer, data, initialValues)
  const valuesRef = useRef(values)
  useEffect(() => {
    valuesRef.current = values
  })
  const [attachments, setAttachments] = useState<readonly Attachment[]>(data.draft?.attachments ?? [])
  const [step, setStep] = useState<StepId>('details')
  const [showErrors, setShowErrors] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<FormFailure | null>(null)
  const [sent, setSent] = useState<{ requestId: string; view: SentView } | null>(null)
  const [fileBusy, setFileBusy] = useState(false)
  const [fileError, setFileError] = useState<string | null>(null)
  const submission = useSubmissionKey()
  const headingRef = useRef<HTMLHeadingElement>(null)
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

  // A new-supplier request has no items: its steps are details, documents, and check and send
  const stepIds: readonly StepId[] = purchase ? STEP_IDS : STEP_IDS.filter((s) => s !== 'items')
  const steps = stepIds.map((id) => ({ id, label: t(`steps.${id}`) }))
  const index = Math.max(0, stepIds.indexOf(step))
  const goTo = useCallback((next: StepId) => {
    setStep(next)
    if (next === 'review') setShowErrors(true)
  }, [])
  // Moving between steps: the new step's heading takes focus, so keyboard and screen reader users start at the top
  const firstRender = useRef(true)
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false
      return
    }
    headingRef.current?.focus()
    headingRef.current?.scrollIntoView({ block: 'start' })
  }, [step])
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
    setShowErrors(true)
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

  return (
    <div className="flex max-w-4xl flex-col gap-6" {...DOOR_ASIDE}>
      <Link href="/requests/new" className={linkClass}>
        {t(`page.${backLink}`)}
      </Link>
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold">{t(titleKey, { type: data.type.name })}</h1>
        {data.type.description ? <p className="text-ink-muted">{data.type.description}</p> : null}
        <SaveLine state={autosave.state} errorText={saveError} isNew={!autosave.requestId} locale={locale} onSaveNow={() => void autosave.saveNow()} />
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

      <Stepper steps={steps} current={step} onSelect={goTo} />

      <section aria-labelledby="step-heading" className="flex flex-col gap-6">
        <h2 id="step-heading" ref={headingRef} tabIndex={-1} className="text-xl font-semibold outline-none">
          {t('steps.heading', { n: index + 1, total: stepIds.length, name: t(`steps.${step}`) })}
        </h2>
        {step === 'details' ? <DetailsStep {...stepProps} /> : null}
        {step === 'items' && purchase ? <ItemsStep {...stepProps} endDateRequired={endDateRequired} /> : null}
        {step === 'documents' ? (
          <DocumentsStep
            {...stepProps}
            rules={rules}
            nets={nets}
            lowest={lowest}
            attachments={attachments}
            uploads={{ requestUpload: actions.requestUpload, completeUpload: actions.completeUpload }}
            onAttach={attach}
            onDetach={detach}
            onOpenFile={openFile}
            fileError={fileError}
            busy={fileBusy || blockedSave}
          />
        ) : null}
        {step === 'review' ? (
          <ReviewStep
            {...stepProps}
            rules={rules}
            problems={problems}
            route={preview?.route ?? null}
            attachmentCount={attachments.length + values.quotations.filter((q) => q.fileId).length}
            onGoTo={goTo}
            onSubmit={() => void submit()}
            onReload={() => window.location.reload()}
            submitting={submitting}
            submitError={submitError}
            saveStop={saveStop}
            {...(autosave.state.kind === 'closed' ? { closedWhy: autosave.state.why } : {})}
            requestHref={autosave.requestId ? `/requests/${autosave.requestId}` : null}
          />
        ) : null}
      </section>

      <div className="flex flex-col-reverse gap-3 border-t border-line pt-6 sm:flex-row sm:justify-between">
        {index > 0 ? (
          <Button variant="secondary" onClick={() => goTo(stepIds[index - 1]!)}>
            {t('steps.back', { name: t(`steps.${stepIds[index - 1]!}`) })}
          </Button>
        ) : (
          <span />
        )}
        {index < stepIds.length - 1 ? <Button onClick={() => goTo(stepIds[index + 1]!)}>{t('steps.next', { name: t(`steps.${stepIds[index + 1]!}`) })}</Button> : null}
      </div>
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
