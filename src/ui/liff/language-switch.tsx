import { cn } from '../cn'

// Thai / English on a LIFF page (FR-PLT-002 AC2): the workspace switch with 44 px touch targets (§9.4). Each language is
// named in itself; the form posts to the server action that keeps the choice in a cookie (never a GET).
export function LiffLanguageSwitch({
  current,
  label,
  options,
  action,
}: {
  readonly current: string
  readonly label: string
  readonly options: ReadonlyArray<{ readonly value: string; readonly name: string }>
  readonly action: (formData: FormData) => Promise<void>
}) {
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <span className="text-ink-muted">{label}</span>
      {options.map((option) => (
        <button
          key={option.value}
          type="submit"
          name="locale"
          value={option.value}
          aria-pressed={option.value === current}
          className={cn(
            'min-h-11 min-w-11 rounded-md border px-3',
            option.value === current ? 'border-primary font-semibold text-ink' : 'border-input text-ink hover:bg-surface',
          )}
        >
          {option.name}
        </button>
      ))}
    </form>
  )
}
