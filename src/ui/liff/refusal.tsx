import type { ReactNode } from 'react'
import { LiffNotice } from './notice'

// A refusal on a LIFF page (§9.9 rule 7): what happened, in the heading line, and what to do about it, with the one
// action that helps when there is one. Announced at once (role=alert); an icon and words, never colour alone. Never the
// error's developer message, a token or a code: the page turns the error code into words.

export interface LiffRefusalProps {
  readonly title: string
  /** What to do about it */
  readonly children: ReactNode
  /** A link or button that helps (open the web settings, try again) */
  readonly action?: ReactNode
}

export function LiffRefusal({ title, children, action }: LiffRefusalProps) {
  return (
    <LiffNotice tone="danger">
      <p className="font-semibold">{title}</p>
      <p>{children}</p>
      {action ? <div className="mt-2 flex flex-wrap gap-3">{action}</div> : null}
    </LiffNotice>
  )
}
