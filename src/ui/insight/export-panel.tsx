'use client'

import { useTranslations } from 'next-intl'
import { useState } from 'react'
import { Button } from '../form/button'
import { Notice } from '../form/notice'
import { useSubmissionKey } from '../form/submission-key'
import { exportErrorKey, type ExportOutcome } from './outcome'

// Exporting what the page shows as a file (FR-VIS-004 AC2, FR-VIS-002 AC1, FR-VIS-003 AC3): a button per format says
// what it makes; the server writes the file, records the export (an ExportJob and its event) and answers with the number
// of rows and the file's SHA-256, which the page shows so the file can be checked later. The file then downloads through
// a short-lived address the server gives after checking who may open it (FR-PLT-004); a second button asks for a new
// one. The export is a POST with this form's key (§4.3): pressing again before an answer is the same export.

export type ExportFormat = 'xlsx' | 'csv'

export interface ExportPanelProps {
  /** The POST route that runs the export */
  readonly endpoint: string
  /** What the export is of: the audit filter, or the report and its parameters */
  readonly payload: Readonly<Record<string, unknown>>
  readonly formats: readonly ExportFormat[]
  /** Asks the server for the file's download address (null when it may not be opened) */
  readonly open: (fileId: string) => Promise<string | null>
}

export function ExportPanel({ endpoint, payload, formats, open }: ExportPanelProps) {
  const t = useTranslations('reports.export')
  const submission = useSubmissionKey()
  const [pending, setPending] = useState<ExportFormat | null>(null)
  const [outcome, setOutcome] = useState<ExportOutcome | null>(null)
  const [openFailed, setOpenFailed] = useState(false)

  async function download(fileId: string) {
    setOpenFailed(false)
    const url = await open(fileId).catch(() => null)
    if (url) window.location.assign(url)
    else setOpenFailed(true)
  }

  async function run(format: ExportFormat) {
    setPending(format)
    setOutcome(null)
    setOpenFailed(false)
    let result: ExportOutcome
    try {
      const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...payload, format, idempotencyKey: submission.key }) })
      result = (await response.json()) as ExportOutcome
      submission.next()
    } catch {
      // no answer: the key stays, so pressing again is the same export
      result = { ok: false, code: 'FAILED' }
    }
    setPending(null)
    setOutcome(result)
    if (result.ok) await download(result.fileId)
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-3">
        {formats.map((format) => (
          <Button key={format} variant="secondary" onClick={() => void run(format)} disabled={pending !== null} aria-busy={pending === format || undefined}>
            {pending === format ? t('working') : t(format)}
          </Button>
        ))}
      </div>
      <ExportResult outcome={outcome} openFailed={openFailed} onAgain={(fileId) => void download(fileId)} />
    </div>
  )
}

/**
 * What the last export answered: the rows and the checksum with a way to download the file again, or the refusal in
 * words; and when the download did not open, that it did not. The success then says only what was exported, never
 * "the download has started" beside a notice that it did not open (§9.9 rule 7: not vague, one message).
 */
export function ExportResult({ outcome, openFailed, onAgain }: { readonly outcome: ExportOutcome | null; readonly openFailed: boolean; readonly onAgain: (fileId: string) => void }) {
  const t = useTranslations('reports.export')
  return (
    <>
      {outcome?.ok ? (
        <Notice tone="success">
          <p>{t(openFailed ? 'doneNotOpened' : 'done', { count: outcome.rowCount })}</p>
          <p className="break-all">{t('checksum', { checksum: outcome.checksum })}</p>
          <Button variant="link" onClick={() => onAgain(outcome.fileId)}>
            {t('again')}
          </Button>
        </Notice>
      ) : outcome ? (
        <Notice tone="danger">{t(`errors.${exportErrorKey(outcome)}`, { max: String(outcome.max ?? '-'), requestId: outcome.requestId ?? '-' })}</Notice>
      ) : null}
      {openFailed ? <Notice tone="danger">{t('openFailed')}</Notice> : null}
    </>
  )
}
