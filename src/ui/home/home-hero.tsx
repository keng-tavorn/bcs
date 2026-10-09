'use client'

import { FilePlus2, ListTodo, Search, Store } from 'lucide-react'
import Link from 'next/link'
import { useSyncExternalStore, type MouseEvent } from 'react'
import { cn } from '../cn'
import { Kbd } from '../shadcn/kbd'
import { openNewRequest, openPalette } from '../shell/shell-events'

// The top of the home page (spec §9.10 "หน้าแรก", FR-VIS-006 AC1): the greeting in the middle, the search field that
// opens the shell's ⌘K palette (560 px wide, 48 px high), and three chips — "งานของฉัน" the view shown now (pressed),
// "เริ่มคำขอใหม่" the shell's dialog of request types (a link to /requests/new before the script runs or for a member the
// door does not serve), "ผู้ขายและราคา" the searchable supplier register. On the page's white, no picture, no gradient
// (§9.9: not a hero section).

const noSubscription = () => () => {}
const isMac = () => /Mac|iPhone|iPad/.test(navigator.userAgent)
const notMac = () => false

const CHIP = 'inline-flex min-h-11 items-center gap-2 rounded-full border border-line-strong bg-bg px-4 font-medium text-ink transition-colors duration-150 hover:bg-primary-tint lg:min-h-10'

export interface HomeHeroTexts {
  readonly greeting: string
  readonly search: string
  readonly shortcutMac: string
  readonly shortcutOther: string
  readonly chips: { readonly label: string; readonly mine: string; readonly newRequest: string; readonly suppliers: string }
}

export function HomeHero({ texts, canRequest }: { texts: HomeHeroTexts; canRequest: boolean }) {
  const mac = useSyncExternalStore(noSubscription, isMac, notMac)
  function onNewRequest(e: MouseEvent<HTMLAnchorElement>) {
    // A new tab or window is the catalogue page itself; so is a page whose shell has no door to open
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    if (openNewRequest()) e.preventDefault()
  }
  return (
    <section aria-labelledby="home-greeting" className="flex flex-col items-center gap-5 px-0 py-4 text-center lg:py-8">
      <h1 id="home-greeting" className="text-2xl font-semibold text-balance lg:text-[1.75rem]">
        {texts.greeting}
      </h1>
      <button
        type="button"
        onClick={openPalette}
        aria-haspopup="dialog"
        className="flex h-12 w-full max-w-[560px] items-center gap-3 rounded-lg border border-line-strong bg-bg px-4 text-left text-ink-muted transition-colors duration-150 hover:border-primary"
      >
        <Search className="size-5 shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">{texts.search}</span>
        <Kbd className="hidden sm:inline-flex">{mac ? texts.shortcutMac : texts.shortcutOther}</Kbd>
      </button>
      <ul aria-label={texts.chips.label} className="flex flex-wrap justify-center gap-2">
        <li>
          <button type="button" aria-pressed="true" className={cn(CHIP, 'border-primary bg-primary-tint')}>
            <ListTodo className="size-4 shrink-0" aria-hidden="true" />
            {texts.chips.mine}
          </button>
        </li>
        {canRequest ? (
          <li>
            <Link href="/requests/new" onClick={onNewRequest} aria-haspopup="dialog" className={CHIP}>
              <FilePlus2 className="size-4 shrink-0" aria-hidden="true" />
              {texts.chips.newRequest}
            </Link>
          </li>
        ) : null}
        <li>
          <Link href="/suppliers" className={CHIP}>
            <Store className="size-4 shrink-0" aria-hidden="true" />
            {texts.chips.suppliers}
          </Link>
        </li>
      </ul>
    </section>
  )
}
