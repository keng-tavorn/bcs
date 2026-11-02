'use client'

import { useState, type ReactNode } from 'react'
import { cn } from '../cn'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../shadcn/tabs'

// Tabs of the document page (FR-INT-012 AC2, §9.10 "แท็บ"): the tab chosen goes into the address (?tab=…) without a
// reload or a new history entry, so a link opens the page on that tab and copying the address keeps it. The page reads
// the same parameter to render the tab it opens on (tabFrom of tab-param.ts). A panel holds server-rendered content;
// only the chosen one is drawn. `stackNarrow` (the invoice's split page, NEW-115): under 1280 px there are no tabs and
// every panel stands in one column, as the page always was on a phone; above it the others are hidden, not taken away,
// so what is typed in a form stays while another tab is read.

export interface DocTab {
  readonly value: string
  readonly label: string
  readonly content: ReactNode
}

const TRIGGER =
  'min-h-11 flex-none rounded-none border-0 border-b-2 border-transparent px-3 text-base font-medium text-ink-muted hover:text-ink data-[state=active]:border-primary data-[state=active]:text-ink md:text-sm'

export function DocTabs({ tabs, initial, label, param, className, stackNarrow }: { tabs: readonly DocTab[]; initial: string; label: string; param?: string; className?: string; stackNarrow?: boolean }) {
  const [value, setValue] = useState(initial)
  const change = (next: string) => {
    setValue(next)
    if (!param) return
    const url = new URL(window.location.href)
    url.searchParams.set(param, next)
    window.history.replaceState(window.history.state, '', url)
  }
  return (
    <Tabs value={value} onValueChange={change} className={cn('gap-4', className)}>
      {/* On a phone the tabs wrap to a second line: every tab stays in sight, the chosen one too (no hidden scroll) */}
      <div className={cn('border-b border-line', stackNarrow && 'hidden xl:block')}>
        <TabsList aria-label={label} variant="line" className="h-auto flex-wrap justify-start gap-0 p-0 group-data-horizontal/tabs:h-auto">
          {tabs.map((tab) => (
            <TabsTrigger key={tab.value} value={tab.value} className={TRIGGER}>
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>
      {tabs.map((tab) => (
        <TabsContent
          key={tab.value}
          value={tab.value}
          className={cn('[font-size:inherit]', stackNarrow && 'flex flex-col gap-4 lg:gap-6 xl:data-[state=inactive]:hidden')}
          {...(stackNarrow ? { forceMount: true, tabIndex: -1 } : {})}
        >
          {tab.content}
        </TabsContent>
      ))}
    </Tabs>
  )
}
