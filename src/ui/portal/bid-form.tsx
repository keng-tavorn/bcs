'use client'

import { useRef, useState } from 'react'
import { amountToSatang } from '@/core/money/dto'
import { formatSatang } from '@/core/money/format'
import { compareBids } from '@/core/sourcing/compare'
import { RFX_CURRENCY, RFX_QUESTION_MAX } from '@/lib/constants'
import { Button } from '../liff/button'
import { LiffNotice } from '../liff/notice'
import { checkboxClass, inputClass, textareaClass } from '../liff/requests/classes'

// The bid form of the portal (S10-07 · BR-RFX-07 08 · docs/sub-specs/S10.md "/portal/rfx/[id]/bid"): one form shown a
// step at a time — the prices of the lines (a few lines a step, the VAT flag on the first when the RFx takes prices
// with VAT, "not offered" when it takes partial bids, THB fixed), the delivery and a note, the files, then a review with
// the amounts bid.submit will compute (compareBids with the rate of today) and the button that sends it. Every value
// stays in the one form, so a bid already sent is edited and sent again without ever turning back into a draft (a sent
// bid stays the one that counts until the next is sent · BR-RFX-07); a draft can be saved on the way. Files go up and
// come off with fetch and Accept: application/json, so the prices on the page stay. At most 8 fields a step; the main
// button sticks to the bottom of the screen. Words come translated from the page (the contact's locale); none of the
// workspace's components (ADR-052).

export interface BidFormLine {
  readonly id: string
  readonly lineNo: number
  readonly description: string
  readonly quantity: string
  readonly uom: string
  readonly unitPrice: string
  readonly notOffered: boolean
}

export interface BidFormFile {
  readonly id: string
  readonly fileName: string
  readonly scanStatus: string
}

export interface BidFormWords {
  readonly stepOf: string
  readonly steps: { readonly prices: string; readonly terms: string; readonly files: string; readonly review: string; readonly answer: string }
  readonly unitPrice: string
  readonly quantity: string
  readonly currency: string
  readonly notOffered: string
  readonly vatIncluded: string
  readonly vatIncludedHint: string
  readonly priceInvalid: string
  readonly deliveryDays: string
  readonly promisedDeliveryOn: string
  readonly note: string
  readonly answer: string
  readonly validity: string
  readonly filesHint: string
  readonly fileChoose: string
  readonly fileUpload: string
  readonly fileUploading: string
  readonly fileRemove: string
  readonly fileNone: string
  readonly scan: Readonly<Record<string, string>>
  readonly fileError: string
  readonly fileErrors: Readonly<Record<string, string>>
  readonly lineAmount: string
  readonly net: string
  readonly vat: string
  readonly gross: string
  readonly vatNotRegistered: string
  readonly vatRateMissing: string
  readonly missing: string
  readonly noPrice: string
  readonly back: string
  readonly next: string
  readonly saveDraft: string
  readonly submit: string
  readonly submitAgain: string
  readonly actions: string
}

export interface BidFormProps {
  readonly action: string
  readonly fileAction: string
  readonly csrf: string
  readonly rfxEventId: string
  readonly rfi: boolean
  readonly bidId: string | null
  readonly version: number | null
  /** The bid was sent: it can be sent again, not saved as a draft (bid.save does not take a sent bid) */
  readonly sent: boolean
  readonly allowPartial: boolean
  readonly vatInclusiveAllowed: boolean
  readonly priceIncludesVat: boolean
  /** 0 when the supplier is not registered or abroad; null when no rate covers today */
  readonly vatRateBp: number | null
  readonly lines: readonly BidFormLine[]
  readonly deliveryDays: string
  readonly promisedDeliveryOn: string
  readonly note: string
  readonly files: readonly BidFormFile[]
  readonly words: BidFormWords
}

const MONEY = /^\d{1,13}(\.\d{1,2})?$/
const MAX_FIELDS = 8
const fill = (text: string, values: Readonly<Record<string, string | number>>) => text.replace(/\{(\w+)\}/g, (_, k: string) => String(values[k] ?? ''))
const cleanPrice = (v: string) => v.trim().replaceAll(',', '')

type Step = { readonly kind: 'prices'; readonly lines: readonly BidFormLine[]; readonly first: boolean } | { readonly kind: 'terms' | 'files' | 'review' | 'answer' }

export function BidForm(props: BidFormProps) {
  const { words: w } = props
  const vatField = props.vatInclusiveAllowed ? 1 : 0
  // a line is its price, and "not offered" when the RFx takes partial bids; the VAT flag rides on the first step
  const perLine = props.allowPartial ? 2 : 1
  const steps: Step[] = []
  if (props.rfi) steps.push({ kind: 'answer' })
  else {
    const size = Math.max(1, Math.floor((MAX_FIELDS - vatField) / perLine))
    for (let i = 0; i < props.lines.length; i += size) steps.push({ kind: 'prices', lines: props.lines.slice(i, i + size), first: i === 0 })
    steps.push({ kind: 'terms' })
  }
  steps.push({ kind: 'files' }, { kind: 'review' })

  const [step, setStep] = useState(0)
  const [prices, setPrices] = useState<Record<string, string>>(() => Object.fromEntries(props.lines.map((l) => [l.id, l.unitPrice])))
  const [notOffered, setNotOffered] = useState<Record<string, boolean>>(() => Object.fromEntries(props.lines.map((l) => [l.id, props.allowPartial && l.notOffered])))
  const [vatIncluded, setVatIncluded] = useState(props.vatInclusiveAllowed && props.priceIncludesVat)
  const [files, setFiles] = useState<readonly BidFormFile[]>(props.files)
  const [fileBusy, setFileBusy] = useState(false)
  const [fileError, setFileError] = useState<string | null>(null)
  const [invalid, setInvalid] = useState<readonly string[]>([])
  const fileInput = useRef<HTMLInputElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)

  const current = steps[step]!
  const title = (s: Step) => (s.kind === 'prices' ? w.steps.prices : w.steps[s.kind])
  const offered = (id: string) => !notOffered[id] && cleanPrice(prices[id] ?? '') !== ''

  function go(to: number) {
    if (current.kind === 'prices' && to > step) {
      const bad = current.lines.filter((l) => offered(l.id) && (!MONEY.test(cleanPrice(prices[l.id]!)) || amountToSatang(cleanPrice(prices[l.id]!)) <= 0n)).map((l) => l.id)
      setInvalid(bad)
      if (bad.length) return
    }
    setStep(to)
    // the new step's heading takes the focus, so a screen reader reads where the person is
    requestAnimationFrame(() => heading.current?.focus())
  }

  async function sendFile(body: FormData): Promise<{ ok: boolean; code?: string; reason?: string; file?: { id: string; scanStatus: string } }> {
    body.set('csrf', props.csrf)
    body.set('rfxEventId', props.rfxEventId)
    try {
      const res = await fetch(props.fileAction, { method: 'POST', body, headers: { accept: 'application/json', 'x-bcs-portal-csrf': props.csrf } })
      return (await res.json()) as { ok: boolean; code?: string; reason?: string; file?: { id: string; scanStatus: string } }
    } catch {
      return { ok: false, code: 'FAILED' }
    }
  }

  const errorOf = (r: { code?: string; reason?: string }) => (r.reason && w.fileErrors[r.reason]) || (r.code && w.fileErrors[r.code]) || w.fileError

  async function upload() {
    const file = fileInput.current?.files?.[0]
    if (!file) return
    setFileBusy(true)
    setFileError(null)
    const body = new FormData()
    body.set('action', 'upload')
    body.set('file', file)
    body.set('key', crypto.randomUUID())
    const r = await sendFile(body)
    setFileBusy(false)
    if (r.ok && r.file) {
      setFiles((f) => [...f, { id: r.file!.id, fileName: file.name, scanStatus: r.file!.scanStatus }])
      if (fileInput.current) fileInput.current.value = ''
    } else setFileError(errorOf(r))
  }

  async function remove(id: string) {
    setFileBusy(true)
    setFileError(null)
    const body = new FormData()
    body.set('action', 'remove')
    body.set('fileId', id)
    body.set('key', crypto.randomUUID())
    const r = await sendFile(body)
    setFileBusy(false)
    if (r.ok) setFiles((f) => f.filter((x) => x.id !== id))
    else setFileError(errorOf(r))
  }

  // the review: the amounts bid.submit computes (BR-RFX-08), from the prices as typed
  const priced = Object.fromEntries(props.lines.filter((l) => offered(l.id) && MONEY.test(cleanPrice(prices[l.id]!))).map((l) => [l.id, amountToSatang(cleanPrice(prices[l.id]!))]))
  const missing = props.rfi ? [] : props.lines.filter((l) => priced[l.id] === undefined && !notOffered[l.id]).map((l) => l.lineNo)
  const none = !props.rfi && Object.keys(priced).length === 0
  const amounts =
    props.rfi || props.vatRateBp === null || none
      ? null
      : compareBids(
          props.lines.map((l) => ({ ref: l.id, quantity: l.quantity })),
          [{ ref: 'bid', priceIncludesVat: vatIncluded, vatRateBp: props.vatRateBp, unitPrices: priced }],
        ).bids[0]!
  const blocked = !props.rfi && (none || (missing.length > 0 && !props.allowPartial))

  return (
    <form method="post" action={props.action} className="flex flex-col gap-5" noValidate>
      <input type="hidden" name="csrf" value={props.csrf} />
      <input type="hidden" name="rfxEventId" value={props.rfxEventId} />
      {/* the one currency (NG-9 · FR-INT-201 AC4): the service refuses any other (CURRENCY) */}
      <input type="hidden" name="currency" value={RFX_CURRENCY} />
      {props.bidId ? <input type="hidden" name="bidId" value={props.bidId} /> : null}
      {props.version !== null ? <input type="hidden" name="version" value={props.version} /> : null}
      <p className="text-sm text-ink-muted" aria-live="polite">
        {fill(w.stepOf, { n: step + 1, total: steps.length, title: title(current) })}
      </p>
      <h2 ref={heading} tabIndex={-1} className="text-lg font-semibold outline-none">
        {title(current)}
      </h2>

      {/* every field of every step is in the form; only the current step is shown */}
      {props.rfi ? (
        <div hidden={current.kind !== 'answer'} className="flex flex-col gap-2">
          <label htmlFor="note" className="font-medium">
            {w.answer}
          </label>
          <textarea id="note" name="note" defaultValue={props.note} maxLength={RFX_QUESTION_MAX} className={textareaClass} />
        </div>
      ) : (
        steps.map((s, i) =>
          s.kind === 'prices' ? (
            <div key={`prices-${i}`} hidden={i !== step} className="flex flex-col gap-5">
              {s.first && props.vatInclusiveAllowed ? (
                <label className="flex items-start gap-3">
                  <input type="checkbox" name="vatIncluded" value="1" checked={vatIncluded} onChange={(e) => setVatIncluded(e.target.checked)} className={`${checkboxClass} mt-0.5`} />
                  <span className="flex flex-col">
                    <span className="font-medium">{w.vatIncluded}</span>
                    <span className="text-sm text-ink-muted">{w.vatIncludedHint}</span>
                  </span>
                </label>
              ) : null}
              {s.lines.map((l) => {
                const id = `price-${l.id}`
                const bad = invalid.includes(l.id)
                return (
                  <fieldset key={l.id} className="flex flex-col gap-2 border-t border-line pt-4">
                    <legend className="font-medium">
                      {l.lineNo}. {l.description}
                    </legend>
                    <p className="tabular text-sm text-ink-muted">{fill(w.quantity, { quantity: l.quantity, uom: l.uom })}</p>
                    <label htmlFor={id} className="text-sm font-medium">
                      {w.unitPrice}
                    </label>
                    <div className="flex items-center gap-2">
                      <input
                        id={id}
                        name={notOffered[l.id] ? undefined : `line:${l.id}:price`}
                        inputMode="decimal"
                        autoComplete="off"
                        value={notOffered[l.id] ? '' : (prices[l.id] ?? '')}
                        disabled={notOffered[l.id]}
                        aria-invalid={bad}
                        aria-describedby={bad ? `${id}-error` : undefined}
                        onChange={(e) => setPrices((p) => ({ ...p, [l.id]: e.target.value }))}
                        className={`${inputClass} tabular text-right`}
                      />
                      {/* the currency is fixed (NG-9): shown, not chosen */}
                      <span className="shrink-0 text-ink-muted">{w.currency}</span>
                    </div>
                    {bad ? (
                      <p id={`${id}-error`} className="text-sm text-danger">
                        {w.priceInvalid}
                      </p>
                    ) : null}
                    {props.allowPartial ? (
                      <label className="flex items-center gap-3">
                        <input type="checkbox" checked={notOffered[l.id] ?? false} onChange={(e) => setNotOffered((n) => ({ ...n, [l.id]: e.target.checked }))} className={checkboxClass} />
                        <span>{w.notOffered}</span>
                      </label>
                    ) : null}
                    {notOffered[l.id] ? <input type="hidden" name={`line:${l.id}:offered`} value="0" /> : null}
                  </fieldset>
                )
              })}
            </div>
          ) : null,
        )
      )}

      {props.rfi ? null : (
        <div hidden={current.kind !== 'terms'} className="flex flex-col gap-2">
          <label htmlFor="deliveryDays" className="font-medium">
            {w.deliveryDays}
          </label>
          <input id="deliveryDays" name="deliveryDays" inputMode="numeric" pattern="[0-9]*" defaultValue={props.deliveryDays} className={`${inputClass} tabular`} />
          <label htmlFor="promisedDeliveryOn" className="font-medium">
            {w.promisedDeliveryOn}
          </label>
          <input id="promisedDeliveryOn" name="promisedDeliveryOn" type="date" defaultValue={props.promisedDeliveryOn} className={inputClass} />
          <label htmlFor="note" className="font-medium">
            {w.note}
          </label>
          <textarea id="note" name="note" defaultValue={props.note} maxLength={RFX_QUESTION_MAX} className={textareaClass} />
          <p className="text-sm text-ink-muted">{w.validity}</p>
        </div>
      )}

      <div hidden={current.kind !== 'files'} className="flex flex-col gap-3">
        <p className="text-ink-muted">{w.filesHint}</p>
        {files.length ? (
          <ul className="flex flex-col divide-y divide-line border-y border-line">
            {files.map((f) => (
              <li key={f.id} className="flex items-center justify-between gap-3 py-3">
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">{f.fileName}</span>
                  <span className="text-sm text-ink-muted">{w.scan[f.scanStatus] ?? f.scanStatus}</span>
                </span>
                <Button variant="secondary" disabled={fileBusy} onClick={() => void remove(f.id)} aria-label={`${w.fileRemove} ${f.fileName}`}>
                  {w.fileRemove}
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-ink-muted">{w.fileNone}</p>
        )}
        <label htmlFor="bid-file" className="font-medium">
          {w.fileChoose}
        </label>
        {/* no name: the file goes up on its own (fetch), never with the prices */}
        <input id="bid-file" ref={fileInput} type="file" accept="application/pdf,image/jpeg,image/png,image/webp" className="text-base" />
        <Button variant="secondary" disabled={fileBusy} onClick={() => void upload()}>
          {fileBusy ? w.fileUploading : w.fileUpload}
        </Button>
        {fileError ? <LiffNotice tone="danger">{fileError}</LiffNotice> : null}
      </div>

      <div hidden={current.kind !== 'review'} className="flex flex-col gap-3">
        {props.rfi ? null : (
          <ul className="flex flex-col divide-y divide-line border-y border-line">
            {props.lines.map((l) => (
              <li key={l.id} className="flex flex-col gap-1 py-3">
                <span className="font-medium">
                  {l.lineNo}. {l.description}
                </span>
                {priced[l.id] !== undefined ? (
                  <span className="tabular flex justify-between gap-3">
                    <span>
                      {l.quantity} {l.uom} × {formatSatang(priced[l.id]!)}
                    </span>
                    <span>{formatSatang(amounts?.lineNet.find(([ref]) => ref === l.id)?.[1] ?? 0n)}</span>
                  </span>
                ) : (
                  <span className="text-ink-muted">{notOffered[l.id] ? w.notOffered : w.noPrice}</span>
                )}
              </li>
            ))}
          </ul>
        )}
        {amounts ? (
          <dl className="tabular grid grid-cols-[1fr_auto] gap-x-4 gap-y-1">
            <dt>{w.net}</dt>
            <dd className="text-right">{formatSatang(amounts.net)}</dd>
            <dt>{w.vat}</dt>
            <dd className="text-right">{formatSatang(amounts.vat)}</dd>
            <dt className="font-semibold">{w.gross}</dt>
            <dd className="text-right font-semibold">{formatSatang(amounts.gross)}</dd>
          </dl>
        ) : null}
        {!props.rfi && props.vatRateBp === 0 ? <p className="text-sm text-ink-muted">{w.vatNotRegistered}</p> : null}
        {!props.rfi && props.vatRateBp === null ? <LiffNotice tone="warning">{w.vatRateMissing}</LiffNotice> : null}
        {missing.length && !props.allowPartial ? <LiffNotice tone="warning">{fill(w.missing, { lines: missing.join(', ') })}</LiffNotice> : null}
        {props.rfi ? null : <p className="text-sm text-ink-muted">{w.validity}</p>}
      </div>

      <section aria-label={w.actions} className="sticky bottom-0 z-20 flex flex-col gap-2 border-t border-line bg-bg pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        {/* two keys: React swaps the element rather than turning the clicked "next" into a submit during the click,
            which the browser would then send */}
        {current.kind === 'review' ? (
          <Button key="submit" type="submit" name="action" value="submit" disabled={blocked || fileBusy}>
            {props.sent ? w.submitAgain : w.submit}
          </Button>
        ) : (
          <Button key="next" onClick={() => go(step + 1)}>
            {w.next}
          </Button>
        )}
        <div className="flex gap-2">
          {step > 0 ? (
            <Button variant="secondary" className="flex-1" onClick={() => go(step - 1)}>
              {w.back}
            </Button>
          ) : null}
          {props.sent ? null : (
            <Button type="submit" variant="secondary" name="action" value="save" className="flex-1" disabled={fileBusy}>
              {w.saveDraft}
            </Button>
          )}
        </div>
      </section>
    </form>
  )
}
