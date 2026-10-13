'use client'

import { Sparkles } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { useState } from 'react'
import { v4 as uuidv4 } from 'uuid'
import { AiReadingStatus, AiReviewBox, useAiNoteText, type AiFieldView } from '../ai/ai-review'
import type { AiNote, AiReadActions, AiReadingView, AiResultView, AiReview } from '../ai/types'
import { useAiRead } from '../ai/use-ai-read'
import { FileUpload, type FileUploadProps } from '../files/file-upload'
import { cleanQuantity } from './quantity'
import type { ReceiveLineView } from './types'

// "อ่านใบส่งของ" on the receiving page (FR-AI-303 AC4, BR-AI-25, ai-dn-map): the receiver uploads the delivery note,
// the Document Agent reads it for this PO, and the quantity of each PO line it names goes into that line, marked
// "เติมโดย AI โปรดตรวจ". Quantities are confirmed one by one (OQ-147); gr.post refuses until every one is, or changed by
// the receiver (AI_REVIEW_PENDING). Lines the note names with another unit, twice or not at all are left to the receiver.

export interface DeliveryNoteRead {
  readonly review: AiReview
  readonly reading: AiReadingView | null
  readonly notes: readonly AiNote[]
  readonly fileId: string
}

/** A quantity as the server reads it back: no trailing zeros after the point (assist-contract.ts decimalText) */
const plain = (q: string | null) => (q === null ? null : q.includes('.') ? q.replace(/0+$/, '').replace(/\.$/, '') : q)

/** The PO line of a proposed path lines.<poLineId>.received */
const lineIdOf = (path: string) => path.slice('lines.'.length, -'.received'.length)

export function DeliveryNoteReader({
  poId,
  ai,
  uploads,
  disabled,
  onRead,
}: {
  poId: string
  ai: AiReadActions
  uploads: Pick<FileUploadProps, 'requestUpload' | 'completeUpload'>
  disabled: boolean
  onRead: (read: DeliveryNoteRead, received: Readonly<Record<string, string>>) => void
}) {
  const t = useTranslations('aiAssist')
  const { state, read } = useAiRead(ai)
  const [busy, setBusy] = useState(false)

  async function readFile(fileId: string) {
    const result: AiResultView | null = await read({ fileId, purpose: 'DELIVERY_NOTE', subject: { type: 'PURCHASE_ORDER', id: poId } }, uuidv4())
    if (!result) return
    const received = Object.fromEntries(Object.entries(result.proposed).map(([path, value]) => [lineIdOf(path), value]))
    onRead({ review: { agentActionId: result.id, proposed: result.proposed, requiredPaths: result.requiredPaths, confirmed: [] }, reading: result.reading, notes: result.notes, fileId }, received)
  }

  return (
    <section aria-label={t('readDeliveryNote')} className="flex flex-col gap-2 rounded-md border border-line p-4">
      <p className="flex items-center gap-2 font-medium text-ink">
        <Sparkles className="size-4 text-info" aria-hidden="true" />
        {t('readDeliveryNote')}
      </p>
      <p className="text-base text-ink-muted md:text-sm">{t('deliveryNoteHint')}</p>
      <FileUpload
        rule={t('deliveryNoteRule')}
        requestUpload={uploads.requestUpload}
        completeUpload={uploads.completeUpload}
        onUploaded={(file) => void readFile(file.fileId)}
        onBusyChange={setBusy}
        disabled={disabled || busy || state.kind === 'reading'}
      />
      <AiReadingStatus state={state} />
    </section>
  )
}

export function DeliveryNoteReview({
  read,
  lines,
  receivedOf,
  onConfirm,
  fileUrl,
}: {
  read: DeliveryNoteRead
  lines: readonly ReceiveLineView[]
  /** What the receiver has on each line now */
  receivedOf: (lineId: string) => string
  onConfirm: (paths: readonly string[], checked: boolean) => void
  fileUrl: () => Promise<string | null>
}) {
  const t = useTranslations('aiAssist')
  const noteText = useAiNoteText()
  const { review } = read
  const fields: AiFieldView[] = Object.entries(review.proposed).flatMap(([path, value]) => {
    const line = lines.find((l) => l.id === lineIdOf(path))
    return line ? [{ path, label: t('fields.received', { description: line.description }), value: `${value} ${line.uom}`, required: review.requiredPaths.includes(path) }] : []
  })
  // A quantity the receiver changed counts as confirmed (the server compares what is posted with what was proposed)
  const confirmed = new Set([...review.confirmed, ...fields.filter((f) => plain(cleanQuantity(receivedOf(lineIdOf(f.path)))) !== review.proposed[f.path]).map((f) => f.path)])
  return (
    <AiReviewBox
      title={t('deliveryNoteTitle')}
      fields={fields}
      confirmed={confirmed}
      onConfirm={(path, checked) => onConfirm([path], checked)}
      onConfirmRest={() => onConfirm(fields.filter((f) => !f.required && !confirmed.has(f.path)).map((f) => f.path), true)}
      reading={read.reading}
      notes={read.notes}
      noteText={noteText}
      fileUrl={fileUrl}
    />
  )
}
