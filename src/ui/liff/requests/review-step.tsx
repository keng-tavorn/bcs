'use client'

import { useTranslations } from 'next-intl'
import { lazy, Suspense, useState } from 'react'
import type { FieldDef } from '@/core/forms/fields'
import type { Satang } from '@/core/money/math'
import type { StepProps } from '../../request-form/details-items'
import { problemStep, savableLine, type Problem, type RuleStatus } from '../../request-form/model'
import { adminsWereTold, failureStep, type FormFailure, type FormOutcome } from '../../request-form/outcome'
import { placeAndSupplierText } from '../../request-form/place-supplier'
import { failureText } from '../../request-form/review-step'
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
// for, and what still needs fixing with a way to the step that fixes it. The workspace's own parts show the totals, the
// budget and the route (src/ui/request-form/summary.tsx), and its documents step the quotations, the suggested supplier
// and the files when the rules ask for them or the requester opens them (loaded only then). A photo from the phone's
// camera is one tap away in any case (./camera-attach.tsx, FR-INT-005 AC3), beside the general file picker. The send
// button sits in the bar at the bottom (the form's shell): its words, its refusal and the server's answer are the same
// as on the web. The file commands reach this step already gated by the LIFF session (the form's shell, ./ready.ts).

/** A refusal because the DOA names nobody who can approve (FR-DOA-003 AC3) */
const DOA_GAPS: ReadonlySet<string> = new Set(['DOA_NOT_CONFIGURED', 'APPROVER_NOT_FOUND', 'NO_HIGHER_AUTHORITY'])
/** Problems that would send something other than what is on screen (the web's review step blocks the button on these) */
const BLOCKING: ReadonlySet<Problem['kind']> = new Set(['TITLE', 'NO_LINES', 'LINE_INCOMPLETE', 'QUOTATION_INCOMPLETE'])

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
  /** The server's last refusal of the send */
  readonly submitError: FormFailure | null
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

export function LiffReviewStep(props: LiffReviewProps) {
  const t = useTranslations('requestForm')
  const tl = useTranslations('liffRequests.form')
  const liff = useLiff()
  const { data, values, update, input, visible, showErrors, fieldErrors, totals, budget, previewLoading, rules, problems, route, onGoTo, locale, submitError, files } = props
  const stepProps: StepProps = { data, values, update, locale, input, visible, totals, showErrors, budget, previewLoading, fieldErrors }
  const purchase = data.type.documentType === 'PURCHASE_REQUEST'
  const line = data.budgetLines.find((l) => l.id === values.budgetLineId) ?? null
  const place = placeAndSupplierText(data, values)
  const kindLabel = (kind: string) => kindLabelOf(t, kind)
  const [fileBusy, setFileBusy] = useState(false)
  const [fileProblem, setFileProblem] = useState<FileProblem | null>(null)
  // Documents show when a rule asks for some, when the request has some, when the requester opens them, or to say why
  // a file could not be attached
  const [documentsOpen, setDocumentsOpen] = useState(false)
  const showDocuments = documentsOpen || rules.length > 0 || values.quotations.length > 0 || files.attachments.length > 0 || fileProblem !== null
  const reported = submitError !== null && DOA_GAPS.has(submitError.code) && adminsWereTold(submitError)
  const failed = submitError ? failureStep(submitError) : null
  // A refusal fixed on this step (the documents) needs no way to it
  const fixStep = failed ? liffStepOf(failed) : null
  const fileError =
    fileProblem === null
      ? null
      : fileProblem === 'NOT_SAVED'
        ? t('errors.DRAFT_NOT_SAVED')
        : fileProblem === 'NOT_OPENED'
          ? t('errors.fileNotOpened')
          : failureText(t, fileProblem, data.form.fields, locale, kindLabel)

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
      {submitError ? (
        <LiffNotice tone="danger">
          <p>{failureText(t, submitError, data.form.fields, locale, kindLabel)}</p>
          {fixStep && fixStep !== 'review' ? (
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
        </LiffNotice>
      ) : null}

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
        {problems.length === 0 ? (
          <LiffNotice tone="success">{t('review.ready')}</LiffNotice>
        ) : (
          <ul className="flex flex-col divide-y divide-line border-y border-line">
            {problems.map((p, i) => {
              const step = liffStepOf(problemStep(p))
              return (
                <li key={i} className="flex flex-col gap-1 py-2">
                  <p className="text-ink">
                    {problemText(t, p, data.form.fields, locale)}
                    {BLOCKING.has(p.kind) ? <span className="text-ink-muted"> {t('review.mustFix')}</span> : null}
                  </p>
                  {step !== 'review' ? (
                    <Button variant="link" className={LINK_BUTTON} onClick={() => onGoTo(step)}>
                      {t('review.goTo', { step: t(`steps.${step}`) })}
                    </Button>
                  ) : null}
                </li>
              )
            })}
          </ul>
        )}
      </LiffSection>
    </div>
  )
}

/** A save of the draft that the server refused, in the words of the workspace's form (shown at the top of the form) */
export function SaveFailureText({ failure, fields, locale }: { readonly failure: FormFailure; readonly fields: readonly FieldDef[]; readonly locale: 'th' | 'en' }) {
  const t = useTranslations('requestForm')
  return <span>{t('save.failed', { reason: failureText(t, failure, fields, locale, (kind) => kindLabelOf(t, kind)) })}</span>
}

const PRIMARY_LINK =
  'inline-flex min-h-11 w-full items-center justify-center rounded-md bg-primary px-4 text-center font-medium text-primary-foreground transition-colors duration-150 hover:bg-[color-mix(in_oklab,var(--primary)_85%,black)]'

/**
 * Sent (§9.9 rule 7): the confirmation repeats the button's words — "ส่งขออนุมัติแล้ว", "ส่งขออนุมัติอีกครั้งแล้ว",
 * "ส่งคำขอให้ฝ่ายจัดซื้อแล้ว" — with the number the request got and who decides it now; the bar leads to the request's
 * LIFF page, where its status and timeline are followed, and back to the LINE chat inside the LINE app.
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
  return (
    <>
      <LiffContent>
        <h2 className="text-lg leading-snug font-semibold break-words">{title}</h2>
        <LiffNotice tone="success">
          <p className="font-semibold">{headline}</p>
          {sent.number ? <p>{t('number', { number: sent.number })}</p> : null}
        </LiffNotice>
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
