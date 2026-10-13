// What a page asks of the shell (spec §9.10 "หน้าแรก"): the home's search field opens the shell's ⌘K palette, and its chip
// "เริ่มคำขอใหม่" the shell's dialog of request types — the same palette and dialog, never a second copy. A page sends a
// window event; the shell's palette and door listen while they are mounted.

const OPEN_PALETTE = 'bcs:open-palette'
const OPEN_NEW_REQUEST = 'bcs:open-new-request'
const ASK_AI = 'bcs:ask-ai'

/** Asks BCS AI from ⌘K (FR-AI-309): the chat sheet of the shell listens while it is mounted */
export function askAi(question: string): void {
  window.dispatchEvent(new CustomEvent<string>(ASK_AI, { detail: question }))
}

/** For the chat sheet: the question asked from ⌘K; returns the cleanup */
export function onAskAi(listener: (question: string) => void): () => void {
  const handler = (e: Event) => listener((e as CustomEvent<string>).detail)
  window.addEventListener(ASK_AI, handler)
  return () => window.removeEventListener(ASK_AI, handler)
}

/** Opens the ⌘K palette (FR-PLT-014) */
export function openPalette(): void {
  window.dispatchEvent(new Event(OPEN_PALETTE))
}

/** Opens the dialog of request types (FR-INT-010); false when no door listens (a member who may not create requests) */
export function openNewRequest(): boolean {
  // the door cancels the event when it opens: an event nobody cancelled leaves the link to do its work
  return !window.dispatchEvent(new Event(OPEN_NEW_REQUEST, { cancelable: true }))
}

/** For the palette and the door: listen while mounted; returns the cleanup */
export function onShellEvent(which: 'palette' | 'new-request', listener: (e: Event) => void): () => void {
  const type = which === 'palette' ? OPEN_PALETTE : OPEN_NEW_REQUEST
  window.addEventListener(type, listener)
  return () => window.removeEventListener(type, listener)
}
