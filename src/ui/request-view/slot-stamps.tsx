import { StateLine, type StateKind } from './status'

// A step of several slots — the reviewers' step or a committee (S6 · ADR-103): its title and how far it is ("ผ่านแล้ว 2
// ใน 3 ฝ่าย"), then one stamp per slot down a rule on its left: who holds the slot (the reviewers of the ANY rules each,
// whoever decides first), what they answer for, and the slot's state, with who decided for whom. Words come translated
// from the caller, so the workspace and LIFF draw the same thing; no cards, as the sections around it (§9.9).

export interface SlotStamp {
  readonly key: string
  /** The holder, or "A หรือ B" for a slot of several */
  readonly who: string
  readonly role?: string | undefined
  readonly rules?: string | undefined
  readonly decidedBy?: string | undefined
  readonly state: { readonly kind: StateKind; readonly text: string }
}

export function SlotStamps({ title, progress, slots }: { title: string; progress: string; slots: readonly SlotStamp[] }) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex flex-col">
        <p className="font-medium text-ink">{title}</p>
        <p className="text-ink-muted">{progress}</p>
      </div>
      <ol className="flex flex-col gap-2 border-l-2 border-line pl-3">
        {slots.map((s) => (
          <li key={s.key} className="flex flex-col gap-0.5">
            <span className="break-words text-ink">{s.who}</span>
            {s.role ? <span className="text-ink-muted">{s.role}</span> : null}
            {s.rules ? <span className="text-ink-muted">{s.rules}</span> : null}
            <StateLine kind={s.state.kind}>{s.state.text}</StateLine>
            {s.decidedBy ? <span className="text-ink-muted">{s.decidedBy}</span> : null}
          </li>
        ))}
      </ol>
    </div>
  )
}
