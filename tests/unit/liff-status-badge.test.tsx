import * as lucide from 'lucide-react'
import type { ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DelegationState, type DelegationStateName } from '@/ui/delegation/delegation-state'
import { BUDGET_BADGES, PO_BADGES, REQUEST_BADGES, STEP_BADGES, URGENCY_BADGES, type BadgeLook, type BadgeTone } from '@/ui/document/badge-looks'
import { BADGE_ICONS, StatusBadge } from '@/ui/document/badges'
import { LiffDelegationStateMark } from '@/ui/liff/delegation/state-mark'
import { LiffStatusBadge, type LiffBadgeIcon } from '@/ui/liff/status-badge'
import { badgeVariants } from '@/ui/shadcn/badge'

// S16-11: LIFF pages show status with the badges of §9.10 — the same table, colour pairs and icons as the workspace's
// StatusBadge — drawn without lucide-react or shadcn/ui (ADR-052). These tests hold the two drawings together.

const html = (node: ReactElement) => renderToStaticMarkup(node)
const firstClass = (markup: string) => /class="([^"]*)"/.exec(markup)?.[1] ?? ''
const classSet = (classes: string) => new Set(classes.split(/\s+/).filter(Boolean))
const TONES: readonly BadgeTone[] = ['ok', 'warn', 'danger', 'info', 'neutral']

/** The shapes inside an SVG, without lucide's own class and key attributes, for comparing two drawings of one icon */
function shapesOf(markup: string): string {
  const inner = /<svg[^>]*>([\s\S]*)<\/svg>/.exec(markup)?.[1] ?? ''
  return inner.replace(/\s(key|class)="[^"]*"/g, '')
}

const TABLES: ReadonlyArray<readonly [string, Readonly<Record<string, BadgeLook>>]> = [
  ['request', REQUEST_BADGES],
  ['po', PO_BADGES],
  ['step', STEP_BADGES],
  ['urgency', URGENCY_BADGES],
  ['budget', BUDGET_BADGES],
]

describe('[§9.10] LIFF status badges', () => {
  it('[FR-PLT-013/AC1] each tone draws the colour pair of §9.10 (--<tone>-bg with --<tone>-ink), the same classes as the workspace Badge', () => {
    for (const tone of TONES) {
      const liff = classSet(firstClass(html(<LiffStatusBadge look={{ tone, icon: null }} label="สถานะ" />)))
      const workspace = classSet(badgeVariants({ variant: tone }))
      expect([liff.has(`bg-${tone}-bg`), liff.has(`text-${tone}-ink`)], tone).toEqual([true, true])
      expect([workspace.has(`bg-${tone}-bg`), workspace.has(`text-${tone}-ink`)], tone).toEqual([true, true])
    }
  })

  it('every look of every table draws the same tone, icon and word on LIFF as on the workspace, never colour alone', () => {
    for (const [table, looks] of TABLES) {
      for (const [status, look] of Object.entries(looks)) {
        const liff = html(<LiffStatusBadge look={look} label="คำบนป้าย" />)
        const workspace = html(<StatusBadge look={look} label="คำบนป้าย" />)
        const toneOf = (markup: string) => /data-tone="([^"]+)"/.exec(markup)?.[1]
        const iconOf = (markup: string) => /data-icon="([^"]+)"/.exec(markup)?.[1] ?? null
        expect([toneOf(liff), iconOf(liff)], `${table} ${status}`).toEqual([toneOf(workspace), iconOf(workspace)])
        expect(liff, `${table} ${status}`).toContain('คำบนป้าย')
        // The icon is decorative: the word says what it means
        if (look.icon) expect(liff).toContain('aria-hidden="true"')
      }
    }
  })

  it('each icon of the LIFF badge is the shape lucide-react draws for the same name', () => {
    const names: readonly LiffBadgeIcon[] = [...(Object.keys(BADGE_ICONS) as LiffBadgeIcon[]), 'CircleMinus', 'CircleSlash']
    for (const name of names) {
      const Icon = lucide[name] as lucide.LucideIcon
      const liff = shapesOf(html(<LiffStatusBadge look={{ tone: 'neutral', icon: name }} label="x" />))
      expect(liff, name).not.toBe('')
      expect(liff, name).toBe(shapesOf(html(<Icon />)))
    }
  })

  it('[FR-PLT-013/AC5] the LIFF badge is markup only: 16 px words (§9.4) with no class of the workspace’s merger to resolve', () => {
    const classes = classSet(firstClass(html(<LiffStatusBadge look={REQUEST_BADGES.APPROVED} label="อนุมัติแล้ว" />)))
    expect(classes.has('text-base')).toBe(true)
    expect(classes.has('text-sm')).toBe(false)
    // An unknown status falls back to the neutral badge with its word
    const unknown = html(<LiffStatusBadge look={undefined} label="ไม่ทราบ" />)
    expect([/data-tone="neutral"/.test(unknown), unknown.includes('ไม่ทราบ'), unknown.includes('<svg')]).toEqual([true, true, false])
  })

  it('a delegation’s state on LIFF has the tone and icon of the workspace’s', () => {
    const states: readonly DelegationStateName[] = ['ACTIVE', 'SCHEDULED', 'ENDED', 'REVOKED']
    for (const state of states) {
      const liff = html(<LiffDelegationStateMark state={state} label="สถานะ" />)
      const workspace = html(<DelegationState state={state} label="สถานะ" />)
      expect(/data-tone="([^"]+)"/.exec(liff)?.[1], state).toBe(/data-tone="([^"]+)"/.exec(workspace)?.[1])
      expect(shapesOf(liff), state).toBe(shapesOf(workspace))
    }
  })
})
