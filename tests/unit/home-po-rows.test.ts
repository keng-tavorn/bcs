import { createTranslator } from 'next-intl'
import { describe, expect, it } from 'vitest'
import { posHref, poRows } from '@/app/(workspace)/_tracking/po-rows'
import type { HomeT } from '@/app/(workspace)/_tracking/pool-row'
import en from '../../messages/en.json'
import th from '../../messages/th.json'

// §9.9 principle 1 ("งานของฉันก่อน") and §9.1 "/" (งานของฉัน): a PO waits on procurement as a draft to check and send for
// approval, and once approved to be sent to its supplier — the PO page says each wait. Once the round drafted the lines
// they leave the pool, so the home lists these POs beside the pool: one row per state with POs in it, with its count and
// a link to the PO list filtered to that state (§9.9: every number leads to its list). Who sees them is the menu's check
// (po.create) in src/app/(workspace)/page.tsx, and the counts come from procurementPoCounts
// (src/server/queries/purchase-orders.ts), the PO list's own counts of those two states.

const tTh = createTranslator({ locale: 'th', messages: th, namespace: 'home' }) as unknown as HomeT
const tEn = createTranslator({ locale: 'en', messages: en, namespace: 'home' }) as unknown as HomeT

describe('[§9.9] [FR-P2P-003/AC2] [FR-P2P-005/AC1] the home shows procurement the POs waiting for them', () => {
  it('nothing waiting: no row, and the home says nothing waits', () => {
    expect(poRows(tTh, { DRAFT: 0, APPROVED: 0 })).toEqual([])
  })

  it('a draft after the round, and an approved PO: one row each, with its count, leading to the PO list of that state', () => {
    expect(poRows(tTh, { DRAFT: 2, APPROVED: 1 })).toEqual([
      { id: 'pos-draft', href: '/procurement/pos?status=DRAFT', title: 'ร่าง PO รอตรวจและส่งขออนุมัติ 2 ฉบับ', states: [], tags: [] },
      { id: 'pos-approved', href: '/procurement/pos?status=APPROVED', title: 'PO อนุมัติแล้ว รอส่งให้ผู้ขาย 1 ฉบับ', states: [], tags: [] },
    ])
    expect(poRows(tTh, { DRAFT: 0, APPROVED: 3 }).map((r) => r.href)).toEqual([posHref('APPROVED')])
    expect(poRows(tEn, { DRAFT: 1, APPROVED: 2 }).map((r) => r.title)).toEqual(['1 draft PO waits to be checked and sent for approval', '2 approved POs wait to be sent to the supplier'])
  })
})
