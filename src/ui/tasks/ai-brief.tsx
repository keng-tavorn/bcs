import { Sparkles } from 'lucide-react'
import type { ReactNode } from 'react'

// The "สรุปจาก AI" box of the decision bar (FR-AI-301 AC1 AC3, §12.5): apart from everything else on the page, Sparkles in
// --info, "AI อาจผิดพลาด ตรวจกับเอกสาร", the sentences when the reader may see them and the facts from the system under
// them. No decision button: the Brief decides nothing (BR-AI-01); in the panel "จากผู้ช่วย" (NEW-122) the reader may say
// under it whether it helped (`feedback`).

export interface AiBriefProps {
  readonly title: string
  readonly note: string
  readonly pending: string | null
  readonly sentences: readonly string[] | null
  readonly factsOnly: string | null
  readonly factsTitle: string
  readonly facts: ReadonlyArray<{ readonly label: string; readonly value: string }>
}

export function AiBrief({ brief, feedback }: { brief: AiBriefProps; feedback?: ReactNode }) {
  return (
    <section aria-labelledby="ai-brief-title" className="flex flex-col gap-3 rounded-md border border-info bg-bg p-4">
      <h3 id="ai-brief-title" className="flex items-center gap-2 font-semibold">
        <Sparkles className="size-4 text-info" aria-hidden="true" />
        {brief.title}
      </h3>
      <p className="text-base text-ink-muted md:text-sm">{brief.note}</p>
      {brief.pending ? <p role="status">{brief.pending}</p> : null}
      {brief.sentences ? (
        <ul className="flex list-disc flex-col gap-1 pl-5">
          {brief.sentences.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ul>
      ) : null}
      {brief.factsOnly ? <p className="text-ink-muted">{brief.factsOnly}</p> : null}
      <div className="flex flex-col gap-1">
        <h4 className="font-medium">{brief.factsTitle}</h4>
        <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1">
          {brief.facts.map((f) => (
            <div key={f.label} className="contents">
              <dt className="text-ink-muted">{f.label}</dt>
              <dd className="tabular text-right">{f.value}</dd>
            </div>
          ))}
        </dl>
      </div>
      {feedback}
    </section>
  )
}
