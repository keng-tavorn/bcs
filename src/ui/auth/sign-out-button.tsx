'use client'

import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useState } from 'react'
import { Button } from '../form/button'
import { authClient } from './client'

export function SignOutButton() {
  const t = useTranslations('auth.security')
  const router = useRouter()
  const [pending, setPending] = useState(false)
  return (
    <Button
      variant="secondary"
      disabled={pending}
      onClick={async () => {
        setPending(true)
        await authClient.signOut()
        router.replace('/login')
        router.refresh()
      }}
    >
      {t('signOut')}
    </Button>
  )
}
