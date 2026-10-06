'use client'

import { Paperclip } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { useEffect, useId, useRef, useState, type ChangeEvent } from 'react'
import { ACCEPT_ATTRIBUTE, type UploadRefusal } from '@/lib/file-types'
import { Button } from '../form/button'
import { Notice } from '../form/notice'
import { openUploadWindow, uploadFile, type UploadWindow } from './upload'

// File attachment (FR-PLT-004): checks type and size first, prepares photos (resize, no GPS; a photo the browser cannot
// decode is refused), uploads straight to private storage through a short-lived presigned URL, then asks the server to
// verify and record the file (./upload.ts). An upload has a time limit and a stop, and the form it belongs to is told
// while one runs (onBusyChange), so it can wait for the file instead of going on without it; the form also turns the
// file input off while it is being checked or saved (disabled). An upload still on its way when the component goes
// (the page or the form's step changes) is stopped, and the form is told it no longer runs.

export type FileRefusal = UploadRefusal | 'CONTENT_MISMATCH' | 'FAILED'
export type RequestUploadResult = { ok: true; uploadUrl: string; ticket: string } | { ok: false; reason: FileRefusal }
export type CompleteUploadResult = { ok: true; fileId: string; fileName: string } | { ok: false; reason: FileRefusal }

export interface FileUploadProps {
  readonly requestUpload: (input: { fileName: string; mimeType: string; sizeBytes: number }) => Promise<RequestUploadResult>
  readonly completeUpload: (ticket: string) => Promise<CompleteUploadResult>
  /** 'photo' opens the camera on phones */
  readonly mode?: 'any' | 'photo'
  /** What may be attached, in place of the general rule — e.g. pictures only, where only a picture is evidence */
  readonly rule?: string
  readonly onUploaded?: (file: { fileId: string; fileName: string }) => void
  /** Told true when an upload starts and false once it is over, whatever became of it (after onUploaded) */
  readonly onBusyChange?: (busy: boolean) => void
  /** No file can be chosen now: the form it belongs to is being checked or saved */
  readonly disabled?: boolean
}

/** Where the upload stands: none yet, one on its way, the last one recorded, refused, or stopped by the person */
export type FileUploadStatus =
  | { readonly kind: 'idle' }
  | { readonly kind: 'busy'; readonly name: string }
  | { readonly kind: 'done'; readonly name: string }
  | { readonly kind: 'error'; readonly reason: FileRefusal | 'UNREADABLE' }
  | { readonly kind: 'stopped' }

export function FileUpload({ requestUpload, completeUpload, mode = 'any', rule, onUploaded, onBusyChange, disabled = false }: FileUploadProps) {
  const id = useId()
  const [status, setStatus] = useState<FileUploadStatus>({ kind: 'idle' })
  /** The upload under way, one at a time: its time limit and its stop */
  const current = useRef<UploadWindow | null>(null)
  /** The form's latest listener, for an upload that ends after a render and for the component going */
  const busyListener = useRef(onBusyChange)
  useEffect(() => {
    busyListener.current = onBusyChange
  })
  // The component goes (another step, another page): an upload still on its way stops, and the form waits no more
  useEffect(
    () => () => {
      const running = current.current
      if (!running) return
      current.current = null
      running.stop()
      busyListener.current?.(false)
    },
    [],
  )

  async function upload(original: File) {
    if (current.current) return
    const limit = openUploadWindow()
    current.current = limit
    setStatus({ kind: 'busy', name: original.name })
    busyListener.current?.(true)
    try {
      const outcome = await uploadFile(original, { requestUpload, completeUpload, onSending: (name) => current.current === limit && setStatus({ kind: 'busy', name }) }, limit)
      // Gone meanwhile: nothing is shown or attached
      if (current.current !== limit) return
      if (outcome.ok) {
        setStatus({ kind: 'done', name: outcome.fileName })
        onUploaded?.({ fileId: outcome.fileId, fileName: outcome.fileName })
      } else {
        setStatus(outcome.reason === 'STOPPED' ? { kind: 'stopped' } : { kind: 'error', reason: outcome.reason })
      }
    } finally {
      limit.close()
      if (current.current === limit) {
        current.current = null
        busyListener.current?.(false)
      }
    }
  }

  function onChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0]
    event.currentTarget.value = ''
    if (file) void upload(file)
  }

  return <FileUploadView id={id} mode={mode} rule={rule} status={status} disabled={disabled} onChange={onChange} onStop={() => current.current?.stop()} />
}

export interface FileUploadViewProps {
  readonly id: string
  readonly mode: 'any' | 'photo'
  readonly rule?: string | undefined
  readonly status: FileUploadStatus
  /** The form is being checked or saved */
  readonly disabled: boolean
  readonly onChange: (event: ChangeEvent<HTMLInputElement>) => void
  /** Stops the upload under way */
  readonly onStop: () => void
}

/** What FileUpload shows: the file input behind a 44 px button, the rule, and where the upload stands with its stop */
export function FileUploadView({ id, mode, rule, status, disabled, onChange, onStop }: FileUploadViewProps) {
  const t = useTranslations('files')
  const busy = status.kind === 'busy'
  const off = disabled || busy
  const messages: Record<FileRefusal | 'UNREADABLE', string> = {
    TYPE_NOT_ALLOWED: t('typeNotAllowed'),
    TOO_LARGE: t('tooLarge'),
    EMPTY: t('empty'),
    CONTENT_MISMATCH: t('contentMismatch'),
    FAILED: t('failed'),
    UNREADABLE: t('unreadable'),
  }

  return (
    <div className="flex flex-col gap-3">
      <label
        htmlFor={id}
        // Not now: the words stay readable (§9.9, 4.5:1), the secondary text on the light surface
        className={`inline-flex min-h-11 w-fit items-center gap-2 rounded-md border px-4 font-medium focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[var(--ring)] ${off ? 'cursor-not-allowed border-line bg-surface text-ink-muted' : 'cursor-pointer border-input bg-bg text-ink hover:bg-surface'}`}
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
          disabled={off}
        />
      </label>
      <p className="text-base text-ink-muted md:text-sm">{rule ?? t('rule')}</p>
      {/* The file's name on its own line (a long one breaks rather than pushing the column wider), the stop under it: in a
          narrow column nothing squeezes the button, whose words stay on one line inside its 44 px */}
      {busy ? (
        <div className="flex flex-col gap-2">
          <p role="status" className="break-words">
            {t('uploading', { name: status.name })}
          </p>
          <Button variant="secondary" className="self-start" onClick={onStop}>
            {t('stop')}
          </Button>
        </div>
      ) : null}
      {status.kind === 'done' ? <Notice tone="success">{t('uploaded', { name: status.name })}</Notice> : null}
      {status.kind === 'stopped' ? <Notice tone="info">{t('stopped')}</Notice> : null}
      {status.kind === 'error' ? <Notice tone="danger">{messages[status.reason]}</Notice> : null}
    </div>
  )
}
