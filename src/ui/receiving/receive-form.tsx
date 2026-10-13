'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { useId, useState, type FormEvent, type ReactNode } from 'react'
import { REASON_MAX_LENGTH } from '@/lib/constants'
import type { AiReadActions } from '../ai/types'
import { FileUpload, type FileUploadProps } from '../files/file-upload'
import { Button } from '../form/button'
import { Field } from '../form/field'
import { Notice } from '../form/notice'
import { useSubmissionKey } from '../form/submission-key'
import { StateLine } from '../request-view/status'
import { TextArea } from '../request-view/text-area'
import { ApproverText } from './approver-text'
import { DeliveryNoteReader, DeliveryNoteReview, type DeliveryNoteRead } from './delivery-note-ai'
import { NO_ANSWER, type ReceivingAction } from './failed'
import { receivingErrorKey, receivingErrorValues, type PostOutcome, type PreviewOutcome, type ReceivingFailure } from './outcome'
import { cleanQuantity, compareQuantity, isZeroQuantity } from './quantity'
import type { ApproverView, DamagedChoice, ExcessChoice, ReceiptInput, ReceiptPreviewView, ReceiveLineView } from './types'

// Receiving one PO on site, from a phone first (FR-P2P-006 AC1, FR-P2P-007, §9.9, demo scene 8). Two real steps, so the
// form never grows past what a phone shows comfortably: (1) what came — the quantity per line, what was refused and why,
// the delivery note, photos taken with the camera (FileUpload shrinks them before upload) and notes; (2) what will
// happen, calculated by the server before anything is written (§9.9 principle 3): what is accepted, the PO's status
// after, and for an excess beyond the tolerance or damaged goods the receiver's choice — send back or replace without an
// approval, or keep with the GR_VARIANCE approver named. Confirming posts the receipt (gr.post). A posted receipt cannot
// be undone by the receiver, so step 2 is the confirmation. The server checks every rule again. Each press of "check"
// carries its own idempotency key, so a check refused by separation of duties is recorded once per press (FR-DOA-007 AC2).
// A photo still being uploaded holds the receipt, as on the LIFF receiving page (src/ui/liff/receiving/receive-flow.tsx):
// neither step's button works until the photo is recorded, and the bar says why — the receipt never goes without a photo
// the receiver chose, and what step 2 showed is what is posted. The upload has a time limit and a stop
// (../files/upload.ts), so a stalled network never locks the form; while the receipt is being checked or posted no photo
// is chosen or taken out. A check or a receipt that gets no answer (the signal drops) says so in the words of its own
// step (./failed.ts): a failed check has recorded nothing, a failed receipt was not recorded.

export interface ReceiveFormActions {
  readonly preview: (input: Omit<ReceiptInput, 'deliveryNoteNo' | 'notes'>, idempotencyKey: string) => Promise<PreviewOutcome>
  readonly post: (input: ReceiptInput, idempotencyKey: string) => Promise<PostOutcome>
  readonly requestUpload: FileUploadProps['requestUpload']
  readonly completeUpload: FileUploadProps['completeUpload']
  /** The Document Agent, when it is available to this member now (FR-AI-303 AC4 AC8) */
  readonly ai?: AiReadActions
}

export interface ReceiveFormProps {
  readonly poId: string
  readonly lines: readonly ReceiveLineView[]
  /** The PO takes goods and the member may post them now */
  readonly open: boolean
  /** Where "back to the list" goes: /receiving on the web, the LIFF list in LINE */
  readonly listHref: string
  readonly actions: ReceiveFormActions
}

interface LineState {
  readonly received: string
  readonly rejected: string
  readonly damaged: boolean
  readonly remark: string
  readonly refusing: boolean
}

type LineErrors = Partial<Record<'received' | 'rejected', string>>
type Choices = Readonly<Record<string, { readonly excess?: ExcessChoice; readonly damaged?: DamagedChoice }>>
type Posted = Extract<PostOutcome, { ok: true }>
/** A check or a receipt that the server refused or did not answer, and which of the two it was: the words depend on it */
interface Failure {
  readonly outcome: ReceivingFailure
  readonly action: ReceivingAction
}

const EMPTY_LINE: LineState = { received: '', rejected: '', damaged: true, remark: '', refusing: false }
const linkClass = 'inline-flex min-h-11 items-center font-medium text-primary underline underline-offset-4 hover:no-underline'
// The main action stays at the bottom of a phone screen while the form scrolls; on wide screens it follows the form.
// What holds the action back (a photo still on its way) has a row of its own above the buttons, so it never squeezes them
const barClass = 'sticky bottom-0 z-10 -mx-4 flex flex-col gap-3 border-t border-line bg-bg px-4 py-3 lg:static lg:mx-0 lg:border-0 lg:px-0 lg:py-0'
// The step's buttons: one under the other on a phone, side by side where they fit and on two rows where they do not —
// each keeps its words on one line inside its 44 px (a squeezed button would spill them over its edge)
const barButtonsClass = 'flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center'

function useFailureText() {
  const t = useTranslations('receiving.errors')
  return ({ outcome, action }: Failure) => t(receivingErrorKey(outcome, action), receivingErrorValues(outcome))
}

export function ReceiveForm({ poId, lines, open, listHref, actions }: ReceiveFormProps) {
  const t = useTranslations('receiving.form')
  const tStatus = useTranslations('receiving.status.po')
  const failureText = useFailureText()
  const locale = useLocale()
  const router = useRouter()
  const id = useId()
  const submission = useSubmissionKey()
  const check = useSubmissionKey()

  const [state, setState] = useState<Readonly<Record<string, LineState>>>({})
  const [deliveryNoteNo, setDeliveryNoteNo] = useState('')
  const [notes, setNotes] = useState('')
  const [photos, setPhotos] = useState<ReadonlyArray<{ fileId: string; fileName: string }>>([])
  const [step, setStep] = useState<'enter' | 'review' | 'done'>('enter')
  const [preview, setPreview] = useState<ReceiptPreviewView | null>(null)
  const [choices, setChoices] = useState<Choices>({})
  const [lineErrors, setLineErrors] = useState<Readonly<Record<string, LineErrors>>>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [photoError, setPhotoError] = useState<string | null>(null)
  const [choiceErrors, setChoiceErrors] = useState<ReadonlySet<string>>(new Set())
  const [failure, setFailure] = useState<Failure | null>(null)
  const [pending, setPending] = useState(false)
  /** A photo is on its way (FileUpload's onBusyChange): the receipt waits for it */
  const [uploading, setUploading] = useState(false)
  const [posted, setPosted] = useState<Posted | null>(null)
  /** A delivery note the AI read into the quantities, until the receiver confirmed them (FR-AI-303 AC4) */
  const [dnRead, setDnRead] = useState<DeliveryNoteRead | null>(null)

  const lineOf = (lineId: string): LineState => state[lineId] ?? EMPTY_LINE
  function update(lineId: string, patch: Partial<LineState>) {
    setState((s) => ({ ...s, [lineId]: { ...(s[lineId] ?? EMPTY_LINE), ...patch } }))
    // An error goes as soon as its field is being fixed
    setLineErrors((e) => ({ ...e, [lineId]: {} }))
    setFormError(null)
    setFailure(null)
  }

  /** The lines of this receipt as the server takes them, or the errors to show */
  function collect(): { ok: true; lines: ReceiptInput['lines'] } | { ok: false } {
    const errors: Record<string, LineErrors> = {}
    const out: Array<ReceiptInput['lines'][number]> = []
    let damagedRefused = false
    for (const line of lines) {
      const s = lineOf(line.id)
      if (!s.received.trim()) continue
      const received = cleanQuantity(s.received)
      if (received === null) {
        errors[line.id] = { received: t('fieldErrors.quantity') }
        continue
      }
      const rejected = s.refusing && s.rejected.trim() ? cleanQuantity(s.rejected) : '0'
      if (rejected === null) {
        errors[line.id] = { rejected: t('fieldErrors.quantity') }
        continue
      }
      if (compareQuantity(rejected, received) > 0) {
        errors[line.id] = { rejected: t('fieldErrors.rejectedTooMany') }
        continue
      }
      if (isZeroQuantity(received)) continue
      const damaged = s.refusing && s.damaged && !isZeroQuantity(rejected)
      damagedRefused ||= damaged
      const choice = choices[line.id] ?? {}
      out.push({
        poLineId: line.id,
        received,
        rejected,
        damaged,
        remark: s.refusing ? s.remark : '',
        ...(choice.excess ? { excessDisposition: choice.excess } : {}),
        ...(damaged && choice.damaged ? { damagedDisposition: choice.damaged } : {}),
      })
    }
    setLineErrors(errors)
    const photoMissing = damagedRefused && photos.length === 0
    setPhotoError(photoMissing ? t('fieldErrors.photo') : null)
    const nothing = Object.keys(errors).length === 0 && out.length === 0
    setFormError(nothing ? t('fieldErrors.nothing') : null)
    if (Object.keys(errors).length || photoMissing || nothing) return { ok: false }
    return { ok: true, lines: out }
  }

  async function onReview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    // A photo on its way belongs to this receipt: the check waits for it (the bar says so); one check at a time
    if (pending || uploading) return
    setFailure(null)
    const collected = collect()
    if (!collected.ok) return
    setPending(true)
    let outcome: PreviewOutcome
    try {
      outcome = await actions.preview({ poId, photoFileIds: photos.map((p) => p.fileId), lines: collected.lines }, check.key)
      check.next()
    } catch {
      // No answer: the key stays, so pressing again is the same check (spec §4.3); nothing has been recorded
      outcome = NO_ANSWER
    }
    setPending(false)
    if (!outcome.ok) return setFailure({ outcome, action: 'check' })
    setPreview(outcome.preview)
    setChoiceErrors(new Set())
    setStep('review')
  }

  async function onConfirm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    // Nothing is posted twice, nor while a photo is still on its way
    if (!preview || pending || uploading) return
    // Every excess and every damaged line needs the receiver's choice (BR-GR-03)
    const missing = new Set<string>()
    for (const l of preview.lines) {
      if (l.excess && !choices[l.poLineId]?.excess) missing.add(`${l.poLineId}:excess`)
      if (l.damaged && !choices[l.poLineId]?.damaged) missing.add(`${l.poLineId}:damaged`)
    }
    setChoiceErrors(missing)
    if (missing.size) return
    const collected = collect()
    if (!collected.ok) return setStep('enter')
    setPending(true)
    setFailure(null)
    let outcome: PostOutcome
    try {
      const aiAssist = dnRead ? { aiAssist: { agentActionId: dnRead.review.agentActionId, confirmedPaths: dnRead.review.confirmed } } : {}
      outcome = await actions.post({ poId, deliveryNoteNo, notes, photoFileIds: photos.map((p) => p.fileId), lines: collected.lines, ...aiAssist }, submission.key)
      submission.next()
    } catch {
      // No answer: the key stays, so trying again is the same submission (spec §4.3)
      outcome = NO_ANSWER
    }
    setPending(false)
    if (!outcome.ok) {
      setFailure({ outcome, action: 'record' })
      // What the server found wrong is fixed on step 1, then checked again (the PO may have moved since the preview)
      if (outcome.code === 'VALIDATION_FAILED') setStep('enter')
      return
    }
    setPosted(outcome)
    setStep('done')
    router.refresh()
  }

  function startAgain() {
    setState({})
    setDeliveryNoteNo('')
    setNotes('')
    setPhotos([])
    setChoices({})
    setDnRead(null)
    setPreview(null)
    setPosted(null)
    setFailure(null)
    setStep('enter')
  }

  if (step === 'done' && posted) {
    return (
      <section aria-labelledby={`${id}-done`} className="flex flex-col gap-4">
        <Notice tone="success">
          <p id={`${id}-done`} className="font-semibold">
            {t('doneTitle', { number: posted.number })}
          </p>
          <p>{t('donePo', { status: tStatus(posted.poStatus === 'RECEIVED' ? 'RECEIVED' : 'PARTIALLY_RECEIVED') })}</p>
          {posted.pendingApproval > 0 ? <p>{t('donePending', { count: posted.pendingApproval })}</p> : null}
        </Notice>
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:gap-x-6">
          {open ? (
            <Button variant="secondary" onClick={startAgain} className="self-start">
              {t('again')}
            </Button>
          ) : null}
          <Link href={listHref} className={linkClass}>
            {t('toList')}
          </Link>
        </div>
      </section>
    )
  }
  if (!open) return null

  if (step === 'review' && preview) {
    return (
      <form onSubmit={onConfirm} noValidate aria-labelledby={`${id}-review`} className="flex flex-col gap-5">
        <div className="flex flex-col gap-1">
          <p className="text-ink-muted">{t('step', { step: 2 })}</p>
          <h2 id={`${id}-review`} className="text-xl font-semibold text-ink">
            {t('reviewTitle')}
          </h2>
          <p className="text-ink-muted">{t('reviewHint')}</p>
        </div>

        <div className="flex flex-col gap-1 rounded-md border border-line bg-surface p-4">
          <StateLine kind={preview.poStatusAfter === 'RECEIVED' ? 'done' : 'waiting'} className="font-medium">
            {preview.poStatusAfter === 'RECEIVED' ? t('afterFull') : t('afterPartial', { count: preview.linesOutstandingAfter })}
          </StateLine>
        </div>

        <ol className="flex flex-col divide-y divide-line border-y border-line">
          {preview.lines.map((l) => (
            <li key={l.poLineId} className="flex flex-col gap-3 py-4">
              <div className="flex flex-col gap-0.5">
                <p className="font-semibold break-words text-ink">{l.description}</p>
                <p className="text-ink">{t('reviewLine', { received: l.received, accepted: l.accepted, left: l.outstandingAfter, uom: l.uom })}</p>
                {l.rejected ? <p className="text-ink">{t('reviewRefused', { quantity: l.rejected, uom: l.uom })}</p> : null}
                {l.withinTolerance ? <p className="text-ink-muted">{t('withinTolerance', { quantity: l.withinTolerance, uom: l.uom, pct: preview.tolerancePct })}</p> : null}
                {l.withinTolerance && l.hold ? <MoneyRow label={t('holdLabel')} amount={t('baht', { amount: l.hold })} /> : null}
              </div>
              {l.excess ? (
                <ChoiceGroup
                  name={`${id}-${l.poLineId}-excess`}
                  legend={t('excessLegend', { quantity: l.excess.quantity, uom: l.uom, pct: preview.tolerancePct })}
                  amount={l.excess.amount ? <MoneyRow label={t('choiceAmountLabel')} amount={t('baht', { amount: l.excess.amount })} /> : null}
                  value={choices[l.poLineId]?.excess ?? null}
                  error={choiceErrors.has(`${l.poLineId}:excess`) ? t('fieldErrors.choose') : undefined}
                  options={[
                    { value: 'RETURN_EXCESS', label: t('returnExcess') },
                    { value: 'ACCEPT_EXCESS', label: t('keepExcess'), approver: l.excess.keep },
                  ]}
                  onChange={(value) => {
                    setChoices((c) => ({ ...c, [l.poLineId]: { ...c[l.poLineId], excess: value as ExcessChoice } }))
                    setChoiceErrors((e) => new Set([...e].filter((k) => k !== `${l.poLineId}:excess`)))
                  }}
                  locale={locale}
                />
              ) : null}
              {l.damaged ? (
                <ChoiceGroup
                  name={`${id}-${l.poLineId}-damaged`}
                  legend={t('damagedLegend', { quantity: l.damaged.quantity, uom: l.uom })}
                  amount={l.damaged.amount ? <MoneyRow label={t('choiceAmountLabel')} amount={t('baht', { amount: l.damaged.amount })} /> : null}
                  value={choices[l.poLineId]?.damaged ?? null}
                  error={choiceErrors.has(`${l.poLineId}:damaged`) ? t('fieldErrors.choose') : undefined}
                  options={[
                    { value: 'RETURN_REPLACE', label: t('replaceDamaged') },
                    { value: 'ACCEPT_DAMAGED', label: t('keepDamaged'), approver: l.damaged.keep },
                  ]}
                  onChange={(value) => {
                    setChoices((c) => ({ ...c, [l.poLineId]: { ...c[l.poLineId], damaged: value as DamagedChoice } }))
                    setChoiceErrors((e) => new Set([...e].filter((k) => k !== `${l.poLineId}:damaged`)))
                  }}
                  locale={locale}
                />
              ) : null}
            </li>
          ))}
        </ol>

        <div className="flex flex-col gap-1">
          <h3 className="font-semibold text-ink">{t('evidenceTitle')}</h3>
          <p className="break-words text-ink">{deliveryNoteNo.trim() ? t('deliveryNoteValue', { number: deliveryNoteNo.trim() }) : t('noDeliveryNote')}</p>
          <p className="text-ink">{photos.length ? t('photoCount', { count: photos.length }) : t('noPhoto')}</p>
          {notes.trim() ? <p className="break-words whitespace-pre-line text-ink">{t('notesValue', { notes: notes.trim() })}</p> : null}
        </div>

        {failure ? <Notice tone="danger">{failureText(failure)}</Notice> : null}
        <ReceiveBar
          step="review"
          pending={pending}
          uploading={uploading}
          onBack={() => {
            setFailure(null)
            setStep('enter')
          }}
        />
      </form>
    )
  }

  return (
    <form onSubmit={onReview} noValidate aria-labelledby={`${id}-enter`} className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <p className="text-ink-muted">{t('step', { step: 1 })}</p>
        <h2 id={`${id}-enter`} className="text-xl font-semibold text-ink">
          {t('enterTitle')}
        </h2>
        <p className="text-ink-muted">{t('enterHint')}</p>
      </div>

      {actions.ai && !dnRead ? (
        <DeliveryNoteReader
          poId={poId}
          ai={actions.ai}
          uploads={{ requestUpload: actions.requestUpload, completeUpload: actions.completeUpload }}
          disabled={pending}
          onRead={(read, received) => {
            for (const [lineId, quantity] of Object.entries(received)) update(lineId, { received: quantity })
            setDnRead(read)
          }}
        />
      ) : null}
      {actions.ai && dnRead ? (
        <DeliveryNoteReview
          read={dnRead}
          lines={lines}
          receivedOf={(lineId) => lineOf(lineId).received}
          onConfirm={(paths, checked) =>
            setDnRead((r) => {
              if (!r) return r
              const confirmed = new Set(r.review.confirmed)
              for (const p of paths) {
                if (checked) confirmed.add(p)
                else confirmed.delete(p)
              }
              return { ...r, review: { ...r.review, confirmed: [...confirmed].sort() } }
            })
          }
          fileUrl={() => actions.ai!.fileUrl(dnRead.fileId)}
        />
      ) : null}

      <ol className="flex flex-col divide-y divide-line border-y border-line">
        {lines.map((line) => {
          const s = lineOf(line.id)
          const errors = lineErrors[line.id] ?? {}
          const nothingLeft = isZeroQuantity(cleanQuantity(line.outstanding) ?? '0')
          return (
            <li key={line.id} className="flex flex-col gap-3 py-4">
              <div className="flex flex-col gap-1">
                <p className="font-semibold break-words text-ink">{line.description}</p>
                <dl className="grid grid-cols-3 gap-2 text-base sm:max-w-md md:text-sm">
                  <Figure label={t('ordered')} value={t('quantity', { quantity: line.ordered, uom: line.uom })} />
                  <Figure label={t('receivedSoFar')} value={t('quantity', { quantity: line.received, uom: line.uom })} />
                  <Figure label={t('outstanding')} value={t('quantity', { quantity: line.outstanding, uom: line.uom })} strong />
                </dl>
                {line.cancelled ? <p className="text-base text-ink-muted md:text-sm">{t('cancelledNote', { quantity: line.cancelled, uom: line.uom })}</p> : null}
                {line.keepPending ? (
                  <StateLine kind="waiting" className="text-base md:text-sm">
                    {t('keepPendingNote', { quantity: line.keepPending, uom: line.uom })}
                  </StateLine>
                ) : null}
                {nothingLeft ? <StateLine kind="done">{t('lineDone')}</StateLine> : null}
              </div>
              <div className="sm:max-w-xs">
                <Field
                  id={`${id}-${line.id}-received`}
                  label={<LineLabel item={line.description} text={t('receivedLabel', { uom: line.uom })} />}
                  inputMode="decimal"
                  autoComplete="off"
                  value={s.received}
                  onChange={(event) => update(line.id, { received: event.currentTarget.value })}
                  error={errors.received}
                  className="tabular text-right"
                />
              </div>
              {s.refusing ? (
                <div className="flex flex-col gap-3 border-l-2 border-line pl-3">
                  <div className="sm:max-w-xs">
                    <Field
                      id={`${id}-${line.id}-rejected`}
                      label={<LineLabel item={line.description} text={t('rejectedLabel', { uom: line.uom })} />}
                      inputMode="decimal"
                      autoComplete="off"
                      value={s.rejected}
                      onChange={(event) => update(line.id, { rejected: event.currentTarget.value })}
                      error={errors.rejected}
                      className="tabular text-right"
                    />
                  </div>
                  <fieldset className="flex flex-col gap-1">
                    <legend className="font-medium text-ink">
                      <LineLabel item={line.description} text={t('whyLegend')} />
                    </legend>
                    <Radio name={`${id}-${line.id}-why`} checked={s.damaged} onChange={() => update(line.id, { damaged: true })} label={t('whyDamaged')} />
                    <Radio name={`${id}-${line.id}-why`} checked={!s.damaged} onChange={() => update(line.id, { damaged: false })} label={t('whyOther')} />
                  </fieldset>
                  <Field
                    id={`${id}-${line.id}-remark`}
                    label={<LineLabel item={line.description} text={t('remarkLabel')} />}
                    value={s.remark}
                    maxLength={REASON_MAX_LENGTH}
                    onChange={(event) => update(line.id, { remark: event.currentTarget.value })}
                  />
                  <Button variant="link" onClick={() => update(line.id, { refusing: false, rejected: '', remark: '' })} className="min-h-11 self-start">
                    {t('refuseClose', { description: line.description })}
                  </Button>
                </div>
              ) : (
                <Button variant="link" onClick={() => update(line.id, { refusing: true })} className="min-h-11 self-start">
                  {t('refuse', { description: line.description })}
                </Button>
              )}
            </li>
          )
        })}
      </ol>

      <section aria-labelledby={`${id}-evidence`} className="flex flex-col gap-4">
        <h3 id={`${id}-evidence`} className="text-lg font-semibold text-ink">
          {t('evidenceTitle')}
        </h3>
        <div className="sm:max-w-sm">
          <Field
            id={`${id}-delivery-note`}
            label={t('deliveryNoteLabel')}
            hint={t('deliveryNoteHint')}
            autoComplete="off"
            maxLength={100}
            value={deliveryNoteNo}
            onChange={(event) => setDeliveryNoteNo(event.currentTarget.value)}
          />
        </div>
        <div className="flex flex-col gap-2">
          <p className="font-medium text-ink">{t('photosLabel')}</p>
          <p className="text-base text-ink-muted md:text-sm">{t('photosHint')}</p>
          <FileUpload
            mode="photo"
            rule={t('photosRule')}
            requestUpload={actions.requestUpload}
            completeUpload={actions.completeUpload}
            onUploaded={(file) => {
              setPhotos((list) => [...list, file])
              setPhotoError(null)
            }}
            onBusyChange={setUploading}
            disabled={pending}
          />
          {photos.length ? (
            <ul aria-label={t('photosLabel')} className="flex flex-col divide-y divide-line border-y border-line">
              {photos.map((photo) => (
                <li key={photo.fileId} className="flex flex-col gap-1 py-2 sm:flex-row sm:items-center sm:justify-between">
                  <span className="break-all text-ink">{t('photoItem', { name: photo.fileName })}</span>
                  <Button
                    variant="link"
                    className="min-h-11 self-start sm:self-center"
                    disabled={pending || uploading}
                    onClick={() => setPhotos((list) => list.filter((p) => p.fileId !== photo.fileId))}
                  >
                    {t('removePhoto', { name: photo.fileName })}
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
          {photoError ? <Notice tone="danger">{photoError}</Notice> : null}
        </div>
        <TextArea id={`${id}-notes`} label={t('notesLabel')} value={notes} maxLength={REASON_MAX_LENGTH} onChange={(event) => setNotes(event.currentTarget.value)} />
      </section>

      {formError ? <Notice tone="danger">{formError}</Notice> : null}
      {failure ? <Notice tone="danger">{failureText(failure)}</Notice> : null}
      <ReceiveBar step="enter" pending={pending} uploading={uploading} />
    </form>
  )
}

export interface ReceiveBarProps {
  /** enter: "check before recording"; review: "confirm the receipt" and the way back to the quantities */
  readonly step: 'enter' | 'review'
  /** The check or the receipt is on its way to the server */
  readonly pending: boolean
  /** A photo is still being uploaded: the receipt waits for it */
  readonly uploading: boolean
  readonly onBack?: () => void
}

/**
 * The main action of a step, at the bottom of a phone screen: its button works only when nothing is on its way — the
 * check or the receipt itself, or a photo of the receipt — and the bar says why when a photo holds it, above the buttons
 */
export function ReceiveBar({ step, pending, uploading, onBack }: ReceiveBarProps) {
  const t = useTranslations('receiving.form')
  const label = step === 'review' ? (pending ? t('posting') : t('confirm')) : pending ? t('checking') : t('toReview')
  return (
    <div className={barClass}>
      {uploading ? <Notice tone="info">{t('uploadWait')}</Notice> : null}
      <div className={barButtonsClass}>
        <Button type="submit" className="shrink-0" disabled={pending || uploading}>
          {label}
        </Button>
        {step === 'review' ? (
          <Button variant="secondary" className="shrink-0" onClick={onBack} disabled={pending}>
            {t('backToEnter')}
          </Button>
        ) : null}
      </div>
    </div>
  )
}

/** A field label that names its line for screen readers: lines with the same unit would otherwise share one name */
function LineLabel({ item, text }: { item: string; text: string }) {
  return (
    <>
      <span className="sr-only">{item}: </span>
      {text}
    </>
  )
}

function Figure({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex flex-col">
      <dt className="text-ink-muted">{label}</dt>
      <dd className={strong ? 'tabular font-semibold text-ink' : 'tabular text-ink'}>{value}</dd>
    </div>
  )
}

function Radio({ name, checked, onChange, label }: { name: string; checked: boolean; onChange: () => void; label: string }) {
  return (
    <label className="flex min-h-11 items-center gap-3">
      <input type="radio" name={name} checked={checked} onChange={onChange} className="size-5 shrink-0" />
      <span>{label}</span>
    </label>
  )
}

/** A sum of money in its own row: the label on the left, the amount right-aligned in tabular digits (§9.9 principle 6) */
function MoneyRow({ label, amount }: { label: string; amount: string }) {
  return (
    <p className="flex items-baseline justify-between gap-3 text-base sm:max-w-md md:text-sm">
      <span className="text-ink-muted">{label}</span>
      <span className="money shrink-0 text-ink">{amount}</span>
    </p>
  )
}

/** One decision the receiver makes on step 2: send back or replace (no approval), or keep with the approver named */
function ChoiceGroup({
  name,
  legend,
  amount,
  value,
  error,
  options,
  onChange,
  locale,
}: {
  name: string
  legend: string
  amount: ReactNode
  value: string | null
  error?: string
  options: ReadonlyArray<{ value: string; label: string; approver?: ApproverView }>
  onChange: (value: string) => void
  locale: string
}) {
  const errorId = `${name}-error`
  return (
    <fieldset className="flex flex-col gap-2" aria-describedby={error ? errorId : undefined}>
      <legend className="font-medium text-ink">{legend}</legend>
      {amount}
      {options.map((o) => {
        const blocked = o.approver?.kind === 'BLOCKED'
        // A tap target of at least 44 px (§9.4), the radio beside the first line of its words
        return (
          <label key={o.value} className={`flex min-h-11 gap-3 py-1 ${o.approver ? 'items-start' : 'items-center'}`}>
            <input
              type="radio"
              name={name}
              value={o.value}
              checked={value === o.value}
              disabled={blocked}
              onChange={() => onChange(o.value)}
              className={`size-5 shrink-0 ${o.approver ? 'mt-1' : ''}`}
            />
            <span className="flex flex-col">
              <span className="text-ink">{o.label}</span>
              {o.approver ? <ApproverText approver={o.approver} locale={locale} /> : null}
            </span>
          </label>
        )
      })}
      {error ? (
        <p id={errorId} className="text-base text-danger md:text-sm">
          <StateLine kind="overdue">{error}</StateLine>
        </p>
      ) : null}
    </fieldset>
  )
}
