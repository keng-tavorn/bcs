import { Badge } from '@/ui/shadcn/badge'

// S7-14 (FR-AI-304 AC2): what the AI read off the application's documents, on its page — each value with the label
// "เติมโดย AI โปรดตรวจ", how sure the AI was, whether it waits one by one, and a check that found something; the values
// go in by the supplier on the portal (or procurement's own form). Read only.

/** One reading as the page shows it (the shape of AiReading of src/server/services/suppliers/ai-assist.ts) */
export interface AiReading {
  readonly agentActionId: string
  readonly documentTypeCode: string | null
  readonly fileName: string | null
  /** Checks on the document as a whole that did not pass: its date, its validity, the bank read */
  readonly documentChecks: readonly ('DOC_DATE_FUTURE' | 'DOC_EXPIRED' | 'BANK_UNKNOWN')[]
  readonly fields: readonly { readonly path: string; readonly value: string; readonly confidencePercent: number; readonly check: 'WARN' | 'FAIL' | null; readonly mustConfirm: boolean; readonly confirmed: boolean }[]
}

export interface AiReadingsLabels {
  readonly byAi: string
  readonly taken: string
  readonly mustConfirm: string
  readonly confidence: (percent: number) => string
  readonly field: (path: string) => string
  readonly doc: (code: string | null) => string
  readonly check: (result: 'WARN' | 'FAIL') => string
  readonly docCheck: (code: 'DOC_DATE_FUTURE' | 'DOC_EXPIRED' | 'BANK_UNKNOWN') => string
  readonly yesNo: (value: boolean) => string
}

export function AiReadings({ readings, labels }: { readonly readings: readonly AiReading[]; readonly labels: AiReadingsLabels }) {
  return (
    <div className="flex flex-col gap-4">
      {readings.map((r) => (
        <section key={r.agentActionId} aria-label={labels.doc(r.documentTypeCode)} className="flex flex-col gap-2">
          <p className="font-medium">
            {labels.doc(r.documentTypeCode)}
            {r.fileName ? ` · ${r.fileName}` : ''}
          </p>
          {r.documentChecks.length ? (
            <ul className="flex flex-wrap gap-2">
              {r.documentChecks.map((code) => (
                <li key={code}>
                  <Badge variant={code === 'BANK_UNKNOWN' ? 'outline' : 'destructive'}>{labels.docCheck(code)}</Badge>
                </li>
              ))}
            </ul>
          ) : null}
          <dl className="grid gap-x-4 gap-y-2 sm:grid-cols-[minmax(10rem,auto)_1fr]">
            {r.fields.map((f) => (
              <div key={f.path} className="contents">
                <dt className="text-ink-muted">{labels.field(f.path)}</dt>
                <dd className="flex flex-wrap items-center gap-2">
                  <span>{f.path === 'isVatRegistered' ? labels.yesNo(f.value === 'true') : f.value}</span>
                  <Badge variant={f.confirmed ? 'secondary' : 'outline'}>{f.confirmed ? labels.taken : labels.byAi}</Badge>
                  <span className="text-ink-muted">{labels.confidence(f.confidencePercent)}</span>
                  {f.mustConfirm && !f.confirmed ? <span className="text-ink-muted">{labels.mustConfirm}</span> : null}
                  {f.check ? <Badge variant={f.check === 'FAIL' ? 'destructive' : 'outline'}>{labels.check(f.check)}</Badge> : null}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </div>
  )
}
