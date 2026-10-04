import type { ReactNode } from 'react'

// The rich-text tags LIFF messages may use (t.rich / getTranslations().rich). <nw>…</nw> keeps a word on one line: the
// browser's Thai line breaking splits some loanwords in the middle (the word for "chat" broke after its second letter
// at 375 px), so the Thai messages mark them. Messages without tags render the same through t.rich.

export const LIFF_RICH = {
  nw: (chunks: ReactNode) => <span className="whitespace-nowrap">{chunks}</span>,
} as const
