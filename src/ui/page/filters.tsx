import Link from 'next/link'
import type { ReactNode } from 'react'
import { Button } from '../shadcn/button'
import { Input } from '../shadcn/input'
import { NativeSelect, NativeSelectOption } from '../shadcn/native-select'
import { Panel } from './page'

// The filters of a Workspace list (spec §9.10 "ตัวกรอง", S16-10): one row in a white card above the list, a plain GET
// form — it changes nothing (§17.3) — whose fields are the list's address, read on the server with the nuqs loaders of
// each page, so a filtered list can be linked to and reloaded. Phones stack the fields; the count of what matched and
// "clear filters" sit under the row. Native selects on purpose: one control that works the same on a phone (§9.10
// "Native Select (มือถือ)") and without the page's script.

const CONTROL = 'h-11 bg-bg text-base lg:h-10 md:text-base'

export interface FilterBarProps {
  readonly action: string
  /** Names the card for screen readers */
  readonly label: string
  readonly submit: string
  /** Values that stay in the address while these filters change (a narrowed scope, a tab) */
  readonly hidden?: Readonly<Record<string, string | null | undefined>>
  readonly children: ReactNode
  /** Under the row: what matched, what narrows the list, "clear filters" */
  readonly footer?: ReactNode
}

export function FilterBar({ action, label, submit, hidden = {}, children, footer }: FilterBarProps) {
  return (
    <Panel label={label}>
      <form method="get" action={action} className="flex flex-col gap-3 md:flex-row md:flex-wrap md:items-start">
        {Object.entries(hidden).map(([name, value]) => (value ? <input key={name} type="hidden" name={name} value={value} /> : null))}
        {children}
        <div className="flex flex-col gap-1.5">
          {/* Lines the button up with the fields on wide screens, under a label-sized gap */}
          <span aria-hidden="true" className="hidden font-medium md:block">
            &nbsp;
          </span>
          <Button type="submit" variant="outline" className="min-h-11 self-start lg:min-h-10">
            {submit}
          </Button>
        </div>
      </form>
      {footer}
    </Panel>
  )
}

export function FilterSearch({ id, name = 'q', label, hint, defaultValue, maxLength = 60 }: { id: string; name?: string; label: string; hint?: string; defaultValue: string; maxLength?: number }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1.5 md:min-w-64">
      <label htmlFor={id} className="font-medium text-ink">
        {label}
      </label>
      <Input id={id} name={name} type="search" defaultValue={defaultValue} maxLength={maxLength} aria-describedby={hint ? `${id}-hint` : undefined} className={CONTROL} />
      {hint ? (
        <p id={`${id}-hint`} className="text-base text-ink-muted md:text-sm">
          {hint}
        </p>
      ) : null}
    </div>
  )
}

export function FilterSelect({
  id,
  name,
  label,
  options,
  defaultValue,
  all,
}: {
  id: string
  name: string
  label: string
  options: ReadonlyArray<{ readonly value: string; readonly label: string }>
  defaultValue: string
  /** The first choice, that filters nothing */
  all?: string
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5 md:w-56">
      <label htmlFor={id} className="font-medium text-ink">
        {label}
      </label>
      <NativeSelect id={id} name={name} defaultValue={defaultValue} className="w-full [&_select]:h-11 [&_select]:bg-bg [&_select]:text-base lg:[&_select]:h-10">
        {all !== undefined ? <NativeSelectOption value="">{all}</NativeSelectOption> : null}
        {options.map((o) => (
          <NativeSelectOption key={o.value} value={o.value}>
            {o.label}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    </div>
  )
}

/** What the filters matched, what narrows the list, and the way back to all of it */
export function FilterSummary({ count, notes = [], clear }: { count: string; notes?: readonly string[]; clear?: { readonly href: string; readonly label: string } | null }) {
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-1 border-t border-line pt-3">
      {notes.map((text) => (
        <p key={text} className="basis-full font-medium text-ink">
          {text}
        </p>
      ))}
      <p className="text-ink" role="status">
        {count}
      </p>
      {clear ? (
        <Link href={clear.href} className="inline-flex min-h-11 items-center font-medium text-primary underline underline-offset-4 hover:no-underline lg:min-h-10">
          {clear.label}
        </Link>
      ) : null}
    </div>
  )
}
