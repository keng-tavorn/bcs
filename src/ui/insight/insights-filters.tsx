'use client'

import Link from 'next/link'
import { NuqsAdapter } from 'nuqs/adapters/next/app'
import { parseAsString, parseAsStringLiteral, useQueryStates } from 'nuqs'
import { useTransition } from 'react'
import { DateField } from '@/ui/form/date-field'
import { Button } from '@/ui/form/button'
import { NativeSelect } from '@/ui/shadcn/native-select'

// The one row of filters of /insights (spec §9.10, FR-VIS-007 AC1): period, department and request type, kept in the
// address with nuqs so the same link opens the same view; changing one asks the server for the page again (shallow:
// false), whose service checks every value. Chosen days are two day fields in a small form that writes the same
// parameters. "ล้างตัวกรอง" opens the page without any. Texts arrive translated.

export const RANGES = ['30d', '90d', 'fy', 'custom'] as const

export interface InsightsFilterTexts {
  readonly label: string
  readonly period: string
  readonly ranges: Readonly<Record<(typeof RANGES)[number], string>>
  readonly department: string
  readonly allDepartments: string
  readonly type: string
  readonly allTypes: string
  readonly clear: string
  readonly from: string
  readonly to: string
  readonly show: string
}

export interface InsightsFilterValues {
  readonly range: (typeof RANGES)[number]
  readonly from: string
  readonly to: string
  readonly departmentId: string | null
  readonly requestTypeId: string | null
}

type Option = { readonly id: string; readonly label: string }

const PARSERS = {
  range: parseAsStringLiteral(RANGES),
  from: parseAsString,
  to: parseAsString,
  dept: parseAsString,
  type: parseAsString,
}

function Filters({ values, departments, types, texts }: { values: InsightsFilterValues; departments: readonly Option[]; types: readonly Option[]; texts: InsightsFilterTexts }) {
  const [pending, startTransition] = useTransition()
  const [, setParams] = useQueryStates(PARSERS, { shallow: false, startTransition })
  const select = 'w-full [&_select]:h-11 [&_select]:text-base md:[&_select]:h-9 md:[&_select]:text-sm'
  const field = 'flex min-w-0 flex-col gap-1.5'
  return (
    <section aria-label={texts.label} aria-busy={pending} className="flex flex-col gap-3 border-y border-line py-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[repeat(3,minmax(0,16rem))_auto] lg:items-end">
        <div className={field}>
          <label htmlFor="insights-range" className="font-medium">
            {texts.period}
          </label>
          <NativeSelect
            id="insights-range"
            className={select}
            value={values.range}
            onChange={(e) => {
              const range = e.target.value as (typeof RANGES)[number]
              void setParams(range === 'custom' ? { range, from: values.from, to: values.to } : { range, from: null, to: null })
            }}
          >
            {RANGES.map((r) => (
              <option key={r} value={r}>
                {texts.ranges[r]}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className={field}>
          <label htmlFor="insights-dept" className="font-medium">
            {texts.department}
          </label>
          <NativeSelect id="insights-dept" className={select} value={values.departmentId ?? ''} onChange={(e) => void setParams({ dept: e.target.value || null })}>
            <option value="">{texts.allDepartments}</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className={field}>
          <label htmlFor="insights-type" className="font-medium">
            {texts.type}
          </label>
          <NativeSelect id="insights-type" className={select} value={values.requestTypeId ?? ''} onChange={(e) => void setParams({ type: e.target.value || null })}>
            <option value="">{texts.allTypes}</option>
            {types.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </NativeSelect>
        </div>
        <Link href="/insights" className="inline-flex min-h-11 items-center self-end font-medium text-primary underline underline-offset-4 hover:no-underline">
          {texts.clear}
        </Link>
      </div>
      {values.range === 'custom' ? (
        <form key={`${values.from}-${values.to}`} method="get" action="/insights" className="flex flex-col gap-3 md:flex-row md:items-start">
          <input type="hidden" name="range" value="custom" />
          {values.departmentId ? <input type="hidden" name="dept" value={values.departmentId} /> : null}
          {values.requestTypeId ? <input type="hidden" name="type" value={values.requestTypeId} /> : null}
          <div className="md:w-72">
            <DateField id="insights-from" name="from" label={texts.from} defaultValue={values.from} required />
          </div>
          <div className="md:w-72">
            <DateField id="insights-to" name="to" label={texts.to} defaultValue={values.to} required />
          </div>
          <Button type="submit" variant="secondary" className="shrink-0 self-start md:mt-[calc(1lh+0.375rem)]">
            {texts.show}
          </Button>
        </form>
      ) : null}
    </section>
  )
}

export function InsightsFilters(props: { values: InsightsFilterValues; departments: readonly Option[]; types: readonly Option[]; texts: InsightsFilterTexts }) {
  return (
    <NuqsAdapter>
      <Filters {...props} />
    </NuqsAdapter>
  )
}
