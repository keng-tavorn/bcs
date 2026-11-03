import Link from 'next/link'
import { getLocale, getTranslations } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { isAllowed, memberPrincipal } from '@/server/authz'
import { savingsNoteAvailable, savingsNotesOf } from '@/server/services/ai'
import { readsSavings, SAVINGS_KINDS, savingsOpportunities, type SavingsItemDto, type SavingsKind, type SavingsLineDto, type SavingsPurchaseDto } from '@/server/services/assistants/savings'
import { lastDayOf } from '@/ui/catalog/model'
import { formatBpPercent } from '@/ui/format'
import { Notice } from '@/ui/form/notice'
import type { ReportColumnView, ReportRowView } from '@/ui/insight/report-table'
import { ListEmpty, Page, PageBody, PageHeader, Panel } from '@/ui/page/page'
import { SavingsExplain } from '@/ui/assistants/savings-explain'
import { SavingsList, type SavingsItemView } from '@/ui/assistants/savings-list'
import { Button } from '@/ui/shadcn/button'
import { getSession } from '../../../_lib/session'
import { giveAiFeedbackAction } from '../../_shell/assistant-actions'
import { day, localeOf, money, nameIn, type Locale } from '../../_tracking/present'
import { explainSavingAction } from './actions'

export async function generateMetadata() {
  const t = await getTranslations('savings')
  return { title: t('metaTitle') }
}

type SavingsT = Awaited<ReturnType<typeof getTranslations<'savings'>>>

const linkClass = 'inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline'
const navLink = 'inline-flex min-h-11 items-center font-medium text-primary underline underline-offset-4 hover:no-underline aria-[current=page]:font-semibold aria-[current=page]:text-ink aria-[current=page]:no-underline lg:min-h-10'
const isKind = (v: unknown): v is SavingsKind => typeof v === 'string' && (SAVINGS_KINDS as readonly string[]).includes(v)
const baht = (satang: string) => money(BigInt(satang))

interface Access {
  readonly pool: boolean
  readonly catalogManage: boolean
}

function columns(t: SavingsT, keys: ReadonlyArray<[string, boolean]>): ReportColumnView[] {
  return keys.map(([key, numeric]) => ({ key, header: t(`evidence.columns.${key}` as 'evidence.columns.po'), numeric }))
}

function purchaseRows(locale: Locale, purchases: readonly SavingsPurchaseDto[], withSupplier: boolean): ReportRowView[] {
  return purchases.map((p) => ({
    id: p.poLineId,
    cells: {
      po: { text: p.poNumber, href: `/procurement/pos/${p.poId}` },
      approvedAt: { text: p.approvedAt ? day(locale, p.approvedAt) : '' },
      ...(withSupplier ? { supplier: { text: nameIn(locale, p.supplier) } } : {}),
      quantity: { text: p.quantity },
      unitPrice: { text: baht(p.unitPriceSatang) },
      net: { text: baht(p.netSatang) },
    },
  }))
}

/** The page where a request line is dealt with: the pool for who works it, else the request */
function lineAction(t: SavingsT, line: SavingsLineDto, access: Access) {
  return line.request.stage === 'POOL' && access.pool ? { href: '/procurement/pool', label: t('action.pool') } : { href: `/requests/${line.request.id}`, label: t('action.request') }
}

function supplierText(t: SavingsT, locale: Locale, line: SavingsLineDto) {
  return line.supplier ? t('kind.OFF_AGREEMENT.supplier', { name: nameIn(locale, line.supplier) }) : t('kind.OFF_AGREEMENT.noSupplier')
}

function viewOf(t: SavingsT, locale: Locale, item: SavingsItemDto, windowDays: number, access: Access): SavingsItemView {
  const more = (shown: number, count: number) => (count > shown ? [t('evidence.more', { shown, count })] : [])
  switch (item.kind) {
    case 'PRICE_ABOVE_HISTORY': {
      const l = item.line
      return {
        key: item.key,
        kind: item.kind,
        title: t('kind.PRICE_ABOVE_HISTORY.title', { number: l.request.number, line: l.lineNo, description: l.description, pct: formatBpPercent(item.deviationBp, { signed: false }) }),
        why: t('kind.PRICE_ABOVE_HISTORY.why', { count: item.count, days: windowDays, reference: baht(item.referenceSatang), uom: l.uom, price: baht(l.unitPriceSatang), quantity: `${l.quantity} ${l.uom}` }),
        note: null,
        amount: t(`amount.${item.kind}`, { amount: baht(item.savingSatang) }),
        stage: t(`stage.${l.request.stage}`),
        action: lineAction(t, l, access),
        evidence: {
          title: t('kind.PRICE_ABOVE_HISTORY.evidence'),
          columns: columns(t, [
            ['po', false],
            ['approvedAt', false],
            ['supplier', false],
            ['quantity', true],
            ['unitPrice', true],
          ]),
          rows: purchaseRows(locale, item.purchases, true),
          notes: [t('kind.PRICE_ABOVE_HISTORY.stats', { min: baht(item.minSatang), median: baht(item.referenceSatang), max: baht(item.maxSatang) }), ...more(item.purchases.length, item.count)],
          empty: t('evidence.empty'),
        },
      }
    }
    case 'OFF_AGREEMENT': {
      const l = item.line
      return {
        key: item.key,
        kind: item.kind,
        title: t('kind.OFF_AGREEMENT.title', { number: l.request.number, line: l.lineNo, item: nameIn(locale, item.item) }),
        why: t('kind.OFF_AGREEMENT.why', { agreed: baht(item.agreedSatang), uom: l.uom, price: baht(l.unitPriceSatang), quantity: `${l.quantity} ${l.uom}`, supplier: supplierText(t, locale, l) }),
        note: item.offAgreementReason ? t('kind.OFF_AGREEMENT.reason', { reason: item.offAgreementReason }) : null,
        amount: t(`amount.${item.kind}`, { amount: baht(item.savingSatang) }),
        stage: t(`stage.${l.request.stage}`),
        action: lineAction(t, l, access),
        evidence: {
          title: t('kind.OFF_AGREEMENT.evidence'),
          columns: columns(t, [
            ['supplier', false],
            ['unitPrice', true],
            ['validFrom', false],
            ['lastDay', false],
          ]),
          rows: item.agreements.map((a) => ({
            id: a.id,
            cells: {
              supplier: { text: a.id === item.agreementId ? `${nameIn(locale, a.supplier)} · ${t('evidence.lowest')}` : nameIn(locale, a.supplier) },
              unitPrice: { text: baht(a.unitPriceSatang) },
              validFrom: { text: day(locale, a.validFrom) },
              lastDay: { text: day(locale, lastDayOf(a.validTo)) },
            },
          })),
          notes: [],
          empty: t('evidence.empty'),
        },
      }
    }
    case 'SAME_ITEM_DEPARTMENTS':
      return {
        key: item.key,
        kind: item.kind,
        title: t('kind.SAME_ITEM_DEPARTMENTS.title', { description: item.description, departments: item.departments }),
        why: t('kind.SAME_ITEM_DEPARTMENTS.why', { lines: item.lines.length, lowest: baht(item.lowestSatang), uom: item.uom }),
        note: item.site ? t('kind.SAME_ITEM_DEPARTMENTS.site', { site: nameIn(locale, item.site) }) : t('kind.SAME_ITEM_DEPARTMENTS.noSite'),
        amount: t(`amount.${item.kind}`, { amount: baht(item.savingSatang) }),
        stage: t('stage.POOL'),
        action: access.pool ? { href: '/procurement/pool', label: t('action.pool') } : null,
        evidence: {
          title: t('kind.SAME_ITEM_DEPARTMENTS.evidence'),
          columns: columns(t, [
            ['request', false],
            ['department', false],
            ['supplier', false],
            ['quantity', true],
            ['unitPrice', true],
            ['saving', true],
          ]),
          rows: item.lines.map((l) => ({
            id: `${l.request.id}:${l.lineNo}`,
            cells: {
              request: { text: `${l.request.number}/${l.lineNo}`, href: `/requests/${l.request.id}` },
              department: { text: nameIn(locale, l.request.department) },
              supplier: { text: l.supplier ? nameIn(locale, l.supplier) : '', emptyLabel: t('kind.OFF_AGREEMENT.noSupplier') },
              quantity: { text: `${l.quantity} ${l.uom}` },
              unitPrice: { text: l.lowest ? `${baht(l.unitPriceSatang)} · ${t('evidence.lowest')}` : baht(l.unitPriceSatang) },
              saving: { text: baht(l.savingSatang) },
            },
          })),
          notes: [],
          empty: t('evidence.empty'),
        },
      }
    case 'AGREEMENT_EXPIRING':
      return {
        key: item.key,
        kind: item.kind,
        title: t('kind.AGREEMENT_EXPIRING.title', { item: nameIn(locale, item.item), supplier: nameIn(locale, item.agreement.supplier), days: item.daysLeft }),
        why: t('kind.AGREEMENT_EXPIRING.why', { lastDay: day(locale, lastDayOf(item.agreement.validTo)), price: baht(item.agreement.unitPriceSatang), window: windowDays, spent: baht(item.spentSatang), count: item.count }),
        note: null,
        amount: t('amount.spent', { amount: baht(item.spentSatang) }),
        stage: null,
        action: access.catalogManage ? { href: '/catalog/manage', label: t('action.catalogManage') } : { href: '/catalog', label: t('action.catalog') },
        evidence: {
          title: t('kind.AGREEMENT_EXPIRING.evidence'),
          columns: columns(t, [
            ['po', false],
            ['approvedAt', false],
            ['quantity', true],
            ['unitPrice', true],
            ['net', true],
          ]),
          rows: purchaseRows(locale, item.purchases, false),
          notes: more(item.purchases.length, item.count),
          empty: t('evidence.none'),
        },
      }
  }
}

// The savings assistant (NEW-123 · FR-VIS-008 · ADR-081): the total that could be saved (each line once, BR-SAV-06),
// one link per kind with its count (every number leads to its list, §9.9), then each saving with its amount and its
// evidence. The page opens for whoever reads every PO and request; the service checks again before reading anything.
// Nothing here changes a document, and no AI is called to draw it.
export default async function SavingsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const state = await getSession()
  const ctx = ctxFromSession(state, 'WEB', systemClock.now())
  if (!ctx || state.kind !== 'member') return null
  const [t, locale] = await Promise.all([getTranslations('savings'), getLocale().then(localeOf)])
  const principal = memberPrincipal(state.member.id, state.roles)
  const result = readsSavings(principal) ? await savingsOpportunities(ctx) : null
  if (!result?.ok) {
    return (
      <Page>
        <PageHeader title={t('title')} />
        <div className="flex max-w-2xl flex-col gap-3">
          <Notice tone="danger">{t('forbidden')}</Notice>
          <Link href="/" className={linkClass}>
            {t('homeLink')}
          </Link>
        </div>
      </Page>
    )
  }
  const data = result.data
  const kindParam = (await searchParams).kind
  const kind = isKind(kindParam) ? kindParam : null
  const access: Access = { pool: isAllowed(principal, 'procurement.pool.view'), catalogManage: isAllowed(principal, 'catalog.manage') }
  const shown = data.items.filter((i) => kind === null || i.kind === kind)
  const views = shown.map((i) => viewOf(t, locale, i, data.windowDays, access))
  const total = BigInt(data.totalSatang)
  // The AI's words, only on a press and only while every gate is open (BR-AI-11); the ones the member asked for before
  const [canAsk, notes] = await Promise.all([savingsNoteAvailable(ctx), savingsNotesOf(ctx, shown)])
  const explainLabels = {
    button: t('explain.button'),
    again: t('explain.again'),
    pending: t('explain.pending'),
    label: t('explain.label'),
    aiNote: t('explain.aiNote'),
    failed: t('explain.failed'),
    gone: t('explain.gone'),
    credits: t('explain.credits'),
  }

  return (
    <Page>
      <PageHeader title={t('title')} intro={t('intro')} />
      <PageBody>
        <Panel label={t('summary.label')}>
          <p className="text-xl font-semibold text-ink tabular-nums">{total > 0n ? t('summary.total', { amount: money(total) }) : t('summary.none')}</p>
          <p className="text-base text-ink-muted md:text-sm">{t('summary.totalNote')}</p>
          {data.items.length ? (
            <nav aria-label={t('filter.label')} className="border-t border-line pt-3">
              <ul className="flex flex-wrap gap-x-5 gap-y-1">
                <li>
                  <Link href="/procurement/savings" aria-current={kind === null ? 'page' : undefined} className={navLink}>
                    {t('filter.all', { count: data.items.length })}
                  </Link>
                </li>
                {SAVINGS_KINDS.filter((k) => data.counts[k] > 0 || k === kind).map((k) => (
                  <li key={k}>
                    <Link href={`/procurement/savings?kind=${k}`} aria-current={kind === k ? 'page' : undefined} className={navLink}>
                      {t(`filter.${k}`, { count: data.counts[k] })}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
          ) : null}
        </Panel>
        <Panel title={t('list')} id="savings-list" actions={views.length ? <span className="text-base text-ink-muted md:text-sm">{t('shown', { count: views.length })}</span> : undefined}>
          {views.length ? (
            <SavingsList
              items={views}
              labels={{ show: t('evidence.show'), hide: t('evidence.hide') }}
              explain={(item) => {
                const note = notes.get(item.key) ?? null
                return canAsk || note ? <SavingsExplain itemKey={item.key} initial={note} canAsk={canAsk} labels={explainLabels} explain={explainSavingAction} give={giveAiFeedbackAction} /> : null
              }}
            />
          ) : (
            <ListEmpty
              title={kind ? t('empty.filtered') : t('empty.title')}
              hint={kind ? undefined : t('empty.hint')}
              actions={
                kind ? (
                  <Button asChild variant="outline" className="min-h-11 lg:min-h-10">
                    <Link href="/procurement/savings">{t('empty.showAll')}</Link>
                  </Button>
                ) : undefined
              }
            />
          )}
        </Panel>
      </PageBody>
    </Page>
  )
}
