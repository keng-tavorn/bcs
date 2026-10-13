import { emptyAdapter } from './empty'

// The WORKFLOW_VERSION approval subject (ADR-068). Filled by S6 (lane 1, FR-WF-103); until then the empty adapter of
// P1-07. Its channels stay off whatever S6 writes: no chat button, no e-mail link, and no LIFF — a workflow version is
// decided on the web only (BR-DOA-25, OQ-110).
const empty = emptyAdapter('WORKFLOW_VERSION')
export const workflowVersionSubject = { ...empty, channels: { ...empty.channels, liff: false } }
