import type { BadgeLook } from '../document/badge-looks'

// Not in the 'use client' questionnaire editor (questionnaire.tsx): a server module reads it too, and a value of a 'use client' module reaches a server module as a client reference,
// not the value (tests/unit/client-boundary.test.ts · S7-18)
// (the version page's badge read STATUS_LOOK[status] on the server and got no look)

export type QuestionnaireStatusUi = 'DRAFT' | 'PENDING_PUBLISH' | 'PUBLISHED' | 'SUPERSEDED'

export const STATUS_LOOK: Record<QuestionnaireStatusUi, BadgeLook> = {
  DRAFT: { tone: 'neutral', icon: 'FilePen' },
  PENDING_PUBLISH: { tone: 'warn', icon: 'Hourglass' },
  PUBLISHED: { tone: 'ok', icon: 'CircleCheck' },
  SUPERSEDED: { tone: 'neutral', icon: 'Ban' },
}
