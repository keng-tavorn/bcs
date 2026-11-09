'use client'

import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { LightLink } from '../light-link'
import { Button } from '../form/button'
import { Notice } from '../form/notice'
import { useOutcomeAction } from '../procurement/use-outcome-action'

// The PO page's band "ความเสี่ยงคู่ค้า" (S11-07 · FR-RSK-203 AC6 · BR-RSK-09): the supplier's risk gate at the PO's next
// step in words — why it would refuse, with the button that clears it ("เปิดแบบประเมินความเสี่ยง", or the way to the
// assessment already open), the override it would pass with, or the warning whose reason the step asks. The page words
// every sentence on the server; this part only runs the button. The service checks the capability again.

export type RiskBandOutcome = { readonly ok: true; readonly href: string } | { readonly ok: false; readonly code: string }
const NO_ANSWER: RiskBandOutcome = { ok: false, code: 'NO_ANSWER' }

export interface RiskBandView {
  readonly tone: 'danger' | 'warning' | 'info'
  readonly lines: readonly string[]
  /** The assessment still open for the supplier: its page */
  readonly openAssessment: { readonly href: string; readonly label: string } | null
  /** The reader may open an assessment from this PO */
  readonly canOpen: boolean
}

export function RiskBand({ poId, view, open }: { poId: string; view: RiskBandView; open: (poId: string, idempotencyKey: string) => Promise<RiskBandOutcome> }) {
  const t = useTranslations('purchaseOrder')
  const router = useRouter()
  const action = useOutcomeAction<RiskBandOutcome>(NO_ANSWER)
  const failed = action.outcome && !action.outcome.ok
  return (
    <Notice tone={view.tone} role="status">
      <div className="flex flex-col gap-2">
        <p className="font-semibold">{t('risk.band.title')}</p>
        {view.lines.map((line) => (
          <p key={line}>{line}</p>
        ))}
        {view.openAssessment ? (
          <LightLink href={view.openAssessment.href} className="inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline">
            {view.openAssessment.label}
          </LightLink>
        ) : null}
        {view.canOpen ? (
          <Button
            variant="secondary"
            className="w-full sm:w-auto sm:self-start"
            disabled={action.pending}
            onClick={async () => {
              const outcome = await action.run((key) => open(poId, key))
              if (outcome.ok) router.push(outcome.href)
            }}
          >
            {action.pending ? t('risk.band.opening') : t('risk.band.open')}
          </Button>
        ) : null}
        {failed ? <p className="text-danger">{t('errors.RISK_OPEN_FAILED')}</p> : null}
      </div>
    </Notice>
  )
}
