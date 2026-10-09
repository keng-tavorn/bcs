'use client'

import { FileText, Search, Store, SquareArrowOutUpRight, Zap, type LucideIcon } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useEffect, useEffectEvent, useRef, useState, useSyncExternalStore } from 'react'
import { HTTP_STATUS } from '@/core/result'
import { SEARCH_GROUP_LIMIT, SEARCH_MIN_LENGTH } from '@/lib/constants'
import { Button } from '../shadcn/button'
import { Command, CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '../shadcn/command'
import { Kbd } from '../shadcn/kbd'

// ⌘K / Ctrl K from every page of the workspace (FR-PLT-014 AC1, §9.10): one palette with the groups ล่าสุด · เอกสาร ·
// ผู้ขาย · ไปที่หน้า · คำสั่ง, worked by keyboard alone (cmdk: ↑ ↓ choose, Enter opens; the dialog: Esc closes).
// Documents and suppliers come from GET /api/search, which decides what the member may find; pages and commands arrive
// from the shell, already only what the member's menu holds. A search starts at two characters, 200 ms after the last
// key; under two the palette shows the member's recent documents. At most five per group (SEARCH_GROUP_LIMIT).

const DEBOUNCE_MS = 200

type DocumentKind = 'REQUEST' | 'PURCHASE_ORDER' | 'GOODS_RECEIPT'

interface FoundDocument {
  readonly kind: DocumentKind
  readonly id: string
  readonly number: string | null
  readonly title: string | null
  readonly href: string
}

interface FoundSupplier {
  readonly id: string
  readonly code: string
  readonly nameTh: string
  readonly nameEn: string | null
  readonly href: string
}

interface Answer {
  readonly documents: readonly FoundDocument[]
  readonly suppliers: readonly FoundSupplier[]
  readonly recent: readonly FoundDocument[]
}

export interface PaletteLink {
  readonly id: string
  readonly label: string
  readonly href: string
}

export interface CommandPaletteLabels {
  readonly trigger: string
  readonly title: string
  readonly description: string
  readonly placeholder: string
  readonly groups: { readonly recent: string; readonly documents: string; readonly suppliers: string; readonly pages: string; readonly commands: string }
  readonly kinds: Readonly<Record<DocumentKind, string>>
  readonly draft: string
  readonly empty: string
  readonly loading: string
  readonly failed: string
  readonly rateLimited: string
  readonly shortcutMac: string
  readonly shortcutOther: string
}

type Status = 'loading' | 'done' | 'failed' | 'limited'

interface Answered {
  /** The text it answered, or RECENT */
  readonly key: string
  readonly status: Exclude<Status, 'loading'>
  readonly answer: Answer
}

const EMPTY: Answer = { documents: [], suppliers: [], recent: [] }
const RECENT = ''
/** What a text asks the server: the trimmed text from two characters on, otherwise the recent documents */
const keyOf = (query: string) => (query.trim().length >= SEARCH_MIN_LENGTH ? query.trim() : RECENT)

const noSubscription = () => () => {}
const isMac = () => /Mac|iPhone|iPad/.test(navigator.userAgent)
const notMac = () => false

const matches = (label: string, text: string) => label.toLocaleLowerCase().includes(text.toLocaleLowerCase())

/**
 * The key that opens the palette: K with ⌘ on a Mac (where Ctrl K stays the text fields' own), with Ctrl elsewhere. The
 * physical key is compared, so it works with the Thai keyboard layout on, where the key types a Thai letter.
 */
const isPaletteKey = (e: KeyboardEvent, mac: boolean) => (mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey) && !e.altKey && !e.shiftKey && (e.code === 'KeyK' || e.key.toLowerCase() === 'k')
/** Another dialog (a form, a sheet, a confirmation) is open — not one closing, like the palette's own on its way out — so the palette never opens on top of it */
const anotherDialogOpen = () => document.querySelector('[role="dialog"]:not([data-state="closed"]), [role="alertdialog"]:not([data-state="closed"])') !== null

export function CommandPalette({ pages, commands, labels, locale }: { pages: readonly PaletteLink[]; commands: readonly PaletteLink[]; labels: CommandPaletteLabels; locale: 'th' | 'en' }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  /** The last answer and the text it answered: until the current text is answered the palette is loading */
  const [answered, setAnswered] = useState<Answered | null>(null)
  const [choice, setChoice] = useState({ first: '', value: '' })
  const mac = useSyncExternalStore(noSubscription, isMac, notMac)
  const seq = useRef(0)

  const onOpenChange = (next: boolean) => {
    setOpen(next)
    if (!next) {
      setQuery('')
      setAnswered(null)
    }
  }

  // The shortcut opens and closes it the same way as Esc and the field do (onOpenChange clears the text)
  const onShortcut = useEffectEvent((e: KeyboardEvent) => {
    if (!isPaletteKey(e, mac) || (!open && anotherDialogOpen())) return
    e.preventDefault()
    onOpenChange(!open)
  })
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => onShortcut(e)
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  // Recent documents when it opens or the text is under two characters; a search 200 ms after the last key otherwise.
  // Only a change of what is asked calls the server (each call counts toward NFR-SEC-05), not every key.
  const key = keyOf(query)
  useEffect(() => {
    if (!open) return
    const searching = key !== RECENT
    const mine = ++seq.current
    const controller = new AbortController()
    const settle = (status: Answered['status'], answer: Answer = EMPTY) => {
      if (mine === seq.current) setAnswered({ key, status, answer })
    }
    const timer = setTimeout(
      async () => {
        try {
          const response = await fetch(`/api/search${searching ? `?q=${encodeURIComponent(key)}` : ''}`, { signal: controller.signal, cache: 'no-store' })
          if (response.status === HTTP_STATUS.RATE_LIMITED) return settle('limited')
          if (!response.ok) return settle('failed')
          settle('done', (await response.json()) as Answer)
        } catch {
          if (!controller.signal.aborted) settle('failed')
        }
      },
      searching ? DEBOUNCE_MS : 0
    )
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [open, key])

  const go = (href: string) => {
    onOpenChange(false)
    router.push(href)
  }

  const text = query.trim()
  const searching = text.length >= SEARCH_MIN_LENGTH
  const current = answered?.key === keyOf(query) ? answered : null
  const status: Status = current ? current.status : 'loading'
  const answer = current?.answer ?? EMPTY
  const shownPages = searching ? pages.filter((p) => matches(p.label, text)).slice(0, SEARCH_GROUP_LIMIT) : []
  const shownCommands = (searching ? commands.filter((c) => matches(c.label, text)) : commands).slice(0, SEARCH_GROUP_LIMIT)
  const documents = (searching ? answer.documents : answer.recent).slice(0, SEARCH_GROUP_LIMIT)
  const suppliers = searching ? answer.suppliers.slice(0, SEARCH_GROUP_LIMIT) : []
  const nothing = documents.length + suppliers.length + shownPages.length + shownCommands.length === 0

  const documentLine = (d: FoundDocument) => `${labels.kinds[d.kind]} ${d.number ?? labels.draft}${d.title ? ` · ${d.title}` : ''}`
  const supplierLine = (s: FoundSupplier) => `${(locale === 'en' ? s.nameEn : null) ?? s.nameTh} · ${s.code}`

  const groups: Array<{ heading: string; Icon: LucideIcon; items: ReadonlyArray<{ id: string; label: string; href: string }> }> = [
    { heading: searching ? labels.groups.documents : labels.groups.recent, Icon: FileText, items: documents.map((d) => ({ id: `${d.kind}:${d.id}`, label: documentLine(d), href: d.href })) },
    { heading: labels.groups.suppliers, Icon: Store, items: suppliers.map((s) => ({ id: s.id, label: supplierLine(s), href: s.href })) },
    { heading: labels.groups.pages, Icon: SquareArrowOutUpRight, items: shownPages },
    { heading: labels.groups.commands, Icon: Zap, items: shownCommands },
  ]
  const valueOf = (heading: string, id: string) => `${heading}:${id}`
  // When results arrive the choice goes back to the first one, so Enter never opens what an earlier key left chosen
  const first = groups.flatMap((g) => g.items.map((item) => valueOf(g.heading, item.id)))[0] ?? ''
  const selected = choice.first === first ? choice.value : first

  const group = (heading: string, Icon: LucideIcon, items: ReadonlyArray<{ id: string; label: string; href: string }>) =>
    items.length ? (
      <CommandGroup key={heading} heading={heading}>
        {items.map((item) => (
          <CommandItem key={item.id} value={valueOf(heading, item.id)} onSelect={() => go(item.href)} className="min-h-11 text-base md:text-sm">
            <Icon aria-hidden="true" />
            <span className="truncate">{item.label}</span>
          </CommandItem>
        ))}
      </CommandGroup>
    ) : null

  return (
    <>
      <Button
        type="button"
        variant="outline"
        onClick={() => onOpenChange(true)}
        aria-haspopup="dialog"
        aria-keyshortcuts={mac ? 'Meta+K' : 'Control+K'}
        className="min-h-11 w-full justify-start text-base font-normal text-ink-muted md:text-sm lg:max-w-sm"
      >
        <Search aria-hidden="true" />
        <span className="flex-1 truncate text-left">{labels.trigger}</span>
        <Kbd aria-hidden="true">{mac ? labels.shortcutMac : labels.shortcutOther}</Kbd>
      </Button>
      <CommandDialog open={open} onOpenChange={onOpenChange} title={labels.title} description={labels.description}>
        <Command shouldFilter={false} loop value={selected} onValueChange={(value) => setChoice({ first, value })}>
          <CommandInput value={query} onValueChange={setQuery} placeholder={labels.placeholder} aria-label={labels.placeholder} className="text-base md:text-sm" />
          <CommandList className="max-h-[60dvh]">
            {status === 'failed' || status === 'limited' ? (
              <p role="alert" className="px-3 py-4 text-base md:text-sm">
                {status === 'limited' ? labels.rateLimited : labels.failed}
              </p>
            ) : null}
            {status === 'loading' && nothing ? (
              <p role="status" className="px-3 py-4 text-base text-ink-muted md:text-sm">
                {labels.loading}
              </p>
            ) : null}
            {status === 'done' && nothing ? <CommandEmpty className="text-base md:text-sm">{labels.empty}</CommandEmpty> : null}
            {groups.map((g) => group(g.heading, g.Icon, g.items))}
          </CommandList>
        </Command>
      </CommandDialog>
    </>
  )
}
