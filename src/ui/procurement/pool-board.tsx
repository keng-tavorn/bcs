'use client'

import { AlarmClock, CircleAlert, CirclePause, Store } from 'lucide-react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { useId, useState } from 'react'
import { Button } from '../form/button'
import { Notice } from '../form/notice'
import { announcePoolAction, useOtherPoolAction } from './activity'
import { POOL_NO_ANSWER, poolActionErrorKey, poolErrorKey, type DraftView, type PoolOutcome } from './outcome'
import { useOutcomeAction } from './use-outcome-action'

// The procurement pool (spec FR-P2P-001): approved request lines nobody has ordered, grouped by request (oldest
// approval first), each line with what is left to order, its price before VAT and its supplier — or the label
// "ต้องเลือกผู้ขาย" with an icon (BR-CONS-03, never colour alone). PROCUREMENT ticks lines (all of a request at once if
// they like) and chooses one supplier for all of them (AC2). The bar that does it heads the list and stays at the top of
// wide screens while the list scrolls; on phones a small bar at the bottom says how many lines are ticked and leads back
// to it. No cards: requests and lines are separated by rules; numbers are right-aligned in tabular digits. Choosing the
// supplier of an urgent request drafts its PO at once (BR-CONS-02), and a draft cannot be thrown away or given another
// supplier yet, so that choice asks a second time, naming how many urgent requests it drafts (§9.9). A request no round
// drafts yet says why under its name, with an icon (a request whose prices include VAT, NEW-50); its prices are shown
// as it states them, marked "รวม VAT", and choosing its supplier drafts nothing at once even when it is urgent — the
// notice of the choice says so. While such a request is listed, the amount column names no VAT basis and every line
// states its own ("รวม VAT" or "ก่อน VAT"). While a choice is sent, the button pressed says so in its own words
// ("กำลังใช้ผู้ขายนี้", "กำลังเอาผู้ขายออก"); a choice that got no answer says it is not certain it was made, and to
// press the same button again without changing the lines or the supplier (POOL_NO_ANSWER). Strings and amounts arrive
// translated and formatted; the service checks permissions again.

export interface PoolLineView {
  readonly id: string
  readonly no: number
  readonly description: string
  readonly kind: string
  readonly quantity: string
  readonly unitPrice: string
  /** What is left × the unit price, on the same VAT basis */
  readonly amount: string
  /** The unit price and the amount include VAT (the request's prices do) */
  readonly includesVat: boolean
  /** The supplier chosen in the pool, or null: the line waits for one */
  readonly supplierName: string | null
}

export interface PoolRequestView {
  readonly id: string
  /** "PR-2569-00012 · ไม้อัดและตะปู" */
  readonly title: string
  readonly number: string
  readonly href: string
  /** Who, where, since when — already worded */
  readonly meta: readonly string[]
  readonly urgent: boolean
  readonly suggested: string | null
  /** Why no round drafts this request's lines yet, or null */
  readonly blocked: 'PRICE_INCLUDES_VAT' | null
  readonly lines: readonly PoolLineView[]
}

export interface PoolBoardProps {
  readonly requests: readonly PoolRequestView[]
  readonly suppliers: ReadonlyArray<{ readonly id: string; readonly label: string }>
  readonly assign: (input: { requestLineIds: string[]; supplierId: string | null }, idempotencyKey: string) => Promise<PoolOutcome>
}

const GRID = 'md:grid md:grid-cols-[minmax(0,1fr)_6.5rem_7.5rem_8.5rem] md:items-start md:gap-4'
const SOURCE = 'assign'

/** `note` is seen under the value on wide screens, where the label is only read out: the label already says it */
function Figure({ label, value, strong, note }: { label: string; value: string; strong?: boolean; note?: string }) {
  return (
    <p className="flex items-baseline justify-between gap-3 md:block md:text-right">
      <span className="text-base text-ink-muted md:sr-only">{label}</span>
      <span className={strong ? 'tabular font-semibold text-ink' : 'tabular text-ink'}>{value}</span>
      {note ? (
        <span aria-hidden="true" className="hidden text-sm text-ink-muted md:block">
          {note}
        </span>
      ) : null}
    </p>
  )
}

type PoolT = ReturnType<typeof useTranslations<'procurement.pool'>>

/** "เปิดร่าง PO ของ <ผู้ขาย> · <สถานที่ส่ง> · <ชนิด>": two drafts of one supplier never read alike */
export function draftLinkLabel(t: PoolT, draft: DraftView): string {
  return t('draftLink', { supplier: draft.supplierName, site: draft.siteName ?? t('round.draftNoSite'), kind: t(`kind.${draft.kind}`) })
}

/**
 * The urgent requests among the ticked lines that choosing their supplier drafts at once (BR-CONS-02) — what the second
 * press asks about. A request no round drafts yet is not drafted at once either (NEW-50: prices that include VAT).
 */
export function urgentDraftedAtOnce(requests: readonly PoolRequestView[], picked: ReadonlySet<string>): number {
  return requests.filter((r) => r.urgent && !r.blocked && r.lines.some((l) => picked.has(l.id))).length
}

/** The ticked lines of requests no round drafts yet (NEW-50): choosing their supplier puts them on no draft PO */
export function blockedPicked(requests: readonly PoolRequestView[], picked: ReadonlySet<string>): number {
  return requests.reduce((n, r) => (r.blocked ? n + r.lines.filter((l) => picked.has(l.id)).length : n), 0)
}

/**
 * The labels of a line's unit price and amount, and the note under each value on wide screens. While a listed request
 * has prices that include VAT, the column heading names no basis, so every line states its own (NEW-50).
 */
export function figureLabels(t: PoolT, line: Pick<PoolLineView, 'includesVat'>, vatListed: boolean): { unitPrice: string; amount: string; note: string | undefined } {
  if (line.includesVat) return { unitPrice: t('line.unitPriceIncludingVat'), amount: t('line.amountIncludingVat'), note: t('line.includingVat') }
  if (vatListed) return { unitPrice: t('line.unitPriceBeforeVat'), amount: t('line.amount'), note: t('line.beforeVat') }
  return { unitPrice: t('line.unitPrice'), amount: t('line.amount'), note: undefined }
}

export function DraftLinks({ drafts, label }: { drafts: readonly DraftView[]; label: (draft: DraftView) => string }) {
  return (
    <ul className="flex flex-col gap-1">
      {drafts.map((d) => (
        <li key={d.id}>
          <Link href={`/procurement/pos/${d.id}`} className="inline-flex min-h-11 items-center font-medium text-primary underline underline-offset-4 hover:no-underline">
            {label(d)}
          </Link>
        </li>
      ))}
    </ul>
  )
}

export function PoolBoard({ requests, suppliers, assign }: PoolBoardProps) {
  const t = useTranslations('procurement.pool')
  const id = useId()
  const action = useOutcomeAction<PoolOutcome>(POOL_NO_ANSWER)
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set())
  const [supplierId, setSupplierId] = useState('')
  const [problem, setProblem] = useState<'needLines' | 'needSupplier' | 'nothingToClear' | null>(null)
  /** The last press asked to take the supplier off (its refusal and its pending words are worded for it) */
  const [clearing, setClearing] = useState(false)
  const [done, setDone] = useState<{ text: string; drafts: readonly DraftView[]; urgent: string | null; blocked: string | null } | null>(null)
  /** Urgent requests among the ticked lines, while the second press is asked for */
  const [confirmUrgent, setConfirmUrgent] = useState<number | null>(null)
  // A round run after the choice: the choice's notice is no longer the last thing done
  useOtherPoolAction(SOURCE, () => {
    setDone(null)
    setConfirmUrgent(null)
    action.clear()
  })

  // Lines that left the pool after a refresh are no longer selected
  const present = new Set(requests.flatMap((r) => r.lines.map((l) => l.id)))
  const selected = [...picked].filter((lineId) => present.has(lineId))
  const urgentPicked = urgentDraftedAtOnce(requests, picked)
  const vatListed = requests.some((r) => r.lines.some((l) => l.includesVat))

  const toggle = (lineIds: readonly string[], on: boolean) => {
    setPicked((current) => {
      const next = new Set(current)
      for (const lineId of lineIds) {
        if (on) next.add(lineId)
        else next.delete(lineId)
      }
      return next
    })
    setProblem(null)
    setDone(null)
    setConfirmUrgent(null)
    action.clear()
  }

  async function apply(clear: boolean, confirmed = false) {
    if (selected.length === 0) return setProblem('needLines')
    if (!clear && !supplierId) return setProblem('needSupplier')
    // Taking the supplier off lines that have none changes nothing: said for what it is (§9.9 rule 7), not sent
    if (clear && !requests.some((r) => r.lines.some((l) => l.supplierName !== null && selected.includes(l.id)))) {
      action.clear()
      setDone(null)
      return setProblem('nothingToClear')
    }
    setProblem(null)
    setClearing(clear)
    setDone(null)
    // An urgent request is drafted as soon as it has its supplier: asked a second time first
    if (!clear && urgentPicked > 0 && !confirmed) {
      action.clear()
      return setConfirmUrgent(urgentPicked)
    }
    setConfirmUrgent(null)
    announcePoolAction(SOURCE)
    const supplier = suppliers.find((s) => s.id === supplierId)
    const blocked = clear ? 0 : blockedPicked(requests, new Set(selected))
    const outcome = await action.run((key) => assign({ requestLineIds: selected, supplierId: clear ? null : supplierId }, key))
    if (!outcome.ok) return
    const count = outcome.assigned ?? selected.length
    const drafts = outcome.drafts ?? []
    setPicked(new Set())
    setDone({
      text: clear ? t('assign.cleared', { count }) : t('assign.done', { supplier: supplier?.label ?? '', count }),
      drafts,
      urgent: drafts.length ? t('assign.urgent', { count: drafts.length }) : null,
      blocked: blocked ? t('assign.blocked', { count: blocked }) : null,
    })
  }

  const failure = action.outcome && !action.outcome.ok ? action.outcome : null

  return (
    <div className="flex flex-col">
      <section
        id={`${id}-assign`}
        aria-labelledby={`${id}-assign-title`}
        className="z-20 flex scroll-mt-4 flex-col gap-3 border-y border-line bg-bg py-4 lg:sticky lg:top-0"
      >
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h2 id={`${id}-assign-title`} className="text-lg font-semibold text-ink">
            {t('assign.title')}
          </h2>
          <p className="font-medium text-ink" aria-live="polite">
            {selected.length ? t('assign.selected', { count: selected.length }) : t('assign.nothing')}
          </p>
        </div>
        {done ? (
          <Notice tone="success">
            <p>{done.text}</p>
            {done.urgent ? <p>{done.urgent}</p> : null}
            {done.blocked ? <p>{done.blocked}</p> : null}
            {done.drafts.length ? <DraftLinks drafts={done.drafts} label={(d) => draftLinkLabel(t, d)} /> : null}
          </Notice>
        ) : null}
        {failure ? (
          <Notice tone="danger">
            {/* Someone took the suppliers off meanwhile: nothing was left to take off, in the words of that case */}
            {clearing && poolErrorKey(failure) === 'NO_CHANGE' ? t('assign.nothingToClear') : t(`errors.${poolActionErrorKey(failure, clearing ? 'clear' : 'assign')}`, { requestId: failure.requestId ?? '-' })}
          </Notice>
        ) : null}
        {problem ? <Notice tone="danger">{t(`assign.${problem}`)}</Notice> : null}
        <div className="flex flex-col gap-3 md:flex-row md:flex-wrap md:items-end">
          <div className="flex flex-col gap-1.5 md:w-64">
            <label htmlFor={`${id}-supplier`} className="font-medium text-ink">
              {t('assign.supplier')}
            </label>
            <select
              id={`${id}-supplier`}
              value={supplierId}
              onChange={(event) => {
                setSupplierId(event.currentTarget.value)
                setProblem(null)
                setConfirmUrgent(null)
              }}
              className="h-11 w-full rounded-md border border-input bg-bg px-3 text-base text-ink"
            >
              <option value="">{t('assign.choose')}</option>
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>
          {/* Only the button pressed says it is working, in its own words */}
          <Button onClick={() => void apply(false)} disabled={action.pending || confirmUrgent !== null}>
            {action.pending && !clearing ? t('assign.working') : t('assign.submit')}
          </Button>
          <Button variant="secondary" onClick={() => void apply(true)} disabled={action.pending || confirmUrgent !== null}>
            {action.pending && clearing ? t('assign.clearing') : t('assign.clear')}
          </Button>
        </div>
        {confirmUrgent !== null ? (
          <div role="group" aria-labelledby={`${id}-urgent`} className="flex flex-col gap-2 border-l-4 border-info bg-surface px-3 py-2.5">
            <p id={`${id}-urgent`} className="font-medium text-ink">
              {t('assign.urgentConfirm', { count: confirmUrgent, supplier: suppliers.find((s) => s.id === supplierId)?.label ?? '' })}
            </p>
            <div className="flex flex-wrap gap-3">
              <Button onClick={() => void apply(false, true)} disabled={action.pending}>
                {action.pending ? t('assign.working') : t('assign.urgentConfirmButton')}
              </Button>
              <Button variant="secondary" onClick={() => setConfirmUrgent(null)} disabled={action.pending}>
                {t('assign.back')}
              </Button>
            </div>
          </div>
        ) : null}
      </section>

      <div className={`mt-2 hidden border-b border-line pb-2 text-sm text-ink-muted md:ml-8 ${GRID}`} aria-hidden="true">
        <span>{t('line.description')}</span>
        <span className="text-right">{t('line.quantity')}</span>
        <span className="text-right">{t('line.unitPrice')}</span>
        <span className="text-right">{vatListed ? t('line.amountColumn') : t('line.amount')}</span>
      </div>
      <ul aria-label={t('listLabel')} className="flex flex-col divide-y divide-line border-b border-line">
        {requests.map((r) => {
          const lineIds = r.lines.map((l) => l.id)
          const all = lineIds.every((lineId) => picked.has(lineId))
          return (
            <li key={r.id} className="flex flex-col gap-2 py-4">
              <div className="flex items-start gap-3">
                <input
                  type="checkbox"
                  checked={all}
                  onChange={(event) => toggle(lineIds, event.currentTarget.checked)}
                  aria-label={t('request.selectAll', { number: r.number })}
                  className="mt-1.5 size-5 shrink-0"
                />
                <div className="flex min-w-0 flex-col gap-0.5">
                  <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <Link href={r.href} className="font-semibold break-words text-primary underline underline-offset-4 hover:no-underline">
                      {r.title}
                    </Link>
                    {r.urgent ? (
                      <span className="inline-flex items-center gap-1 rounded-sm border border-warn px-1.5 font-medium text-warn">
                        <AlarmClock className="size-4 shrink-0" aria-hidden="true" />
                        {t('urgency.URGENT')}
                      </span>
                    ) : null}
                  </p>
                  {/* What procurement reads before choosing a supplier — who asked, where it goes, since when it was
                      approved, the supplier the requester suggests — is content at the body's size (§9.9: 15 px on the
                      web, 16 on phones); only the column headings and the note under an amount are smaller on the web */}
                  {r.meta.map((m) => (
                    <span key={m} className="text-ink-muted">
                      {m}
                    </span>
                  ))}
                  {r.suggested ? <span className="text-ink">{t('request.suggested', { name: r.suggested })}</span> : null}
                  {r.blocked ? (
                    // A sentence on why the request waits: body size, not a caption (§9.9)
                    <span className="inline-flex items-start gap-1.5 font-medium text-warn">
                      <CirclePause className="mt-[0.3em] size-4 shrink-0" aria-hidden="true" />
                      <span className="break-words">{t(`blocked.${r.blocked}`)}</span>
                    </span>
                  ) : null}
                </div>
              </div>
              <ol className="flex flex-col divide-y divide-line border-t border-line md:ml-8">
                {r.lines.map((l) => {
                  const labels = figureLabels(t, l, vatListed)
                  return (
                    <li key={l.id} className={`flex flex-col gap-1.5 py-2.5 ${GRID}`}>
                      <label className="flex min-w-0 items-start gap-3">
                        <input
                          type="checkbox"
                          checked={picked.has(l.id)}
                          onChange={(event) => toggle([l.id], event.currentTarget.checked)}
                          aria-label={t('line.select', { no: l.no, description: l.description })}
                          className="mt-1.5 size-5 shrink-0"
                        />
                        <span className="flex min-w-0 flex-col gap-0.5">
                          {/* The line's kind and its supplier, or that it needs one: content at the body's size (§9.9). A
                              supplier chosen is not an approval: its store in --info, never --primary (§9.9 tokens) */}
                          <span className="font-medium break-words text-ink">{t('line.title', { no: l.no, description: l.description })}</span>
                          <span className="text-ink-muted">{l.kind}</span>
                          {l.supplierName ? (
                            <span className="inline-flex items-start gap-1.5 text-ink">
                              <Store className="mt-[0.3em] size-4 shrink-0 text-info" aria-hidden="true" />
                              <span className="break-words">{t('line.supplier', { name: l.supplierName })}</span>
                            </span>
                          ) : (
                            <span className="inline-flex items-start gap-1.5 font-medium text-warn">
                              <CircleAlert className="mt-[0.3em] size-4 shrink-0" aria-hidden="true" />
                              <span>{t('line.needsSupplier')}</span>
                            </span>
                          )}
                        </span>
                      </label>
                      <Figure label={t('line.quantity')} value={l.quantity} />
                      <Figure label={labels.unitPrice} value={l.unitPrice} note={labels.note} />
                      <Figure label={labels.amount} value={l.amount} strong note={labels.note} />
                    </li>
                  )
                })}
              </ol>
            </li>
          )
        })}
      </ul>

      {/* Phones: how many lines are ticked, and the way back up to choosing their supplier */}
      {selected.length ? (
        <>
          <div aria-hidden="true" className="h-20 lg:hidden" />
          <div className="fixed inset-x-0 bottom-0 z-30 flex items-center justify-between gap-3 border-t border-line bg-bg px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] lg:hidden">
            <p className="font-medium text-ink">{t('assign.selected', { count: selected.length })}</p>
            <a href={`#${id}-assign`} className="inline-flex h-11 items-center rounded-md bg-primary px-4 font-medium text-primary-foreground">
              {t('assign.jump')}
            </a>
          </div>
        </>
      ) : null}
    </div>
  )
}
