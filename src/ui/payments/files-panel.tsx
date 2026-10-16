'use client'

import { Download } from 'lucide-react'
import { useLocale, useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Button } from '../form/button'
import { Notice } from '../form/notice'
import { formatDateTime } from '../format'
import { FileStatusBadge } from './badges'
import { ConfirmDialog } from './confirm-dialog'
import { money } from './present'
import { nameIn, type PayAction, type RunFileView } from './types'
import { usePayAction, usePayErrorText } from './use-pay-action'

// The bank files of a payment run (S9-09, FR-PAY-102 AC1 to AC6, FR-PAY-101 AC11, BR-BANK-03 to BR-BANK-08, BR-PAY-10
// BR-PAY-11): every version, newest first, with its checksum, item count, total, who made it and when, when it was
// first downloaded, and whether it is the one in use or an old file. FINANCE makes the file of an approved run, makes it
// again with a reason (after a download only with the word that it was not sent to the bank), downloads the version in
// use — a POST command that records the download and answers an address of five minutes, opened at once (never a GET
// that changes anything) — marks the run sent to the bank once it was downloaded and takes that back with a reason, and
// cancels an approved run. Each of these is asked first in an Alert Dialog, except making the first file and the
// download.

export interface FilesPanelProps {
  readonly paymentRunId: string
  readonly version: number
  readonly status: string
  readonly files: readonly RunFileView[]
  readonly downloaded: { readonly any: boolean; readonly current: boolean }
  readonly may: { readonly generate: boolean; readonly regenerate: boolean; readonly download: boolean; readonly markSent: boolean; readonly revertSent: boolean; readonly cancelApproved: boolean }
  readonly actions: { readonly generateFile: PayAction; readonly regenerateFile: PayAction; readonly downloadFile: PayAction; readonly markSent: PayAction; readonly revertSent: PayAction; readonly cancelApproved: PayAction }
}

export function FilesPanel({ paymentRunId, version, status, files, downloaded, may, actions }: FilesPanelProps) {
  const t = useTranslations('payRun')
  const locale = useLocale()
  const errorText = usePayErrorText()
  const generate = usePayAction()
  const download = usePayAction()
  const current = files.find((f) => f.status === 'CURRENT') ?? null

  async function onGenerate() {
    const outcome = await generate.run((key) => actions.generateFile({ paymentRunId, version }, key))
    if (outcome.ok) toast.success(t('files.generatedNow'))
  }

  async function onDownload(file: RunFileView) {
    const outcome = await download.run((key) => actions.downloadFile({ paymentRunId, paymentFileId: file.id }, key))
    if (outcome.ok && outcome.url) {
      window.location.assign(outcome.url)
      toast.success(t('files.downloadedNow'))
    }
  }

  const empty = status === 'APPROVED' ? t('files.emptyApproved') : t('files.emptyNotYet')
  return (
    <section aria-labelledby="run-files-title" className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 id="run-files-title" className="text-base font-semibold text-ink">
          {t('files.title')}
        </h2>
        <p className="text-ink-muted">{t('files.hint')}</p>
      </div>

      {files.length === 0 ? (
        <div className="flex flex-col gap-1">
          <p className="font-medium text-ink">{t('files.empty')}</p>
          <p className="text-ink-muted">{empty}</p>
        </div>
      ) : (
        <ul aria-label={t('files.list')} className="flex flex-col divide-y divide-line border-y border-line">
          {files.map((f) => (
            <li key={f.id} className="flex flex-col gap-1.5 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold text-ink">{t('files.version', { version: f.version })}</span>
                <FileStatusBadge status={f.status} label={f.status === 'CURRENT' ? t('files.current') : t('files.superseded')} />
              </div>
              <span className="break-all text-ink">{f.fileName}</span>
              <span className="text-ink-muted">
                {t('files.items', { count: f.itemCount })} · <span className="money">{t('files.total', { amount: money(f.totalSatang) })}</span>
              </span>
              <span className="tabular break-all text-ink-muted">{t('files.sha', { sha: f.sha256Short })}</span>
              <span className="text-ink-muted">{t('files.generated', { name: nameIn(locale, f.generatedBy), time: formatDateTime(locale, f.generatedAt) })}</span>
              <span className="text-ink-muted">{f.firstDownloadedAt ? t('files.downloaded', { time: formatDateTime(locale, f.firstDownloadedAt) }) : t('files.notDownloaded')}</span>
              {f.reason ? <span className="break-words text-ink">{t('files.reason', { reason: f.reason })}</span> : null}
              {may.download && f.status === 'CURRENT' ? (
                <Button variant="secondary" className="mt-1 self-start" disabled={download.pending} aria-busy={download.pending || undefined} onClick={() => void onDownload(f)}>
                  <Download aria-hidden="true" className="size-4 shrink-0" />
                  <span className="text-left break-all">{download.pending ? t('files.downloading') : t('files.download', { name: f.fileName })}</span>
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {download.outcome && !download.outcome.ok ? <Notice tone="danger">{errorText(download.outcome)}</Notice> : null}

      {may.generate ? (
        <div className="flex flex-col gap-2">
          <Button className="self-start" disabled={generate.pending} aria-busy={generate.pending || undefined} onClick={() => void onGenerate()}>
            {generate.pending ? t('files.generating') : t('files.generate')}
          </Button>
          {generate.outcome && !generate.outcome.ok ? <Notice tone="danger">{errorText(generate.outcome)}</Notice> : null}
        </div>
      ) : null}

      {may.markSent && current ? (
        <div className="flex flex-col gap-2">
          <p className="text-ink-muted">{downloaded.current ? t('files.markSentHint') : t('files.markSentNeedsDownload')}</p>
          <ConfirmDialog
            trigger={t('files.markSent')}
            triggerVariant="primary"
            disabled={!downloaded.current}
            title={t('files.markSentTitle')}
            hint={t('files.markSentText', { version: current.version })}
            confirm={t('files.markSentConfirm')}
            busy={t('files.marking')}
            done={() => t('files.marked')}
            run={(_, key) => actions.markSent({ paymentRunId, version }, key)}
          />
        </div>
      ) : null}

      {may.regenerate || may.revertSent || may.cancelApproved ? (
        <div className="flex flex-wrap gap-3 border-t border-line pt-4">
          {may.regenerate ? (
            <ConfirmDialog
              trigger={t('files.regenerate')}
              title={t('files.regenerateTitle')}
              hint={t('files.regenerateHint')}
              confirm={t('files.regenerateConfirm')}
              busy={t('files.regenerating')}
              done={() => t('files.regenerated')}
              reason
              notSent={downloaded.current}
              run={(values, key) => actions.regenerateFile({ paymentRunId, version, reason: values.reason, confirmNotSentToBank: values.confirmNotSentToBank }, key)}
            />
          ) : null}
          {may.revertSent ? (
            <ConfirmDialog
              trigger={t('files.revert')}
              title={t('files.revertTitle')}
              hint={t('files.revertHint')}
              confirm={t('files.revertConfirm')}
              busy={t('files.reverting')}
              done={() => t('files.reverted')}
              reason
              run={(values, key) => actions.revertSent({ paymentRunId, version, reason: values.reason }, key)}
            />
          ) : null}
          {may.cancelApproved ? (
            <div className="sm:ml-auto">
              <ConfirmDialog
                trigger={t('files.cancel')}
                title={t('files.cancelTitle')}
                hint={t('files.cancelHint')}
                confirm={t('files.cancelConfirm')}
                busy={t('files.cancelBusy')}
                done={() => t('files.cancelled')}
                reason
                notSent={downloaded.any}
                danger
                run={(values, key) => actions.cancelApproved({ paymentRunId, version, reason: values.reason, confirmNotSentToBank: values.confirmNotSentToBank }, key)}
              />
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
