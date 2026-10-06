'use client'

import { useTranslations } from 'next-intl'
import { useId, useState, type ChangeEvent } from 'react'
import type { CompleteUploadResult, FileRefusal, RequestUploadResult } from '../../files/file-upload'
import { cn } from '../cn'
import { LiffNotice } from '../notice'
import { CameraIcon } from '../receiving/camera-icon'
import type { LiffReadiness } from './ready'

// A photo from the phone's camera, attached to the request in LIFF (FR-INT-005 AC3, §9.4: "กล้องใช้ <input type="file"
// accept="image/*" capture="environment"> แล้วย่อรูปฝั่ง client"): the button opens the camera, the photo is made ready in
// the phone — upright, at most 2,000 px, a JPEG without the camera's metadata or position, named apart from the
// request's other files — and goes straight to private storage through the file service's short-lived presigned
// address, which the server checks again (FR-PLT-004, NFR-SEC-08), with the steps the LIFF receiving page uses
// (../receiving/photo-upload.ts, loaded only when a photo is taken, so the step carries none of it until then). The
// recorded photo is then attached to the draft as a รูปถ่าย (PHOTO), through the form's attach (which saves the draft
// first when it does not exist yet). A quotation or any other file — a PDF included — is attached with the general file
// picker of the documents step beside it, which the camera does not replace. The camera button is a label around the
// visually hidden input, 44 px high, focus ring included.

export interface LiffCameraAttachProps {
  /** The names of the request's files so far: a new photo gets a name none of them has */
  readonly taken: readonly string[]
  /** A file is being attached or taken off, or saving is stopped: the camera waits */
  readonly busy: boolean
  readonly ready: () => Promise<LiffReadiness>
  readonly requestUpload: (input: { fileName: string; mimeType: string; sizeBytes: number }) => Promise<RequestUploadResult>
  readonly completeUpload: (ticket: string) => Promise<CompleteUploadResult>
  /** Links the recorded photo to the draft as a PHOTO; the form says when that fails */
  readonly onAttach: (file: { fileId: string; fileName: string }) => Promise<boolean>
}

type Status =
  | { readonly kind: 'idle' }
  | { readonly kind: 'preparing' }
  | { readonly kind: 'sending'; readonly name: string }
  | { readonly kind: 'added'; readonly name: string }
  | { readonly kind: 'refused'; readonly text: string }

const REFUSAL_KEYS: Readonly<Record<FileRefusal, 'typeNotAllowed' | 'tooLarge' | 'empty' | 'contentMismatch' | 'failed'>> = {
  TYPE_NOT_ALLOWED: 'typeNotAllowed',
  TOO_LARGE: 'tooLarge',
  EMPTY: 'empty',
  CONTENT_MISMATCH: 'contentMismatch',
  FAILED: 'failed',
}

export function LiffCameraAttach({ taken, busy, ready, requestUpload, completeUpload, onAttach }: LiffCameraAttachProps) {
  const t = useTranslations('liffRequests.form.camera')
  const tForm = useTranslations('liffRequests.form')
  const tFiles = useTranslations('files')
  const id = useId()
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const working = status.kind === 'preparing' || status.kind === 'sending'

  async function add(original: File) {
    setStatus({ kind: 'preparing' })
    let ended = false
    const { uploadLiffPhoto } = await import('../receiving/photo-upload')
    const sent = await uploadLiffPhoto(original, {
      taken,
      ready: async () => {
        const readiness = await ready()
        ended = readiness === 'ended'
        return readiness === 'go'
      },
      requestUpload,
      completeUpload,
      onSending: (name) => setStatus({ kind: 'sending', name }),
    })
    if (!sent.ok) {
      // The session has ended: LIFF has no sign-in page of its own, so the words say nothing was attached and how to come back
      if (sent.reason === 'NOT_SENT') return setStatus(ended ? { kind: 'refused', text: tForm('sessionEnded') } : { kind: 'idle' })
      return setStatus({ kind: 'refused', text: sent.reason === 'UNREADABLE' ? t('unreadable') : tFiles(REFUSAL_KEYS[sent.reason]) })
    }
    // Attached: the documents list shows it with its kind; a refusal of the attach is said there by the form
    setStatus((await onAttach({ fileId: sent.fileId, fileName: sent.fileName })) ? { kind: 'added', name: sent.fileName } : { kind: 'idle' })
  }

  function onChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0]
    // The same photo may be chosen again after it was taken off
    event.currentTarget.value = ''
    if (!file || busy || working) return
    void add(file).catch(() => setStatus({ kind: 'refused', text: tFiles('failed') }))
  }

  const disabled = busy || working
  return (
    <div className="flex flex-col gap-2">
      <label
        htmlFor={id}
        className={cn(
          'inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-md border px-4 py-2 text-center font-medium focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[var(--ring)]',
          // Not ready yet: the words stay readable (§9.9, 4.5:1), the secondary text on the light surface
          disabled ? 'cursor-not-allowed border-line bg-surface text-ink-muted' : 'cursor-pointer border-input bg-bg text-ink hover:bg-surface',
        )}
      >
        <CameraIcon />
        {status.kind === 'added' ? t('takeMore') : t('take')}
        <input id={id} type="file" accept="image/*" capture="environment" className="sr-only" onChange={onChange} disabled={disabled} aria-describedby={`${id}-hint`} />
      </label>
      <p id={`${id}-hint`} className="text-ink-muted">
        {t('hint')}
      </p>
      {status.kind === 'preparing' ? <p role="status">{t('preparing')}</p> : null}
      {status.kind === 'sending' ? <p role="status">{t('sending', { name: status.name })}</p> : null}
      {status.kind === 'added' ? <LiffNotice tone="success">{t('added', { name: status.name })}</LiffNotice> : null}
      {status.kind === 'refused' ? <LiffNotice tone="danger">{status.text}</LiffNotice> : null}
    </div>
  )
}
