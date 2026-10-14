'use client'

import { CircleAlert } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { useState } from 'react'
import { AiReviewBox, useAiNoteText, type AiFieldView } from '../../ai/ai-review'
import type { AiNote, AiReadingView } from '../../ai/types'
import { Button } from '../../form/button'
import type { ApInvoiceActions } from './outcome'
import { useApAction, useApErrorText } from './use-ap-action'

// What an AI read off a tier-2 invoice's file and FINANCE still confirms (S13-20, FR-AI-303 AC6, BR-AI-16, BR-AI-17,
// OQ-147): the draft was made from the reading (invoice.createDraftFromReading), so every value it filled is already in
// the header and the lines; here each one is confirmed on its own, beside the original file. A value FINANCE changed in
// the header or a line counts as confirmed (the server compares the draft with what the AI said). "บันทึกการยืนยัน" is
// invoice.update with aiAssist; invoice.submit refuses with AI_REVIEW_PENDING until nothing waits. Workspace only.

export interface InvoiceAiReviewView {
  readonly agentActionId: string
  readonly fileId: string | null
  readonly proposed: Readonly<Record<string, string>>
  readonly requiredPaths: readonly string[]
  readonly confirmedPaths: readonly string[]
  /** What was read and what the checks found: the member who asked for the reading only (getAgentAction) */
  readonly reading: AiReadingView | null
  readonly notes: readonly AiNote[]
}

const HEADER = ['supplierInvoiceNo', 'invoiceDate', 'priceIncludesVat', 'discount', 'statedVat'] as const
const LINE = /^lines\.([0-9a-f-]{36})\.(quantity|unitPrice)$/

export function InvoiceAiReview({
  invoiceId,
  version,
  review,
  current,
  lines,
  update,
  openFile,
}: {
  invoiceId: string
  version: number
  review: InvoiceAiReviewView
  /** The draft's values by the same paths (src/server/services/ap/ai-assist.ts) */
  current: Readonly<Record<string, string>>
  lines: ReadonlyArray<{ readonly poLineId: string; readonly description: string; readonly uom: string }>
  update: ApInvoiceActions['update']
  openFile: (fileId: string) => Promise<string | null>
}) {
  const t = useTranslations('aiAssist')
  const noteText = useAiNoteText()
  const action = useApAction()
  const errorText = useApErrorText()
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set())

  const fields: AiFieldView[] = Object.entries(review.proposed).flatMap(([path, value]): AiFieldView[] => {
    const required = review.requiredPaths.includes(path)
    const line = LINE.exec(path)
    if (line) {
      const poLine = lines.find((l) => l.poLineId === line[1])
      if (!poLine) return []
      const kind = line[2] as 'quantity' | 'unitPrice'
      return [{ path, label: t(`invoice.fields.${kind}`, { description: poLine.description }), value: kind === 'quantity' ? `${value} ${poLine.uom}` : value, required }]
    }
    const field = HEADER.find((h) => h === path)
    if (!field) return []
    return [{ path, label: t(`invoice.fields.${field}`), value: field === 'priceIncludesVat' ? t(value === 'true' ? 'values.yes' : 'values.no') : value, required }]
  })
  const saved = new Set(review.confirmedPaths)
  const changed = fields.filter((f) => current[f.path] !== review.proposed[f.path]).map((f) => f.path)
  const confirmed = new Set([...saved, ...checked, ...changed])
  const unsaved = [...checked].filter((p) => !saved.has(p))
  const done = fields.every((f) => confirmed.has(f.path))

  function toggle(paths: readonly string[], on: boolean) {
    setChecked((before) => {
      const next = new Set(before)
      // What the server already holds stays confirmed
      for (const p of paths) {
        if (saved.has(p)) continue
        if (on) next.add(p)
        else next.delete(p)
      }
      return next
    })
  }

  async function save() {
    const confirmedPaths = [...confirmed].filter((p) => Object.hasOwn(review.proposed, p))
    const outcome = await action.run((key) => update({ invoiceId, version, aiAssist: { agentActionId: review.agentActionId, confirmedPaths } }, key))
    if (outcome.ok) setChecked(new Set())
  }

  return (
    <div className="flex flex-col gap-3">
      <AiReviewBox
        title={t('invoice.title')}
        fields={fields}
        confirmed={confirmed}
        onConfirm={(path, on) => toggle([path], on)}
        onConfirmRest={() => toggle(fields.filter((f) => !f.required && !confirmed.has(f.path)).map((f) => f.path), true)}
        reading={review.reading}
        notes={review.notes}
        noteText={noteText}
        {...(review.fileId ? { fileUrl: () => openFile(review.fileId!) } : {})}
      />
      <p className="text-ink-muted">{t('invoice.hint')}</p>
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        <Button disabled={action.pending || (unsaved.length === 0 && !done)} onClick={() => void save()}>
          {action.pending ? t('invoice.saving') : t('invoice.save')}
        </Button>
      </div>
      {action.outcome && !action.outcome.ok ? (
        <p role="alert" className="flex items-start gap-1.5 text-danger">
          <CircleAlert className="mt-1 size-4 shrink-0" aria-hidden="true" />
          <span>{errorText(action.outcome)}</span>
        </p>
      ) : null}
    </div>
  )
}
