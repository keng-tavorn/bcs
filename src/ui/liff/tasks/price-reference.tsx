import { PRICE_BADGES } from '../../document/badge-looks'
import { PriceLineList, PriceQuotes } from '../../price-reference/list'
import type { PriceAlert, PriceReferenceView } from '../../price-reference/view'
import { LiffSection } from '../content'
import { LiffNotice } from '../notice'
import { LiffStatusBadge } from '../status-badge'

// The price reference on the LIFF task page (S6-11 · FR-DOA-101 AC2, BR-PRC-05: the full figures are here, behind the
// LIFF sign-in, never on the LINE card): the numbers of the web decision page as one compact list in the LIFF column,
// with the LIFF badge — plain elements and SVG, no shadcn/ui or Workspace component (ADR-052, §9.4).

const badge = (alert: { kind: PriceAlert; label: string }) => <LiffStatusBadge look={PRICE_BADGES[alert.kind]} label={alert.label} />

export function LiffPriceReference({ view }: { view: PriceReferenceView }) {
  return (
    <LiffSection id="price-reference" title={view.title}>
      <p className="text-ink-muted">{view.intro}</p>
      {view.vatNote ? <LiffNotice tone="info">{view.vatNote}</LiffNotice> : null}
      <PriceLineList lines={view.lines} labels={view.labels} badge={badge} />
      {view.quotes ? <PriceQuotes quotes={view.quotes} unit={view.labels.unit} /> : null}
    </LiffSection>
  )
}
