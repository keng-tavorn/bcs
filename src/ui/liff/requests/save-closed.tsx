'use client'

import { useTranslations } from 'next-intl'
import type { ClosedWhy } from '../../request-form/outcome'
import { LiffLink } from '../liff-link'
import { LiffNotice } from '../notice'

// The notice above the LIFF request form once its draft can no longer be saved because the request was closed to it
// (§9.9 rule 7, FR-INT-006 AC2): what closed it, as the server said (closedWhy, src/ui/request-form/outcome.ts — the
// same cause the workspace's form reads), never a guess between two: sent elsewhere, cancelled elsewhere, no longer found,
// or no longer this account's to change; "sent or cancelled" only when the server named no status. Each says that what was
// changed on this page since the draft was last saved is not saved, and what to do next. The request's own page says
// where it stands, so it is offered for a request that was sent or cancelled — never for one this account can no longer
// open (gone, or not its own any more), whose link would only be refused. The words are the LIFF form's own
// (liffRequests.form.closedBy): what to do next is said in the LINE app's terms.

/** The request's page can be opened: it was sent or cancelled, not gone or taken from this account */
export const closedRequestOpens = (why: ClosedWhy): boolean => why !== 'NOT_FOUND' && why !== 'FORBIDDEN'

export function LiffSaveClosed({ why, requestHref }: { readonly why: ClosedWhy; readonly requestHref: string | null }) {
  const t = useTranslations('liffRequests.form.closedBy')
  const tSave = useTranslations('requestForm.save')
  return (
    <LiffNotice tone="warning">
      <p>{t(why)}</p>
      {requestHref && closedRequestOpens(why) ? <LiffLink href={requestHref}>{tSave('openRequest')}</LiffLink> : null}
    </LiffNotice>
  )
}
