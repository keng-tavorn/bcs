'use client'

import { CircleAlert } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { useId, useRef, useState, type ReactNode } from 'react'
import { parseQuantity } from '@/core/money/math'
import { formatQuantity, receiveIncrement } from '@/core/receiving'
import { checkDeclaredUpload } from '@/lib/file-types'
import { REASON_MAX_LENGTH } from '@/lib/constants'
import { newId } from '@/lib/ids'
import { Button } from '../form/button'
import { Field } from '../form/field'
import { Notice } from '../form/notice'
import { distinctPhotoName, prepareLiffPhoto } from '../liff/image-resize'
import { cleanQuantity, compareQuantity, isZeroQuantity } from '../receiving/quantity'
import type { DamagedChoice, ExcessChoice } from '../receiving/types'
import { Label } from '../shadcn/label'
import { RadioGroup, RadioGroupItem } from '../shadcn/radio-group'
import { Textarea } from '../shadcn/textarea'
import { writePhoto, type PoCopy, type PoLineCopy, type ReceiptLine, type ReceiptPayload, type StoredPhoto } from './store'

// The receipt of /go/receive (S17-13, FR-PLT-301 AC7, BR-APP-04): the fields of /liff/gr/[poId] in their words
// (receiving.form) — what came, what was refused and why, what to do with damaged goods and with an excess beyond the
// tolerance, the delivery note, notes and photos — on one step, since there may be no signal for the LIFF form's preview:
// the page works out from the copy what the server will ask (an excess beyond the tolerance of what is still on order,
// as receiveIncrement measures it; a photo for damaged goods; damaged goods kept within what is still to come). Prices
// are not on the phone, so nothing here shows an amount. The server checks everything again when the receipt goes; what
// it refuses comes back to the queue with why.

/** gr.post takes at most 20 photos (src/server/services/receiving/index.ts) */
const MAX_PHOTOS = 20

interface LineState {
  readonly received: string
  readonly rejected: string
  readonly refusing: boolean
  readonly damaged: boolean
  readonly remark: string
  readonly excess?: ExcessChoice
  readonly damagedChoice?: DamagedChoice
}

const EMPTY_LINE: LineState = { received: '', rejected: '', refusing: false, damaged: true, remark: '' }

/** Still on order and still to come of a line of the copy, ×10⁴ */
function standing(line: PoLineCopy): { onOrder: bigint; toCome: bigint; before: bigint } {
  const ordered = parseQuantity(line.ordered)
  const cancelled = parseQuantity(line.cancelled)
  const before = parseQuantity(line.received)
  const onOrder = ordered > cancelled ? ordered - cancelled : 0n
  return { onOrder, toCome: onOrder > before ? onOrder - before : 0n, before }
}

/** The excess beyond the tolerance the server will ask about, ×10⁴ (0 when none) */
export function excessOf(line: PoLineCopy, accepted: bigint, tolerancePct: number): bigint {
  const { onOrder, before } = standing(line)
  if (accepted <= 0n) return 0n
  if (onOrder === 0n) return accepted
  return receiveIncrement({ ordered: onOrder, unitPriceSatang: 0n, acceptedBefore: before, received: accepted, tolerancePct }).over?.quantity ?? 0n
}

function initialLines(copy: PoCopy, before: ReceiptPayload | null): Record<string, LineState> {
  return Object.fromEntries(
    copy.lines.map((l) => {
      const was = before?.lines.find((x) => x.poLineId === l.poLineId)
      if (!was) return [l.poLineId, EMPTY_LINE]
      const refusing = !isZeroQuantity(was.rejected)
      return [l.poLineId, { received: was.received, rejected: refusing ? was.rejected : '', refusing, damaged: refusing ? was.damagedDisposition !== undefined : true, remark: was.remark ?? '', ...(was.excessDisposition ? { excess: was.excessDisposition } : {}), ...(was.damagedDisposition ? { damagedChoice: was.damagedDisposition } : {}) }]
    }),
  )
}

export interface ReceiptFormProps {
  readonly copy: PoCopy
  /** What an earlier receipt of this PO said, when it is corrected */
  readonly before: { readonly payload: ReceiptPayload; readonly photos: readonly StoredPhoto[] } | null
  readonly onCancel: () => void
  readonly onSave: (payload: ReceiptPayload, photos: readonly StoredPhoto[]) => Promise<boolean>
}

export function ReceiptForm({ copy, before, onCancel, onSave }: ReceiptFormProps) {
  const t = useTranslations('receiving.form')
  const tErrors = useTranslations('receiving.errors')
  const tGo = useTranslations('goReceive.form')
  const id = useId()
  const camera = useRef<HTMLInputElement>(null)
  const [lines, setLines] = useState<Record<string, LineState>>(() => initialLines(copy, before?.payload ?? null))
  const [deliveryNoteNo, setDeliveryNoteNo] = useState(before?.payload.deliveryNoteNo ?? '')
  const [notes, setNotes] = useState(before?.payload.notes ?? '')
  const [photos, setPhotos] = useState<readonly StoredPhoto[]>(before?.photos ?? [])
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const update = (lineId: string, patch: Partial<LineState>) => setLines((all) => ({ ...all, [lineId]: { ...(all[lineId] ?? EMPTY_LINE), ...patch } }))

  async function addPhotos(files: FileList | null) {
    setProblem(null)
    for (const original of Array.from(files ?? [])) {
      if (photos.length >= MAX_PHOTOS) return setProblem(tGo('photoLimit', { count: MAX_PHOTOS }))
      // Made ready on the phone as on LINE: upright, at most 2,000 px, a JPEG without the camera's metadata
      const shrunk = await prepareLiffPhoto(original)
      if (!shrunk.ok || checkDeclaredUpload(shrunk.file.type, shrunk.file.size)) {
        setProblem(tGo('photoUnreadable'))
        continue
      }
      const localId = newId()
      const fileName = distinctPhotoName(shrunk.file.name, photos.map((p) => p.fileName))
      if (!(await writePhoto(localId, shrunk.file))) {
        setProblem(tGo('notKept'))
        continue
      }
      setPhotos((list) => [...list, { localId, fileName }])
    }
    if (camera.current) camera.current.value = ''
  }

  /** The lines as gr.post takes them, or the errors shown under the fields */
  function collect(): readonly ReceiptLine[] | null {
    const found: Record<string, string> = {}
    const out: ReceiptLine[] = []
    let damagedRefused = false
    for (const line of copy.lines) {
      const s = lines[line.poLineId] ?? EMPTY_LINE
      if (!s.received.trim()) continue
      const received = cleanQuantity(s.received)
      if (received === null) {
        found[`${line.poLineId}-received`] = t('fieldErrors.quantity')
        continue
      }
      const rejected = s.refusing && s.rejected.trim() ? cleanQuantity(s.rejected) : '0'
      if (rejected === null || compareQuantity(rejected, received) > 0) {
        found[`${line.poLineId}-rejected`] = rejected === null ? t('fieldErrors.quantity') : t('fieldErrors.rejectedTooMany')
        continue
      }
      if (isZeroQuantity(received)) continue
      const accepted = parseQuantity(received) - parseQuantity(rejected)
      const over = excessOf(line, accepted, copy.overTolerancePct) > 0n
      const damaged = s.refusing && s.damaged && !isZeroQuantity(rejected)
      if (over && !s.excess) found[`${line.poLineId}-excess`] = t('fieldErrors.choose')
      if (damaged && !s.damagedChoice) found[`${line.poLineId}-damaged`] = t('fieldErrors.choose')
      if (damaged && s.damagedChoice === 'ACCEPT_DAMAGED') {
        const { toCome } = standing(line)
        const keepable = toCome > accepted ? toCome - accepted : 0n
        if (parseQuantity(rejected) > keepable) found[`${line.poLineId}-damaged`] = tErrors('DAMAGED_BEYOND_ORDER', { keepable: formatQuantity(keepable) })
      }
      damagedRefused ||= damaged
      out.push({
        poLineId: line.poLineId,
        received,
        rejected,
        ...(s.refusing && s.remark.trim() ? { remark: s.remark.trim() } : {}),
        ...(over && s.excess ? { excessDisposition: s.excess } : {}),
        ...(damaged && s.damagedChoice ? { damagedDisposition: s.damagedChoice } : {}),
      })
    }
    if (damagedRefused && photos.length === 0) found.photos = t('fieldErrors.photo')
    setErrors(found)
    if (Object.keys(found).length) {
      setProblem(tGo('fixAbove'))
      return null
    }
    if (out.length === 0) {
      setProblem(t('fieldErrors.nothing'))
      return null
    }
    setProblem(null)
    return out
  }

  async function save() {
    const collected = collect()
    if (!collected) return
    setBusy(true)
    const kept = await onSave({ lines: collected, deliveryNoteNo: deliveryNoteNo.trim(), notes: notes.trim() }, photos)
    setBusy(false)
    if (!kept) setProblem(tGo('notKept'))
  }

  return (
    <section aria-labelledby={`${id}-title`} className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h2 id={`${id}-title`} className="text-lg font-semibold text-ink">
          {tGo('title', { number: copy.number ?? '' })}
        </h2>
        <p className="text-ink-muted">
          {copy.supplier}
          {copy.site ? ` · ${copy.site}` : ''}
        </p>
      </div>

      <ol className="flex flex-col divide-y divide-line border-y border-line">
        {copy.lines.map((line) => {
          const s = lines[line.poLineId] ?? EMPTY_LINE
          const { toCome } = standing(line)
          const received = cleanQuantity(s.received)
          const rejected = s.refusing && s.rejected.trim() ? cleanQuantity(s.rejected) : '0'
          const accepted = received !== null && rejected !== null ? parseQuantity(received) - parseQuantity(rejected) : 0n
          const excess = excessOf(line, accepted, copy.overTolerancePct)
          const damaged = s.refusing && s.damaged && rejected !== null && !isZeroQuantity(rejected)
          const base = `${id}-${line.poLineId}`
          return (
            <li key={line.poLineId} className="flex flex-col gap-3 py-4">
              <div className="flex flex-col gap-1">
                <p className="font-semibold break-words text-ink">{line.description}</p>
                <dl className="grid grid-cols-3 gap-2">
                  <Figure label={t('ordered')} value={t('quantity', { quantity: line.ordered, uom: line.uom })} />
                  <Figure label={t('receivedSoFar')} value={t('quantity', { quantity: line.received, uom: line.uom })} />
                  <Figure label={t('outstanding')} value={t('quantity', { quantity: formatQuantity(toCome), uom: line.uom })} strong />
                </dl>
                {toCome === 0n ? <p className="text-ink-muted">{t('lineDone')}</p> : null}
              </div>
              <Field
                id={`${base}-received`}
                label={<LineLabel item={line.description} text={t('receivedLabel', { uom: line.uom })} />}
                inputMode="decimal"
                autoComplete="off"
                value={s.received}
                onChange={(event) => update(line.poLineId, { received: event.currentTarget.value })}
                error={errors[`${line.poLineId}-received`]}
                className="tabular text-right"
              />
              {s.refusing ? (
                <div className="flex flex-col gap-3 border-l-2 border-line pl-3">
                  <Field
                    id={`${base}-rejected`}
                    label={<LineLabel item={line.description} text={t('rejectedLabel', { uom: line.uom })} />}
                    inputMode="decimal"
                    autoComplete="off"
                    value={s.rejected}
                    onChange={(event) => update(line.poLineId, { rejected: event.currentTarget.value })}
                    error={errors[`${line.poLineId}-rejected`]}
                    className="tabular text-right"
                  />
                  <Choice
                    id={`${base}-why`}
                    legend={<LineLabel item={line.description} text={t('whyLegend')} />}
                    value={s.damaged ? 'DAMAGED' : 'OTHER'}
                    choices={[
                      ['DAMAGED', t('whyDamaged')],
                      ['OTHER', t('whyOther')],
                    ]}
                    onChange={(v) => update(line.poLineId, { damaged: v === 'DAMAGED' })}
                  />
                  <Field
                    id={`${base}-remark`}
                    label={<LineLabel item={line.description} text={t('remarkLabel')} />}
                    value={s.remark}
                    maxLength={REASON_MAX_LENGTH}
                    onChange={(event) => update(line.poLineId, { remark: event.currentTarget.value })}
                  />
                  <Button variant="link" onClick={() => update(line.poLineId, { refusing: false, rejected: '', remark: '' })} className="min-h-11 self-start text-left">
                    {t('refuseClose', { description: line.description })}
                  </Button>
                </div>
              ) : (
                <Button variant="link" onClick={() => update(line.poLineId, { refusing: true })} className="min-h-11 self-start text-left">
                  {t('refuse', { description: line.description })}
                </Button>
              )}
              {excess > 0n ? (
                <Choice
                  id={`${base}-excess`}
                  legend={<LineLabel item={line.description} text={t('excessLegend', { quantity: formatQuantity(excess), uom: line.uom, pct: copy.overTolerancePct })} />}
                  value={s.excess ?? ''}
                  choices={[
                    ['RETURN_EXCESS', t('returnExcess')],
                    ['ACCEPT_EXCESS', t('keepExcess')],
                  ]}
                  onChange={(v) => update(line.poLineId, { excess: v as ExcessChoice })}
                  error={errors[`${line.poLineId}-excess`]}
                />
              ) : null}
              {damaged ? (
                <Choice
                  id={`${base}-damaged`}
                  legend={<LineLabel item={line.description} text={t('damagedLegend', { quantity: rejected ?? '0', uom: line.uom })} />}
                  value={s.damagedChoice ?? ''}
                  choices={[
                    ['RETURN_REPLACE', t('replaceDamaged')],
                    ['ACCEPT_DAMAGED', t('keepDamaged')],
                  ]}
                  onChange={(v) => update(line.poLineId, { damagedChoice: v as DamagedChoice })}
                  error={errors[`${line.poLineId}-damaged`]}
                />
              ) : null}
            </li>
          )
        })}
      </ol>

      <section aria-labelledby={`${id}-evidence`} className="flex flex-col gap-4">
        <h3 id={`${id}-evidence`} className="font-semibold text-ink">
          {t('evidenceTitle')}
        </h3>
        <Field id={`${id}-delivery-note`} label={t('deliveryNoteLabel')} hint={t('deliveryNoteHint')} maxLength={100} value={deliveryNoteNo} onChange={(event) => setDeliveryNoteNo(event.currentTarget.value)} />
        <div className="flex flex-col gap-2">
          <p id={`${id}-photos`} className="font-medium text-ink">
            {t('photosLabel')}
          </p>
          <p id={`${id}-photos-hint`} className="text-base text-ink-muted md:text-sm">
            {t('photosHint')}
          </p>
          <input ref={camera} id={`${id}-camera`} type="file" accept="image/*" capture="environment" multiple hidden aria-labelledby={`${id}-photos`} onChange={(event) => void addPhotos(event.currentTarget.files)} />
          <Button variant="secondary" className="self-start" aria-describedby={`${id}-photos-hint`} onClick={() => camera.current?.click()} disabled={busy}>
            {tGo('addPhoto')}
          </Button>
          {errors.photos ? <Notice tone="danger">{errors.photos}</Notice> : null}
          {photos.length ? (
            <ul className="flex flex-col gap-1" aria-labelledby={`${id}-photos`}>
              {photos.map((p) => (
                <li key={p.localId} className="flex flex-wrap items-center justify-between gap-2">
                  <span className="break-all text-ink">{t('photoItem', { name: p.fileName })}</span>
                  <Button variant="link" onClick={() => setPhotos((list) => list.filter((x) => x.localId !== p.localId))}>
                    {t('removePhoto', { name: p.fileName })}
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-notes`} className="font-medium text-ink">
            {t('notesLabel')}
          </Label>
          <Textarea id={`${id}-notes`} value={notes} maxLength={REASON_MAX_LENGTH} onChange={(event) => setNotes(event.currentTarget.value)} className="min-h-24 text-base" />
        </div>
      </section>

      {problem ? <Notice tone="danger">{problem}</Notice> : null}
      <div className="flex flex-wrap gap-3">
        <Button onClick={() => void save()} disabled={busy}>
          {tGo('save')}
        </Button>
        <Button variant="secondary" onClick={onCancel} disabled={busy}>
          {tGo('cancel')}
        </Button>
      </div>
    </section>
  )
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

function Choice({ id, legend, value, choices, onChange, error }: { readonly id: string; readonly legend: ReactNode; readonly value: string; readonly choices: ReadonlyArray<readonly [string, string]>; readonly onChange: (value: string) => void; readonly error?: string | undefined }) {
  return (
    <fieldset className="flex flex-col gap-1">
      <legend id={`${id}-legend`} className="font-medium text-ink">
        {legend}
      </legend>
      <RadioGroup value={value} onValueChange={onChange} aria-labelledby={`${id}-legend`} aria-invalid={error ? true : undefined} aria-describedby={error ? `${id}-error` : undefined} className="gap-1">
        {choices.map(([v, label]) => (
          <label key={v} htmlFor={`${id}-${v}`} className="flex min-h-11 cursor-pointer items-center gap-3">
            <RadioGroupItem id={`${id}-${v}`} value={v} className="size-5" />
            <span>{label}</span>
          </label>
        ))}
      </RadioGroup>
      {error ? (
        <p id={`${id}-error`} className="flex items-start gap-1.5 text-base text-danger md:text-sm">
          <CircleAlert className="mt-1 size-4 shrink-0" aria-hidden="true" />
          <span>{error}</span>
        </p>
      ) : null}
    </fieldset>
  )
}
