'use client'

import { CopyPlus, RefreshCw } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useState } from 'react'
import { useSubmissionKey } from '../form/submission-key'
import { Notice } from '../form/notice'
import { Button } from '../shadcn/button'
import { NO_ANSWER, type ActionFailure } from '../tasks/outcome'
import { repeatErrorKey, type RepeatOutcome } from './repeat-rules'
import { useFailureText } from './requester-actions'

// "ขอซ้ำ" and "สร้างคำขอต่ออายุ" on the request page (S6-12 · FR-INT-101): the requester asks again for what they asked
// before — the whole request (BR-FORM-07) or one service line that ends (BR-FORM-08). Each button makes a new draft of
// theirs with one POST (a server action, with this button's idempotency key: a double click makes one draft) and opens
// the draft's edit page, where it is checked, changed and sent like any other (the same place "แก้ไขร่าง" leads). The
// page shows them to the requester only (./repeat-rules.ts); the service checks the requester, the state and the line
// again, and a refusal is said in words beside its button — never in a pop-up.

type Repeat = (id: string, idempotencyKey: string) => Promise<RepeatOutcome>

/** The edit page of a draft of the workspace (requests/[id]/edit) */
const draftHref = (requestId: string) => `/requests/${encodeURIComponent(requestId)}/edit`

/** Runs one reorder or renewal; a new draft opens its edit page, a refusal stays to be said */
function useRepeat(action: Repeat, id: string) {
  const router = useRouter()
  const submission = useSubmissionKey()
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<ActionFailure | null>(null)

  async function run() {
    setPending(true)
    setFailure(null)
    let result: RepeatOutcome
    try {
      result = await action(id, submission.key)
      submission.next()
    } catch {
      // No answer: the key stays, so pressing again is the same request for a draft, made once (spec §4.3)
      result = NO_ANSWER
    }
    // Made: the button stays busy while the draft's edit page opens
    if (result.ok) return router.push(draftHref(result.requestId))
    setPending(false)
    setFailure(result)
  }

  return { pending, failure, run }
}

/** "ขอซ้ำ" in the request's header, beside the follow button and the menu */
export function ReorderButton({ requestId, reorder }: { readonly requestId: string; readonly reorder: Repeat }) {
  const t = useTranslations('requestView.actions')
  const failureText = useFailureText(repeatErrorKey)
  const { pending, failure, run } = useRepeat(reorder, requestId)
  return (
    <div className="flex max-w-sm flex-col items-start gap-1.5">
      <Button type="button" variant="outline" className="h-11 gap-2 px-3 text-base md:text-sm" disabled={pending} onClick={() => void run()}>
        <CopyPlus aria-hidden="true" />
        {pending ? t('repeatWorking') : t('reorder')}
      </Button>
      {failure ? <Notice tone="danger">{failureText(failure)}</Notice> : null}
    </div>
  )
}

export interface RenewLineView {
  readonly id: string
  readonly description: string
  /** "สิ้นสุดบริการ 31 ต.ค. 2569", in the reader's language */
  readonly ends: string
}

function RenewRow({ line, renew }: { readonly line: RenewLineView; readonly renew: Repeat }) {
  const t = useTranslations('requestView.actions')
  const failureText = useFailureText(repeatErrorKey)
  const { pending, failure, run } = useRepeat(renew, line.id)
  return (
    <li className="flex flex-col gap-2 py-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div className="min-w-0">
          <p className="font-medium break-words text-ink">{line.description}</p>
          <p className="text-ink-muted">{line.ends}</p>
        </div>
        <Button
          type="button"
          variant="outline"
          className="h-11 shrink-0 gap-2 self-start px-3 text-base md:text-sm"
          aria-label={pending ? undefined : t('renewLabel', { item: line.description })}
          disabled={pending}
          onClick={() => void run()}
        >
          <RefreshCw aria-hidden="true" />
          {pending ? t('repeatWorking') : t('renew')}
        </Button>
      </div>
      {failure ? <Notice tone="danger">{failureText(failure)}</Notice> : null}
    </li>
  )
}

/** The service lines of an ordered or done request, each with "สร้างคำขอต่ออายุ" (the renewal reminder opens this page) */
export function RenewLines({ lines, renew }: { readonly lines: readonly RenewLineView[]; readonly renew: Repeat }) {
  const t = useTranslations('requestView.actions')
  return (
    <div className="flex flex-col gap-2">
      <p className="text-ink-muted">{t('renewHint')}</p>
      <ul aria-label={t('renewList')} className="flex flex-col divide-y divide-line border-t border-line">
        {lines.map((line) => (
          <RenewRow key={line.id} line={line} renew={renew} />
        ))}
      </ul>
    </div>
  )
}
