'use client'

import { useTranslations } from 'next-intl'
import type { ChangeEvent } from 'react'
import { Button } from '../../form/button'
import { LiffNotice } from '../notice'
import { CameraIcon } from './camera-icon'
import { FieldError } from './fields'

// Photos of a delivery taken in LIFF (§9.4, FR-LINE-003 AC3, FR-P2P-006 AC1, BR-GR-05): the phone's camera opens from
// <input type="file" accept="image/*" capture="environment">; the photo it gives goes to the receiving flow
// (./receive-flow.tsx), which makes it ready in the phone and sends it (./photo-upload.ts), keeps the receipt waiting
// meanwhile, and holds where the send stands (`status`) — so what happened to a photo is never lost when this part leaves
// the screen. While a photo is made ready or sent, or the receipt is being checked or posted (`busy`), the camera takes
// no other photo and none is taken out. Each photo shows as a small picture made from the file in the phone, with a way
// to take it out before the receipt is posted. The camera button is a label around the visually hidden input, 44 px
// high, focus ring included; the input carries the photo rule's error (aria-describedby).

/** As many photos as one receipt takes (the gr.post command of src/server/services/receiving refuses more) */
export const LIFF_RECEIPT_MAX_PHOTOS = 20

export interface LiffPhoto {
  readonly fileId: string
  readonly fileName: string
  /** An object URL of the file as it was sent, for the small picture (made and freed by the flow) */
  readonly preview: string
}

/** Where the photo being taken stands, and how the last one ended */
export type LiffPhotoStatus =
  | { readonly kind: 'idle' }
  | { readonly kind: 'preparing' }
  | { readonly kind: 'sending'; readonly name: string }
  | { readonly kind: 'added'; readonly name: string }
  | { readonly kind: 'stopped' }
  | { readonly kind: 'refused'; readonly text: string }

export interface LiffPhotosProps {
  /** The id of the camera input: the receipt's form moves the focus there when a photo is needed first */
  readonly inputId: string
  readonly photos: readonly LiffPhoto[]
  readonly status: LiffPhotoStatus
  /** A photo is being made ready or sent, or the receipt is being checked or posted */
  readonly busy: boolean
  /** The camera gave a photo */
  readonly onTake: (file: File) => void
  readonly onRemove: (fileId: string) => void
  /** Why the receipt needs a photo first (damaged goods, BR-GR-05) */
  readonly error?: string | null
}

export function LiffPhotos({ inputId, photos, status, busy, onTake, onRemove, error = null }: LiffPhotosProps) {
  const t = useTranslations('liffReceiving.photos')
  const tForm = useTranslations('receiving.form')
  const full = photos.length >= LIFF_RECEIPT_MAX_PHOTOS
  const errorId = `${inputId}-error`

  function onChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0]
    // The same photo may be chosen again after it was taken out
    event.currentTarget.value = ''
    if (file && !busy) onTake(file)
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="font-medium text-ink">{tForm('photosLabel')}</p>
      <p className="text-ink-muted">{tForm('photosHint')}</p>
      {photos.length ? (
        <ul aria-label={tForm('photosLabel')} className="flex flex-col divide-y divide-line border-y border-line">
          {photos.map((photo) => (
            <li key={photo.fileId} className="flex items-center gap-3 py-2">
              {/* The picture made in the phone, decorative: the words beside it name the photo */}
              <span aria-hidden="true" className="size-16 shrink-0 rounded-md border border-line bg-surface bg-cover bg-center" style={{ backgroundImage: `url("${photo.preview}")` }} />
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="break-all text-ink">{tForm('photoItem', { name: photo.fileName })}</span>
                <Button variant="link" className="min-h-11 self-start" onClick={() => onRemove(photo.fileId)} disabled={busy}>
                  {tForm('removePhoto', { name: photo.fileName })}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      {full ? (
        <p className="text-ink-muted">{t('full', { max: LIFF_RECEIPT_MAX_PHOTOS })}</p>
      ) : (
        <label
          htmlFor={inputId}
          className={`inline-flex min-h-11 w-full cursor-pointer items-center justify-center gap-2 rounded-md border bg-bg px-4 font-medium text-ink hover:bg-surface focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[var(--ring)] ${error ? 'border-danger' : 'border-input'} ${busy ? 'cursor-not-allowed opacity-60' : ''}`}
        >
          <CameraIcon />
          {photos.length ? t('takeMore') : t('take')}
          <input
            id={inputId}
            type="file"
            accept="image/*"
            capture="environment"
            className="sr-only"
            onChange={onChange}
            disabled={busy}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
          />
        </label>
      )}
      <p className="text-ink-muted">{t('rule', { max: LIFF_RECEIPT_MAX_PHOTOS })}</p>
      {status.kind === 'preparing' ? <p role="status">{t('preparing')}</p> : null}
      {status.kind === 'sending' ? <p role="status">{t('sending', { name: status.name })}</p> : null}
      {status.kind === 'added' ? (
        <p role="status" className="sr-only">
          {t('added', { name: status.name })}
        </p>
      ) : null}
      {status.kind === 'stopped' ? <LiffNotice tone="info">{t('stopped')}</LiffNotice> : null}
      {status.kind === 'refused' ? <LiffNotice tone="danger">{status.text}</LiffNotice> : null}
      <FieldError id={errorId} text={error} />
    </div>
  )
}
