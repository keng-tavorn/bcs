'use client'

import { FileText, MessageSquareText } from 'lucide-react'
import { Button } from '../shadcn/button'
import { askAi } from '../shell/shell-events'

// The shortcuts "ถามเรื่องนี้" and "สรุปให้" of the panel "จากผู้ช่วย" (NEW-122 · ADR-079, NEW-118): both open the shell's
// "ถาม BCS AI" sheet with the document's number in the question, so the Insight Agent reads it through its read-only
// tools under the asker's rights (FR-AI-307). "สรุปให้" asks at once; "ถามเรื่องนี้" puts the number in the field for
// the member to finish. Shown only while the sheet is mounted (the page asks isAgentAvailable as the shell does); the
// sheet opens on the member's press only (NG-13).

export function AskShortcuts({ draft, summarize, labels }: { draft: string; summarize: string; labels: { readonly ask: string; readonly summarize: string } }) {
  return (
    <div className="flex flex-wrap gap-2">
      <Button type="button" variant="outline" className="min-h-11 lg:min-h-9" onClick={() => askAi(draft, { send: false })}>
        <MessageSquareText aria-hidden="true" />
        {labels.ask}
      </Button>
      <Button type="button" variant="outline" className="min-h-11 lg:min-h-9" onClick={() => askAi(summarize)}>
        <FileText aria-hidden="true" />
        {labels.summarize}
      </Button>
    </div>
  )
}
