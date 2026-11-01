'use client'

import { createContext, useContext, useMemo, useState, type ReactNode } from 'react'

// The box of the reader's step on the route's map decides too (ADR-076), and the decision bar stays the one place that
// decides: it publishes what it can do here, and the box's buttons only ask it to open its own confirmation. So the
// second press, the PIN, the reason and the service call are the bar's in both cases, and when the bar has no open task
// to decide (decided, or closed under the reader) the box has no buttons either.

export type OtherDecision = 'ASK' | 'RETURN' | 'REJECT'

export interface DecisionCommands {
  readonly approveLabel: string
  readonly moreLabel: string
  readonly others: ReadonlyArray<{ readonly key: OtherDecision; readonly label: string }>
  readonly approve: () => void
  readonly open: (which: OtherDecision) => void
}

const Link = createContext<{ readonly commands: DecisionCommands | null; readonly publish: (commands: DecisionCommands | null) => void } | null>(null)

export function DecisionLink({ children }: { children: ReactNode }) {
  const [commands, publish] = useState<DecisionCommands | null>(null)
  const value = useMemo(() => ({ commands, publish }), [commands])
  return <Link.Provider value={value}>{children}</Link.Provider>
}

export const useDecisionLink = () => useContext(Link)
