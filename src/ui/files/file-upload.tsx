'use client'

import { Paperclip } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { useId, useState, type ChangeEvent } from 'react'
import { ACCEPT_ATTRIBUTE, checkDeclaredUpload, mimeTypeFromName, type UploadRefusal } from '@/lib/file-types'
import { Notice } from '../form/notice'
import { prepareImage } from './prepare-image'

// File attachment (FR-PLT-004): checks type and size first, prepares photos (resize, no GPS), uploads straight to
// private storage through a short-lived presigned URL, then asks the server to verify and record the file.

export type FileRefusal = UploadRefusal | 'CONTENT_MISMATCH' | 'FAILED'
export type RequestUploadResult = { ok: true; uploadUrl: string; ticket: string } | { ok: false; reason: FileRefusal }
export type CompleteUploadResult = { ok: true; fileId: string; fileName: string } | { ok: false; reason: FileRefusal }

export interface FileUploadProps {
  readonly requestUpload: (input: { fileName: string; mimeType: string; sizeBytes: number }) => Promise<RequestUploadResult>
  readonly completeUpload: (ticket: string) => Promise<CompleteUploadResult>
  /** 'photo' opens the camera on phones */
  readonly mode?: 'any' | 'photo'
  readonly onUploaded?: (file: { fileId: string; fileName: string }) => void
}

type Status = { kind: 'idle' } | { kind: 'busy'; name: string } | { kind: 'done'; name: string } | { kind: 'error'; reason: FileRefusal }

export function FileUpload({ requestUpload, completeUpload, mode = 'any', onUploaded }: FileUploadProps) {
  const t = useTranslations('files')
  const id = useId()
  const [status, setStatus] = useState<Status>({ kind: 'idle' })

  async function upload(original: File) {
    const prepared = await prepareImage(original)
    const mimeType = prepared.type || mimeTypeFromName(prepared.name) || ''
    const refusal = checkDeclaredUpload(mimeType, prepared.size)
    if (refusal) return setStatus({ kind: 'error', reason: refusal })
    setStatus({ kind: 'busy', name: prepared.name })
    const started = await requestUpload({ fileName: prepared.name, mimeType, sizeBytes: prepared.size })
    if (!started.ok) return setStatus({ kind: 'error', reason: started.reason })
    const put = await fetch(started.uploadUrl, { method: 'PUT', headers: { 'content-type': mimeType }, body: prepared }).catch(() => null)
    if (!put?.ok) return setStatus({ kind: 'error', reason: 'FAILED' })
    const done = await completeUpload(started.ticket)
    if (!done.ok) return setStatus({ kind: 'error', reason: done.reason })
    setStatus({ kind: 'done', name: done.fileName })
    onUploaded?.({ fileId: done.fileId, fileName: done.fileName })
  }

  function onChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0]
    event.currentTarget.value = ''
    if (file) void upload(file).catch(() => setStatus({ kind: 'error', reason: 'FAILED' }))
  }

  const messages: Record<FileRefusal, string> = {
    TYPE_NOT_ALLOWED: t('typeNotAllowed'),
    TOO_LARGE: t('tooLarge'),
    EMPTY: t('empty'),
    CONTENT_MISMATCH: t('contentMismatch'),
    FAILED: t('failed'),
  }

  return (
    <div className="flex flex-col gap-3">
      <label
        htmlFor={id}
        className="inline-flex min-h-11 w-fit cursor-pointer items-center gap-2 rounded-md border border-input bg-bg px-4 font-medium text-ink hover:bg-surface focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[var(--ring)]"
      >
        <Paperclip className="size-4" aria-hidden="true" />
        {mode === 'photo' ? t('choosePhoto') : t('chooseFile')}
        <input
          id={id}
          type="file"
          className="sr-only"
          accept={mode === 'photo' ? 'image/*' : ACCEPT_ATTRIBUTE}
          {...(mode === 'photo' ? { capture: 'environment' as const } : {})}
          onChange={onChange}
          disabled={status.kind === 'busy'}
        />
      </label>
      <p className="text-base text-ink-muted md:text-sm">{t('rule')}</p>
      {status.kind === 'busy' ? <p role="status">{t('uploading', { name: status.name })}</p> : null}
      {status.kind === 'done' ? <Notice tone="success">{t('uploaded', { name: status.name })}</Notice> : null}
      {status.kind === 'error' ? <Notice tone="danger">{messages[status.reason]}</Notice> : null}
    </div>
  )
}
