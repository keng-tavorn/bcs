'use client'

import { useRouter } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { useState } from 'react'
import { Button } from '../form/button'
import { Notice } from '../form/notice'
import { useSubmissionKey } from '../form/submission-key'
import { formatDateTime } from '../format'
import type { BankOutcome } from './outcome'

// A bank account change the supplier proposed on the portal (S7-10 · ADR-190 · FR-SUP-103 AC2 · BR-SUP ข้อ 17), on its page
// for FINANCE and its approver: who proposed it, "รับเรื่อง" while no member claimed it (the first claim wins, the server
// says so to the second), the warnings of a contact added or re-addressed or the register's phone changed lately with the
// member who did it, and the number to call with where it came from — never the one the supplier typed.

export interface PortalChangeView {
  readonly proposedBy: string | null
  readonly awaitingClaim: boolean
  readonly canClaim: boolean
  readonly warnings: ReadonlyArray<{ readonly kind: 'CONTACT_ADDED' | 'CONTACT_EMAIL_CHANGED' | 'PHONE_CHANGED'; readonly by: string | null; readonly at: string }>
  readonly callPhone: { readonly phone: string | null; readonly source: 'REGISTER' | 'DBD' | 'INVITER' | 'APPLICANT' | 'UNKNOWN' }
}

export function PortalChange({ changeId, version, portal, claim }: { readonly changeId: string; readonly version: number; readonly portal: PortalChangeView; readonly claim: (input: unknown, key: string) => Promise<BankOutcome> }) {
  const t = useTranslations('supplierBank.finance')
  const locale = useLocale()
  const router = useRouter()
  const { key, next } = useSubmissionKey()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onClaim() {
    setBusy(true)
    setError(null)
    const r = await claim({ changeId, version }, key)
    setBusy(false)
    next()
    if (!r.ok) return setError(r.code === 'INVALID_STATE_TRANSITION' ? t('claimedAlready') : r.code === 'FORBIDDEN' ? t('forbidden') : t('failed'))
    router.refresh()
  }

  return (
    <div className="flex flex-col gap-3">
      <Notice tone="info">{t('fromPortal', { name: portal.proposedBy ?? '-' })}</Notice>
      {portal.warnings.map((w, i) => (
        <Notice key={`${w.kind}-${i}`} tone="warning">
          {t(`warning.${w.kind}`, { by: w.by ?? t('someone'), at: formatDateTime(locale, w.at) })}
        </Notice>
      ))}
      <p>
        {t('callPhone', { phone: portal.callPhone.phone ?? '-' })} · {t(`phoneSource.${portal.callPhone.source}`)}
      </p>
      {portal.callPhone.source === 'APPLICANT' || portal.callPhone.source === 'UNKNOWN' ? <Notice tone="warning">{t('findPhone')}</Notice> : null}
      {portal.awaitingClaim ? (
        <div className="flex flex-col gap-2">
          <p className="font-medium">{t('awaitingClaim')}</p>
          {error ? <Notice tone="danger">{error}</Notice> : null}
          {portal.canClaim ? (
            <Button variant="primary" disabled={busy} onClick={() => void onClaim()} className="self-start">
              {t('claim')}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
