'use client'

import { useState } from 'react'
import { cn } from '../cn'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '../shadcn/sheet'
import { StatusBadge, type BadgeLook } from './badges'

// The approval route of a document as cards, one per step, in a vertical line like a parcel's tracking (FR-INT-012 AC3,
// §9.9 principle 4, §9.10 "การ์ดขั้น"): the step's state, its name, who has it, when it is due and how much of its
// business time is used. A decided step turns into the stamp of §9.9 — name, position, time, channel, and the DOA version
// and rule — the one signature element of the page. The current step stands out with a 2 px frame. Pressing a step opens
// its panel on the right (Sheet, 440 px): what happened to its tasks and why the route goes where it goes. The panel has no
// decision buttons — deciding happens in the decision bar only, so no dialog ever opens over the panel (§9.10). Strings
// arrive translated; the card's heading is the button, stretched over the card, so the whole card opens the panel.

export interface StepStampView {
  readonly name: string
  readonly role?: string
  readonly onBehalfOf?: string
  readonly when: string
  readonly channel?: string
  readonly doaRef?: string
  readonly doaHref?: string
  readonly escalated?: string
}

export interface StepHistoryView {
  readonly key: string
  readonly when: string
  readonly text: string
  readonly note?: string
}

export interface StepCardView {
  readonly key: string
  readonly title: string
  readonly badge: { readonly look: BadgeLook; readonly label: string }
  readonly current: boolean
  readonly overdue?: boolean
  /** Who has the step (or may decide it, an escalated step's co-assignee too), or who the rule expects later */
  readonly people: readonly string[]
  readonly due?: string
  readonly sla?: string
  readonly stamp?: StepStampView
  readonly stampTone?: 'ok' | 'warn' | 'danger'
  readonly history: readonly StepHistoryView[]
}

export interface StepCardsLabels {
  readonly list: string
  readonly open: string
  readonly panelHistory: string
  readonly panelWhy: string
  readonly panelNoHistory: string
}

const STAMP_FRAME = { ok: 'border-primary', warn: 'border-warn', danger: 'border-danger' } as const

export function StepCards({ steps, explanation, labels }: { steps: readonly StepCardView[]; explanation: string; labels: StepCardsLabels }) {
  const [openKey, setOpenKey] = useState<string | null>(null)
  const open = steps.find((s) => s.key === openKey) ?? null
  return (
    <>
      <ol aria-label={labels.list} className="flex flex-col">
        {steps.map((step, index) => {
          const last = index === steps.length - 1
          const frame = step.current ? cn('border-2', step.overdue ? 'border-danger' : 'border-primary') : step.stamp && step.stampTone ? STAMP_FRAME[step.stampTone] : 'border-line'
          return (
            <li key={step.key} className="relative flex gap-3 pb-4" aria-current={step.current ? 'step' : undefined} data-step-card="">
              {!last ? <span aria-hidden="true" className="absolute top-4 left-1.5 h-full w-px bg-line" /> : null}
              <span aria-hidden="true" className={cn('relative mt-3 size-3 shrink-0 rounded-full border-2 bg-bg', step.current ? 'border-primary bg-primary' : step.stamp ? 'border-primary' : 'border-line-strong')} />
              <div className={cn('relative min-w-0 flex-1 rounded-md border bg-bg p-3 focus-within:ring-2 focus-within:ring-focus focus-within:ring-offset-2', frame)}>
                <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
                  <h3 className="min-w-0 font-semibold text-ink">
                    <button
                      type="button"
                      onClick={() => setOpenKey(step.key)}
                      aria-haspopup="dialog"
                      className="text-left after:absolute after:inset-0 after:content-[''] focus-visible:outline-none"
                    >
                      {step.title}
                      <span className="sr-only"> — {labels.open}</span>
                    </button>
                  </h3>
                  <StatusBadge look={step.badge.look} label={step.badge.label} />
                </div>
                {step.people.map((p) => (
                  <p key={p} className="break-words text-ink">
                    {p}
                  </p>
                ))}
                {step.due ? <p className={cn('tabular', step.overdue ? 'font-medium text-danger' : 'text-ink-muted')}>{step.due}</p> : null}
                {step.sla ? <p className="tabular text-ink-muted">{step.sla}</p> : null}
                {step.stamp ? <Stamp stamp={step.stamp} /> : null}
              </div>
            </li>
          )
        })}
      </ol>
      <Sheet open={open !== null} onOpenChange={(next) => (next ? null : setOpenKey(null))}>
        <SheetContent side="right" className="w-full overflow-y-auto data-[side=right]:sm:max-w-[27.5rem]">
          {open ? (
            <>
              <SheetHeader className="pr-12">
                <SheetTitle className="text-lg font-semibold text-ink">{open.title}</SheetTitle>
                <SheetDescription className="text-base text-ink-muted">{open.badge.label}</SheetDescription>
              </SheetHeader>
              <div className="flex flex-col gap-6 px-4 pb-6 text-base">
                <section aria-labelledby="step-panel-history" className="flex flex-col gap-2">
                  <h4 id="step-panel-history" className="font-semibold text-ink">
                    {labels.panelHistory}
                  </h4>
                  {open.history.length ? (
                    <ol className="flex flex-col divide-y divide-line border-y border-line">
                      {open.history.map((h) => (
                        <li key={h.key} className="flex flex-col gap-0.5 py-2">
                          <span className="text-ink">{h.text}</span>
                          <span className="tabular text-ink-muted">{h.when}</span>
                          {h.note ? <span className="border-l-2 border-line pl-3 break-words whitespace-pre-line text-ink">{h.note}</span> : null}
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <p className="text-ink-muted">{labels.panelNoHistory}</p>
                  )}
                </section>
                {explanation ? (
                  <section aria-labelledby="step-panel-why" className="flex flex-col gap-2">
                    <h4 id="step-panel-why" className="font-semibold text-ink">
                      {labels.panelWhy}
                    </h4>
                    <p className="break-words text-ink">{explanation}</p>
                  </section>
                ) : null}
              </div>
            </>
          ) : null}
        </SheetContent>
      </Sheet>
    </>
  )
}

/** The stamp of a decided step: who, in which position, when, through which channel, under which DOA version and rule */
function Stamp({ stamp }: { stamp: StepStampView }) {
  const ref = stamp.doaRef ? <span className="inline-block rounded-sm border-2 border-primary px-1.5 py-0.5 font-semibold text-primary">{stamp.doaRef}</span> : null
  return (
    <div className="mt-1 flex flex-col gap-0.5" data-stamp="">
      <p className="text-ink">
        {stamp.name}
        {stamp.role ? <span className="text-ink-muted"> · {stamp.role}</span> : null}
      </p>
      {stamp.onBehalfOf ? <p className="text-ink-muted">{stamp.onBehalfOf}</p> : null}
      <p className="tabular text-ink-muted">{[stamp.when, stamp.channel].filter(Boolean).join(' · ')}</p>
      {stamp.escalated ? <p className="text-ink-muted">{stamp.escalated}</p> : null}
      {ref ? (
        <p className="relative z-10 mt-1">
          {stamp.doaHref ? (
            <a href={stamp.doaHref} className="inline-block underline-offset-4 hover:underline">
              {ref}
            </a>
          ) : (
            ref
          )}
        </p>
      ) : null}
    </div>
  )
}
