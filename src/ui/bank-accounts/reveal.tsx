'use client'

import { Eye, EyeOff } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { useState } from 'react'
import { Button } from '../form/button'
import { useHydrated } from '../form/hydrated'
import { Notice } from '../form/notice'
import { BANK_NO_ANSWER, type RevealOutcome } from './outcome'
import { useBankErrorText } from './use-bank-action'

// "ดูเลขเต็ม" (S9-09, FR-PAY-102 AC8, NFR-PRIV-03): a number is masked on every page; FINANCE, and the approver of the
// request, open it whole one press at a time. The press is a POST (never a GET) and the service writes a
// SensitiveAccessLog row for it before the number leaves the server; the page then says the opening was recorded. The
// number lives in this component's state only — never in the address, the page's HTML or storage — and "ซ่อนเลขเต็ม"
// drops it. The button is shown to those the server says may open it; the service checks again.

type Opened = Extract<RevealOutcome, { ok: true }>

export interface RevealRow {
  /** Which number of the answer: the one proposed (or the account's own) or the one replaced */
  readonly key: 'accountNo' | 'targetAccountNo'
  readonly label: string
}

export function RevealNumbers({ reveal, input, rows }: { reveal: (input: unknown) => Promise<RevealOutcome>; input: Readonly<Record<string, string>>; rows: readonly RevealRow[] }) {
  const t = useTranslations('bankAccount.reveal')
  const errorText = useBankErrorText()
  const hydrated = useHydrated()
  const [busy, setBusy] = useState(false)
  const [opened, setOpened] = useState<Opened | null>(null)
  const [failure, setFailure] = useState<Exclude<RevealOutcome, { ok: true }> | null>(null)

  async function onReveal() {
    setBusy(true)
    setFailure(null)
    let outcome: RevealOutcome
    try {
      outcome = await reveal(input)
    } catch {
      outcome = BANK_NO_ANSWER
    }
    setBusy(false)
    if (outcome.ok) setOpened(outcome)
    else setFailure(outcome)
  }

  const shown = opened ? rows.filter((r) => opened[r.key]) : []
  return (
    <div className="flex flex-col gap-2">
      {opened ? (
        <>
          <dl className="flex flex-col gap-1 border-l-4 border-info bg-surface px-3 py-2">
            {shown.map((r) => (
              <div key={r.key} className="flex flex-wrap items-baseline gap-x-2">
                <dt className="text-ink-muted">{r.label}</dt>
                <dd className="tabular font-semibold text-ink">{opened[r.key]}</dd>
              </div>
            ))}
          </dl>
          <p role="status" className="text-base text-ink-muted md:text-sm">
            {t('logged')}
          </p>
          <Button variant="secondary" className="self-start" onClick={() => setOpened(null)}>
            <EyeOff className="size-4" aria-hidden="true" />
            {t('hide')}
          </Button>
        </>
      ) : (
        <Button variant="secondary" className="self-start" disabled={busy || !hydrated} aria-busy={busy || undefined} onClick={() => void onReveal()}>
          <Eye className="size-4" aria-hidden="true" />
          {busy ? t('showing') : t('show')}
        </Button>
      )}
      {failure ? <Notice tone="danger">{errorText(failure)}</Notice> : null}
    </div>
  )
}
