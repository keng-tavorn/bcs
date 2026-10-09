'use client'

import { Building2, Check, CircleAlert, Package, Search } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { NEW_REQUEST_DRAWER_BELOW_PX, NEW_REQUEST_SEARCH_OVER } from '@/lib/constants'
import { cn } from '../cn'
import { useBelow } from '../hooks/use-below'
import { Button } from '../shadcn/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../shadcn/dialog'
import { Drawer, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle } from '../shadcn/drawer'
import { Input } from '../shadcn/input'
import { RadioGroup, RadioGroupItem } from '../shadcn/radio-group'
import type { CatalogEntry } from './types'

// "เริ่มคำขอใหม่" (FR-INT-010, §9.10): the one door's dialog, opened only by the requester's press (NG-13) — a drawer from
// the bottom below 768 px. One request type is chosen from cards (a card per type is a real unit, §9.9) that say when
// to use each; more than six types get a keyword search (AC3, the catalogue's own matching, no AI in tier 1); the
// requester's open drafts are a link away (AC2). "ดำเนินการต่อ" goes to the type's step-by-step form — a page, never a
// dialog on the dialog. Arrow keys choose, Enter goes on (AC3). /requests/new stays the page behind it (AC4).

/** The catalogue's matching: every word in the name, the description or the code (FR-INT-001 AC2) */
export function matchesType(type: CatalogEntry, query: string): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const text = `${type.name} ${type.description ?? ''} ${type.code}`.toLowerCase()
  return words.every((w) => text.includes(w))
}

export interface NewRequestDialogProps {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly types: readonly CatalogEntry[]
  /** The requester's drafts and returned requests; null while not known */
  readonly drafts: number | null
}

export function NewRequestDialog({ open, onOpenChange, types, drafts }: NewRequestDialogProps) {
  const t = useTranslations('request.newDialog')
  const below = useBelow(NEW_REQUEST_DRAWER_BELOW_PX)
  // Opened, it keeps its shape until closed: a screen that turns or resizes across 768 px would otherwise swap the dialog
  // for the drawer and drop the type already chosen (NEW-84)
  const [openedAs, setOpenedAs] = useState<boolean | null>(null)
  if (open && openedAs === null) setOpenedAs(below)
  if (!open && openedAs !== null) setOpenedAs(null)
  const drawer = open ? (openedAs ?? below) : below
  const body = <ChooseType types={types} drafts={drafts} onDone={() => onOpenChange(false)} />
  if (drawer) {
    return (
      <Drawer open={open} onOpenChange={onOpenChange}>
        <DrawerContent className="max-h-[90dvh]">
          <DrawerHeader className="text-left">
            <DrawerTitle className="text-xl font-semibold">{t('title')}</DrawerTitle>
            <DrawerDescription className="text-base text-ink-muted">{t('description')}</DrawerDescription>
          </DrawerHeader>
          <div className="flex min-h-0 flex-col px-4 pb-4">{body}</div>
        </DrawerContent>
      </Drawer>
    )
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] grid-rows-[auto_minmax(0,1fr)] p-6 sm:max-w-160">
        <DialogHeader>
          <DialogTitle className="text-xl font-semibold">{t('title')}</DialogTitle>
          <DialogDescription className="text-base text-ink-muted md:text-sm">{t('description')}</DialogDescription>
        </DialogHeader>
        {body}
      </DialogContent>
    </Dialog>
  )
}

export function ChooseType({ types, drafts, onDone }: { types: readonly CatalogEntry[]; drafts: number | null; onDone: () => void }) {
  const t = useTranslations('request.newDialog')
  const tc = useTranslations('request.catalog')
  const router = useRouter()
  const id = useId()
  const [query, setQuery] = useState('')
  const [chosen, setChosen] = useState<string>('')
  const [missing, setMissing] = useState(false)
  // An arrow key moved the focus: the card it lands on is chosen, however briefly the key was held (Radix checks a card
  // only while the key is still down, so a quick press could move the focus and leave the choice behind)
  const byArrow = useRef(false)
  const searchable = types.length > NEW_REQUEST_SEARCH_OVER
  const shown = searchable ? types.filter((type) => matchesType(type, query)) : types

  function go() {
    const type = types.find((x) => x.code === chosen)
    if (!type) return setMissing(true)
    onDone()
    router.push(`/requests/new/${encodeURIComponent(type.code)}`)
  }
  // Enter on a chosen card goes on, as the button does (AC3); the arrow keys move the choice (the radio group's own)
  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key.startsWith('Arrow')) byArrow.current = true
    if (e.key === 'Enter' && chosen) {
      e.preventDefault()
      go()
    }
  }

  if (types.length === 0) return <p className="border-y border-line py-4">{tc('noTypes')}</p>
  return (
    <div className="flex min-h-0 flex-col gap-4">
      {drafts ? (
        <p className="text-ink">
          {t('drafts', { count: drafts })}{' '}
          <span aria-hidden="true">·</span>{' '}
          <Link href="/requests/new#drafts" onClick={onDone} className="inline-flex min-h-11 items-center font-medium text-primary underline underline-offset-4 hover:no-underline">
            {t('viewDrafts')}
          </Link>
        </p>
      ) : null}
      {searchable ? (
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-search`} className="font-medium text-ink">
            {tc('search')}
          </label>
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-muted" aria-hidden="true" />
            <Input
              id={`${id}-search`}
              type="search"
              className="h-11 pl-9 text-base md:text-sm"
              value={query}
              autoComplete="off"
              aria-describedby={`${id}-found`}
              onChange={(e) => setQuery(e.currentTarget.value)}
            />
          </div>
          <p id={`${id}-found`} role="status" className="text-base text-ink-muted md:text-sm">
            {query.trim() ? tc('found', { count: shown.length }) : tc('all', { count: types.length })}
          </p>
        </div>
      ) : null}
      <div className="-mx-1 min-h-0 overflow-y-auto px-1 py-1">
        {shown.length === 0 ? (
          <p className="border-y border-line py-4">{tc('noMatch', { query: query.trim() })}</p>
        ) : (
          <RadioGroup
            value={chosen}
            onValueChange={(code) => {
              setChosen(code)
              setMissing(false)
            }}
            onKeyDown={onKeyDown}
            aria-label={t('typesLabel')}
            aria-describedby={missing ? `${id}-missing` : undefined}
            className="gap-3"
          >
            {shown.map((type) => (
              <TypeCard
                key={type.code}
                type={type}
                chosen={type.code === chosen}
                id={`${id}-${type.code}`}
                onFocus={() => {
                  if (!byArrow.current) return
                  byArrow.current = false
                  setChosen(type.code)
                  setMissing(false)
                }}
              >
                {type.description ? tc('whenToUse', { description: type.description }) : tc('noDescription')}
              </TypeCard>
            ))}
          </RadioGroup>
        )}
      </div>
      {missing ? (
        <p id={`${id}-missing`} className="flex items-start gap-2 font-medium text-danger">
          <CircleAlert className="mt-1 size-4 shrink-0" aria-hidden="true" />
          <span>{t('chooseFirst')}</span>
        </p>
      ) : null}
      <Button type="button" className="h-11 w-full text-base hover:bg-primary-hover md:text-sm" onClick={go}>
        {t('continue')}
      </Button>
    </div>
  )
}

/** One request type: its card is the radio's label — icon, name and when to use it; the chosen one tinted with a check */
function TypeCard({ type, chosen, id, onFocus, children }: { type: CatalogEntry; chosen: boolean; id: string; onFocus: () => void; children: ReactNode }) {
  const Icon = type.documentType === 'SUPPLIER_REQUEST' ? Building2 : Package
  return (
    <label
      htmlFor={id}
      className={cn(
        'flex cursor-pointer items-start gap-3 rounded-md border p-4 transition-colors duration-150 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-focus has-[:focus-visible]:ring-offset-2',
        chosen ? 'border-primary bg-primary-tint' : 'border-line bg-bg hover:bg-surface',
      )}
    >
      <RadioGroupItem id={id} value={type.code} className="sr-only" onFocus={onFocus} />
      <Icon className="mt-1 size-5 shrink-0 text-primary" aria-hidden="true" />
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="font-semibold text-ink">{type.name}</span>
        <span className="text-ink-muted">{children}</span>
      </span>
      <Check className={cn('mt-1 size-5 shrink-0 text-primary', chosen ? 'visible' : 'invisible')} aria-hidden="true" />
    </label>
  )
}
