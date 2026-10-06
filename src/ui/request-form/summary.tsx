'use client'

import { CircleAlert, CircleCheck, Info } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { amountToSatang } from '@/core/money/dto'
import type { Satang } from '@/core/money/math'
import { Notice } from '../form/notice'
import { showMoney, showRate, showSatang } from './money'
import type { Totals } from './model'
import type { BudgetView, RouteView, ScreenLocale } from './types'

// What the requester sees before sending (§9.9 principle 3): the totals, what is left on the budget line they chose
// (FR-INT-004 AC1–AC2, only that line: budget.view SELECTED_LINE_ONLY) and the expected approval route with its
// explanation (FR-DOA-003 AC2) or whom to contact when the DOA cannot route the request (AC3). Money is right-aligned
// with tabular digits and two decimals; status is never colour alone.

export function TotalsList({ totals, rateBp }: { totals: Totals | null; rateBp: number | null }) {
  const t = useTranslations('requestForm.totals')
  if (!totals || rateBp === null) return <p className="text-ink-muted">{rateBp === null ? t('noRate') : t('none')}</p>
  // Kept narrow on wide screens so each amount stays next to its label
  return (
    <dl className="grid max-w-xl grid-cols-[minmax(0,1fr)_auto] gap-x-6 gap-y-1">
      <dt>{t('net')}</dt>
      <dd className="money">{t('baht', { amount: showSatang(totals.net) })}</dd>
      <dt>{t('vat', { rate: showRate(rateBp) })}</dt>
      <dd className="money">{t('baht', { amount: showSatang(totals.vat) })}</dd>
      <dt className="font-semibold">{t('gross')}</dt>
      <dd className="money font-semibold">{t('baht', { amount: showSatang(totals.gross) })}</dd>
    </dl>
  )
}

/**
 * The selected budget line against the amount before VAT (BR-BUD-03), worked out on every keystroke from the last
 * balance the server sent; the submit checks again under lock (AC3).
 */
export function BudgetStatus({ lineChosen, budget, need, loading }: { lineChosen: boolean; budget: BudgetView | null; need: Satang | null; loading: boolean }) {
  const t = useTranslations('requestForm.budget')
  if (!lineChosen) return <p className="text-ink-muted">{t('noLine')}</p>
  if (budget?.kind === 'NOT_USABLE') return <Notice tone="danger">{t('notUsable')}</Notice>
  if (budget?.kind !== 'LINE') return <p className="text-ink-muted">{loading ? t('loading') : t('unknown')}</p>
  const available = amountToSatang(budget.available.amount)
  const amount = need ?? 0n
  const enough = amount <= available
  return (
    <div className="flex max-w-xl flex-col gap-2" aria-live="polite">
      <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-6 gap-y-1">
        <dt>{t('available')}</dt>
        <dd className="money">{t('baht', { amount: showMoney(budget.available) })}</dd>
        <dt>{t('need')}</dt>
        <dd className="money">{t('baht', { amount: showSatang(amount) })}</dd>
      </dl>
      {enough ? (
        <p className="flex items-start gap-2 font-medium text-primary">
          <CircleCheck className="mt-1 size-4 shrink-0" aria-hidden="true" />
          <span>{t('enough')}</span>
        </p>
      ) : (
        <p className="flex items-start gap-2 font-medium text-danger">
          <CircleAlert className="mt-1 size-4 shrink-0" aria-hidden="true" />
          <span>{t('short', { shortfall: showSatang(amount - available) })}</span>
        </p>
      )}
    </div>
  )
}

/**
 * The route the DOA engine expects for the request as it is now. `reported`: a refused submit already told the
 * organization's administrators about this gap (only then does the screen say so, FR-DOA-003 AC3).
 */
export function RoutePreview({ route, loading, locale, reported }: { route: RouteView | null; loading: boolean; locale: ScreenLocale; reported: boolean }) {
  const t = useTranslations('requestForm.route')
  if (!route) return <p className="text-ink-muted">{loading ? t('loading') : t('unknown')}</p>
  if (route.kind === 'NO_ROUTE') return <p>{t('noRoute')}</p>
  if (route.kind === 'NEEDS_AMOUNT') return <p className="text-ink-muted">{t('needsAmount')}</p>
  if (route.kind === 'BLOCKED') return <RouteBlocked route={route} reported={reported} />
  const who = (s: (typeof route.steps)[number]) => {
    const role = s.position ? t('positionOf', { position: s.positionName ?? s.position, department: s.departmentName ?? '' }) : null
    return { name: s.principalName ? t('acting', { name: s.assigneeName, principal: s.principalName }) : s.assigneeName, role }
  }
  const band = route.band
  const english =
    locale === 'en'
      ? t('explain', {
          doa: route.doaCode,
          version: route.versionNo,
          rule: route.ruleCode,
          amount: route.basisAmount ? showMoney(route.basisAmount) : '-',
          basis: route.amountBasis === 'GROSS' ? t('basisGross') : t('basisNet'),
          band: band ? (band.over && band.upTo ? t('bandBetween', { over: showMoney(band.over), upTo: showMoney(band.upTo) }) : band.over ? t('bandOver', { over: showMoney(band.over) }) : band.upTo ? t('bandUpTo', { upTo: showMoney(band.upTo) }) : '') : '',
        })
      : null
  return (
    <div className="flex flex-col gap-3">
      <ol className="flex flex-col gap-2">
        {route.steps.map((s) => {
          const w = who(s)
          return (
            // An expected approver, not a decision yet: the rule of supporting information, not the approved colour
            <li key={s.stepNo} className="flex flex-col border-l-4 border-info bg-surface px-3 py-2">
              <span className="text-base text-ink-muted md:text-sm">{t('step', { n: s.stepNo })}</span>
              <span className="font-semibold">{w.name}</span>
              {w.role ? <span>{w.role}</span> : null}
            </li>
          )
        })}
      </ol>
      <p className="flex items-start gap-2 text-ink">
        <Info className="mt-1 size-4 shrink-0 text-info" aria-hidden="true" />
        <span>
          {english ?? route.explanationTh}
          {/* The engine's Thai sentence already tells the escalation (BR-DOA-06); the English one is built here */}
          {english && route.escalatedFromRuleCode ? ` ${t('escalated', { from: route.escalatedFromRuleCode, to: route.ruleCode })}` : ''}
        </span>
      </p>
    </div>
  )
}

/** Why the DOA cannot route the request and whom to contact: the organization's administrators, by their role */
function RouteBlocked({ route, reported }: { route: Extract<RouteView, { kind: 'BLOCKED' }>; reported: boolean }) {
  const t = useTranslations('requestForm.route')
  const reason =
    route.code === 'APPROVER_NOT_FOUND'
      ? t('blocked.APPROVER_NOT_FOUND', { position: route.positionName ?? route.position ?? '-', departments: route.departments.join(', ') || '-', rule: route.ruleCode ?? '-' })
      : route.code === 'NO_HIGHER_AUTHORITY'
        ? t('blocked.NO_HIGHER_AUTHORITY', { rule: route.ruleCode ?? '-' })
        : route.code === 'DOA_NOT_CONFIGURED'
          ? t('blocked.DOA_NOT_CONFIGURED')
          : route.code === 'TAX_RATE_NOT_CONFIGURED'
            ? t('blocked.TAX_RATE_NOT_CONFIGURED')
            : route.code === 'NO_DEPARTMENT'
              ? t('blocked.NO_DEPARTMENT')
              : t('blocked.OTHER')
  return (
    <Notice tone="danger">
      <p>{reason}</p>
      <p>{route.code === 'TAX_RATE_NOT_CONFIGURED' ? t('contactPlatform') : t('contactAdmin')}</p>
      {reported ? <p>{t('reported')}</p> : null}
    </Notice>
  )
}
