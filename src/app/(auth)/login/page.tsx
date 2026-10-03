import Link from 'next/link'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { safeNextPath } from '@/lib/next-path'
import { resolveSession } from '@/server/auth/session'
import { LoginForm } from '@/ui/auth/login-form'

export async function generateMetadata() {
  const t = await getTranslations('auth.login')
  return { title: t('title') }
}

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ ended?: string; next?: string }> }) {
  const { ended, next: rawNext } = await searchParams
  // An e-mail action link sends people here first and back afterwards (BR-TOK-03)
  const next = safeNextPath(rawNext)
  const state = await resolveSession(await headers())
  if (state.kind === 'member' || state.kind === 'needs-2fa-setup') redirect(next ?? '/')
  const t = await getTranslations('auth.login')
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">{t('title')}</h1>
      <LoginForm sessionEnded={ended === '1' || state.kind === 'expired'} next={next} />
      <Link href="/forgot-password" className="self-start font-medium text-primary underline underline-offset-4 hover:no-underline">
        {t('forgot')}
      </Link>
    </div>
  )
}
