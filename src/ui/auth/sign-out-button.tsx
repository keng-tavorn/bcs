'use client'

import { CircleAlert } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useId, useState } from 'react'
import { Button } from '../form/button'
import { authClient, errorStatus, settled } from './client'

// "ออกจากระบบ" in the menu of the workspace and of the platform (twice on a page: the side menu and the phone's menu
// panel). Signing out is a call of Better Auth's client like the sign-in's (./client.ts settled): a request that gets no
// answer throws and nobody catches it, and a refusal (a limit on requests, a server failure) would be dropped — the page
// would go to /login, which sends a member still signed in straight back home, so on a shared computer they would
// believe they had signed out (§9.9 rule 7). So the button goes to /login only once signed out; otherwise it can be
// pressed again, and says beside it, in words with an icon, what happened and what to do: check the connection (no
// answer), or reload the page (any answer that did not sign out).

/** What a press of "ออกจากระบบ" came to */
export type SignOutResult = 'done' | 'noAnswer' | 'refused'

/** Signs out with `signOut` (the auth client's) and says what came of it; it never throws */
export async function signOutWith(signOut: () => Promise<{ readonly error: { readonly status?: number } | null }>): Promise<SignOutResult> {
  const { error } = await settled(signOut())
  if (!error) return 'done'
  return errorStatus(error) === 0 ? 'noAnswer' : 'refused'
}

/** Why the last press did not sign out, beside the button (as a field's error: an icon and words) */
export function SignOutFailure({ id, result }: { readonly id: string; readonly result: Exclude<SignOutResult, 'done'> }) {
  const t = useTranslations('auth.security')
  return (
    <p id={id} role="alert" className="flex items-start gap-1.5 text-base text-danger md:text-sm">
      <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <span>{t(result === 'noAnswer' ? 'signOutNoAnswer' : 'signOutRefused')}</span>
    </p>
  )
}

export function SignOutButton() {
  const t = useTranslations('auth.security')
  const router = useRouter()
  // The button is on the page twice (the side menu and the phone's menu panel): each says its own failure
  const messageId = `${useId()}-sign-out`
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState<Exclude<SignOutResult, 'done'> | null>(null)
  return (
    <div className="flex flex-col items-start gap-2">
      <Button
        variant="secondary"
        disabled={pending}
        aria-describedby={failed ? messageId : undefined}
        onClick={async () => {
          setPending(true)
          setFailed(null)
          const result = await signOutWith(() => authClient.signOut())
          if (result === 'done') {
            router.replace('/login')
            router.refresh()
            return
          }
          setPending(false)
          setFailed(result)
        }}
      >
        {t('signOut')}
      </Button>
      {failed ? <SignOutFailure id={messageId} result={failed} /> : null}
    </div>
  )
}
