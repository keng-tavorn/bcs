'use client'

import { useTranslations } from 'next-intl'
import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import type { FieldDef } from '@/core/forms/fields'
import type { Satang } from '@/core/money/math'
import type { StepProps } from '../../request-form/details-items'
import { documentFieldIds } from '../../request-form/document-fields'
import { problemStep, savableLine, type Problem, type RuleStatus } from '../../request-form/model'
import { adminsWereTold, failureKey, failureStep, failureTarget, type FormFailure, type FormOutcome } from '../../request-form/outcome'
import { placeAndSupplierText } from '../../request-form/place-supplier'
import { failureText, mustFixBeforeSending, sendBlockPoint, type SendBlock } from '../../request-form/review-step'
import { BudgetStatus, RoutePreview, TotalsList } from '../../request-form/summary'
import type { Attachment, RouteView, SentView } from '../../request-form/types'
import type { UploadActions } from '../../request-form/upload-button'
import { LiffActionBar } from '../action-bar'
import { Button } from '../button'
import { LiffContent, LiffSection } from '../content'
import { LiffLink } from '../liff-link'
import { useLiff } from '../liff-provider'
import { LiffNotice } from '../notice'
import { LiffCameraAttach } from './camera-attach'
import { fieldLabelOf } from './field'
import { newUuid } from './key'
import type { LiffReadiness } from './ready'

// The last step of the LIFF request form, "ตรวจและส่ง" (§9.9 principle 3, FR-INT-004, FR-INT-005 AC1, FR-DOA-003 AC2),
// loaded once the requester gets there (it is not part of the first JavaScript, §9.4): the request in short, its totals,
// the chosen budget line against the amount before VAT (enough, or short by how much), the route the DOA engine expects
// — who approves under which rule of which DOA version, e.g. "DOA-DEMO ฉบับ 1 ข้อ PR-02" — the documents the rules ask
// for, and what still needs fixing: what stops the send button first, then each problem with a way to the step that
// fixes it, or — for one this step fixes itself, in its quotations and documents — what to do there and a way to the
// place, each marked as one to fix before sending as the workspace's step marks it: what stops the button, and every
// other problem, which the button still sends for the server to refuse (an attachment rule with its code; the budget
// point names its two fixes, a lower amount or another line, in words); the server's refusal of a send
// leads the same way, to another step or to its place on this one. The workspace's own parts
// show the totals, the budget and the route (src/ui/request-form/summary.tsx), and its documents step the quotations, the
// suggested supplier and the files when the rules ask for them or the requester opens them (loaded only then). A photo
// from the phone's camera is one tap away in any case (./camera-attach.tsx, FR-INT-005 AC3), beside the general file
// picker. The send button sits in the bar at the bottom (the form's shell): its words, its refusal and the server's
// answer are the same as on the web, and the shell tells this step what stops the button, so that "ตรวจก่อนส่ง" leads
// with it and says the request can be sent only when nothing does (§9.9 principle 3). The server's refusal of a send is
// the last thing on the step, right above the bar's button as on the web, and comes into view when it arrives; a refusal
// because the request was sent or cancelled meanwhile leads to its page, as on the web. The file commands reach this step
// already gated by the LIFF session (the form's shell, ./ready.ts). LIFF has no sign-in page of its own: a session that
// has ended — a send, a file, the camera or a save of the draft refused for it — says that nothing was done, and to open
// the form again from the LINE chat's menu, where the saved drafts are (liffRequests.form.sessionEnded), never the web's
// "sign in again".

/** A refusal because the DOA names nobody who can approve (FR-DOA-003 AC3) */
const DOA_GAPS: ReadonlySet<string> = new Set(['DOA_NOT_CONFIGURED', 'APPROVER_NOT_FOUND', 'NO_HIGHER_AUTHORITY', 'REVIEWER_NOT_FOUND'])

/** The steps of the LIFF form: the workspace's four, with quotations and documents inside the last one */
export type LiffStep = 'details' | 'items' | 'review'

/** Where a problem or a refusal is fixed on the LIFF form */
const liffStepOf = (step: 'details' | 'items' | 'documents' | 'review'): LiffStep => (step === 'documents' ? 'review' : step)

const DocumentsStep = lazy(() => import('../../request-form/documents-step').then((m) => ({ default: m.DocumentsStep })))

type T = ReturnType<typeof useTranslations<'requestForm'>>

/** A file kind in words (the kinds of FileLink, §6.2) */
function kindLabelOf(t: T, kind: string): string {
  switch (kind) {
    case 'QUOTATION':
    case 'DELIVERY_NOTE':
    case 'PHOTO':
    case 'JUSTIFICATION':
    case 'INVOICE':
    case 'PO_PDF':
    case 'DPA':
    case 'ETAX':
    case 'REGISTRY_PROOF':
    case 'OTHER':
      return t(`kinds.${kind}`)
    default:
      return kind
  }
}

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
      return t('problems.FIELD_REQUIRED', { field: def ? fieldLabelOf(def, locale) : p.fieldId })
    }
    case 'ATTACHMENTS':
      return t('problems.ATTACHMENTS', { rule: p.ruleId })
  }
}

/** The file commands of the LIFF page (src/app/liff/requests/actions.ts) */
export interface LiffFileActions extends UploadActions {
  readonly attach: (requestId: string, fileId: string, kind: string, idempotencyKey: string) => Promise<FormOutcome>
  readonly detach: (requestId: string, fileId: string, idempotencyKey: string) => Promise<FormOutcome>
  /** A file of the draft (requestId), or the requester's own upload not linked yet (requestId null without a draft) */
  readonly downloadUrl: (requestId: string | null, fileId: string) => Promise<string | null>
}

/** The request's files and how to change them */
export interface LiffReviewFiles {
  readonly attachments: readonly Attachment[]
  readonly setAttachments: (update: (list: readonly Attachment[]) => readonly Attachment[]) => void
  /** The draft's id, saving it first when it does not exist yet (a file is linked to a saved draft) */
  readonly draftId: () => Promise<string | null>
  /** The draft's id as the form knows it now, without saving: null while nothing has been saved yet */
  readonly requestId: string | null
  /** The file commands, each sent only once the LIFF session is kept (./ready.ts) */
  readonly actions: LiffFileActions
  /** Whether a command may go now (the camera asks before its upload) */
  readonly ready: () => Promise<LiffReadiness>
  /** Saving is stopped (a conflict, or the request was sent elsewhere) */
  readonly saveBlocked: boolean
}

export interface LiffReviewProps extends StepProps {
  readonly rules: readonly RuleStatus[]
  /** Price before VAT of each complete quotation, by key, and the keys of the lowest (core/forms compareQuotations) */
  readonly nets: Readonly<Record<string, Satang>>
  readonly lowest: readonly string[]
  readonly problems: readonly Problem[]
  readonly route: RouteView | null
  readonly onGoTo: (step: LiffStep) => void
  /** What stops the send button in the bar now, as the bar says it (the form's shell works it out); null: it can send */
  readonly sendBlock: SendBlock | null
  /** The server's last refusal of the send */
  readonly submitError: FormFailure | null
  /** The request's LIFF page, once the draft exists: where a refusal because it was sent or cancelled meanwhile leads */
  readonly requestHref?: string | null
  /** Load the latest version of the draft (after CONFLICT_VERSION) */
  readonly onReload: () => void
  readonly files: LiffReviewFiles
}

/** Why the last attach, detach or opening of a file failed: the service's refusal, or what the screen saw */
type FileProblem = FormFailure | 'NOT_SAVED' | 'NOT_OPENED'

/**
 * Opens a file at its short-lived address (FR-PLT-004 AC2); false when it could not be opened. In the LINE app a window
 * the page opens itself may never show (LINE opens pages with liff.openWindow): the address is asked for first and LINE
 * opens it (`line`, the provider's openExternal). In a browser, a window opened by the tap itself is not blocked, and
 * the address follows a moment later.
 */
export async function openFileWith(way: { readonly line: ((href: string) => void) | null; readonly open: () => Window | null }, address: () => Promise<string | null>): Promise<boolean> {
  if (way.line) {
    const url = await address()
    if (url) way.line(url)
    return url !== null
  }
  const opened = way.open()
  if (opened) opened.opener = null
  const url = await address()
  if (url && opened) {
    opened.location.href = url
    return true
  }
  opened?.close()
  return false
}

/** A button that looks like a link and is still 44 px high (§9.4) */
const LINK_BUTTON = 'min-h-11 self-start text-left'

/** The part of this step that holds the quotations and the documents (its LiffSection below) */
const DOCUMENTS_PART = 'review-documents'
/**
 * The quotations, the reason for not choosing the lowest one and the suggested supplier, as the documents step names
 * them (src/ui/request-form/documents-step.tsx, place-supplier.tsx)
 */
const QUOTATIONS_ID = 'quotations'
const REASON_ID = 'non-lowest-reason'
const SUPPLIER_ID = 'suggested-supplier'

/** The entry of an attachment rule in the documents step, which says what the rule still lacks */
const ruleEntryOf = (ruleId: string | undefined) => [...document.querySelectorAll<HTMLElement>('[data-rule]')].find((entry) => entry.dataset.rule === ruleId) ?? null

/**
 * A question of the form asked beside the documents (src/ui/request-form/document-fields.ts): its label with the box,
 * or — a question of a few choices, radio buttons with no box of their own — the group under the question
 */
function fieldPlaceOf(fieldId: string): HTMLElement | null {
  const control = document.getElementById(`field-${fieldId}`)
  if (control) return control.closest<HTMLElement>('div') ?? control
  const choice = document.querySelector<HTMLElement>(`input[name="${CSS.escape(fieldId)}"]`)
  return choice?.closest<HTMLElement>('fieldset') ?? choice
}

/**
 * Where on this step the requester puts right a problem the step fixes itself, in its quotations and documents: the entry
 * of the attachment rule, which says what the rule still lacks; a question the rules ask to be answered; the reason for
 * not choosing the lowest quotation; the quotation that is not complete; the quotations. While the documents are still
 * loading, the part that holds them.
 */
function placeOf(p: Problem): HTMLElement | null {
  const part = document.getElementById(DOCUMENTS_PART)
  const quotations = document.getElementById(QUOTATIONS_ID)
  switch (p.kind) {
    case 'ATTACHMENTS':
      return ruleEntryOf(p.ruleId) ?? part
    case 'FIELD_REQUIRED':
      return fieldPlaceOf(p.fieldId) ?? part
    case 'QUOTATION_REASON':
      return document.getElementById(REASON_ID) ?? quotations ?? part
    case 'QUOTATION_INCOMPLETE':
    case 'QUOTATION_FILE':
      return document.getElementById(`quote-${p.quotationNo}-supplier`)?.closest('fieldset') ?? quotations ?? part
    default:
      return quotations ?? part
  }
}

/**
 * Where on this step the requester puts right what the server refused, when this step fixes it (failureStep
 * 'documents'): the rule that is not met, the question it names, the reason for not choosing the lowest quotation, the
 * suggested supplier, the quotations. While the documents are still loading, the part that holds them.
 */
function refusalPlaceOf(f: FormFailure): HTMLElement | null {
  const part = document.getElementById(DOCUMENTS_PART)
  const key = failureKey(f)
  const fieldId = failureTarget(f).fieldId
  const place =
    key === 'ATTACHMENT_RULE_FAILED'
      ? ruleEntryOf(f.rule ?? f.failures?.[0]?.rule)
      : fieldId
        ? fieldPlaceOf(fieldId)
        : key === 'QUOTE_LOWEST' || f.field === 'nonLowestQuoteReason'
          ? document.getElementById(REASON_ID)
          : key === 'SUPPLIER_UNKNOWN'
            ? (document.getElementById(SUPPLIER_ID)?.closest<HTMLElement>('section') ?? null)
            : null
  return place ?? document.getElementById(QUOTATIONS_ID) ?? part
}

/**
 * Brings a place on this step to the top of the screen — near the end of the page, as far up as the page scrolls, so the
 * bar never covers it — and gives it focus, so that keyboard and screen reader users start there too. A place that cannot
 * take focus takes it until it loses it again.
 */
function bringToFocus(place: HTMLElement | null) {
  if (!place) return
  if (place.tabIndex < 0 && !place.hasAttribute('tabindex')) {
    place.setAttribute('tabindex', '-1')
    place.addEventListener('blur', () => place.removeAttribute('tabindex'), { once: true })
  }
  place.focus({ preventScroll: true })
  place.scrollIntoView({ block: 'start' })
}

export function LiffReviewStep(props: LiffReviewProps) {
  const t = useTranslations('requestForm')
  const tl = useTranslations('liffRequests.form')
  const liff = useLiff()
  const { data, values, update, input, visible, showErrors, fieldErrors, totals, budget, previewLoading, rules, problems, route, onGoTo, locale, sendBlock, submitError, files } = props
  const stepProps: StepProps = { data, values, update, locale, input, visible, totals, showErrors, budget, previewLoading, fieldErrors }
  // "ตรวจก่อนส่ง" leads with what stops the button, and is ready only when nothing does
  const blockPoint = sendBlockPoint(t, sendBlock)
  const purchase = data.type.documentType === 'PURCHASE_REQUEST'
  const line = data.budgetLines.find((l) => l.id === values.budgetLineId) ?? null
  const place = placeAndSupplierText(data, values)
  const kindLabel = (kind: string) => kindLabelOf(t, kind)
  const [fileBusy, setFileBusy] = useState(false)
  const [fileProblem, setFileProblem] = useState<FileProblem | null>(null)
  // The questions the attachment rules ask to be answered are asked with the documents (src/ui/request-form/document-fields.ts)
  const documentFields = documentFieldIds(data.form.rules)
  const asksHere = data.form.fields.some((f) => visible.has(f.id) && documentFields.has(f.id))
  // Documents show when a rule asks for some, when the request has some, when one of those questions is asked, when the
  // requester opens them, or to say why a file could not be attached
  const [documentsOpen, setDocumentsOpen] = useState(false)
  const showDocuments = documentsOpen || rules.length > 0 || asksHere || values.quotations.length > 0 || files.attachments.length > 0 || fileProblem !== null
  const reported = submitError !== null && DOA_GAPS.has(submitError.code) && adminsWereTold(submitError)
  const failed = submitError ? failureStep(submitError, documentFields) : null
  // A refusal fixed on this step (the documents) leads to its place here, one fixed on another step to that step
  const fixStep = failed ? liffStepOf(failed) : null
  // The send button sits in the bar at the bottom of the screen, wherever on this long step the requester is when they
  // press it: a new refusal is brought into view, right above the bar, and takes focus, so that keyboard and screen
  // reader users are there too. One already shown when the step opened stays where it is: the step's heading takes focus.
  const refusalRef = useRef<HTMLDivElement>(null)
  const shownRefusal = useRef(submitError)
  useEffect(() => {
    if (submitError === shownRefusal.current) return
    shownRefusal.current = submitError
    if (submitError) bringToFocus(refusalRef.current)
  }, [submitError])

  /** Opens the documents if they are closed, and brings the place that fixes the refusal to the top */
  function toRefusalPlace(f: FormFailure) {
    setDocumentsOpen(true)
    bringToFocus(refusalPlaceOf(f))
  }
  /** A refusal in the workspace's words, but a session that has ended in LIFF's: nothing was done, and how to come back */
  const refusalText = (f: FormFailure) => (f.code === 'UNAUTHENTICATED' ? tl('sessionEnded') : failureText(t, f, data.form.fields, locale, kindLabel))
  const fileError =
    fileProblem === null
      ? null
      : fileProblem === 'NOT_SAVED'
        ? t('errors.DRAFT_NOT_SAVED')
        : fileProblem === 'NOT_OPENED'
          ? t('errors.fileNotOpened')
          : refusalText(fileProblem)

  /** Links an uploaded file to the draft as `kind`; true when it is attached */
  async function attachAs(file: { fileId: string; fileName: string }, kind: string): Promise<boolean> {
    setFileProblem(null)
    setFileBusy(true)
    try {
      const id = await files.draftId()
      if (!id) {
        setFileProblem('NOT_SAVED')
        return false
      }
      const outcome = await files.actions.attach(id, file.fileId, kind, newUuid())
      if (!outcome.ok) {
        setFileProblem(outcome)
        return false
      }
      files.setAttachments((list) => [...list, { fileId: file.fileId, fileName: file.fileName, kind }])
      return true
    } finally {
      setFileBusy(false)
    }
  }

  async function attach(file: { fileId: string; fileName: string }, kind: string) {
    await attachAs(file, kind)
  }

  async function detach(fileId: string) {
    setFileProblem(null)
    setFileBusy(true)
    try {
      const id = await files.draftId()
      if (!id) return setFileProblem('NOT_SAVED')
      const outcome = await files.actions.detach(id, fileId, newUuid())
      if (outcome.ok) files.setAttachments((list) => list.filter((a) => a.fileId !== fileId))
      else setFileProblem(outcome)
    } finally {
      setFileBusy(false)
    }
  }

  function openFile(fileId: string) {
    setFileProblem(null)
    // Inside the LINE app (not the LIFF_MOCK stand-in, whose browser opens windows as any browser does) LINE opens it
    const line = liff.inClient && !liff.mocked ? liff.openExternal : null
    // A file opens through the draft it belongs to, or — nothing saved yet — as the requester's own upload
    // (src/app/liff/requests/actions.ts downloadUrlAction); opening a file saves nothing
    void openFileWith({ line, open: () => window.open('', '_blank') }, () => files.actions.downloadUrl(files.requestId, fileId)).then((opened) => {
      if (!opened) setFileProblem('NOT_OPENED')
    })
  }

  return (
    <div className="flex flex-col gap-6">
      <LiffSection id="review-summary" title={t('review.summary')}>
        <dl className="grid grid-cols-1 gap-y-1">
          <dt className="text-ink-muted">{t('review.type')}</dt>
          <dd className="mb-2">{data.type.name}</dd>
          <dt className="text-ink-muted">{t('review.title')}</dt>
          <dd className="mb-2 break-words">{values.title.trim() || t('review.noTitle')}</dd>
          {purchase ? (
            <>
              <dt className="text-ink-muted">{t('review.budgetLine')}</dt>
              <dd className="mb-2">{line ? t('budget.option', { code: line.code, name: line.name }) : t('review.noBudgetLine')}</dd>
              <dt className="text-ink-muted">{t('review.department')}</dt>
              <dd className="mb-2">{line?.departmentName ?? data.requesterDepartmentName ?? t('budget.dash')}</dd>
              <dt className="text-ink-muted">{t('review.site')}</dt>
              <dd className="mb-2 break-words">{place.site ? t('site.option', place.site) : t('review.noSite')}</dd>
              <dt className="text-ink-muted">{t('review.lines')}</dt>
              <dd className="mb-2">{t('review.lineCount', { count: values.lines.filter(savableLine).length })}</dd>
            </>
          ) : null}
          <dt className="text-ink-muted">{t('review.files')}</dt>
          <dd>{t('review.fileCount', { count: files.attachments.length + values.quotations.filter((q) => q.fileId).length })}</dd>
        </dl>
        {purchase ? <TotalsList totals={totals} rateBp={data.vatRateBp} /> : null}
      </LiffSection>

      {purchase ? (
        <LiffSection id="review-budget" title={t('budget.title')}>
          <BudgetStatus lineChosen={Boolean(values.budgetLineId)} budget={budget} need={totals?.net ?? null} loading={previewLoading} />
        </LiffSection>
      ) : null}

      <LiffSection id="review-route" title={t('route.title')}>
        <RoutePreview route={purchase ? route : { kind: 'NO_ROUTE' }} loading={previewLoading} locale={locale} reported={reported} />
      </LiffSection>

      <LiffSection id="review-documents" title={t('steps.documents')}>
        {showDocuments ? (
          <Suspense fallback={<p className="text-ink-muted">{tl('documentsLoading')}</p>}>
            <DocumentsStep
              {...stepProps}
              rules={rules}
              nets={props.nets}
              lowest={props.lowest}
              attachments={files.attachments}
              uploads={{ requestUpload: files.actions.requestUpload, completeUpload: files.actions.completeUpload }}
              onAttach={attach}
              onDetach={detach}
              onOpenFile={openFile}
              fileError={fileError}
              busy={fileBusy || files.saveBlocked}
            />
          </Suspense>
        ) : (
          <>
            <p className="text-ink-muted">{t('documents.noneRequired')}</p>
            {/* The workspace's documents step: quotations, files of every kind and the suggested supplier (S4-02) */}
            <Button variant="secondary" className="h-auto min-h-11 self-start py-2 text-left" onClick={() => setDocumentsOpen(true)}>
              {tl('documentsOpen')}
            </Button>
          </>
        )}
        {data.attachmentKinds.includes('PHOTO') ? (
          <LiffCameraAttach
            taken={files.attachments.map((a) => a.fileName)}
            busy={fileBusy || files.saveBlocked}
            ready={files.ready}
            requestUpload={files.actions.requestUpload}
            completeUpload={files.actions.completeUpload}
            onAttach={(file) => attachAs(file, 'PHOTO')}
          />
        ) : null}
      </LiffSection>

      <LiffSection id="review-problems" title={t('review.problemsTitle')}>
        {problems.length === 0 && sendBlock === null ? (
          // Supporting information on a request not sent yet, as the workspace's form says it: --info, never the
          // approved colour of --primary (§9.9 tokens)
          <LiffNotice tone="info">{t('review.ready')}</LiffNotice>
        ) : (
          <ul className="flex flex-col divide-y divide-line border-y border-line">
            {blockPoint ? (
              <li className="py-2">
                <p className="text-ink">
                  {blockPoint.text}
                  {blockPoint.mustFix ? <span className="text-ink-muted"> {t('review.mustFix')}</span> : null}
                </p>
              </li>
            ) : null}
            {problems.map((p, i) => {
              const step = liffStepOf(problemStep(p, documentFields))
              return (
                <li key={i} className="flex flex-col gap-1 py-2">
                  <p className="text-ink">
                    {problemText(t, p, data.form.fields, locale)}
                    {/* What stops the bar's button, and every other problem, which the server refuses on send (FR-INT-005 AC2) */}
                    {mustFixBeforeSending(p) ? <span className="text-ink-muted"> {t('review.mustFix')}</span> : null}
                  </p>
                  {step !== 'review' ? (
                    <Button variant="link" className={LINK_BUTTON} onClick={() => onGoTo(step)}>
                      {t('review.goTo', { step: t(`steps.${step}`) })}
                    </Button>
                  ) : (
                    // Fixed on this step, under its quotations and documents: what to do, and the way there (§9.9 rule 7)
                    <Button variant="link" className={LINK_BUTTON} onClick={() => bringToFocus(placeOf(p))}>
                      {p.kind === 'ATTACHMENTS' ? tl('fixRule', { rule: p.ruleId, part: t('steps.documents') }) : tl('fixHere', { part: t('steps.documents') })}
                    </Button>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </LiffSection>

      {/* The server's refusal of the send, last on the step: right above the send button in the bar, as the workspace's
          review step puts it above its button (§9.9: never only somewhere the requester does not look) */}
      {submitError ? (
        <div ref={refusalRef}>
          <LiffNotice tone="danger">
            <p>{refusalText(submitError)}</p>
            {fixStep === 'review' ? (
              // Fixed on this step, under its quotations and documents: the way there (§9.9 rule 7)
              <Button variant="link" className={LINK_BUTTON} onClick={() => toRefusalPlace(submitError)}>
                {tl('fixHere', { part: t('steps.documents') })}
              </Button>
            ) : fixStep ? (
              <Button variant="link" className={LINK_BUTTON} onClick={() => onGoTo(fixStep)}>
                {t('review.goTo', { step: t(`steps.${fixStep}`) })}
              </Button>
            ) : null}
            {/* FR-INT-006 AC2: saved elsewhere since this page opened — offer the latest version right here */}
            {submitError.code === 'CONFLICT_VERSION' ? (
              <Button variant="secondary" className="mt-2" onClick={props.onReload}>
                {t('save.reload')}
              </Button>
            ) : null}
            {/* Sent or cancelled meanwhile: its own page says where it stands (§9.9 rule 7: the way on), as on the web */}
            {failureKey(submitError) === 'STATE' && props.requestHref ? <LiffLink href={props.requestHref}>{t('page.openRequest')}</LiffLink> : null}
          </LiffNotice>
        </div>
      ) : null}
    </div>
  )
}

/**
 * A save of the draft that the server refused, in the words of the workspace's form (shown at the top of the form) — but
 * a session that has ended in LIFF's own: the latest changes were not saved, and the form opens again from the LINE chat
 */
export function SaveFailureText({ failure, fields, locale }: { readonly failure: FormFailure; readonly fields: readonly FieldDef[]; readonly locale: 'th' | 'en' }) {
  const t = useTranslations('requestForm')
  const tl = useTranslations('liffRequests.form')
  if (failure.code === 'UNAUTHENTICATED') return <span>{tl('sessionEnded')}</span>
  return <span>{t('save.failed', { reason: failureText(t, failure, fields, locale, (kind) => kindLabelOf(t, kind)) })}</span>
}

const PRIMARY_LINK =
  'inline-flex min-h-11 w-full items-center justify-center rounded-md bg-primary px-4 text-center font-medium text-primary-foreground underline-offset-4 transition-colors duration-150 hover:underline'

/**
 * Sent (§9.9 rule 7): the confirmation repeats the button's words — "ส่งขออนุมัติแล้ว", "ส่งขออนุมัติอีกครั้งแล้ว",
 * "ส่งคำขอให้ฝ่ายจัดซื้อแล้ว" — with the number the request got and who decides it now; the bar leads to the request's
 * LIFF page, where its status and timeline are followed, and back to the LINE chat inside the LINE app. The send button
 * goes with the form, so the confirmation takes focus as it appears (NFR-A11Y-01, WCAG 2.4.3 and 4.1.3): the request's
 * title and the confirmation with its number are the first thing a screen reader reads, as on the web's form.
 */
export function LiffSent({
  sent,
  title,
  kind,
  requestHref,
  catalogHref,
}: {
  readonly sent: SentView
  readonly title: string
  readonly kind: 'send' | 'resubmit' | 'procurement'
  readonly requestHref: string
  readonly catalogHref: string
}) {
  const t = useTranslations('requestForm.sent')
  const tl = useTranslations('liffRequests.form')
  const { inClient, mocked, closeWindow } = useLiff()
  const names = sent.waitingFor.map((w) => (w.principalName ? t('acting', { name: w.name, principal: w.principalName }) : w.name)).join(t('namesJoin'))
  const headline = kind === 'procurement' ? t('procurement') : names ? t(kind === 'resubmit' ? 'resubmitWaiting' : 'sendWaiting', { names }) : t(kind === 'resubmit' ? 'resubmit' : 'send')
  const confirmation = useRef<HTMLDivElement>(null)
  useEffect(() => {
    confirmation.current?.focus()
  }, [])
  return (
    <>
      <LiffContent>
        <div ref={confirmation} tabIndex={-1} className="flex flex-col gap-6 outline-none">
          <h2 className="text-lg font-semibold break-words">{title}</h2>
          <LiffNotice tone="success">
            <p className="font-semibold">{headline}</p>
            {sent.number ? <p>{t('number', { number: sent.number })}</p> : null}
          </LiffNotice>
        </div>
        <p className="text-ink-muted">{kind === 'procurement' ? t('nextProcurement') : t('next')}</p>
        <LiffLink href={catalogHref}>{t('another')}</LiffLink>
      </LiffContent>
      <LiffActionBar label={tl('sentBar')}>
        <LiffLink href={requestHref} className={PRIMARY_LINK}>
          {sent.number ? t('open', { number: sent.number }) : t('openNoNumber')}
        </LiffLink>
        {inClient && !mocked ? (
          <Button variant="secondary" className="w-full" onClick={closeWindow}>
            {tl('backToChat')}
          </Button>
        ) : null}
      </LiffActionBar>
    </>
  )
}
