'use client'

import { useTranslations } from 'next-intl'
import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import { Button } from '../button'
import { LiffNotice } from '../notice'
import { CameraIcon } from './camera-icon'
import { FieldError } from './fields'

// Photos of a delivery taken in LIFF (§9.4, FR-LINE-003 AC3, FR-P2P-006 AC1, BR-GR-05): the phone's camera opens from
// <input type="file" accept="image/*" capture="environment">; the photo it gives goes to the receiving flow
// (./receive-flow.tsx), which makes it ready in the phone and sends it (./photo-upload.ts), keeps the receipt waiting
// meanwhile, and holds where the send stands (`status`) — so what happened to a photo is never lost when this part leaves
// the screen. While a photo is made ready or sent, or the receipt is being checked or posted (`busy`), the camera takes
// no other photo and none is taken out. Each photo shows as a small picture made from the file in the phone, with a way
// to take it out before the receipt is posted. Taking one out cannot be undone — it is gone from the phone's page, and
// damaged goods need a photo (BR-GR-05) — so it asks once, in the photo's place (§9.9: nothing that cannot be undone
// without a confirmation), as the request form asks before a file goes: what goes and that it cannot be brought back,
// with "เอารูปนี้ออก" outlined in danger and "ไม่เอาออก เก็บรูปไว้" apart from it, 44 px each — the LIFF buttons, not the
// workspace's ConfirmRemove, which would bring tailwind-merge into the page's first JavaScript (§9.4). The focus moves to
// the question, back to the photo's button when it is kept, and to the camera once it is taken out, which a screen reader
// is told. The camera button is a label around the visually hidden input, 44 px high, focus ring included; the input
// carries the photo rule's error (aria-describedby).

/** As many photos as one receipt takes (the gr.post command of src/server/services/receiving refuses more) */
export const LIFF_RECEIPT_MAX_PHOTOS = 20

/** A full-width button of the question whose words may take two lines: it grows, never below 44 px */
const WRAPPING = 'h-auto min-h-11 w-full py-2 text-center'

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
  const questionId = `${inputId}-remove-question`
  /** The button that takes a photo out: the focus comes back to it when the photo is kept */
  const removeButtonId = (photo: LiffPhoto) => `${inputId}-remove-${photo.fileId}`
  /** The photo whose taking out is being asked about */
  const [asking, setAsking] = useState<string | null>(null)
  /** The name of the photo just taken out, said to a screen reader */
  const [removed, setRemoved] = useState<string | null>(null)
  /** Where the focus goes once the question has gone: the photo's button when it is kept, the camera when it went */
  const focusNext = useRef<string | null>(null)
  useEffect(() => {
    if (asking !== null) {
      document.getElementById(questionId)?.focus()
      return
    }
    if (focusNext.current) document.getElementById(focusNext.current)?.focus()
    focusNext.current = null
  }, [asking, questionId])

  function onChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0]
    // The same photo may be chosen again after it was taken out
    event.currentTarget.value = ''
    if (file && !busy) {
      setRemoved(null)
      onTake(file)
    }
  }

  function ask(photo: LiffPhoto) {
    setRemoved(null)
    setAsking(photo.fileId)
  }

  function keep(photo: LiffPhoto) {
    focusNext.current = removeButtonId(photo)
    setAsking(null)
  }

  function remove(photo: LiffPhoto) {
    if (busy) return
    focusNext.current = inputId
    setAsking(null)
    setRemoved(photo.fileName)
    onRemove(photo.fileId)
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="font-medium text-ink">{tForm('photosLabel')}</p>
      <p className="text-ink-muted">{tForm('photosHint')}</p>
      {photos.length ? (
        <ul aria-label={tForm('photosLabel')} className="flex flex-col divide-y divide-line border-y border-line">
          {photos.map((photo) => (
            <li key={photo.fileId} className="flex items-start gap-3 py-2">
              {/* The picture made in the phone, decorative: the words beside it name the photo */}
              <span aria-hidden="true" className="size-16 shrink-0 rounded-md border border-line bg-surface bg-cover bg-center" style={{ backgroundImage: `url("${photo.preview}")` }} />
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="break-all text-ink">{tForm('photoItem', { name: photo.fileName })}</span>
                {asking === photo.fileId ? (
                  <LiffRemovePhotoQuestion id={questionId} name={photo.fileName} busy={busy} onRemove={() => remove(photo)} onKeep={() => keep(photo)} />
                ) : (
                  <Button id={removeButtonId(photo)} variant="link" className="min-h-11 self-start" onClick={() => ask(photo)} disabled={busy}>
                    {tForm('removePhoto', { name: photo.fileName })}
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      {removed ? (
        <p role="status" className="sr-only">
          {t('removed', { name: removed })}
        </p>
      ) : null}
      {full ? (
        <p className="text-ink-muted">{t('full', { max: LIFF_RECEIPT_MAX_PHOTOS })}</p>
      ) : (
        <label
          htmlFor={inputId}
          // While a photo is sent the words stay readable (§9.9, 4.5:1): the secondary text on the light surface
          className={`inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-md border px-4 font-medium focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[var(--ring)] ${error ? 'border-danger' : busy ? 'border-line' : 'border-input'} ${busy ? 'cursor-not-allowed bg-surface text-ink-muted' : 'cursor-pointer bg-bg text-ink hover:bg-surface'}`}
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

/**
 * The question in a photo's place before it is taken out: the photo it is about (its name, which names the group), that
 * it cannot be brought back, and the two answers — taking it out outlined in danger, keeping it plain — one under the
 * other, 12 px apart and 44 px high each, so neither is pressed by mistake (§9.9). Taking it out waits while the camera
 * or the receipt is busy; keeping it never does. `id` is the question's, which takes the focus when it shows.
 */
export function LiffRemovePhotoQuestion({
  id,
  name,
  busy,
  onRemove,
  onKeep,
}: {
  readonly id: string
  readonly name: string
  readonly busy: boolean
  readonly onRemove: () => void
  readonly onKeep: () => void
}) {
  const tq = useTranslations('liffReceiving.photos')
  return (
    <div role="group" aria-labelledby={id} className="mt-1 flex flex-col gap-3 border-l-4 border-danger bg-surface px-3 py-2.5">
      <p id={id} tabIndex={-1} className="font-medium break-words text-ink outline-none">
        {tq('removeQuestion', { name })}
      </p>
      <p className="text-ink">{tq('removeDetail')}</p>
      <Button variant="danger" className={WRAPPING} onClick={onRemove} disabled={busy}>
        {tq('removeConfirm')}
      </Button>
      <Button variant="secondary" className={WRAPPING} onClick={onKeep}>
        {tq('removeKeep')}
      </Button>
    </div>
  )
}
