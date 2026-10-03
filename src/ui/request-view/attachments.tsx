'use client'

import { FileText } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { useState } from 'react'
import { Notice } from '../form/notice'

// Attachments of a request (FR-PLT-004 AC2): a link asks the server for a download address valid 5 minutes, after it
// checks that the member may view the request the file belongs to, then opens it. Addresses are never put in the page,
// so a page left open never holds an expired one.

export interface AttachmentView {
  readonly fileId: string
  readonly fileName: string
  /** Kind and size, already translated */
  readonly detail: string
}

export function AttachmentList({ files, open }: { files: readonly AttachmentView[]; open: (fileId: string) => Promise<string | null> }) {
  const t = useTranslations('requestView.files')
  const [busy, setBusy] = useState<string | null>(null)
  const [failed, setFailed] = useState<string | null>(null)

  async function onOpen(file: AttachmentView) {
    setBusy(file.fileId)
    setFailed(null)
    const url = await open(file.fileId).catch(() => null)
    setBusy(null)
    if (url) window.location.assign(url)
    else setFailed(file.fileName)
  }

  return (
    <div className="flex flex-col gap-3">
      {failed ? <Notice tone="danger">{t('failed', { name: failed })}</Notice> : null}
      <ul className="flex flex-col divide-y divide-line border-t border-line">
        {files.map((file) => (
          <li key={file.fileId} className="flex flex-col gap-1 py-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
            <span className="inline-flex min-w-0 items-start gap-2">
              <FileText className="mt-1 size-4 shrink-0 text-ink-muted" aria-hidden="true" />
              <span className="min-w-0">
                <span className="block break-all text-ink">{file.fileName}</span>
                <span className="block text-base text-ink-muted md:text-sm">{file.detail}</span>
              </span>
            </span>
            <button
              type="button"
              onClick={() => void onOpen(file)}
              disabled={busy === file.fileId}
              aria-busy={busy === file.fileId || undefined}
              className="inline-flex min-h-11 shrink-0 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline disabled:opacity-60 sm:self-center"
            >
              {busy === file.fileId ? t('opening', { name: file.fileName }) : t('open', { name: file.fileName })}
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
