'use client'

import dynamic from 'next/dynamic'
import { useCallback, useState, useSyncExternalStore } from 'react'
import { Skeleton } from '../shadcn/skeleton'
import { StepCards, StepPanel, type StepCardsLabels, type StepCardView } from './step-cards'

// The route on the document page (FR-INT-012 AC3 · ADR-076): the map of boxes on a computer's screen, the long line of
// cards on a phone. The server draws the cards, hidden on a wide screen where a placeholder holds the map's place, and
// the map and its library are fetched only once the screen is known to be wide, so a phone never downloads them.

const StepFlow = dynamic(() => import('./step-flow').then((m) => m.StepFlow), { ssr: false, loading: () => <Skeleton className="h-60 w-full" /> })

const WIDE = '(min-width: 64rem)'

function subscribe(onChange: () => void) {
  const query = window.matchMedia(WIDE)
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}

export interface StepRouteLabels extends StepCardsLabels {
  readonly zoomIn: string
  readonly zoomOut: string
  readonly fit: string
}

export function StepRoute({ steps, explanation, labels, next, briefLink }: { steps: readonly StepCardView[]; explanation: string; labels: StepRouteLabels; next?: string; briefLink?: string }) {
  const wide = useSyncExternalStore<boolean | null>(subscribe, () => window.matchMedia(WIDE).matches, () => null)
  const [openKey, setOpenKey] = useState<string | null>(null)
  const open = useCallback((key: string) => setOpenKey(key), [])
  return (
    <>
      {wide ? (
        <StepFlow steps={steps} {...(next ? { next } : {})} {...(briefLink ? { briefLink } : {})} labels={labels} onOpen={open} />
      ) : (
        <div className={wide === null ? 'lg:hidden' : undefined}>
          <StepCards steps={steps} labels={labels} onOpen={open} {...(next ? { next } : {})} />
        </div>
      )}
      {wide === null ? <Skeleton className="hidden h-60 w-full lg:block" /> : null}
      <StepPanel step={steps.find((s) => s.key === openKey) ?? null} explanation={explanation} labels={labels} onClose={() => setOpenKey(null)} />
    </>
  )
}
