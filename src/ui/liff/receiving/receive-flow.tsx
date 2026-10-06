'use client'

import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { REASON_MAX_LENGTH } from '@/lib/constants'
import type { FileRefusal } from '../../files/file-upload'
import { NO_ANSWER, type ReceivingAction } from '../../receiving/failed'
import type { PostOutcome, PreviewOutcome, ReceivingFailure } from '../../receiving/outcome'
import { cleanQuantity, compareQuantity, isZeroQuantity } from '../../receiving/quantity'
import type { DamagedChoice, ExcessChoice, ReceiptInput, ReceiptPreviewView, ReceiveLineView } from '../../receiving/types'
import { LiffActionBar } from '../action-bar'
import { Button } from '../button'
import { LiffContent } from '../content'
import { useLiff } from '../liff-provider'
import { LiffNotice } from '../notice'
import { useLiffSubmissionKey } from '../submission-key'
import { liffFailureText } from './failure-text'
import { LiffField, LiffRadio, LiffTextArea } from './fields'
import type { LiffCompleteUpload, LiffRequestUpload } from './photo-upload'
import { LiffPhotos, type LiffPhoto, type LiffPhotoStatus } from './photos'
import type { LiffReceiptReview } from './review'
import { openPhotoSendWindow, untilAborted, type PhotoSendWindow } from './send-window'
import { useSessionReady } from './session-ready'

// Receiving a PO on site in the LINE app (/liff/gr/[poId], §9.4, FR-LINE-003 AC3, FR-P2P-006, FR-P2P-007, demo scene
// 8): the same two real steps and the same receive command as the workspace's page (src/ui/receiving/receive-form.tsx,
// gr.post through src/app/(workspace)/receiving/commands.ts), on channel LIFF and built for a phone in LINE — one
// column, 16 px text, 44 px targets, the step's main button in the bar at the bottom of the screen (§9.4, §9.9 principle
// 5). (1) What came: the quantity per line, what was refused and why, the delivery note, photos from the camera
// (./photos.tsx shrinks each in the phone before the presigned upload) and notes. (2) What will happen, calculated by
// the server before anything is written (§9.9 principle 3): what is accepted, the PO's status after, and for an excess
// beyond the tolerance or damaged goods the receiver's choice. Confirming posts the receipt; it cannot be undone by the
// receiver, so step 2 is the confirmation (§9.9): its button works only once step 2 is on the screen. Then the PO's
// status after it, while the page's own server part shows the receipt with its photos (the page refreshes).
//
// A photo still being made ready or sent holds the receipt: neither step's button works until it is recorded, and the
// bar says why — the receipt never goes without a photo the receiver took (a site's mobile network can be slow). The
// send has a time limit and the bar offers to stop it (./send-window.ts), so a stalled network never locks the page;
// while the receipt is being checked or posted the camera takes no photo. The flow owns the send and what became of it
// (./photos.tsx only shows it), so a refusal is never lost when step 1 leaves the screen: step 2's bar says it. The
// flow also owns the photos and their small pictures (object URLs), so going back from step 2 shows them again; they are
// freed when a photo is taken out, when the next delivery starts and when the page goes. Step 2's part is loaded only
// when needed (./review.tsx: the first screen carries little JavaScript, §9.4: 200 KB gzip): fetched in the background
// at the receiver's first entry, and when it cannot be fetched (no signal) the flow says so, keeps what was entered and
// offers to try again. Who may receive is decided by the service on every action (gr.post with BR-SOD-02 and BR-SOD-07):
// the page only shows the form to a member it may serve. Before every server action the LIFF session is renewed when it
// is close to its idle limit, and nothing is sent once it has ended (./session-ready.ts); the button shows the action
// is under way from the tap. A refusal, or no answer at all (the signal drops), is said in the bar in the words of the
// step it came from (./failure-text.ts): a check that failed has recorded nothing, a receipt that failed was not recorded.
// The component stays mounted while the page refreshes, so its confirmation stays on screen.

type ReviewPart = typeof LiffReceiptReview

export interface LiffReceiveActions {
  readonly preview: (input: Omit<ReceiptInput, 'deliveryNoteNo' | 'notes'>, idempotencyKey: string) => Promise<PreviewOutcome>
  readonly post: (input: ReceiptInput, idempotencyKey: string) => Promise<PostOutcome>
  readonly requestUpload: LiffRequestUpload
  readonly completeUpload: LiffCompleteUpload
}

export interface LiffReceiveFlowProps {
  readonly poId: string
  readonly lines: readonly ReceiveLineView[]
  /** The PO takes goods now and the member may post them */
  readonly open: boolean
  /** Which PO: its status, supplier, site and requests (rendered by the server) */
  readonly summary: ReactNode
  /** Messages about the PO that hold whatever the step (a close-short waiting for approval) */
  readonly notices?: ReactNode
  /** When the PO takes no goods now: why, and its lines (rendered by the server) */
  readonly closed?: ReactNode
  /** The receipts so far with their photos (rendered by the server, refreshed after a receipt) */
  readonly history: ReactNode
  readonly actions: LiffReceiveActions
}

interface LineState {
  readonly received: string
  readonly rejected: string
  readonly damaged: boolean
  readonly remark: string
  readonly refusing: boolean
}

type LineErrors = Partial<Record<'received' | 'rejected', string>>
export type Choices = Readonly<Record<string, { readonly excess?: ExcessChoice; readonly damaged?: DamagedChoice }>>
type Posted = Extract<PostOutcome, { ok: true }>
type Step = 'enter' | 'review' | 'done'

const EMPTY_LINE: LineState = { received: '', rejected: '', damaged: true, remark: '', refusing: false }
const IDLE: LiffPhotoStatus = { kind: 'idle' }

const REFUSAL_KEYS: Readonly<Record<FileRefusal, 'typeNotAllowed' | 'tooLarge' | 'empty' | 'contentMismatch' | 'failed'>> = {
  TYPE_NOT_ALLOWED: 'typeNotAllowed',
  TOO_LARGE: 'tooLarge',
  EMPTY: 'empty',
  CONTENT_MISMATCH: 'contentMismatch',
  FAILED: 'failed',
}

/** A field label that names its line for screen readers: lines with the same unit would otherwise share one name */
function LineLabel({ item, text }: { readonly item: string; readonly text: string }) {
  return (
    <>
      <span className="sr-only">{item}: </span>
      {text}
    </>
  )
}

function Figure({ label, value, strong }: { readonly label: string; readonly value: string; readonly strong?: boolean }) {
  return (
    <div className="flex flex-col">
      <dt className="text-ink-muted">{label}</dt>
      <dd className={strong ? 'tabular font-semibold text-ink' : 'tabular text-ink'}>{value}</dd>
    </div>
  )
}

export function LiffReceiveFlow({ poId, lines, open, summary, notices = null, closed = null, history, actions }: LiffReceiveFlowProps) {
  const t = useTranslations('receiving.form')
  const tStatus = useTranslations('receiving.status.po')
  const tErrors = useTranslations('receiving.errors')
  const tLiff = useTranslations('liffReceiving')
  const tPhotos = useTranslations('liffReceiving.photos')
  const tFiles = useTranslations('files')
  const liff = useLiff()
  const router = useRouter()
  const id = useId()
  const formId = `${id}-form`
  const cameraId = `${id}-camera`
  const submission = useLiffSubmissionKey()
  const check = useLiffSubmissionKey()

  const [state, setState] = useState<Readonly<Record<string, LineState>>>({})
  const [deliveryNoteNo, setDeliveryNoteNo] = useState('')
  const [notes, setNotes] = useState('')
  const [photos, setPhotos] = useState<readonly LiffPhoto[]>([])
  /** The photo being made ready or sent (the receipt waits for it), or how the last one ended */
  const [photoStatus, setPhotoStatus] = useState<LiffPhotoStatus>(IDLE)
  /** The send under way, one at a time: its time limit and its stop */
  const photoSend = useRef<PhotoSendWindow | null>(null)
  const photoBusy = photoStatus.kind === 'preparing' || photoStatus.kind === 'sending'
  const [step, setStep] = useState<Step>('enter')
  const [preview, setPreview] = useState<ReceiptPreviewView | null>(null)
  const [choices, setChoices] = useState<Choices>({})
  const [lineErrors, setLineErrors] = useState<Readonly<Record<string, LineErrors>>>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [photoError, setPhotoError] = useState<string | null>(null)
  const [choiceErrors, setChoiceErrors] = useState<ReadonlySet<string>>(new Set())
  /** What the server refused, in words */
  const [failure, setFailure] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [posted, setPosted] = useState<Posted | null>(null)
  /** Step 2's part once it is loaded, and whether loading it failed */
  const [review, setReview] = useState<{ readonly Part: ReviewPart } | null>(null)
  const [reviewFailed, setReviewFailed] = useState(false)
  const reviewLoading = useRef<Promise<void> | null>(null)
  const stepHeading = useRef<HTMLHeadingElement | null>(null)
  const moved = useRef(false)
  /** The field that gets the focus once its error is on the screen */
  const focusNext = useRef<string | null>(null)
  /** The small pictures of the photos (object URLs), freed by the flow */
  const previews = useRef(new Set<string>())
  const alive = useRef(true)

  const sessionEnded = useCallback(() => setFailure(tLiff('sessionEnded')), [tLiff])
  const ready = useSessionReady(sessionEnded)
  /**
   * A refusal of the check or of the receipt, or no answer, in words of that step (./failure-text.ts): the mapping of
   * error codes to messages is loaded only when a refusal comes
   */
  async function refuse(outcome: ReceivingFailure, action: ReceivingAction) {
    setFailure(await liffFailureText(outcome, action, { error: (key, values) => tErrors(key, values), sessionEnded: () => tLiff('sessionEnded') }))
  }

  /** Fetches step 2's part once (again after a failure); nothing happens while it is on its way or once it is here */
  const loadReview = useCallback(() => {
    if (reviewLoading.current) return
    setReviewFailed(false)
    reviewLoading.current = import('./review').then(
      (m) => setReview({ Part: m.LiffReceiptReview }),
      () => {
        reviewLoading.current = null
        setReviewFailed(true)
      },
    )
  }, [])

  // The small pictures go with the page, and a photo still on its way stops
  useEffect(() => {
    alive.current = true
    const live = previews.current
    const sending = photoSend
    return () => {
      alive.current = false
      sending.current?.stop()
      for (const url of live) URL.revokeObjectURL(url)
      live.clear()
    }
  }, [])

  // A new step starts at its heading: the bar's button is at the bottom, the step's first words at the top
  useEffect(() => {
    if (!moved.current) return
    moved.current = false
    stepHeading.current?.focus()
    stepHeading.current?.scrollIntoView({ block: 'start' })
  }, [step])
  // The first field to fix gets the focus once its error is on the screen (aria-invalid and the error read with it)
  useEffect(() => {
    const target = focusNext.current
    if (!target) return
    focusNext.current = null
    document.getElementById(target)?.focus()
  })
  const goTo = (next: Step) => {
    moved.current = true
    setStep(next)
  }

  const lineOf = (lineId: string): LineState => state[lineId] ?? EMPTY_LINE
  function update(lineId: string, patch: Partial<LineState>) {
    // Step 2's part comes while the receiver types, before the signal can drop
    loadReview()
    setState((s) => ({ ...s, [lineId]: { ...(s[lineId] ?? EMPTY_LINE), ...patch } }))
    // An error goes as soon as its field is being fixed
    setLineErrors((e) => ({ ...e, [lineId]: {} }))
    setFormError(null)
    setFailure(null)
  }

  /**
   * The photo the camera gave: made ready and sent (./photo-upload.ts, fetched now), one at a time, within its time and
   * until the receiver stops it (./send-window.ts — loading the photo code counts in it too). Not while the receipt is
   * being checked or posted: the camera is off then.
   */
  async function takePhoto(original: File) {
    if (photoSend.current || pending) return
    const send = openPhotoSendWindow()
    photoSend.current = send
    // Step 2's part comes while the photo is made ready, before the signal can drop
    loadReview()
    setPhotoStatus({ kind: 'preparing' })
    let outcome: LiffPhotoStatus
    try {
      const { uploadLiffPhoto } = await untilAborted(import('./photo-upload'), send.signal)
      const sent = await uploadLiffPhoto(original, {
        taken: photos.map((p) => p.fileName),
        ready,
        requestUpload: actions.requestUpload,
        completeUpload: actions.completeUpload,
        onSending: (name) => alive.current && setPhotoStatus({ kind: 'sending', name }),
        onSessionEnded: sessionEnded,
        window: send,
      })
      if (sent.ok) {
        addPhoto(sent.fileId, sent.fileName, sent.file)
        outcome = { kind: 'added', name: sent.fileName }
      } else if (sent.reason === 'NOT_SENT') {
        // Stopped by the receiver; or the session ended, which the bar says
        outcome = send.signal.aborted ? { kind: 'stopped' } : IDLE
      } else {
        outcome = { kind: 'refused', text: sent.reason === 'UNREADABLE' ? tPhotos('unreadable') : tFiles(REFUSAL_KEYS[sent.reason]) }
      }
    } catch {
      // The photo code could not be fetched or the send broke off: out of time is a failure, a stop is just a stop
      outcome = send.signal.aborted && !send.timedOut() ? { kind: 'stopped' } : { kind: 'refused', text: tFiles('failed') }
    } finally {
      send.close()
      if (photoSend.current === send) photoSend.current = null
    }
    if (alive.current) setPhotoStatus(outcome)
  }

  function addPhoto(fileId: string, fileName: string, file: File) {
    // The page went while the photo was on its way: there is nothing to show it in
    if (!alive.current) return
    const picture = URL.createObjectURL(file)
    previews.current.add(picture)
    setPhotos((list) => [...list, { fileId, fileName, preview: picture }])
    setPhotoError(null)
  }

  function removePhoto(fileId: string) {
    const photo = photos.find((p) => p.fileId === fileId)
    if (photo) {
      URL.revokeObjectURL(photo.preview)
      previews.current.delete(photo.preview)
    }
    setPhotos((list) => list.filter((p) => p.fileId !== fileId))
  }

  /** The lines of this receipt as the server takes them, or the errors to show (the first wrong field gets focus) */
  function collect(): { ok: true; lines: ReceiptInput['lines'] } | { ok: false } {
    const errors: Record<string, LineErrors> = {}
    const out: Array<ReceiptInput['lines'][number]> = []
    let damagedRefused = false
    let first: string | null = null
    for (const line of lines) {
      const s = lineOf(line.id)
      if (!s.received.trim()) continue
      const received = cleanQuantity(s.received)
      if (received === null) {
        errors[line.id] = { received: t('fieldErrors.quantity') }
        first ??= `${id}-${line.id}-received`
        continue
      }
      const rejected = s.refusing && s.rejected.trim() ? cleanQuantity(s.rejected) : '0'
      if (rejected === null || compareQuantity(rejected, received) > 0) {
        errors[line.id] = { rejected: rejected === null ? t('fieldErrors.quantity') : t('fieldErrors.rejectedTooMany') }
        first ??= `${id}-${line.id}-rejected`
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
    if (photoMissing) first ??= cameraId
    const nothing = Object.keys(errors).length === 0 && out.length === 0
    setFormError(nothing ? t('fieldErrors.nothing') : Object.keys(errors).length || photoMissing ? tLiff('fixAbove') : null)
    focusNext.current = first
    if (Object.keys(errors).length || photoMissing || nothing) return { ok: false }
    return { ok: true, lines: out }
  }

  async function onReview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    // A photo on its way belongs to this receipt: the check waits for it (the button says so)
    if (pending || photoBusy || photoSend.current) return
    setFailure(null)
    const collected = collect()
    if (!collected.ok) return
    loadReview()
    setPending(true)
    if (!(await ready())) return setPending(false)
    let outcome: PreviewOutcome
    try {
      outcome = await actions.preview({ poId, photoFileIds: photos.map((p) => p.fileId), lines: collected.lines }, check.key)
      check.next()
    } catch {
      // No answer: the key stays, so pressing again is the same check (spec §4.3); nothing has been recorded
      outcome = NO_ANSWER
    }
    setPending(false)
    if (!outcome.ok) return refuse(outcome, 'check')
    setPreview(outcome.preview)
    setChoiceErrors(new Set())
    // What step 1 said about the last photo stays with step 1: a refusal step 2's bar shows is one that came after
    setPhotoStatus(IDLE)
    goTo('review')
  }

  async function onConfirm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    // Step 2 is the confirmation: nothing is posted before the receiver has seen it, nor without a photo on its way
    if (!preview || !review || pending || photoBusy || photoSend.current) return
    // Every excess and every damaged line needs the receiver's choice (BR-GR-03)
    const missing = new Set<string>()
    for (const l of preview.lines) {
      if (l.excess && !choices[l.poLineId]?.excess) missing.add(`${l.poLineId}:excess`)
      if (l.damaged && !choices[l.poLineId]?.damaged) missing.add(`${l.poLineId}:damaged`)
    }
    setChoiceErrors(missing)
    setFormError(missing.size ? tLiff('fixAbove') : null)
    if (missing.size) {
      const [first] = missing
      focusNext.current = first ? `${id}-${first.replace(':', '-')}-choice` : null
      return
    }
    const collected = collect()
    if (!collected.ok) return goTo('enter')
    setPending(true)
    setFailure(null)
    if (!(await ready())) return setPending(false)
    let outcome: PostOutcome
    try {
      outcome = await actions.post({ poId, deliveryNoteNo, notes, photoFileIds: photos.map((p) => p.fileId), lines: collected.lines }, submission.key)
      submission.next()
    } catch {
      // No answer: the key stays, so trying again is the same submission (spec §4.3)
      outcome = NO_ANSWER
    }
    setPending(false)
    if (!outcome.ok) {
      // What the server found wrong is fixed on step 1, then checked again (the PO may have moved since the preview)
      if (outcome.code === 'VALIDATION_FAILED') goTo('enter')
      return refuse(outcome, 'record')
    }
    setPosted(outcome)
    goTo('done')
    router.refresh()
  }

  function startAgain() {
    photoSend.current?.stop()
    for (const url of previews.current) URL.revokeObjectURL(url)
    previews.current.clear()
    setState({})
    setDeliveryNoteNo('')
    setNotes('')
    setPhotos([])
    setPhotoStatus(IDLE)
    setChoices({})
    setPreview(null)
    setPosted(null)
    setFailure(null)
    setFormError(null)
    setPhotoError(null)
    setLineErrors({})
    goTo('enter')
  }

  if (step === 'done' && posted) {
    const closeChat = liff.inClient && !liff.mocked
    return (
      <>
        <LiffContent>
          {summary}
          <section aria-labelledby={`${id}-done`} className="flex flex-col gap-3">
            <LiffNotice tone="success">
              {/* An h2 at the size of the step headings it replaces and of "การตรวจรับที่ผ่านมา" (18 px, §9.9) */}
              <h2 id={`${id}-done`} ref={stepHeading} tabIndex={-1} className="text-lg font-semibold">
                {t('doneTitle', { number: posted.number })}
              </h2>
              <p>{t('donePo', { status: tStatus(posted.poStatus === 'RECEIVED' ? 'RECEIVED' : 'PARTIALLY_RECEIVED') })}</p>
              {posted.pendingApproval > 0 ? <p>{t('donePending', { count: posted.pendingApproval })}</p> : null}
            </LiffNotice>
          </section>
          {notices}
          {history}
        </LiffContent>
        {open || closeChat ? (
          <LiffActionBar label={tLiff('nextLabel')}>
            {open ? (
              <Button variant="secondary" className="w-full" onClick={startAgain}>
                {t('again')}
              </Button>
            ) : null}
            {closeChat ? (
              <Button variant="secondary" className="w-full" onClick={liff.closeWindow}>
                {tLiff('closeChat')}
              </Button>
            ) : null}
          </LiffActionBar>
        ) : null}
      </>
    )
  }

  if (!open) {
    return (
      <LiffContent>
        {summary}
        {notices}
        {closed}
        {history}
      </LiffContent>
    )
  }

  const reviewing = step === 'review' && preview !== null
  const Review = review?.Part ?? null
  return (
    <>
      <LiffContent>
        {summary}
        {notices}
        {reviewing ? (
          <form id={formId} onSubmit={onConfirm} noValidate aria-labelledby={`${id}-review`} className="flex flex-col gap-5">
            <div className="flex flex-col gap-1">
              <p className="text-ink-muted">{t('step', { step: 2 })}</p>
              <h2 id={`${id}-review`} ref={stepHeading} tabIndex={-1} className="text-lg font-semibold text-ink">
                {t('reviewTitle')}
              </h2>
              <p className="text-ink-muted">{t('reviewHint')}</p>
            </div>
            {Review ? (
              <Review
                namePrefix={id}
                preview={preview}
                choices={choices}
                choiceErrors={choiceErrors}
                onChoose={(poLineId, kind, value) => {
                  setChoices((c) => ({ ...c, [poLineId]: { ...c[poLineId], [kind]: value } }))
                  setChoiceErrors((e) => new Set([...e].filter((k) => k !== `${poLineId}:${kind}`)))
                  setFormError(null)
                }}
                evidence={{ deliveryNoteNo: deliveryNoteNo.trim(), photoCount: photos.length, notes: notes.trim() }}
              />
            ) : reviewFailed ? (
              <div className="flex flex-col gap-3">
                <LiffNotice tone="danger">{tLiff('reviewFailed')}</LiffNotice>
                <Button variant="secondary" className="w-full" onClick={loadReview}>
                  {tLiff('reviewRetry')}
                </Button>
              </div>
            ) : (
              <p role="status">{t('checking')}</p>
            )}
          </form>
        ) : (
          <form id={formId} onSubmit={onReview} noValidate aria-labelledby={`${id}-enter`} className="flex flex-col gap-5">
            <div className="flex flex-col gap-1">
              <p className="text-ink-muted">{t('step', { step: 1 })}</p>
              <h2 id={`${id}-enter`} ref={stepHeading} tabIndex={-1} className="text-lg font-semibold text-ink">
                {t('enterTitle')}
              </h2>
              <p className="text-ink-muted">{t('enterHint')}</p>
            </div>

            <ol className="flex flex-col divide-y divide-line border-y border-line">
              {lines.map((line) => {
                const s = lineOf(line.id)
                const errors = lineErrors[line.id] ?? {}
                const nothingLeft = isZeroQuantity(cleanQuantity(line.outstanding) ?? '0')
                return (
                  <li key={line.id} className="flex flex-col gap-3 py-4">
                    <div className="flex flex-col gap-1">
                      <p className="font-semibold break-words text-ink">{line.description}</p>
                      <dl className="grid grid-cols-3 gap-2">
                        <Figure label={t('ordered')} value={t('quantity', { quantity: line.ordered, uom: line.uom })} />
                        <Figure label={t('receivedSoFar')} value={t('quantity', { quantity: line.received, uom: line.uom })} />
                        <Figure label={t('outstanding')} value={t('quantity', { quantity: line.outstanding, uom: line.uom })} strong />
                      </dl>
                      {line.cancelled ? <p className="text-ink-muted">{t('cancelledNote', { quantity: line.cancelled, uom: line.uom })}</p> : null}
                      {line.keepPending ? <p className="text-ink-muted">{t('keepPendingNote', { quantity: line.keepPending, uom: line.uom })}</p> : null}
                      {nothingLeft ? <p className="text-ink-muted">{t('lineDone')}</p> : null}
                    </div>
                    <LiffField
                      id={`${id}-${line.id}-received`}
                      label={<LineLabel item={line.description} text={t('receivedLabel', { uom: line.uom })} />}
                      inputMode="decimal"
                      autoComplete="off"
                      value={s.received}
                      onChange={(event) => update(line.id, { received: event.currentTarget.value })}
                      error={errors.received}
                      className="tabular text-right"
                    />
                    {s.refusing ? (
                      <div className="flex flex-col gap-3 border-l-2 border-line pl-3">
                        <LiffField
                          id={`${id}-${line.id}-rejected`}
                          label={<LineLabel item={line.description} text={t('rejectedLabel', { uom: line.uom })} />}
                          inputMode="decimal"
                          autoComplete="off"
                          value={s.rejected}
                          onChange={(event) => update(line.id, { rejected: event.currentTarget.value })}
                          error={errors.rejected}
                          className="tabular text-right"
                        />
                        <fieldset className="flex flex-col gap-1">
                          <legend className="font-medium text-ink">
                            <LineLabel item={line.description} text={t('whyLegend')} />
                          </legend>
                          <LiffRadio name={`${id}-${line.id}-why`} checked={s.damaged} onChange={() => update(line.id, { damaged: true })} label={t('whyDamaged')} />
                          <LiffRadio name={`${id}-${line.id}-why`} checked={!s.damaged} onChange={() => update(line.id, { damaged: false })} label={t('whyOther')} />
                        </fieldset>
                        <LiffField
                          id={`${id}-${line.id}-remark`}
                          label={<LineLabel item={line.description} text={t('remarkLabel')} />}
                          value={s.remark}
                          maxLength={REASON_MAX_LENGTH}
                          onChange={(event) => update(line.id, { remark: event.currentTarget.value })}
                        />
                        <Button variant="link" onClick={() => update(line.id, { refusing: false, rejected: '', remark: '' })} className="min-h-11 self-start text-left">
                          {t('refuseClose', { description: line.description })}
                        </Button>
                      </div>
                    ) : (
                      <Button variant="link" onClick={() => update(line.id, { refusing: true })} className="min-h-11 self-start text-left">
                        {t('refuse', { description: line.description })}
                      </Button>
                    )}
                  </li>
                )
              })}
            </ol>

            <section aria-labelledby={`${id}-evidence`} className="flex flex-col gap-4">
              <h3 id={`${id}-evidence`} className="font-semibold text-ink">
                {t('evidenceTitle')}
              </h3>
              <LiffField
                id={`${id}-delivery-note`}
                label={t('deliveryNoteLabel')}
                hint={t('deliveryNoteHint')}
                autoComplete="off"
                maxLength={100}
                value={deliveryNoteNo}
                onChange={(event) => setDeliveryNoteNo(event.currentTarget.value)}
              />
              <LiffPhotos
                inputId={cameraId}
                photos={photos}
                status={photoStatus}
                busy={photoBusy || pending}
                onTake={(file) => void takePhoto(file)}
                onRemove={removePhoto}
                error={photoError}
              />
              <LiffTextArea id={`${id}-notes`} label={t('notesLabel')} value={notes} maxLength={REASON_MAX_LENGTH} onChange={(event) => setNotes(event.currentTarget.value)} />
            </section>
          </form>
        )}
        {history}
      </LiffContent>
      <LiffActionBar label={tLiff('barLabel')}>
        {photoBusy ? <LiffNotice tone="info">{tLiff('photoWait')}</LiffNotice> : null}
        {/* Step 1 shows it at the camera; once step 1 has left, a photo that was refused is said here */}
        {reviewing && photoStatus.kind === 'refused' ? <LiffNotice tone="danger">{tLiff('photoRefusedLate', { reason: photoStatus.text })}</LiffNotice> : null}
        {formError ? <LiffNotice tone="danger">{formError}</LiffNotice> : null}
        {failure ? <LiffNotice tone="danger">{failure}</LiffNotice> : null}
        <Button type="submit" form={formId} className="w-full" disabled={pending || photoBusy || (reviewing && !Review)}>
          {reviewing ? (pending ? t('posting') : t('confirm')) : pending ? t('checking') : t('toReview')}
        </Button>
        {photoBusy ? (
          <Button variant="secondary" className="w-full" onClick={() => photoSend.current?.stop()}>
            {tPhotos('stop')}
          </Button>
        ) : null}
        {reviewing ? (
          <Button
            variant="secondary"
            className="w-full"
            disabled={pending}
            onClick={() => {
              setFailure(null)
              setFormError(null)
              goTo('enter')
            }}
          >
            {t('backToEnter')}
          </Button>
        ) : null}
      </LiffActionBar>
    </>
  )
}
