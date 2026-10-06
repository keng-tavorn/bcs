// A route step that waits for more than one approver (spec BR-SLA-04, NEW-46): the first assignee of an escalated step
// and the approver of the next band added as co-assignee — or a delegate who holds one of the tasks — each with their
// position, the line that says why there are two (`mark`: escalated when overdue) and the line that says whoever decides
// first decides. The step's state sits beside it as for any step. Strings arrive translated.

export interface StepApprover {
  readonly key: string
  /** The name, or "หรือ …" for the approvers after the first */
  readonly name: string
  readonly role?: string | undefined
  /** "รักษาการแทน …" when a delegate holds the task (BR-DLG-04) */
  readonly actingFor?: string | undefined
}

export function StepApprovers({ title, approvers, note, mark }: { title: string; approvers: readonly StepApprover[]; note: string; mark?: string | undefined }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <p className="font-medium text-ink">{title}</p>
      <ul className="flex flex-col gap-1">
        {approvers.map((a) => (
          <li key={a.key} className="flex flex-col">
            <span className="break-words text-ink">{a.name}</span>
            {a.role ? <span className="text-ink-muted">{a.role}</span> : null}
            {a.actingFor ? <span className="text-ink-muted">{a.actingFor}</span> : null}
          </li>
        ))}
      </ul>
      {/* Why there are two, and who decides: sentences of the step at the body's size, as the one-approver step's (§9.9: 15 px on the web) */}
      {mark ? <p className="text-ink-muted">{mark}</p> : null}
      <p className="text-ink-muted">{note}</p>
    </div>
  )
}
