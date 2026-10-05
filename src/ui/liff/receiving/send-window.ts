import { MS_PER_SECOND } from '@/lib/constants'

// The time one photo of a LIFF page may take to be sent, and the way to stop it (FR-LINE-003 AC3, §9.4): a site's mobile
// network can stall, and while a photo is on its way the receipt waits for it (./receive-flow.tsx), so every send has
// an end. The window aborts by itself after LIFF_PHOTO_SEND_LIMIT_MS — the send failed, the page says so and the
// receiver may try again — or when the receiver stops it: nothing is attached and the receipt can go on. Small and
// loaded with the page, so loading the photo code itself (./photo-upload.ts, fetched when a photo is taken) is bounded
// by it too.

/** The longest one photo may take, from the tap to the server recording it: a 600 KB photo on a very slow link */
export const LIFF_PHOTO_SEND_LIMIT_MS = 90 * MS_PER_SECOND

export interface PhotoSendWindow {
  /** Aborts when the time is up or when the receiver stops the send */
  readonly signal: AbortSignal
  /** The receiver stops the send */
  readonly stop: () => void
  /** Whether it ended because the time was up (rather than stopped) */
  readonly timedOut: () => boolean
  /** Ends the timer once the send is over, whatever its outcome */
  readonly close: () => void
}

export function openPhotoSendWindow(limitMs: number = LIFF_PHOTO_SEND_LIMIT_MS): PhotoSendWindow {
  const control = new AbortController()
  let late = false
  const timer = setTimeout(() => {
    // Only a send still running runs out of time
    if (control.signal.aborted) return
    late = true
    control.abort()
  }, limitMs)
  return {
    signal: control.signal,
    stop: () => {
      clearTimeout(timer)
      control.abort()
    },
    timedOut: () => late,
    close: () => clearTimeout(timer),
  }
}

/** Thrown in place of an answer that came too late: the send's window closed first */
export class PhotoSendAborted extends Error {
  constructor() {
    super('the photo send was stopped or ran out of time')
    this.name = 'PhotoSendAborted'
  }
}

/**
 * The work's answer, or PhotoSendAborted as soon as the signal aborts. The work itself may go on (a server action cannot
 * be called back); its answer is then dropped.
 */
export function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new PhotoSendAborted())
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error instanceof Error ? error : new Error('the photo send failed'))
      },
    )
  })
}
