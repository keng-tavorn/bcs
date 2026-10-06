'use client'

import { Paperclip } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { useId, useState, type ChangeEvent } from 'react'
import { ACCEPT_ATTRIBUTE } from '@/lib/file-types'
import { cn } from '../cn'
import type { CompleteUploadResult, FileRefusal, RequestUploadResult } from '../files/file-upload'
import { uploadFile } from '../files/upload'
import { FieldError } from './controls'

// The upload flow of FR-PLT-004 (presigned PUT straight to private storage, then the server verifies and records the
// file) with a label that says what the file is for, so a form with several uploads stays clear. The caller links the
// recorded file to the request (a quotation, or an attachment of a kind). The steps are the workspace's one upload
// (src/ui/files/upload.ts, as FileUpload runs them): the file made ready in the browser first — a photo the browser
// cannot decode is refused and the button says so (files.unreadable: choose a JPG or PNG), never "check your connection"
// —, its declared type and size checked, then the file service's steps, within FILE_UPLOAD_LIMIT_MS.

export interface UploadActions {
  readonly requestUpload: (input: { fileName: string; mimeType: string; sizeBytes: number }) => Promise<RequestUploadResult>
  readonly completeUpload: (ticket: string) => Promise<CompleteUploadResult>
}

/** Where the button's upload stands: nothing under way, a file on its way, or why the last one was not attached */
export type UploadButtonStatus =
  | { readonly kind: 'idle' }
  | { readonly kind: 'busy'; readonly name: string }
  | { readonly kind: 'error'; readonly reason: FileRefusal | 'UNREADABLE' }

/**
 * One upload of the button, told to `show` as it goes: busy once the prepared file is on its way, idle once the caller
 * has attached the recorded file, or why it was not attached. Nothing on the button stops an upload, so an upload that
 * ended early ran out of time: a failed one
 */
export async function uploadFromButton(
  original: File,
  actions: UploadActions,
  onUploaded: (file: { fileId: string; fileName: string }) => Promise<void> | void,
  show: (status: UploadButtonStatus) => void,
): Promise<void> {
  try {
    const outcome = await uploadFile(original, { requestUpload: actions.requestUpload, completeUpload: actions.completeUpload, onSending: (name) => show({ kind: 'busy', name }) })
    if (!outcome.ok) return show({ kind: 'error', reason: outcome.reason === 'STOPPED' ? 'FAILED' : outcome.reason })
    await onUploaded({ fileId: outcome.fileId, fileName: outcome.fileName })
    show({ kind: 'idle' })
  } catch {
    // The caller could not attach the recorded file (a server action with no answer)
    show({ kind: 'error', reason: 'FAILED' })
  }
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
  const id = useId()
  const [status, setStatus] = useState<UploadButtonStatus>({ kind: 'idle' })

  function onChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0]
    event.currentTarget.value = ''
    if (file) void uploadFromButton(file, actions, onUploaded, setStatus)
  }

  return <UploadButtonView id={id} label={label} status={status} disabled={disabled} className={className} showRule={showRule} onChange={onChange} />
}

/** What UploadButton shows: the file input behind a 44 px button, the rule or the file on its way, and why a file was not attached */
export function UploadButtonView({
  id,
  label,
  status,
  disabled,
  className,
  showRule,
  onChange,
}: {
  id: string
  label: string
  status: UploadButtonStatus
  disabled?: boolean
  className?: string
  showRule: boolean
  onChange: (event: ChangeEvent<HTMLInputElement>) => void
}) {
  const t = useTranslations('files')
  const tf = useTranslations('requestForm.files')
  const refusals: Record<FileRefusal | 'UNREADABLE', string> = {
    TYPE_NOT_ALLOWED: t('typeNotAllowed'),
    TOO_LARGE: t('tooLarge'),
    EMPTY: t('empty'),
    CONTENT_MISMATCH: t('contentMismatch'),
    FAILED: t('failed'),
    UNREADABLE: t('unreadable'),
  }
  const busy = status.kind === 'busy'

  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      <label
        htmlFor={id}
        className={cn(
          'inline-flex min-h-11 w-fit max-w-full items-center gap-2 rounded-md border px-4 font-medium focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[var(--ring)]',
          // Not now (another file is on its way, or saving stopped): the words stay readable (§9.9, 4.5:1)
          disabled || busy ? 'cursor-not-allowed border-line bg-surface text-ink-muted' : 'cursor-pointer border-input bg-bg text-ink hover:bg-surface',
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
