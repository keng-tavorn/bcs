'use client'

import { StarIcon, XIcon } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useId, useState } from 'react'
import { Notice } from '../form/notice'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../shadcn/alert-dialog'
import { Button } from '../shadcn/button'
import { Combobox } from '../shadcn/combobox'
import { Label } from '../shadcn/label'
import { Toggle } from '../shadcn/toggle'
import type { ActionFailure, ActionOutcome } from '../tasks/outcome'
import { useAction } from './use-action'

// Followers of a request (FR-INT-013 AC1–AC3, §9.10 document header and right panel). The header carries the follow
// toggle — a star with the word "ติดตาม", pressed (filled star, shaded) while the viewer follows — for anybody who may
// view the request but the requester. Its name stays the same and aria-pressed says the state. A viewer who sees the
// request only because they follow it is asked first: stopping ends their access, and they cannot follow it again
// (§9.9: nothing that cannot be undone without a confirmation). The panel lists the followers; the requester removes one or adds a member who already sees the request
// (OQ-39: the list holds only them, and the service checks again). Each result stays as a line under the control after
// the page refreshes (§9.9 rule 7); nothing pops up by itself (NG-13). A button that cannot be pressed keeps its words
// readable (§9.9 contrast 4.5:1, as src/ui/form/button.tsx), not faded out.

export interface FollowerItem {
  readonly id: string
  readonly name: string
}

type Follow = (input: { requestId: string; follow: boolean }, idempotencyKey: string) => Promise<ActionOutcome>
type Manage = (input: { requestId: string; memberId: string; follow: boolean }, idempotencyKey: string) => Promise<ActionOutcome>

function useFailureText() {
  const t = useTranslations('requestView.followers.errors')
  return (failure: ActionFailure) => {
    if (failure.code === 'NO_ANSWER') return t('NO_ANSWER')
    if (failure.reason === 'CANNOT_VIEW') return t('CANNOT_VIEW')
    if (failure.reason === 'TOO_MANY') return t('TOO_MANY')
    if (failure.code === 'INVALID_STATE_TRANSITION') return t('STATE')
    if (failure.code === 'FORBIDDEN') return t('FORBIDDEN')
    return t('FAILED')
  }
}

/**
 * Runs a follower action; when the server says the list changed meanwhile (already following, not following any
 * more) the page is refreshed too, so the screen shows the state as it is and the next press does what it says.
 */
function useFollowerAction() {
  const router = useRouter()
  const action = useAction()
  async function run(call: (idempotencyKey: string) => Promise<ActionOutcome>) {
    const outcome = await action.run(call)
    if (!outcome.ok && outcome.code === 'INVALID_STATE_TRANSITION') router.refresh()
    return outcome
  }
  return { ...action, run }
}

/** The header's follow toggle: follows the request, or stops following it */
export function FollowButton({
  requestId,
  following,
  unfollowEndsAccess,
  follow,
}: {
  readonly requestId: string
  readonly following: boolean
  /** The viewer sees the request only because they follow it */
  readonly unfollowEndsAccess: boolean
  readonly follow: Follow
}) {
  const t = useTranslations('requestView.followers')
  const failureText = useFailureText()
  const action = useFollowerAction()
  const [asking, setAsking] = useState(false)
  const failure = action.outcome && !action.outcome.ok ? action.outcome : null
  const send = (next: boolean) => void action.run((key) => follow({ requestId, follow: next }, key))

  return (
    <div className="flex flex-col items-start gap-1.5">
      <Toggle
        variant="outline"
        pressed={following}
        disabled={action.pending}
        className="min-h-11 px-3 text-base"
        onPressedChange={(next) => (!next && unfollowEndsAccess ? setAsking(true) : send(next))}
      >
        <StarIcon aria-hidden="true" className={following ? 'fill-primary text-primary' : 'text-ink-muted'} />
        {t('follow')}
      </Toggle>
      {failure ? <p className="text-danger">{failureText(failure)}</p> : null}
      <AlertDialog open={asking} onOpenChange={setAsking}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('unfollowTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('unfollowBody')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="min-h-11 text-base">{t('unfollowKeep')}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" className="min-h-11 text-base" onClick={() => send(false)}>
              {t('unfollowConfirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

export interface FollowersPanelProps {
  readonly requestId: string
  readonly followers: readonly FollowerItem[]
  /** The requester: removes followers and adds members from `candidates` */
  readonly canManage: boolean
  readonly candidates: readonly FollowerItem[]
  readonly manage: Manage
}

export function FollowersPanel({ requestId, followers, canManage, candidates, manage }: FollowersPanelProps) {
  const t = useTranslations('requestView.followers')
  const failureText = useFailureText()
  const headingId = useId()
  const pickerId = useId()
  const [chosen, setChosen] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const action = useFollowerAction()
  const failure = action.outcome && !action.outcome.ok ? action.outcome : null

  async function change(memberId: string, follow: boolean, name: string) {
    setDone(null)
    const outcome = await action.run((key) => manage({ requestId, memberId, follow }, key))
    if (outcome.ok) {
      setChosen(null)
      setDone(follow ? t('added', { name }) : t('removed', { name }))
    }
  }

  const picked = candidates.find((c) => c.id === chosen) ?? null

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <h2 id={headingId} className="text-lg font-semibold text-ink">
        {t('title', { n: followers.length })}
      </h2>
      {followers.length === 0 ? (
        <p className="text-ink-muted">{canManage ? t('emptyRequester') : t('empty')}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-line border-y border-line" aria-labelledby={headingId}>
          {followers.map((f) => (
            <li key={f.id} className="flex min-h-11 items-center justify-between gap-2 py-1">
              <span className="min-w-0 break-words text-ink">{f.name}</span>
              {canManage ? (
                <Button
                  type="button"
                  variant="ghost"
                  disabled={action.pending}
                  className="min-h-11 px-3 text-base text-ink-muted"
                  aria-label={t('removeLabel', { name: f.name })}
                  onClick={() => void change(f.id, false, f.name)}
                >
                  <XIcon aria-hidden="true" />
                  {t('remove')}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {canManage ? (
        <div className="flex flex-col gap-2">
          <Label htmlFor={pickerId} className="text-base text-ink">
            {t('addLabel')}
          </Label>
          <p className="text-ink-muted">{t('addHint')}</p>
          <Combobox
            id={pickerId}
            options={candidates.map((c) => ({ value: c.id, label: c.name }))}
            value={chosen}
            onValueChange={(v) => {
              setChosen(v)
              setDone(null)
              action.clear()
            }}
            placeholder={t('pick')}
            searchPlaceholder={t('search')}
            emptyText={t('noCandidates')}
            className="min-h-11 text-base"
          />
          <Button type="button" disabled={!picked || action.pending} className="min-h-11 self-start px-4 text-base md:text-base disabled:bg-surface disabled:text-ink-muted disabled:opacity-100 disabled:ring-1 disabled:ring-line disabled:ring-inset" onClick={() => picked && void change(picked.id, true, picked.name)}>
            {t('add')}
          </Button>
        </div>
      ) : null}
      {failure ? <Notice tone="danger">{failureText(failure)}</Notice> : null}
      {done ? (
        <p role="status" className="text-ink">
          {done}
        </p>
      ) : null}
    </section>
  )
}
