'use client'

import { FilePen, Search } from 'lucide-react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { useId, useState } from 'react'
import { Button } from '../form/button'
import { formatDateTime } from '../format'
import { DOOR_ASIDE } from '../shell/new-request-door'
import { inputClass } from './controls'
import type { CatalogEntry, OpenDraft, ScreenLocale } from './types'

// Where every request starts (FR-INT-001, §9.9 principle 2): the request types the organization switched on as cards —
// a card per type is a real unit — each saying when to use it, a keyword search over names and descriptions (no AI in
// tier 1, AC2), and the requester's own drafts and returned requests to go on with (FR-INT-006). It is the door's own
// content (DOOR_ASIDE): while it shows, the shell's "ขอซื้อ / ขอจ้าง" steps aside.

function matches(type: CatalogEntry, words: readonly string[]): boolean {
  const text = `${type.name} ${type.description ?? ''} ${type.code}`.toLowerCase()
  return words.every((w) => text.includes(w))
}

export function RequestCatalog({ types, drafts, locale }: { types: readonly CatalogEntry[]; drafts: readonly OpenDraft[]; locale: ScreenLocale }) {
  const t = useTranslations('request.catalog')
  const id = useId()
  const [query, setQuery] = useState('')
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const shown = types.filter((type) => matches(type, words))

  return (
    <div className="flex flex-col gap-10" {...DOOR_ASIDE}>
      {types.length === 0 ? (
        <p className="border-y border-line py-4">{t('noTypes')}</p>
      ) : (
        <section aria-labelledby={`${id}-types`} className="flex flex-col gap-5">
          <h2 id={`${id}-types`} className="sr-only">
            {t('typesHeading')}
          </h2>
          <div className="flex max-w-xl flex-col gap-1.5">
            <label htmlFor={`${id}-search`} className="font-medium text-ink">
              {t('search')}
            </label>
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-muted" aria-hidden="true" />
              <input
                id={`${id}-search`}
                type="search"
                className={`${inputClass} pl-9`}
                value={query}
                onChange={(e) => setQuery(e.currentTarget.value)}
                aria-describedby={`${id}-search-hint`}
                autoComplete="off"
              />
            </div>
            <p id={`${id}-search-hint`} className="text-base text-ink-muted md:text-sm">
              {t('searchHint')}
            </p>
          </div>
          <p role="status" className="text-base text-ink-muted md:text-sm">
            {words.length ? t('found', { count: shown.length }) : t('all', { count: types.length })}
          </p>
          {shown.length === 0 ? (
            <div className="flex flex-col items-start gap-3 border-y border-line py-4">
              <p>{t('noMatch', { query: query.trim() })}</p>
              <Button variant="secondary" onClick={() => setQuery('')}>
                {t('clear')}
              </Button>
            </div>
          ) : (
            <ul className="grid gap-4 sm:grid-cols-2">
              {shown.map((type) => (
                <li key={type.code}>
                  <Link
                    href={`/requests/new/${encodeURIComponent(type.code)}`}
                    className="flex h-full flex-col gap-2 rounded-md border border-line bg-bg p-4 transition-colors duration-150 hover:border-primary hover:bg-surface"
                  >
                    <span className="text-lg font-semibold text-ink">{type.name}</span>
                    <span className="text-ink-muted">{type.description ? t('whenToUse', { description: type.description }) : t('noDescription')}</span>
                    <span className="mt-auto pt-2 font-medium text-primary underline underline-offset-4">{t('start', { name: type.name })}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <section id="drafts" aria-labelledby={`${id}-drafts`} className="flex scroll-mt-20 flex-col gap-3">
        <h2 id={`${id}-drafts`} className="text-xl font-semibold">
          {t('draftsTitle')}
        </h2>
        {drafts.length === 0 ? (
          <p className="text-ink-muted">{t('draftsEmpty')}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-line border-y border-line">
            {drafts.map((d) => (
              <li key={d.id} className="flex flex-col gap-1 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
                <div className="flex min-w-0 flex-col">
                  <span className="font-medium break-words">{d.title}</span>
                  <span className="text-base text-ink-muted md:text-sm">
                    {t('draftLine', { type: d.typeName, status: d.status === 'RETURNED' ? t('statusReturned') : t('statusDraft'), time: formatDateTime(locale, d.updatedAt) })}
                  </span>
                </div>
                <Link href={`/requests/${d.id}/edit`} className="inline-flex min-h-11 shrink-0 items-center gap-2 font-medium text-primary underline underline-offset-4 hover:no-underline">
                  <FilePen className="size-4" aria-hidden="true" />
                  {t('continue', { title: d.title })}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
