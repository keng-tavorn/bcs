'use client'

import { Sparkles } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { useId, useState } from 'react'
import { Button } from '../form/button'
import { Notice } from '../form/notice'
import { Badge } from '../shadcn/badge'
import { Checkbox } from '../shadcn/checkbox'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '../shadcn/sheet'
import { Spinner } from '../shadcn/spinner'
import type { AiNote, AiReadingView } from './types'
import type { AiReadState } from './use-ai-read'

// The values an AI filled in, beside what it read (FR-AI-303 AC1, BR-AI-02, BR-AI-16, OQ-147, docs/sub-specs/S13.md
// "หน้าจอ"): every value carries "เติมโดย AI โปรดตรวจ"; a field that must be confirmed on its own (money, quantities, tax
// ids, branches, and anything a check flagged or below the organization's confidence) is highlighted with --warn and
// has its own "ยืนยันแล้ว"; the others are confirmed together by a button the person presses. The original file opens in
// a sheet beside the form, drawn by the browser (no PDF library: §5.5). Workspace only (ADR-052).

export interface AiFieldView {
  readonly path: string
  readonly label: string
  readonly value: string
  readonly required: boolean
}

/** What a note of the checks or of the mapping says, with its line; a code without words of its own shows as it is */
export function useAiNoteText(): (note: AiNote) => string {
  const t = useTranslations('aiAssist.notes')
  return (note) => {
    const key = note.code as 'CURRENCY'
    return t.has(key) ? t(key, { line: note.line ?? '' }) : note.code
  }
}

export function AiReadingStatus({ state }: { state: AiReadState }) {
  const t = useTranslations('aiAssist')
  const te = useTranslations('errors')
  if (state.kind === 'reading') {
    return (
      <p className="flex items-center gap-2 text-ink-muted" role="status">
        <Spinner aria-hidden="true" role="presentation" />
        <span>{t('reading')}</span>
      </p>
    )
  }
  if (state.kind !== 'failed') return null
  const known = ['AI_AGENT_DISABLED', 'AI_CREDITS_EXHAUSTED', 'AI_NOT_EVALUATED', 'MODULE_DISABLED', 'RATE_LIMITED'].includes(state.code)
  const text =
    state.code === 'AI_FILE_UNSUPPORTED'
      ? state.reason === 'ETAX'
        ? t('failed.etax')
        : t('failed.unsupported')
      : known
        ? te(state.code as 'AI_AGENT_DISABLED', { agent: t('documentAgent'), retryAfterSeconds: 60, reason: 'AI' })
        : t('failed.general')
  return <Notice tone="warning">{text}</Notice>
}

export function AiReviewBox({
  title,
  fields,
  confirmed,
  onConfirm,
  onConfirmRest,
  reading,
  notes,
  noteText,
  fileUrl,
}: {
  title: string
  fields: readonly AiFieldView[]
  confirmed: ReadonlySet<string>
  onConfirm: (path: string, checked: boolean) => void
  onConfirmRest: () => void
  reading: AiReadingView | null
  notes: readonly AiNote[]
  noteText: (note: AiNote) => string
  fileUrl?: () => Promise<string | null>
}) {
  const t = useTranslations('aiAssist')
  const id = useId()
  const [url, setUrl] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const waiting = fields.filter((f) => !confirmed.has(f.path))
  const rest = waiting.filter((f) => !f.required)

  async function openFile() {
    if (!fileUrl) return
    setUrl(await fileUrl())
    setOpen(true)
  }

  return (
    <section aria-labelledby={`${id}-title`} className="flex flex-col gap-3 rounded-md border border-info bg-bg p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 id={`${id}-title`} className="font-semibold">
          {title}
        </h4>
        <Badge variant="info" className="text-base md:text-sm">
          <Sparkles aria-hidden="true" />
          {t('badge')}
        </Badge>
      </div>
      <p className="text-ink-muted" role="status">
        {waiting.length ? t('waiting', { count: waiting.length }) : t('allConfirmed')}
      </p>
      {notes.length ? (
        <ul className="flex flex-col gap-2">
          {notes.map((n, i) => (
            <li key={`${n.code}-${n.line ?? i}`}>
              <Notice tone={n.tone} role="status">
                {noteText(n)}
              </Notice>
            </li>
          ))}
        </ul>
      ) : null}
      <ul className="flex flex-col gap-2">
        {fields.map((f) => {
          const box = `${id}-${f.path}`
          return (
            <li key={f.path} className={`flex flex-wrap items-center justify-between gap-x-4 gap-y-1 rounded-md border p-3 ${f.required && !confirmed.has(f.path) ? 'border-warn bg-warn-bg' : 'border-line'}`}>
              <div className="flex min-w-0 flex-col">
                <span className="text-ink-muted">{f.label}</span>
                <span className="break-words font-medium">{f.value}</span>
                {f.required ? <span className="text-base text-warn-ink md:text-sm">{t('mustConfirm')}</span> : null}
              </div>
              <label htmlFor={box} className="flex min-h-11 items-center gap-2">
                <Checkbox id={box} checked={confirmed.has(f.path)} onCheckedChange={(v) => onConfirm(f.path, v === true)} aria-label={t('confirmField', { field: f.label })} />
                <span>{t('confirmed')}</span>
              </label>
            </li>
          )
        })}
      </ul>
      <div className="flex flex-wrap gap-3">
        {/* Only fields that may be confirmed together; when every one is confirmed on its own there is no such button */}
        {fields.some((f) => !f.required) ? (
          <Button variant="secondary" disabled={rest.length === 0} onClick={onConfirmRest}>
            {t('confirmRest', { count: rest.length })}
          </Button>
        ) : null}
        {fileUrl ? (
          <Button variant="link" className="min-h-11" onClick={() => void openFile()}>
            {t('openFile')}
          </Button>
        ) : null}
      </div>
      {reading ? <ReadingFacts reading={reading} /> : null}
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent className="w-full sm:max-w-xl">
          <SheetHeader>
            <SheetTitle>{t('fileTitle')}</SheetTitle>
            <SheetDescription>{t('fileHint')}</SheetDescription>
          </SheetHeader>
          {url ? <iframe title={t('fileTitle')} src={url} className="h-[75vh] w-full rounded-md border border-line" /> : <p className="px-4">{t('fileMissing')}</p>}
        </SheetContent>
      </Sheet>
    </section>
  )
}

function ReadingFacts({ reading }: { reading: AiReadingView }) {
  const t = useTranslations('aiAssist.read')
  const dash = '—'
  const rows: Array<[string, string | null]> = [
    [t('seller'), reading.sellerName],
    [t('sellerTaxId'), reading.sellerTaxId],
    [t('sellerBranch'), reading.sellerBranch],
    [t('docNo'), reading.docNo],
    [t('docDate'), reading.docDate],
    [t('net'), reading.net],
    [t('vat'), reading.vat],
    [t('gross'), reading.gross],
    [t('includesVat'), reading.priceIncludesVat === null ? null : reading.priceIncludesVat ? t('yes') : t('no')],
  ]
  return (
    <details className="rounded-md border border-line p-3">
      <summary className="min-h-11 cursor-pointer content-center font-medium">{t('title', { lines: reading.lines.length })}</summary>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-ink-muted">{label}</dt>
            <dd className="break-words tabular">{value ?? dash}</dd>
          </div>
        ))}
      </dl>
      {reading.lines.length ? (
        <ol className="mt-2 flex list-decimal flex-col gap-1 pl-6">
          {reading.lines.map((l, i) => (
            <li key={i} className="break-words">
              {t('line', { description: l.description ?? dash, qty: l.qty ?? dash, unit: l.unit ?? '', amount: l.amount ?? dash })}
            </li>
          ))}
        </ol>
      ) : null}
    </details>
  )
}
