// The "สรุปจาก AI" box of a LIFF task page (FR-AI-301 AC1, ADR-052): the light set's plain HTML and CSS, no component or
// library of the Workspace, no JavaScript of its own. The words come ready from the page (src/app/_lib/brief-present.ts).

export interface AiBriefBoxProps {
  readonly title: string
  readonly note: string
  readonly pending: string | null
  readonly sentences: readonly string[] | null
  readonly factsOnly: string | null
  readonly factsTitle: string
  readonly facts: ReadonlyArray<{ readonly label: string; readonly value: string }>
}

export function AiBriefBox({ brief }: { brief: AiBriefBoxProps | null }) {
  if (!brief) return null
  return (
    <section aria-labelledby="liff-ai-brief" className="flex flex-col gap-2 rounded-md border border-info p-3">
      <h2 id="liff-ai-brief" className="font-semibold">
        {brief.title}
      </h2>
      <p className="text-sm text-ink-muted">{brief.note}</p>
      {brief.pending ? <p role="status">{brief.pending}</p> : null}
      {brief.sentences ? (
        <ul className="flex list-disc flex-col gap-1 pl-5">
          {brief.sentences.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ul>
      ) : null}
      {brief.factsOnly ? <p className="text-ink-muted">{brief.factsOnly}</p> : null}
      <p className="font-medium">{brief.factsTitle}</p>
      <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1">
        {brief.facts.map((f) => (
          <div key={f.label} className="contents">
            <dt className="text-ink-muted">{f.label}</dt>
            <dd className="text-right">{f.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}
