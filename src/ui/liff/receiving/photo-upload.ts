import { checkDeclaredUpload } from '@/lib/file-types'
import type { CompleteUploadResult, FileRefusal, RequestUploadResult } from '../../files/file-upload'
import { distinctPhotoName, prepareLiffPhoto } from '../image-resize'
import { openPhotoSendWindow, untilAborted, type PhotoSendWindow } from './send-window'

// Sending one photo of the LIFF receiving page (FR-LINE-003 AC3, FR-PLT-004, NFR-SEC-08), loaded only when a photo is
// chosen (import() in ./receive-flow.tsx) so none of it counts in the page's first JavaScript (§9.4: 200 KB gzip): the
// photo is made ready in the phone first (../image-resize.ts: upright, at most 2,000 px, a JPEG without the camera's
// metadata), named apart from the receipt's other photos (an iPhone calls every capture "image.jpg"), its declared type
// and size are checked as the server will check them, the LIFF session is made sure of, and then the file service's
// three steps run — a short-lived PUT address bound to the type and size, the bytes straight to private storage, and the
// server reading them back (size, magic bytes, sha256) before it records the file. The whole send has a time limit and
// can be stopped (./send-window.ts): after either, nothing more goes out and the PUT is cancelled. When the server says
// the page's session has ended, the page is told (onSessionEnded) and nothing more is sent.

/** The page's session has ended: nothing was done (the upload actions of a LIFF page answer this without a member) */
export type LiffNoSession = { readonly ok: false; readonly reason: 'UNAUTHENTICATED' }
export type LiffRequestUpload = (input: { fileName: string; mimeType: string; sizeBytes: number }) => Promise<RequestUploadResult | LiffNoSession>
export type LiffCompleteUpload = (ticket: string) => Promise<CompleteUploadResult | LiffNoSession>

/**
 * Why a photo is not attached. NOT_SENT: the page already knows why — the LIFF session cannot be used, the server said it
 * ended, or the receiver stopped the send. FAILED also covers a send that ran out of time.
 */
export type LiffPhotoRefusal = FileRefusal | 'UNREADABLE' | 'NOT_SENT'

export type LiffPhotoUpload = { readonly ok: true; readonly fileId: string; readonly fileName: string; readonly file: File } | { readonly ok: false; readonly reason: LiffPhotoRefusal }

export interface LiffPhotoUploadSteps {
  /** The names of the receipt's photos so far: the new one gets a name none of them has */
  readonly taken: readonly string[]
  /** The LIFF session can be used; false: nothing is sent (the page has said why) */
  readonly ready: () => Promise<boolean>
  readonly requestUpload: LiffRequestUpload
  readonly completeUpload: LiffCompleteUpload
  /** The prepared photo is on its way */
  readonly onSending: (fileName: string) => void
  /** The server found the page's session ended: the page says so */
  readonly onSessionEnded?: () => void
  /** The send's time limit and stop, when the page holds them (it may stop the send); otherwise the send has its own */
  readonly window?: PhotoSendWindow
}

const NOT_SENT: LiffPhotoUpload = { ok: false, reason: 'NOT_SENT' }

export async function uploadLiffPhoto(original: File, steps: LiffPhotoUploadSteps): Promise<LiffPhotoUpload> {
  const sendWindow = steps.window ?? openPhotoSendWindow()
  try {
    return await untilAborted(send(original, steps, sendWindow.signal), sendWindow.signal)
  } catch (error) {
    if (!sendWindow.signal.aborted) throw error
    // Out of time: the send failed (the page says so); stopped: the page knows
    return sendWindow.timedOut() ? { ok: false, reason: 'FAILED' } : NOT_SENT
  } finally {
    if (!steps.window) sendWindow.close()
  }
}

/** The steps of one send; each looks at the signal first, so nothing more goes out once the send is over */
async function send(original: File, steps: LiffPhotoUploadSteps, signal: AbortSignal): Promise<LiffPhotoUpload> {
  const prepared = await prepareLiffPhoto(original)
  if (!prepared.ok) return { ok: false, reason: 'UNREADABLE' }
  const name = distinctPhotoName(prepared.file.name, steps.taken)
  const file = name === prepared.file.name ? prepared.file : new File([prepared.file], name, { type: prepared.file.type, lastModified: prepared.file.lastModified })
  const refusal = checkDeclaredUpload(file.type, file.size)
  if (refusal) return { ok: false, reason: refusal }
  if (signal.aborted) return NOT_SENT
  const sessionReady = await steps.ready()
  if (signal.aborted || !sessionReady) return NOT_SENT
  steps.onSending(file.name)
  const started = await steps.requestUpload({ fileName: file.name, mimeType: file.type, sizeBytes: file.size })
  if (signal.aborted) return NOT_SENT
  if (!started.ok) return refusedBy(started.reason, steps)
  const put = await fetch(started.uploadUrl, { method: 'PUT', headers: { 'content-type': file.type }, body: file, signal }).catch(() => null)
  // The answer is read to its end, so the request closes (an unread body keeps the connection open)
  await put?.arrayBuffer().catch(() => null)
  if (signal.aborted) return NOT_SENT
  if (!put?.ok) return { ok: false, reason: 'FAILED' }
  const done = await steps.completeUpload(started.ticket)
  if (signal.aborted) return NOT_SENT
  if (!done.ok) return refusedBy(done.reason, steps)
  return { ok: true, fileId: done.fileId, fileName: done.fileName, file }
}

/** A refusal of the server; "no session" is told to the page, which says the session ended */
function refusedBy(reason: FileRefusal | 'UNAUTHENTICATED', steps: LiffPhotoUploadSteps): LiffPhotoUpload {
  if (reason !== 'UNAUTHENTICATED') return { ok: false, reason }
  steps.onSessionEnded?.()
  return NOT_SENT
}
