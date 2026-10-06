import { MS_PER_MINUTE } from '@/lib/constants'
import { checkDeclaredUpload, mimeTypeFromName } from '@/lib/file-types'
import type { CompleteUploadResult, FileRefusal, RequestUploadResult } from './file-upload'
import { prepareFile } from './prepare-image'

// One upload of the workspace (FR-PLT-004, NFR-SEC-08): the file made ready in the browser first (./prepare-image.ts: a
// photo upright, at most 2,000 px and without its EXIF; a photo the browser cannot decode is refused), its declared type
// and size checked as the server checks them, then the file service's three steps — a short-lived PUT address bound to
// that type and size, the bytes straight to private storage, and the server reading them back (size, first bytes,
// sha256) before it records the file. Every upload has an end, as the LIFF camera's has (src/ui/liff/receiving/
// send-window.ts): it fails after FILE_UPLOAD_LIMIT_MS, and the person can stop it; after either nothing more goes out
// and the PUT is cancelled. A form that waits for its upload (the receiving form holds the receipt for its photo) is so
// never locked by a stalled network.

/**
 * The longest one upload may take, from the choice of the file to the server recording it: a 20 MB file on a slow link,
 * well within the 15 minutes the server's upload ticket is valid
 */
export const FILE_UPLOAD_LIMIT_MS = 10 * MS_PER_MINUTE

/** Why a file is not attached: the server's or the browser's refusal, a photo the browser cannot decode, or the person stopped it */
export type UploadRefusalReason = FileRefusal | 'UNREADABLE' | 'STOPPED'

export type UploadOutcome = { readonly ok: true; readonly fileId: string; readonly fileName: string } | { readonly ok: false; readonly reason: UploadRefusalReason }

export interface UploadSteps {
  readonly requestUpload: (input: { fileName: string; mimeType: string; sizeBytes: number }) => Promise<RequestUploadResult>
  readonly completeUpload: (ticket: string) => Promise<CompleteUploadResult>
  /** The prepared file is on its way, under this name */
  readonly onSending?: (fileName: string) => void
}

export interface UploadWindow {
  /** Aborts when the time is up or when the person stops the upload */
  readonly signal: AbortSignal
  /** The person stops the upload */
  readonly stop: () => void
  /** Whether it ended because the time was up (rather than stopped) */
  readonly timedOut: () => boolean
  /** Ends the timer once the upload is over, whatever its outcome */
  readonly close: () => void
}

export function openUploadWindow(limitMs: number = FILE_UPLOAD_LIMIT_MS): UploadWindow {
  const control = new AbortController()
  let late = false
  const timer = setTimeout(() => {
    // Only an upload still running runs out of time
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

const STOPPED: UploadOutcome = { ok: false, reason: 'STOPPED' }
const FAILED: UploadOutcome = { ok: false, reason: 'FAILED' }

/** The work's answer, or a rejection as soon as the signal aborts (the work may go on — a server action cannot be called back — and its answer is dropped) */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error('the upload was stopped or ran out of time'))
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error instanceof Error ? error : new Error('the upload failed'))
      },
    )
  })
}

/**
 * Uploads one file within `uploadWindow` (its own, with FILE_UPLOAD_LIMIT_MS, when none is given): ok with the recorded
 * file, or why not — STOPPED when the person stopped it, FAILED when the time ran out or the connection or a step broke off
 */
export async function uploadFile(original: File, steps: UploadSteps, uploadWindow?: UploadWindow): Promise<UploadOutcome> {
  const limit = uploadWindow ?? openUploadWindow()
  try {
    return await untilAborted(send(original, steps, limit.signal), limit.signal)
  } catch {
    return limit.signal.aborted && !limit.timedOut() ? STOPPED : FAILED
  } finally {
    if (!uploadWindow) limit.close()
  }
}

/** The steps of one upload; each looks at the signal first, so nothing more goes out once the upload is over */
async function send(original: File, steps: UploadSteps, signal: AbortSignal): Promise<UploadOutcome> {
  const prepared = await prepareFile(original)
  if (!prepared.ok) return { ok: false, reason: 'UNREADABLE' }
  const file = prepared.file
  const mimeType = file.type || mimeTypeFromName(file.name) || ''
  const refusal = checkDeclaredUpload(mimeType, file.size)
  if (refusal) return { ok: false, reason: refusal }
  if (signal.aborted) return STOPPED
  steps.onSending?.(file.name)
  const started = await steps.requestUpload({ fileName: file.name, mimeType, sizeBytes: file.size })
  if (signal.aborted) return STOPPED
  if (!started.ok) return { ok: false, reason: started.reason }
  const put = await fetch(started.uploadUrl, { method: 'PUT', headers: { 'content-type': mimeType }, body: file, signal }).catch(() => null)
  // The answer is read to its end, so the request closes (an unread body keeps the connection open)
  await put?.arrayBuffer().catch(() => null)
  if (signal.aborted) return STOPPED
  if (!put?.ok) return FAILED
  const done = await steps.completeUpload(started.ticket)
  if (signal.aborted) return STOPPED
  if (!done.ok) return { ok: false, reason: done.reason }
  return { ok: true, fileId: done.fileId, fileName: done.fileName }
}
