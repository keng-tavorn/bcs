'use client'

import { CircleAlert, Sparkles } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useId, useState } from 'react'
import { v4 as uuidv4 } from 'uuid'
import { AiReadingStatus } from '../../ai/ai-review'
import type { AiReadActions } from '../../ai/types'
import { useAiRead } from '../../ai/use-ai-read'
import { useSubmissionKey } from '../../form/submission-key'
import { Button } from '../../shadcn/button'
import { Card, CardContent, CardHeader, CardTitle } from '../../shadcn/card'
import { Combobox } from '../../shadcn/combobox'
import { Label } from '../../shadcn/label'
import { apErrorKey } from './failure'
import { AP_FILE_ACCEPT, AP_FILE_MAX_BYTES, AP_FILE_MAX_MIB } from './limits'
import { AP_NO_ANSWER, type ApDraftOutcome, type ApFailure, type ApFileOutcome } from './outcome'

// /finance/invoices/new (S8-13, FR-AP-101 AC1): FINANCE chooses the PO (a Combobox that searches by PO number or
// supplier), then uploads the supplier's file (PDF, XML, JPEG or PNG) or starts without one; the draft opens next
// (/finance/invoices/<id>). The file goes to ./new/file (a route: a server action takes 1 MB at most), then the draft is
// made with the file the server kept. A file already kept for the same PO is not sent again when the draft is retried.
// The draft's idempotencyKey follows the form (spec §4.3). Errors stay as a line under the buttons (§9.9).

export interface PoChoiceView {
  readonly value: string
  readonly label: string
  readonly summary: string
}

type Create = (input: { poId: string; sourceFileId: string | null }, idempotencyKey: string) => Promise<ApDraftOutcome>

/** S13-20 (FR-AI-303 AC6): the Document Agent reads the file for the PO, then the draft is made from its reading */
export interface NewInvoiceAi {
  readonly read: AiReadActions
  readonly createFromReading: (input: { agentActionId: string }, idempotencyKey: string) => Promise<ApDraftOutcome>
}

async function sendFile(poId: string, file: File): Promise<ApFileOutcome> {
  try {
    const response = await fetch(`/finance/invoices/new/file?po=${encodeURIComponent(poId)}`, {
      method: 'POST',
      body: file,
      headers: { 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent(file.name) },
    })
    return (await response.json()) as ApFileOutcome
  } catch {
    return AP_NO_ANSWER
  }
}

export function NewInvoiceForm({ pos, create, ai }: { pos: readonly PoChoiceView[]; create: Create; ai?: NewInvoiceAi }) {
  const t = useTranslations('apList.new')
  const tai = useTranslations('aiAssist.invoice')
  const reader = useAiRead(ai?.read)
  // The draft from a reading has its own submission key, and the reading of a kept file is made once: a retry after no
  // answer sends the same reading with the same key (spec §4.3), and never pays for the same file twice
  const aiSubmission = useSubmissionKey()
  const [readOf, setReadOf] = useState<{ poId: string; fileId: string; agentActionId: string } | null>(null)
  const te = useTranslations('apList.errors')
  const router = useRouter()
  const submission = useSubmissionKey()
  const poId = useId()
  const fileId = useId()
  const [po, setPo] = useState<string | null>(null)
  const [file, setFile] = useState<File | null>(null)
  const [kept, setKept] = useState<{ poId: string; file: File; fileId: string } | null>(null)
  const [stage, setStage] = useState<'uploading' | 'reading' | 'creating' | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const chosen = pos.find((p) => p.value === po) ?? null

  const fail = (failure: ApFailure) => {
    setProblem(te(apErrorKey(failure)))
    setStage(null)
  }

  /** The chosen file kept for the PO (sent once per PO and file), or null after saying what is missing */
  async function keptFile(poId: string): Promise<string | null> {
    if (!file) {
      setProblem(t('pickFileFirst'))
      return null
    }
    if (file.size > AP_FILE_MAX_BYTES) {
      setProblem(t('fileTooLarge', { mib: AP_FILE_MAX_MIB }))
      return null
    }
    if (kept && kept.poId === poId && kept.file === file) return kept.fileId
    setStage('uploading')
    const uploaded = await sendFile(poId, file)
    if (!uploaded.ok) {
      fail(uploaded)
      return null
    }
    setKept({ poId, file, fileId: uploaded.fileId })
    return uploaded.fileId
  }

  async function start(withFile: boolean) {
    setProblem(null)
    if (!po) return setProblem(t('pickPoFirst'))
    let sourceFileId: string | null = null
    if (withFile) {
      sourceFileId = await keptFile(po)
      if (!sourceFileId) return
    }
    setStage('creating')
    let outcome: ApDraftOutcome
    try {
      outcome = await create({ poId: po, sourceFileId }, submission.key)
      submission.next()
    } catch {
      outcome = AP_NO_ANSWER
    }
    if (!outcome.ok) return fail(outcome)
    router.push(`/finance/invoices/${outcome.invoiceId}`)
  }

  /** "อ่านไฟล์ด้วย AI": the reading waits in the background; the draft opens with every value waiting for FINANCE */
  async function readWithAi() {
    setProblem(null)
    if (!ai) return
    if (!po) return setProblem(t('pickPoFirst'))
    const fileId = await keptFile(po)
    if (!fileId) return
    let agentActionId = readOf && readOf.poId === po && readOf.fileId === fileId ? readOf.agentActionId : null
    if (!agentActionId) {
      setStage('reading')
      const result = await reader.read({ fileId, purpose: 'INVOICE', subject: { type: 'PURCHASE_ORDER', id: po } }, uuidv4())
      // A refusal or a failed reading says why under the buttons (AiReadingStatus); the file stays kept for the other buttons
      if (!result) return setStage(null)
      agentActionId = result.id
      setReadOf({ poId: po, fileId, agentActionId })
    }
    setStage('creating')
    let outcome: ApDraftOutcome
    try {
      outcome = await ai.createFromReading({ agentActionId }, aiSubmission.key)
      aiSubmission.next()
    } catch {
      outcome = AP_NO_ANSWER
    }
    if (!outcome.ok) return fail(outcome)
    router.push(`/finance/invoices/${outcome.invoiceId}`)
  }

  const busy = stage !== null
  return (
    <form
      className="flex max-w-3xl flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault()
        void start(true)
      }}
    >
      <Card className="gap-3 bg-bg text-base">
        <CardHeader>
          <CardTitle>
            <h2 className="text-base font-semibold">{t('poTitle')}</h2>
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <Label htmlFor={poId} className="text-base text-ink">
            {t('poLabel')}
          </Label>
          <p id={`${poId}-hint`} className="text-ink-muted">
            {t('poHint')}
          </p>
          <Combobox
            id={poId}
            options={pos.map((p) => ({ value: p.value, label: p.label }))}
            value={po}
            onValueChange={(value) => {
              setPo(value)
              setProblem(null)
            }}
            placeholder={t('pick')}
            searchPlaceholder={t('search')}
            emptyText={t('noPo')}
            className="min-h-11 text-base"
          />
          {chosen ? <p className="text-ink">{chosen.summary}</p> : null}
        </CardContent>
      </Card>

      <Card className="gap-3 bg-bg text-base">
        <CardHeader>
          <CardTitle>
            <h2 className="text-base font-semibold">{t('fileTitle')}</h2>
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <span id={`${fileId}-label`} className="font-medium text-ink">
            {t('fileLabel')}
          </span>
          <p id={`${fileId}-hint`} className="text-ink-muted">
            {t('fileHint', { mib: AP_FILE_MAX_MIB })}
          </p>
          {/* Our own button and file-name text instead of the browser's, which follows the browser language (§9.9) */}
          <div className="flex flex-wrap items-center gap-3">
            <label className="inline-flex h-11 cursor-pointer items-center rounded-md border border-input bg-bg px-4 font-medium text-ink hover:bg-surface has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-primary">
              {t('chooseFile')}
              <input
                id={fileId}
                name="file"
                type="file"
                accept={AP_FILE_ACCEPT}
                aria-labelledby={`${fileId}-label`}
                aria-describedby={`${fileId}-hint ${fileId}-name`}
                disabled={busy}
                onChange={(event) => {
                  setFile(event.currentTarget.files?.[0] ?? null)
                  setProblem(null)
                }}
                className="sr-only"
              />
            </label>
            <span id={`${fileId}-name`} className="min-w-0 break-all text-ink-muted">
              {file?.name ?? t('noFileChosen')}
            </span>
          </div>
        </CardContent>
      </Card>

      {problem ? (
        <p role="alert" className="flex items-start gap-1.5 text-danger">
          <CircleAlert className="mt-1 size-4 shrink-0" aria-hidden="true" />
          <span>{problem}</span>
        </p>
      ) : null}
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        <Button type="submit" disabled={busy} className="min-h-11 px-4 text-base md:text-base">
          {stage === 'uploading' ? t('uploading') : stage === 'creating' ? t('creating') : t('submitFile')}
        </Button>
        {ai ? (
          <Button type="button" variant="outline" disabled={busy} className="min-h-11 px-4 text-base md:text-base" aria-describedby={`${fileId}-ai`} onClick={() => void readWithAi()}>
            <Sparkles className="size-4 text-info" aria-hidden="true" />
            {tai('read')}
          </Button>
        ) : null}
        <Button type="button" variant="outline" disabled={busy} className="min-h-11 px-4 text-base md:text-base" onClick={() => void start(false)}>
          {t('submitNoFile')}
        </Button>
      </div>
      {ai ? (
        <p id={`${fileId}-ai`} className="text-ink-muted">
          {tai('readHint')}
        </p>
      ) : null}
      <AiReadingStatus state={reader.state} />
    </form>
  )
}
