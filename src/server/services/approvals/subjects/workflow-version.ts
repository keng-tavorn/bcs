import { emptyAdapter } from './empty'

// The WORKFLOW_VERSION approval subject (ADR-068). Filled by S6 (lane 1, FR-WF-103); its channels stay off (BR-DOA-15, BR-DOA-25); until then the empty adapter of P1-07.
export const workflowVersionSubject = emptyAdapter('WORKFLOW_VERSION')
