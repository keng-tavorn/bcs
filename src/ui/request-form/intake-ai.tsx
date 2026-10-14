'use client'

import { Sparkles } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { useEffect, useId, useState } from 'react'
import { v4 as uuidv4 } from 'uuid'
import { amountToSatang, satangToAmount } from '@/core/money/dto'
import { AI_LIMITS } from '@/lib/ai-config'
import { AiReadingStatus, AiReviewBox, type AiFieldView } from '../ai/ai-review'
import type { AiResultOutcome, AiResultView, AiStartOutcome } from '../ai/types'
import { useAiRead } from '../ai/use-ai-read'
import { Button } from '../form/button'
import { Notice } from '../form/notice'
import { textareaClass } from './controls'
import { emptyLine, plainNumber, savableLine, validMoney, validQuantity, type FormAction, type FormLine, type FormValues } from './model'
import { showMoney } from './money'
import type { RequestFormData } from './types'
import { UploadButton, type UploadActions } from './upload-button'

// Step 0 of the request form (FR-AI-302 AC1 AC2, FR-INT-011, docs/sub-specs/S13.md "หน้าจอ"): optional, before the
// details. The requester writes what they need and may attach a quotation or a photo; the Intake Agent fills the title,
// the lines (in place of the lines typed so far), the delivery site and the supplier of the register, each marked
// "เติมโดย AI โปรดตรวจ" and confirmed before the request can be sent (AI_REVIEW_PENDING). A type that fits better is
// offered as a link, never switched by itself; screening questions, budget lines and approvers are never filled. Shown
// only when the Intake Agent is available to this member (EG-1): otherwise the form starts at its details as before.

export interface IntakeActions {
  readonly start: (input: { requestTypeCode: string; text: string; fileIds: string[]; requestId?: string }, idempotencyKey: string) => Promise<AiStartOutcome>
  readonly result: (agentActionId: string) => Promise<AiResultOutcome>
  readonly fileUrl: (fileId: string) => Promise<string | null>
}

type LineField = 'description' | 'quantity' | 'uom' | 'unitPrice'
const LINE_ORDER: readonly LineField[] = ['description', 'quantity', 'uom', 'unitPrice']
const HEAD_ORDER = ['title', 'deliverySiteId', 'suggestedSupplierId']
const decimal = (s: string) => (s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s)

/** The request's value of a proposed path as the server reads it back (requests/ai-assist.ts), to tell a changed one */
function currentValue(values: FormValues, path: string): string | null {
  if (path === 'title') return values.title.trim()
  if (path === 'deliverySiteId') return values.deliverySiteId || null
  if (path === 'suggestedSupplierId') return values.suggestedSupplierId || null
  const m = /^lines\.(\d+)\.(\w+)$/.exec(path)
  const line = m ? values.lines.filter(savableLine)[Number(m[1])] : undefined
  if (!m || !line) return null
  if (m[2] === 'description') return line.description.trim()
  if (m[2] === 'uom') return line.uom.trim()
  if (m[2] === 'quantity') return validQuantity(line.quantity) ? decimal(plainNumber(line.quantity)) : line.quantity
  return validMoney(line.unitPrice) ? satangToAmount(amountToSatang(plainNumber(line.unitPrice))) : line.unitPrice
}

/** The lines the AI proposed, as lines of the form */
function linesOf(proposed: Readonly<Record<string, string>>): FormLine[] {
  const lines: FormLine[] = []
  for (let i = 0; proposed[`lines.${i}.description`] !== undefined; i++) {
    const at = (f: string) => proposed[`lines.${i}.${f}`] ?? ''
    lines.push({ ...emptyLine(uuidv4()), description: at('description'), quantity: at('quantity'), uom: at('uom'), unitPrice: at('unitPrice') })
  }
  return lines
}

export function IntakeAi({
  data,
  values,
  requestId,
  actions,
  uploads,
  update,
}: {
  data: RequestFormData
  values: FormValues
  requestId: string | null
  actions: IntakeActions
  uploads: UploadActions
  update: (action: FormAction) => void
}) {
  const t = useTranslations('aiAssist.intake')
  const id = useId()
  const { state, read } = useAiRead(actions)
  const [text, setText] = useState('')
  const [files, setFiles] = useState<ReadonlyArray<{ fileId: string; fileName: string }>>([])
  const [empty, setEmpty] = useState(false)
  const [result, setResult] = useState<AiResultView | null>(null)
  const review = values.intakeAi ?? null

  // A draft opened again brings its Intake reading back: the better type and the supplier as text come from the server
  useEffect(() => {
    if (!review || result) return
    let live = true
    void actions.result(review.agentActionId).then((r) => {
      if (live && r.ok) setResult(r.result)
    })
    return () => {
      live = false
    }
  }, [review, result, actions])

  async function start() {
    if (!text.trim() && files.length === 0) return setEmpty(true)
    setEmpty(false)
    const done = await read({ requestTypeCode: data.type.code, text, fileIds: files.map((f) => f.fileId), ...(requestId ? { requestId } : {}) }, uuidv4())
    if (!done) return
    setResult(done)
    const p = done.proposed
    const lines = linesOf(p)
    update({
      type: 'intakeFilled',
      review: { agentActionId: done.id, proposed: p, requiredPaths: done.requiredPaths, confirmed: [] },
      patch: {
        ...(p.title !== undefined ? { title: p.title } : {}),
        ...(p.deliverySiteId !== undefined ? { deliverySiteId: p.deliverySiteId } : {}),
        ...(p.suggestedSupplierId !== undefined ? { suggestedSupplierId: p.suggestedSupplierId } : {}),
        ...(lines.length ? { lines } : {}),
      },
    })
  }

  const labelOf = (path: string): string => {
    const m = /^lines\.(\d+)\.(\w+)$/.exec(path)
    if (m) return t(`fields.line.${m[2] as LineField}`, { n: Number(m[1]) + 1 })
    return t(`fields.${path as 'title' | 'deliverySiteId' | 'suggestedSupplierId'}`)
  }
  const shown = (path: string, value: string): string => {
    if (path === 'deliverySiteId') return data.deliverySites?.find((s) => s.id === value)?.name ?? value
    if (path === 'suggestedSupplierId') return data.suppliers?.find((s) => s.id === value)?.name ?? value
    if (path.endsWith('.unitPrice')) return showMoney(value)
    return value
  }

  return (
    <section aria-labelledby={`${id}-title`} className="flex flex-col gap-3 rounded-md border border-line p-4">
      <h3 id={`${id}-title`} className="flex items-center gap-2 font-semibold">
        <Sparkles className="size-4 text-info" aria-hidden="true" />
        {t('title')}
      </h3>
      <p className="text-ink-muted">{t('hint')}</p>
      {review ? null : (
        <>
          <label htmlFor={`${id}-text`} className="font-medium">
            {t('textLabel')}
          </label>
          <textarea id={`${id}-text`} className={textareaClass} rows={4} maxLength={AI_LIMITS.maxInputTextChars} value={text} aria-invalid={empty || undefined} onChange={(e) => setText(e.currentTarget.value)} />
          {files.length ? (
            <ul className="flex flex-col gap-1">
              {files.map((f) => (
                <li key={f.fileId}>{t('fileAttached', { name: f.fileName })}</li>
              ))}
            </ul>
          ) : null}
          <div className="flex flex-wrap items-center gap-3">
            <UploadButton label={t('attach')} actions={uploads} showRule={false} disabled={state.kind === 'reading'} onUploaded={(f) => setFiles((list) => [...list, f])} />
            <Button disabled={state.kind === 'reading'} onClick={() => void start()}>
              <Sparkles className="size-4" aria-hidden="true" />
              {t('start')}
            </Button>
          </div>
          {empty ? <Notice tone="danger">{t('empty')}</Notice> : null}
          <AiReadingStatus state={state} />
        </>
      )}
      {result?.suggestedType ? (
        <Notice tone="info" role="status">
          {t('suggestType', { name: result.suggestedType.name })}{' '}
          <a className="font-medium text-primary underline underline-offset-4" href={`/requests/new/${result.suggestedType.code}`}>
            {t('changeType')}
          </a>
        </Notice>
      ) : null}
      {result?.supplierText ? <Notice tone="info" role="status">{t('supplierText', { name: result.supplierText })}</Notice> : null}
      {review ? (
        <IntakeReview values={values} review={review} labelOf={labelOf} shown={shown} update={update} />
      ) : null}
    </section>
  )
}

function IntakeReview({
  values,
  review,
  labelOf,
  shown,
  update,
}: {
  values: FormValues
  review: NonNullable<FormValues['intakeAi']>
  labelOf: (path: string) => string
  shown: (path: string, value: string) => string
  update: (action: FormAction) => void
}) {
  const t = useTranslations('aiAssist.intake')
  // In the order of the form: the title, the site, the supplier, then each line's item, quantity, unit and price
  const rank = (path: string) => {
    const m = /^lines\.(\d+)\.(\w+)$/.exec(path)
    return m ? 10 + Number(m[1]) * 10 + LINE_ORDER.indexOf(m[2] as LineField) : HEAD_ORDER.indexOf(path)
  }
  const fields: AiFieldView[] = Object.entries(review.proposed).sort(([a], [b]) => rank(a) - rank(b)).map(([path, value]) => ({ path, label: labelOf(path), value: shown(path, value), required: review.requiredPaths.includes(path) }))
  // A value the requester changed counts as confirmed (the server compares what is saved with what was proposed)
  const confirmed = new Set([...review.confirmed, ...Object.entries(review.proposed).filter(([path, value]) => currentValue(values, path) !== value).map(([path]) => path)])
  return (
    <AiReviewBox
      title={t('boxTitle')}
      fields={fields}
      confirmed={confirmed}
      onConfirm={(path, checked) => update({ type: 'intakeConfirm', paths: [path], checked })}
      onConfirmRest={() => update({ type: 'intakeConfirm', paths: fields.filter((f) => !f.required && !confirmed.has(f.path)).map((f) => f.path), checked: true })}
      reading={null}
      notes={[]}
      noteText={(n) => n.code}
    />
  )
}
