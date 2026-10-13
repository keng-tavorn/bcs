'use client'

import { BookOpen, Search } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { useId, useRef, useState, type FormEvent } from 'react'
import { StatusBadge } from '../document/badges'
import { Notice } from '../form/notice'
import { Button } from '../shadcn/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../shadcn/dialog'
import { Input } from '../shadcn/input'
import { catalogPickOf } from './catalog-lines'
import type { CatalogPickerProps } from './details-items'
import { showSatang } from './money'
import type { CatalogItemOption } from './types'

// The catalogue picker of a line of the workspace's request form (S6-10 · FR-INT-102 AC1 AC2): a button that opens a
// Dialog — only when pressed (NG-13) — with a search by code or name over the active items, each with its unit, its
// reference price and the agreed prices in effect today (before VAT, with their suppliers). Choosing one hands it to the
// form (model.ts pickCatalog), which fills the line and applies the agreed price of the suggested supplier. Drawn with
// the workspace's components: only the workspace's form passes it (StepProps.catalog), never the LIFF form (ADR-052).

type Found = { readonly kind: 'idle' } | { readonly kind: 'loading' } | { readonly kind: 'failed' } | { readonly kind: 'found'; readonly items: readonly CatalogItemOption[]; readonly total: number }

export function CatalogPicker({ lineNo, linked, search, onPick }: CatalogPickerProps) {
  const t = useTranslations('requestForm.catalog')
  const id = useId()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [found, setFound] = useState<Found>({ kind: 'idle' })
  // Only the latest search's answer is shown
  const seq = useRef(0)

  async function run(q: string) {
    const mine = ++seq.current
    setFound({ kind: 'loading' })
    try {
      const answer = await search(q.trim())
      if (mine !== seq.current) return
      setFound(answer.ok ? { kind: 'found', items: answer.items, total: answer.total } : { kind: 'failed' })
    } catch {
      if (mine === seq.current) setFound({ kind: 'failed' })
    }
  }

  function onOpenChange(next: boolean) {
    setOpen(next)
    if (next && found.kind === 'idle') void run(query)
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    event.stopPropagation()
    void run(query)
  }

  return (
    <>
      <Button type="button" variant="outline" className="h-11 gap-2 text-base md:text-sm" aria-label={linked ? t('changeLabel', { n: lineNo }) : t('pickLabel', { n: lineNo })} onClick={() => onOpenChange(true)}>
        <BookOpen aria-hidden="true" />
        {linked ? t('change') : t('pick')}
      </Button>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-h-[90dvh] grid-rows-[auto_auto_minmax(0,1fr)] p-6 sm:max-w-160">
          <DialogHeader>
            <DialogTitle className="text-xl font-semibold">{t('dialogTitle', { n: lineNo })}</DialogTitle>
            <DialogDescription className="text-base text-ink-muted md:text-sm">{t('dialogText')}</DialogDescription>
          </DialogHeader>
          <form role="search" className="flex flex-col gap-1.5" onSubmit={onSubmit}>
            <label htmlFor={`${id}-q`} className="font-medium text-ink">
              {t('search')}
            </label>
            <div className="flex gap-2">
              <div className="relative min-w-0 flex-1">
                <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-muted" aria-hidden="true" />
                <Input id={`${id}-q`} type="search" className="h-11 pl-9 text-base md:text-sm" value={query} maxLength={100} autoComplete="off" onChange={(e) => setQuery(e.currentTarget.value)} />
              </div>
              <Button type="submit" className="h-11 px-4 text-base hover:bg-primary-hover md:text-sm">
                {t('searchSubmit')}
              </Button>
            </div>
          </form>
          <div className="-mx-1 min-h-0 overflow-y-auto px-1 py-1">
            <Results found={found} query={query.trim()} onChoose={(item) => {
              setOpen(false)
              onPick(catalogPickOf(item))
            }} />
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}

function Results({ found, query, onChoose }: { found: Found; query: string; onChoose: (item: CatalogItemOption) => void }) {
  const t = useTranslations('requestForm.catalog')
  if (found.kind === 'idle' || found.kind === 'loading') return <p role="status" className="text-ink-muted">{t('loading')}</p>
  if (found.kind === 'failed') return <Notice tone="danger">{t('failed')}</Notice>
  if (found.items.length === 0) return <p className="border-y border-line py-4">{query ? t('noMatch', { query }) : t('empty')}</p>
  return (
    <div className="flex flex-col gap-2">
      <p role="status" className="text-base text-ink-muted md:text-sm">
        {found.items.length < found.total ? t('foundLimited', { shown: found.items.length, total: found.total }) : t('found', { count: found.total })}
      </p>
      <ul aria-label={t('resultsLabel')} className="flex flex-col divide-y divide-line border-y border-line">
        {found.items.map((item) => (
          <li key={item.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
            <div className="flex min-w-0 flex-col gap-1">
              <span className="font-semibold break-words text-ink">{item.nameTh}</span>
              <span className="text-base text-ink-muted md:text-sm">{t('codeUnit', { code: item.code, uom: item.uom })}</span>
              <span className="text-base text-ink md:text-sm">{t('reference', { amount: showSatang(BigInt(item.refUnitPriceSatang)), uom: item.uom })}</span>
              {item.agreements.map((a) => (
                <span key={a.supplierId} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-base md:text-sm">
                  <StatusBadge look={{ tone: 'info', icon: 'Lock' }} label={t('agreedBadge')} />
                  <span className="text-ink">{t('agreed', { supplier: a.supplierName, amount: showSatang(BigInt(a.unitPriceSatang)), uom: item.uom })}</span>
                </span>
              ))}
            </div>
            <Button type="button" variant="outline" className="h-11 shrink-0 self-start text-base md:text-sm" aria-label={t('chooseLabel', { name: item.nameTh, code: item.code })} onClick={() => onChoose(item)}>
              {t('choose')}
            </Button>
          </li>
        ))}
      </ul>
    </div>
  )
}
