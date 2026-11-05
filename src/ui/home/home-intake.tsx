'use client'

import { ArrowRight, Search, Sparkles } from 'lucide-react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { useId, useState } from 'react'
import { v4 as uuidv4 } from 'uuid'
import { AI_LIMITS } from '@/lib/ai-config'
import { AiReadingStatus } from '../ai/ai-review'
import type { AiResultView } from '../ai/types'
import { useAiRead } from '../ai/use-ai-read'
import { Notice } from '../form/notice'
import { DropUploadButton } from '../request-form/drop-upload'
import type { IntakeActions } from '../request-form/intake-ai'
import type { UploadActions } from '../request-form/upload-button'
import { Button } from '../shadcn/button'
import { Kbd } from '../shadcn/kbd'
import { Textarea } from '../shadcn/textarea'
import { openPalette } from '../shell/shell-events'

// The home page's box "บอกสิ่งที่อยากได้" (NEW-120, docs/reports/bcs-assistants.md "หน้าแรก", FR-AI-302): in the greeting
// in place of the search field, only when the Intake Agent is available to a member who may start a request (otherwise
// the search field stays). The requester writes what they need or drops a quotation; the Intake Agent proposes the type
// of request and the supplier of the register, and the button opens that type's form with the draft filled in to be
// checked there. Nothing is created or sent here (BR-AI-01): the form's own autosave and "ส่ง" are the requester's.
// The palette (⌘K) stays a button away.

/** Pointed at, a main button keeps its --primary fill and underlines its words (form/button.tsx: 4.5:1 on hover too) */
const PRIMARY = 'min-h-11 underline-offset-4 hover:bg-primary hover:underline'

export function HomeIntake({ actions, uploads, shortcut }: { actions: IntakeActions; uploads: UploadActions; shortcut: string }) {
  const t = useTranslations('home.intake')
  const id = useId()
  const { state, read, reset } = useAiRead(actions)
  const [text, setText] = useState('')
  const [files, setFiles] = useState<ReadonlyArray<{ fileId: string; fileName: string }>>([])
  const [empty, setEmpty] = useState(false)
  const [result, setResult] = useState<AiResultView | null>(null)
  const reading = state.kind === 'reading'

  async function start() {
    if (!text.trim() && files.length === 0) return setEmpty(true)
    setEmpty(false)
    const done = await read({ text, fileIds: files.map((f) => f.fileId) }, uuidv4())
    if (done) setResult(done)
  }
  function again() {
    setResult(null)
    setText('')
    setFiles([])
    reset()
  }

  return (
    <section aria-labelledby={`${id}-label`} className="flex w-full max-w-[560px] flex-col gap-3 text-left">
      {result ? (
        <Proposal result={result} onAgain={again} />
      ) : (
        <>
          <label id={`${id}-label`} htmlFor={`${id}-text`} className="font-medium">
            {t('label')}
          </label>
          <Textarea
            id={`${id}-text`}
            rows={2}
            maxLength={AI_LIMITS.maxInputTextChars}
            placeholder={t('placeholder')}
            value={text}
            disabled={reading}
            aria-invalid={empty || undefined}
            aria-describedby={`${id}-hint`}
            className="min-h-12 text-base"
            onChange={(e) => {
              setText(e.currentTarget.value)
              setEmpty(false)
            }}
          />
          <p id={`${id}-hint`} className="text-sm text-ink-muted">
            {t('hint')}
          </p>
          {files.length ? (
            <ul className="flex flex-col gap-1">
              {files.map((f) => (
                <li key={f.fileId}>{t('fileAttached', { name: f.fileName })}</li>
              ))}
            </ul>
          ) : null}
          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" disabled={reading} onClick={() => void start()} className={PRIMARY}>
              <Sparkles aria-hidden="true" />
              {t('start')}
            </Button>
            <Button type="button" variant="ghost" onClick={openPalette} aria-haspopup="dialog" className="min-h-11">
              <Search aria-hidden="true" />
              {t('search')}
              <Kbd className="hidden sm:inline-flex">{shortcut}</Kbd>
            </Button>
          </div>
          <DropUploadButton label={t('attach')} actions={uploads} showRule={false} disabled={reading} onUploaded={(f) => setFiles((list) => [...list, f])} />
          {empty ? <Notice tone="danger">{t('empty')}</Notice> : null}
          <AiReadingStatus state={state} />
        </>
      )}
    </section>
  )
}

/** What the Intake Agent proposed: the type, the supplier, and the button that opens the form with the draft */
function Proposal({ result, onAgain }: { result: AiResultView; onAgain: () => void }) {
  const t = useTranslations('home.intake')
  const id = useId()
  const type = result.proposedType
  const supplier = result.supplierName ? t('supplierFound', { name: result.supplierName }) : result.supplierText ? t('supplierText', { name: result.supplierText }) : t('supplierNone')
  return (
    <div role="region" aria-labelledby={`${id}-title`} className="flex flex-col gap-3 rounded-md border border-line p-4">
      <h2 id={`${id}-title`} className="flex items-center gap-2 font-semibold">
        <Sparkles className="size-4 text-info" aria-hidden="true" />
        {t('proposalTitle')}
      </h2>
      {type ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
          <dt className="text-ink-muted">{t('type')}</dt>
          <dd className="font-medium">{type.name}</dd>
          <dt className="text-ink-muted">{t('supplier')}</dt>
          <dd>{supplier}</dd>
        </dl>
      ) : (
        <Notice tone="info" role="status">
          {t('noType')}
        </Notice>
      )}
      <p className="text-sm text-ink-muted">{t('notSent')}</p>
      <div className="flex flex-wrap items-center gap-3">
        <Button asChild className={PRIMARY}>
          <Link href={type ? `/requests/new/${encodeURIComponent(type.code)}?intake=${result.id}` : '/requests/new'}>
            {type ? t('open', { type: type.name }) : t('pickType')}
            <ArrowRight aria-hidden="true" />
          </Link>
        </Button>
        <Button type="button" variant="outline" onClick={onAgain} className="min-h-11">
          {t('again')}
        </Button>
      </div>
    </div>
  )
}
