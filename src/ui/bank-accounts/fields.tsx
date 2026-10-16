'use client'

import { CircleAlert } from 'lucide-react'
import type { ComponentProps, ReactNode } from 'react'
import { cn } from '../cn'
import { Field, FieldDescription, FieldLabel, FieldLegend, FieldSet } from '../shadcn/field'
import { Input } from '../shadcn/input'
import { NativeSelect, NativeSelectOption } from '../shadcn/native-select'
import { RadioGroup, RadioGroupItem } from '../shadcn/radio-group'
import { Textarea } from '../shadcn/textarea'

// The fields of the bank-account forms (S9-09, §9.10 ฟอร์ม: Field · Input · Native Select · Radio Group · Textarea), at
// the sizes of §9.10 — 44 px controls, 16 px text on phones — with the hint under the label and the error under the
// field, in words with an icon, never colour alone (NFR-A11Y-03), announced with the field (aria-describedby).

const CONTROL = 'h-11 text-base'

function described(id: string, hint: ReactNode, error: ReactNode): string | undefined {
  return [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(' ') || undefined
}

export function FieldProblem({ id, children }: { id: string; children: ReactNode }) {
  return (
    <p id={id} className="flex items-start gap-1.5 text-base text-danger md:text-sm">
      <CircleAlert className="mt-1 size-4 shrink-0" aria-hidden="true" />
      <span>{children}</span>
    </p>
  )
}

export function TextField({ id, label, hint, error, className, ...input }: { id: string; label: ReactNode; hint?: ReactNode; error?: ReactNode } & Omit<ComponentProps<'input'>, 'id'>) {
  return (
    <Field>
      <FieldLabel htmlFor={id} className="text-base font-medium text-ink">
        {label}
      </FieldLabel>
      {hint ? <FieldDescription id={`${id}-hint`}>{hint}</FieldDescription> : null}
      <Input id={id} aria-invalid={error ? true : undefined} aria-describedby={described(id, hint, error)} className={cn(CONTROL, className)} {...input} />
      {error ? <FieldProblem id={`${id}-error`}>{error}</FieldProblem> : null}
    </Field>
  )
}

export function NoteField({ id, label, hint, error, className, ...input }: { id: string; label: ReactNode; hint?: ReactNode; error?: ReactNode } & Omit<ComponentProps<'textarea'>, 'id'>) {
  return (
    <Field>
      <FieldLabel htmlFor={id} className="text-base font-medium text-ink">
        {label}
      </FieldLabel>
      {hint ? <FieldDescription id={`${id}-hint`}>{hint}</FieldDescription> : null}
      <Textarea id={id} aria-invalid={error ? true : undefined} aria-describedby={described(id, hint, error)} className={cn('min-h-24 text-base', className)} {...input} />
      {error ? <FieldProblem id={`${id}-error`}>{error}</FieldProblem> : null}
    </Field>
  )
}

export interface SelectChoice {
  readonly value: string
  readonly label: string
}

/** A list chosen with the phone's own picker (Native Select): banks, accounts */
export function ChoiceSelect({
  id,
  label,
  hint,
  error,
  choices,
  value,
  onChange,
  placeholder,
  disabled,
}: {
  id: string
  label: ReactNode
  hint?: ReactNode
  error?: ReactNode
  choices: readonly SelectChoice[]
  value: string
  onChange: (value: string) => void
  placeholder: string
  disabled?: boolean
}) {
  return (
    <Field>
      <FieldLabel htmlFor={id} className="text-base font-medium text-ink">
        {label}
      </FieldLabel>
      {hint ? <FieldDescription id={`${id}-hint`}>{hint}</FieldDescription> : null}
      <NativeSelect
        id={id}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={described(id, hint, error)}
        disabled={disabled}
        className="w-full [&_select]:h-11 [&_select]:text-base"
      >
        <NativeSelectOption value="">{placeholder}</NativeSelectOption>
        {choices.map((c) => (
          <NativeSelectOption key={c.value} value={c.value}>
            {c.label}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      {error ? <FieldProblem id={`${id}-error`}>{error}</FieldProblem> : null}
    </Field>
  )
}

export interface RadioChoice<V extends string> {
  readonly value: V
  readonly label: string
  readonly hint?: string
}

/** One choice of a few, each with what it does (Radio Group) */
export function RadioChoices<V extends string>({
  id,
  legend,
  choices,
  value,
  onChange,
  error,
  disabled,
}: {
  id: string
  legend: string
  choices: ReadonlyArray<RadioChoice<V>>
  value: V
  onChange: (value: V) => void
  error?: ReactNode
  disabled?: boolean
}) {
  return (
    <FieldSet>
      <FieldLegend id={`${id}-legend`} variant="label" className="text-base font-medium text-ink">
        {legend}
      </FieldLegend>
      <RadioGroup
        value={value}
        onValueChange={(next) => onChange(next as V)}
        aria-labelledby={`${id}-legend`}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        disabled={disabled}
        className="gap-1"
      >
        {choices.map((c) => (
          <label key={c.value} htmlFor={`${id}-${c.value}`} className="flex min-h-11 cursor-pointer items-start gap-3 py-1.5">
            <RadioGroupItem id={`${id}-${c.value}`} value={c.value} aria-describedby={c.hint ? `${id}-${c.value}-hint` : undefined} className="mt-1 size-5" />
            <span className="flex flex-col">
              <span className="font-medium text-ink">{c.label}</span>
              {c.hint ? (
                <span id={`${id}-${c.value}-hint`} className="text-base text-ink-muted md:text-sm">
                  {c.hint}
                </span>
              ) : null}
            </span>
          </label>
        ))}
      </RadioGroup>
      {error ? <FieldProblem id={`${id}-error`}>{error}</FieldProblem> : null}
    </FieldSet>
  )
}
