'use client'

import { ArrowLeftRight, FileCheck2, FileText, Network, PackageX, ShoppingCart, SquareCheckBig, UserRoundCheck, Wallet } from 'lucide-react'
import Link from 'next/link'
import { parseAsStringLiteral, useQueryState } from 'nuqs'
import { NuqsAdapter } from 'nuqs/adapters/next/app'
import { STEP_BADGES, StatusBadge, type StepBadgeKey } from '../document/badges'
import { Badge } from '../shadcn/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../shadcn/tabs'

// "รอฉันอนุมัติ" (spec §9.10, FR-VIS-006 AC5): tabs ทั้งหมด · เกินกำหนด · รอผู้ขอตอบ, each with its count; a row per task —
// what kind of document, its number and title, who asked from which department, the amount the DOA counted, its SLA as a
// badge, and "แทนคุณ…" when the member holds it for someone — the earliest due first, ten at most, each opening the
// decision page. No decide button here: the approver sees the amount, the budget and the DOA before deciding (§9.9 ข้อ 5).
// The tab chosen is in the address (?approvals=overdue or info, nuqs, §9.10 "ลิงก์ตรงไปแท็บได้"), changed without
// asking the server again; "all" leaves the address plain.

export const APPROVAL_TABS = ['all', 'overdue', 'info'] as const
const TAB = parseAsStringLiteral(APPROVAL_TABS).withDefault('all').withOptions({ shallow: true, scroll: false, history: 'replace' })

const KIND_ICONS = { REQUEST: FileText, PURCHASE_ORDER: ShoppingCart, VARIANCE: PackageX, DOA_VERSION: FileCheck2, WORKFLOW_VERSION: FileCheck2, ORG_AUTHORITY_CHANGE: Network, BUDGET_TRANSFER: ArrowLeftRight, BUDGET_OVERRUN: Wallet, OTHER: SquareCheckBig } as const

export interface ApprovalRowView {
  readonly id: string
  readonly href: string
  readonly kind: keyof typeof KIND_ICONS
  readonly kindLabel: string
  readonly title: string
  readonly meta: string | null
  readonly amount: string | null
  readonly sla: { readonly key: StepBadgeKey; readonly label: string }
  readonly forName: string | null
}

export interface ApprovalTabView {
  readonly key: (typeof APPROVAL_TABS)[number]
  readonly label: string
  readonly listLabel: string
  readonly rows: readonly ApprovalRowView[]
  readonly empty: string
  readonly seeAll: { readonly href: string; readonly text: string } | null
}

export function ApprovalsTabs(props: { label: string; tabs: readonly ApprovalTabView[] }) {
  return (
    <NuqsAdapter>
      <ApprovalsTabsInAddress {...props} />
    </NuqsAdapter>
  )
}

/** The tabs, their choice read from and written to the address (under any nuqs adapter) */
export function ApprovalsTabsInAddress({ label, tabs }: { label: string; tabs: readonly ApprovalTabView[] }) {
  const [tab, setTab] = useQueryState('approvals', TAB)
  return (
    <Tabs value={tab} onValueChange={(value) => void setTab(value as ApprovalTabView['key'])}>
      <TabsList aria-label={label} className="grid w-full grid-cols-3 group-data-horizontal/tabs:h-auto">
        {tabs.map((tab) => (
          <TabsTrigger key={tab.key} value={tab.key} className="h-auto min-h-11 px-2 text-base whitespace-normal md:text-sm lg:min-h-10">
            {tab.label}
          </TabsTrigger>
        ))}
      </TabsList>
      {tabs.map((tab) => (
        <TabsContent key={tab.key} value={tab.key} className="flex flex-col gap-2 text-base">
          {tab.rows.length ? (
            <ul aria-label={tab.listLabel} className="flex flex-col">
              {tab.rows.map((row) => {
                const Icon = KIND_ICONS[row.kind]
                return (
                  <li key={row.id} className="border-b border-line last:border-b-0">
                    <Link href={row.href} className="flex items-start gap-3 rounded-md px-1 py-3 text-ink hover:bg-primary-tint">
                      <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-md bg-primary-tint text-primary">
                        <Icon className="size-5" aria-hidden="true" />
                        <span className="sr-only">{row.kindLabel}</span>
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col gap-1">
                        <span className="font-medium break-words underline-offset-4 hover:underline">{row.title}</span>
                        {row.meta ? <span className="text-ink-muted">{row.meta}</span> : null}
                        <span className="flex flex-wrap items-center gap-2">
                          <StatusBadge look={STEP_BADGES[row.sla.key]} label={row.sla.label} />
                          {row.forName ? (
                            <Badge variant="neutral">
                              <UserRoundCheck aria-hidden="true" />
                              {row.forName}
                            </Badge>
                          ) : null}
                          {row.amount ? <span className="ml-auto text-right tabular-nums">{row.amount}</span> : null}
                        </span>
                      </span>
                    </Link>
                  </li>
                )
              })}
            </ul>
          ) : (
            <p className="py-4 text-ink-muted">{tab.empty}</p>
          )}
          {tab.seeAll ? (
            <Link href={tab.seeAll.href} className="inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline">
              {tab.seeAll.text}
            </Link>
          ) : null}
        </TabsContent>
      ))}
    </Tabs>
  )
}
