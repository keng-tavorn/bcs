'use client'

import { Fingerprint } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { useState } from 'react'
import { Button } from '../form/button'
import { useHydrated } from '../form/hydrated'
import { Notice } from '../form/notice'
import { answerChallenge, passkeySupported } from '../passkey/webauthn'
import type { ActionFailure } from './outcome'

// A passkey in place of the PIN on the decision page (S17-15, FR-PLT-301 AC3, BR-AUTH-09): offered beside the PIN field
// when the member has a passkey in use and the browser or the BCS Go app can use it. Pressed, it asks the server for a
// challenge of this task's document (passkeyOptions), lets the device check the fingerprint, face or screen lock, and
// hands the answer to the form, which sends it with the decision instead of the PIN. The PIN stays: a device without a
// passkey, or a passkey that fails, still decides with it. Nothing is decided here; the server checks everything.

export type PasskeyOptionsOutcome = { readonly ok: true; readonly options: Record<string, unknown> } | ActionFailure

export interface PasskeyProof {
  /** Offer the button: the member has a passkey and this browser can use it */
  readonly usable: boolean
  /** The device's answer for this task, or null when it was not given (the reason is in `problem`) */
  readonly prove: () => Promise<Record<string, unknown> | null>
  readonly problem: string | null
  readonly clear: () => void
}

export function usePasskeyProof(taskId: string, hasPasskey: boolean, options: ((taskId: string) => Promise<PasskeyOptionsOutcome>) | undefined): PasskeyProof {
  const t = useTranslations('tasks.passkey')
  const [problem, setProblem] = useState<string | null>(null)
  // Known in the browser only: the server's HTML never shows the button, so nothing differs when the script starts
  const hydrated = useHydrated()
  return {
    usable: Boolean(hasPasskey && options && hydrated && passkeySupported()),
    problem,
    clear: () => setProblem(null),
    prove: async () => {
      setProblem(null)
      if (!options) return null
      const asked = await options(taskId).catch(() => null)
      if (!asked || !asked.ok) {
        setProblem(t('notAsked'))
        return null
      }
      const answer = await answerChallenge(asked.options)
      if (answer.ok) return answer.response
      // Closing the prompt is the person's choice: nothing to say
      if (answer.reason !== 'CANCELLED') setProblem(t('failed'))
      return null
    },
  }
}

/** The button beside the PIN, and what went wrong with the last try */
export function PasskeyButton({ proof, label, onPress, disabled }: { readonly proof: PasskeyProof; readonly label: string; readonly onPress: () => void; readonly disabled?: boolean }) {
  if (!proof.usable) return null
  return (
    <div className="flex flex-col gap-2">
      <Button variant="secondary" onClick={onPress} disabled={disabled} className="w-full">
        <Fingerprint className="size-5" aria-hidden="true" />
        {label}
      </Button>
      {proof.problem ? <Notice tone="danger">{proof.problem}</Notice> : null}
    </div>
  )
}
