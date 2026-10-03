'use client'

import { Paperclip } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { useId, useState, type ChangeEvent } from 'react'
import { ACCEPT_ATTRIBUTE, checkDeclaredUpload, mimeTypeFromName } from '@/lib/file-types'
import { cn } from '../cn'
import type { CompleteUploadResult, FileRefusal, RequestUploadResult } from '../files/file-upload'
import { prepareImage } from '../files/prepare-image'
import { FieldError } from './controls'

// The upload flow of FR-PLT-004 (presigned PUT straight to private storage, then the server verifies and records the
// file) with a label that says what the file is for, so a form with several uploads stays clear. The caller links the
// recorded file to the request (a quotation, or an attachment of a kind).

export interface UploadActions {
  readonly requestUpload: (input: { fileName: string; mimeType: string; sizeBytes: number }) => Promise<RequestUploadResult>
  readonly completeUpload: (ticket: string) => Promise<CompleteUploadResult>
}

export function UploadButton({
  label,
  actions,
  onUploaded,
  disabled,
  className,
  showRule = true,
}: {
  label: string
  actions: UploadActions
  onUploaded: (file: { fileId: string; fileName: string }) => Promise<void> | void
  disabled?: boolean
  className?: string
  /** Which files are accepted; a list of several uploads says it once instead */
  showRule?: boolean
}) {
  const t = useTranslations('files')
  const tf = useTranslations('requestForm.files')
  const id = useId()
  const [status, setStatus] = useState<{ kind: 'idle' } | { kind: 'busy'; name: string } | { kind: 'error'; reason: FileRefusal }>({ kind: 'idle' })

  async function upload(original: File) {
    const prepared = await prepareImage(original)
    const mimeType = prepared.type || mimeTypeFromName(prepared.name) || ''
    const refusal = checkDeclaredUpload(mimeType, prepared.size)
    if (refusal) return setStatus({ kind: 'error', reason: refusal })
    setStatus({ kind: 'busy', name: prepared.name })
    const started = await actions.requestUpload({ fileName: prepared.name, mimeType, sizeBytes: prepared.size })
    if (!started.ok) return setStatus({ kind: 'error', reason: started.reason })
    const put = await fetch(started.uploadUrl, { method: 'PUT', headers: { 'content-type': mimeType }, body: prepared }).catch(() => null)
    if (!put?.ok) return setStatus({ kind: 'error', reason: 'FAILED' })
    const done = await actions.completeUpload(started.ticket)
    if (!done.ok) return setStatus({ kind: 'error', reason: done.reason })
    await onUploaded({ fileId: done.fileId, fileName: done.fileName })
    setStatus({ kind: 'idle' })
  }

  function onChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0]
    event.currentTarget.value = ''
    if (file) void upload(file).catch(() => setStatus({ kind: 'error', reason: 'FAILED' }))
  }

  const refusals: Record<FileRefusal, string> = {
    TYPE_NOT_ALLOWED: t('typeNotAllowed'),
    TOO_LARGE: t('tooLarge'),
    EMPTY: t('empty'),
    CONTENT_MISMATCH: t('contentMismatch'),
    FAILED: t('failed'),
  }
  const busy = status.kind === 'busy'

  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      <label
        htmlFor={id}
        className={cn(
          'inline-flex min-h-11 w-fit max-w-full cursor-pointer items-center gap-2 rounded-md border border-input bg-bg px-4 font-medium text-ink hover:bg-surface focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[var(--ring)]',
          (disabled || busy) && 'cursor-not-allowed opacity-60',
        )}
      >
        <Paperclip className="size-4 shrink-0" aria-hidden="true" />
        <span>{label}</span>
        <input
          id={id}
          type="file"
          className="sr-only"
          accept={ACCEPT_ATTRIBUTE}
          onChange={onChange}
          disabled={disabled || busy}
          aria-describedby={status.kind === 'error' ? `${id}-error` : showRule ? `${id}-hint` : undefined}
        />
      </label>
      {busy ? (
        <p role="status" className="text-base md:text-sm">
          {t('uploading', { name: status.name })}
        </p>
      ) : showRule ? (
        <p id={`${id}-hint`} className="text-base text-ink-muted md:text-sm">
          {tf('rule')}
        </p>
      ) : null}
      {status.kind === 'error' ? (
        <div role="alert">
          <FieldError id={id}>{refusals[status.reason]}</FieldError>
        </div>
      ) : null}
    </div>
  )
}
