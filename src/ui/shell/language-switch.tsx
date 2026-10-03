import { cn } from '../cn'

// Thai / English switch (FR-PLT-002 AC2). Each language is named in itself; the form posts to a server action.
export function LanguageSwitch({
  current,
  label,
  options,
  action,
}: {
  current: string
  label: string
  options: ReadonlyArray<{ value: string; name: string }>
  action: (formData: FormData) => Promise<void>
}) {
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <span className="text-base text-ink-muted md:text-sm">{label}</span>
      {options.map((option) => (
        <button
          key={option.value}
          type="submit"
          name="locale"
          value={option.value}
          aria-pressed={option.value === current}
          className={cn(
            'min-h-9 rounded-md border px-3 text-base md:text-sm',
            option.value === current ? 'border-primary font-semibold text-ink' : 'border-input text-ink hover:bg-surface',
          )}
        >
          {option.name}
        </button>
      ))}
    </form>
  )
}
