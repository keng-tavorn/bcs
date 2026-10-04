'use client'

import { useTranslations } from 'next-intl'
import { useId, useState } from 'react'
import { LiffNotice } from '../notice'
import { CameraIcon } from './camera-icon'

// One photo of a goods receipt on the LIFF receiving page (FR-LINE-003 AC3, FR-PLT-004 AC2): the address of the picture
// is asked for only when the receiver taps it — the server checks that this member may see the receipt and gives an
// address valid five minutes — so no storage address sits in the page until then. The picture opens right under its
// button, in the page (a disclosure: tap again to hide it), so a receiver halfway through the next receipt keeps what
// they entered: the page never leaves for the picture. It is loaded before it is shown, so an address that no longer
// works says so instead of an empty frame, and it keeps its own shape.

type Shown = { readonly url: string; readonly width: number; readonly height: number }

/** The picture's size once the phone has loaded it from the address, or null when it cannot be loaded */
function loadPicture(url: string): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    const picture = new Image()
    picture.onload = () => resolve(picture.naturalWidth > 0 && picture.naturalHeight > 0 ? { width: picture.naturalWidth, height: picture.naturalHeight } : null)
    picture.onerror = () => resolve(null)
    picture.src = url
  })
}

/** The address as a CSS url(), its quotes and line breaks escaped */
const cssUrl = (url: string) => `url("${url.replace(/["\\\n\r]/g, (c) => encodeURIComponent(c))}")`

export function LiffPhotoButton({
  fileId,
  name,
  open,
}: {
  readonly fileId: string
  /** What the photo is called on the page: its file name, numbered when another photo of the receipt has the same one */
  readonly name: string
  readonly open: (fileId: string) => Promise<string | null>
}) {
  const t = useTranslations('receiving.history')
  const tForm = useTranslations('receiving.form')
  const tLiff = useTranslations('liffReceiving.photos')
  const id = useId()
  const [state, setState] = useState<'idle' | 'opening' | 'failed'>('idle')
  const [shown, setShown] = useState<Shown | null>(null)

  async function onToggle() {
    if (shown) return setShown(null)
    setState('opening')
    const url = await open(fileId).catch(() => null)
    const size = url ? await loadPicture(url) : null
    if (!url || !size) return setState('failed')
    setState('idle')
    setShown({ url, ...size })
  }

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={() => void onToggle()}
        disabled={state === 'opening'}
        aria-busy={state === 'opening' || undefined}
        aria-expanded={shown !== null}
        aria-controls={shown ? `${id}-photo` : undefined}
        className="inline-flex min-h-11 items-center gap-2 self-start text-left font-medium text-primary underline underline-offset-4 hover:no-underline disabled:opacity-60"
      >
        <CameraIcon className="size-4" />
        <span className="break-all">{state === 'opening' ? t('openingPhoto', { name }) : shown ? tLiff('hide', { name }) : t('openPhoto', { name })}</span>
      </button>
      {shown ? (
        <span
          id={`${id}-photo`}
          role="img"
          aria-label={tForm('photoItem', { name })}
          className="block w-full max-w-md rounded-md border border-line bg-surface bg-contain bg-center bg-no-repeat"
          style={{ backgroundImage: cssUrl(shown.url), aspectRatio: `${shown.width} / ${shown.height}` }}
        />
      ) : null}
      {state === 'failed' ? <LiffNotice tone="danger">{t('photoFailed', { name })}</LiffNotice> : null}
    </div>
  )
}
