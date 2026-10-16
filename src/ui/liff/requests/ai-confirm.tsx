'use client'

import { useId, useState, useTransition } from 'react'
import { Button } from '../button'
import { LiffNotice } from '../notice'
import { useLiffSubmissionKey } from '../submission-key'
import { checkboxClass } from './classes'

// The values the AI put into a request draft that wait to be confirmed one by one (S17-08 · BR-AI-16 BR-AI-17 ·
// FR-LINE-301 AC5): money, quantities, the supplier and what it read with too little confidence. Each is ticked by the
// requester after checking it in the form, then confirmed with request.edit and aiAssist; until every one is, the request
// cannot be sent (AI_REVIEW_PENDING). A value the requester changed in the form no longer waits. The words come from the
// page (the LIFF form's own words stay as they are); the light components of LIFF only (ADR-052).

export interface LiffAiConfirmItem {
  readonly path: string
  readonly label: string
  /** The value in words, or null for one chosen from a list (a site, a supplier) */
  readonly value: string | null
}

export interface LiffAiConfirmWords {
  readonly heading: string
  readonly badge: string
  readonly intro: string
  readonly confirm: string
  readonly working: string
  readonly failed: string
}

export interface LiffAiConfirmProps {
  readonly requestId: string
  readonly agentActionId: string
  readonly items: readonly LiffAiConfirmItem[]
  readonly words: LiffAiConfirmWords
  readonly confirm: (input: { requestId: string; agentActionId: string; paths: string[]; idempotencyKey: string }) => Promise<{ readonly ok: boolean }>
}

export function LiffAiConfirm({ requestId, agentActionId, items, words, confirm }: LiffAiConfirmProps) {
  const id = useId()
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set())
  const [failed, setFailed] = useState(false)
  const [pending, start] = useTransition()
  const key = useLiffSubmissionKey()
  if (items.length === 0) return null

  const onConfirm = () =>
    start(async () => {
      setFailed(false)
      const outcome = await confirm({ requestId, agentActionId, paths: [...checked], idempotencyKey: key.key }).catch(() => ({ ok: false }))
      key.next()
      // The form reads the request again: its version moved and the confirmed values no longer wait
      if (outcome.ok) window.location.reload()
      else setFailed(true)
    })

  return (
    <section aria-labelledby={`${id}-ai`} className="flex flex-col gap-3 border-b border-line px-4 py-4">
      <h2 id={`${id}-ai`} className="flex flex-wrap items-center gap-2 text-lg font-semibold">
        {words.heading} <span className="rounded-sm border border-info px-1.5 text-sm text-info">{words.badge}</span>
      </h2>
      <p className="text-ink-muted">{words.intro}</p>
      <ul className="flex flex-col gap-2">
        {items.map((item) => (
          <li key={item.path}>
            <label className="flex min-h-11 items-start gap-3 rounded-md border border-line px-3 py-2">
              <input
                type="checkbox"
                className={`${checkboxClass} mt-0.5`}
                checked={checked.has(item.path)}
                onChange={(e) => {
                  const next = new Set(checked)
                  if (e.currentTarget.checked) next.add(item.path)
                  else next.delete(item.path)
                  setChecked(next)
                }}
              />
              <span className="flex flex-col">
                <span className="font-medium">{item.label}</span>
                {item.value ? <span>{item.value}</span> : null}
              </span>
            </label>
          </li>
        ))}
      </ul>
      {failed ? <LiffNotice tone="danger">{words.failed}</LiffNotice> : null}
      <Button onClick={onConfirm} disabled={pending || checked.size === 0}>
        {pending ? words.working : words.confirm}
      </Button>
    </section>
  )
}
