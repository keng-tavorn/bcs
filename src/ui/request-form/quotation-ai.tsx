'use client'

import { Sparkles } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { useEffect, useState } from 'react'
import { v4 as uuidv4 } from 'uuid'
import { amountToSatang, satangToAmount } from '@/core/money/dto'
import { AiReadingStatus, AiReviewBox, useAiNoteText, type AiFieldView } from '../ai/ai-review'
import type { AiNote, AiReadActions, AiReadingView } from '../ai/types'
import { useAiRead } from '../ai/use-ai-read'
import { Button } from '../form/button'
import { plainNumber, validMoney, type FormAction, type FormQuotation } from './model'
import { showMoney } from './money'

// Reading a quotation's file with the Document Agent (FR-AI-303 AC1 AC3, BR-AI-25): the requester presses "อ่านจากไฟล์"
// once the quotation has its file; the values come back into the quotation — the supplier of the register when its tax
// id and branch match, the amount when the totals passed the checks, whether it includes VAT — each marked
// "เติมโดย AI โปรดตรวจ", and the requester confirms them before the request can be sent (AI_REVIEW_PENDING). A value they
// change counts as confirmed. The form's next save tells the server what they confirmed (aiAssist).

const FIELDS = ['supplierName', 'supplierId', 'amount', 'includesVat'] as const

/** The quotation's value of a field as the server reads it back (requests/ai-assist.ts), to tell a changed one */
function currentValue(q: FormQuotation, field: (typeof FIELDS)[number]): string | null {
  if (field === 'supplierName') return q.supplierName.trim()
  if (field === 'supplierId') return q.supplierId
  if (field === 'includesVat') return String(q.includesVat)
  return validMoney(q.amount) ? satangToAmount(amountToSatang(plainNumber(q.amount))) : q.amount
}

export interface QuotationAiProps {
  readonly q: FormQuotation
  readonly n: number
  readonly ai: { readonly actions: AiReadActions; readonly requestId: string | null }
  readonly update: (action: FormAction) => void
}

export function QuotationAi({ q, n, ai, update }: QuotationAiProps) {
  const t = useTranslations('aiAssist')
  const { state, read } = useAiRead(ai.actions)
  const noteText = useAiNoteText()
  const [details, setDetails] = useState<{ reading: AiReadingView | null; notes: readonly AiNote[] } | null>(null)
  const reviewId = q.ai?.agentActionId ?? null

  // A draft opened again brings its AI reading back: what was read and what the checks found come from the server
  useEffect(() => {
    if (!reviewId || details) return
    let live = true
    void ai.actions.result(reviewId).then((r) => {
      if (live && r.ok) setDetails({ reading: r.result.reading, notes: r.result.notes })
    })
    return () => {
      live = false
    }
  }, [reviewId, details, ai.actions])

  if (!q.fileId) return null
  const fileId = q.fileId
  const at = `quotations.${fileId}`

  async function start() {
    const result = await read({ fileId, purpose: 'QUOTATION', ...(ai.requestId ? { subject: { type: 'REQUEST' as const, id: ai.requestId } } : {}) }, uuidv4())
    if (!result) return
    const proposed = Object.fromEntries(Object.entries(result.proposed).filter(([path]) => path.startsWith(`${at}.`)))
    const value = (field: string) => proposed[`${at}.${field}`]
    const amount = value('amount')
    const includesVat = value('includesVat')
    setDetails({ reading: result.reading, notes: result.notes })
    update({
      type: 'aiFilled',
      key: q.key,
      review: { agentActionId: result.id, proposed, requiredPaths: result.requiredPaths.filter((p) => p.startsWith(`${at}.`)), confirmed: [] },
      patch: {
        ...(value('supplierName') !== undefined ? { supplierName: value('supplierName')! } : {}),
        ...(value('supplierId') !== undefined ? { supplierId: value('supplierId')! } : {}),
        ...(amount !== undefined ? { amount } : {}),
        ...(includesVat !== undefined ? { includesVat: includesVat === 'true' } : {}),
      },
    })
  }

  if (!q.ai) {
    return (
      <div className="flex flex-col gap-2">
        {state.kind !== 'reading' ? (
          <Button variant="secondary" className="self-start" onClick={() => void start()} aria-label={t('readQuotation', { n })}>
            <Sparkles className="size-4" aria-hidden="true" />
            {t('readButton')}
          </Button>
        ) : null}
        <AiReadingStatus state={state} />
      </div>
    )
  }

  const review = q.ai
  const fields: AiFieldView[] = FIELDS.flatMap((field) => {
    const path = `${at}.${field}`
    const proposed = review.proposed[path]
    if (proposed === undefined) return []
    const shown =
      field === 'amount' ? showMoney(proposed) : field === 'includesVat' ? t(proposed === 'true' ? 'values.yes' : 'values.no') : field === 'supplierId' ? (review.proposed[`${at}.supplierName`] ?? proposed) : proposed
    return [{ path, label: t(`fields.${field}`), value: shown, required: review.requiredPaths.includes(path) }]
  })
  // Confirmed: ticked by the requester, or changed by them since (the server counts a changed value as confirmed)
  const confirmed = new Set([...review.confirmed, ...FIELDS.map((f) => `${at}.${f}`).filter((path) => review.proposed[path] !== undefined && review.proposed[path] !== currentValue(q, path.slice(at.length + 1) as (typeof FIELDS)[number]))])
  return (
    <AiReviewBox
      title={t('quotationTitle', { n })}
      fields={fields}
      confirmed={confirmed}
      onConfirm={(path, checked) => update({ type: 'aiConfirm', key: q.key, paths: [path], checked })}
      onConfirmRest={() => update({ type: 'aiConfirm', key: q.key, paths: fields.filter((f) => !f.required && !confirmed.has(f.path)).map((f) => f.path), checked: true })}
      reading={details?.reading ?? null}
      notes={details?.notes ?? []}
      noteText={noteText}
      fileUrl={() => ai.actions.fileUrl(fileId)}
    />
  )
}
