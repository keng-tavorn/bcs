'use client'

import { useTranslations } from 'next-intl'
import { useId, useState } from 'react'
import type { CatalogEntry } from '../../request-form/types'
import { Button } from '../button'
import { LiffLink } from '../liff-link'
import { inputClass } from './classes'

// Where a request starts in LINE (FR-INT-001 AC1–AC3, §9.9 principle 2): the rich menu's "ขอซื้อ" opens this list of
// the request types the organization switched on — a card per type, a real unit, each saying when to use it — with a
// keyword search over names and descriptions (no AI in tier 1, AC2). The same types and words as the workspace's
// catalogue (src/ui/request-form/catalog.tsx), one column for the LINE app, and links that keep the LIFF app loaded
// (LiffLink) instead of the workspace's next/link, so the page stays within the first-JavaScript budget (§9.4).

function matches(type: CatalogEntry, words: readonly string[]): boolean {
  const text = `${type.name} ${type.description ?? ''} ${type.code}`.toLowerCase()
  return words.every((w) => text.includes(w))
}

/** A type card: the whole card is the link, at least 44 px high; a plain border, no shadow (§9.9) */
const CARD =
  'flex min-h-11 flex-col gap-1 rounded-md border border-line bg-bg px-4 py-3 text-ink transition-colors duration-150 hover:border-primary hover:bg-surface focus-visible:border-primary'

export function LiffCatalog({ types, formBase }: { readonly types: readonly CatalogEntry[]; readonly formBase: string }) {
  const t = useTranslations('request.catalog')
  const id = useId()
  const [query, setQuery] = useState('')
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const shown = types.filter((type) => matches(type, words))

  if (types.length === 0) return <p className="border-y border-line py-4">{t('noTypes')}</p>
  return (
    <section aria-labelledby={`${id}-types`} className="flex flex-col gap-4">
      <h2 id={`${id}-types`} className="sr-only">
        {t('typesHeading')}
      </h2>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${id}-search`} className="font-medium text-ink">
          {t('search')}
        </label>
        <input
          id={`${id}-search`}
          type="search"
          className={inputClass}
          value={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
          aria-describedby={`${id}-search-hint`}
          autoComplete="off"
        />
        <p id={`${id}-search-hint`} className="text-ink-muted">
          {t('searchHint')}
        </p>
      </div>
      <p role="status" className="text-ink-muted">
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
        <ul className="flex flex-col gap-3">
          {shown.map((type) => (
            <li key={type.code}>
              <LiffLink href={`${formBase}/${encodeURIComponent(type.code)}`} className={CARD}>
                <span className="text-lg leading-snug font-semibold">{type.name}</span>
                <span className="text-ink-muted">{type.description ? t('whenToUse', { description: type.description }) : t('noDescription')}</span>
                <span className="pt-1 font-medium text-primary underline underline-offset-4">{t('start', { name: type.name })}</span>
              </LiffLink>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
