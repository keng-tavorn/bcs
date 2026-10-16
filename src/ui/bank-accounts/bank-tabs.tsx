'use client'

import { useRouter } from 'next/navigation'
import type { ReactNode } from 'react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../shadcn/tabs'

// The tabs of /finance/bank-accounts (S9-09): the organization's payer accounts, the requests still open, every request,
// each with its count. The tab is in the address (?tab=…), so choosing one asks the server for its rows and a link opens
// the page on that tab; the chosen tab's content arrives as children, rendered on the server.

export interface BankTabView {
  readonly key: string
  readonly label: string
  readonly href: string
}

const TRIGGER =
  'min-h-11 flex-none rounded-none border-0 border-b-2 border-transparent px-3 text-base font-medium text-ink-muted hover:text-ink data-[state=active]:border-primary data-[state=active]:text-ink md:text-sm'

export function BankTabs({ tabs, current, label, children }: { tabs: readonly BankTabView[]; current: string; label: string; children: ReactNode }) {
  const router = useRouter()
  return (
    <Tabs
      value={current}
      onValueChange={(next) => {
        const tab = tabs.find((t) => t.key === next)
        if (tab) router.push(tab.href, { scroll: false })
      }}
      className="gap-4"
    >
      {/* On a phone the tabs wrap to a second line: every tab stays in sight (no hidden scroll) */}
      <div className="border-b border-line">
        <TabsList aria-label={label} variant="line" className="h-auto flex-wrap justify-start gap-0 p-0 group-data-horizontal/tabs:h-auto">
          {tabs.map((tab) => (
            <TabsTrigger key={tab.key} value={tab.key} className={TRIGGER}>
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>
      <TabsContent value={current} className="flex flex-col gap-3 [font-size:inherit]">
        {children}
      </TabsContent>
    </Tabs>
  )
}
