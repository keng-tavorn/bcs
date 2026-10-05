'use client'

import { useTranslations } from 'next-intl'
import { useState } from 'react'
import { settle } from '../admin-settings/outcome'
import { useHydrated } from '../form/hydrated'
import { Notice } from '../form/notice'
import { useSubmissionKey } from '../form/submission-key'
import { Switch } from './switch'
import { digestErrorKey, type SetDigestAction } from './types'

// The member's own daily summary, on or off (FR-LINE-006 AC3). The switch saves at once and says what is now in effect;
// while a change is on its way the switch waits. A refused change leaves the switch where the server has it and says
// so. A change whose answer never arrives may or may not be saved: the switch goes back to where it was, and the page
// says it is not known whether the change was saved — trying again sends the same change with the same key, so it is
// made at most once, and a reload shows what is in effect. The switch waits for the page's script (src/ui/form/hydrated.ts):
// a tap before it would move the switch without saving anything. Approval tasks and overdue work are not switches
// anywhere (BR-NOTI-04).

type Result = { readonly tone: 'success' | 'warning' | 'danger'; readonly text: string }

export function DigestSwitch({ initial, save }: { initial: boolean; save: SetDigestAction }) {
  const t = useTranslations('notificationSettings')
  const hydrated = useHydrated()
  const submission = useSubmissionKey()
  const [digest, setDigest] = useState(initial)
  const [pending, setPending] = useState(false)
  const [result, setResult] = useState<Result | null>(null)

  async function change(next: boolean) {
    setResult(null)
    setPending(true)
    setDigest(next)
    const answer = await settle(save(next, submission.key))
    setPending(false)
    if (!answer) {
      // No answer: the setting may or may not have changed (never "the old one still applies"); the same key goes with
      // the next try, which asks for the same change
      setDigest(!next)
      return setResult({ tone: 'warning', text: t('errors.NO_ANSWER') })
    }
    submission.next()
    if (!answer.ok) {
      setDigest(!next)
      return setResult({ tone: 'danger', text: t(`errors.${digestErrorKey(answer)}`, { requestId: answer.requestId ?? '-' }) })
    }
    setDigest(answer.digest)
    setResult({ tone: 'success', text: answer.digest ? t('digest.turnedOn') : t('digest.turnedOff') })
  }

  return (
    <div className="flex flex-col gap-3">
      <Switch
        id="daily-digest"
        label={t('digest.label')}
        stateLabel={pending ? t('digest.saving') : digest ? t('digest.on') : t('digest.off')}
        hint={t('digest.hint')}
        checked={digest}
        disabled={pending || !hydrated}
        onChange={(event) => change(event.currentTarget.checked)}
      />
      {result ? <Notice tone={result.tone}>{result.text}</Notice> : null}
    </div>
  )
}
