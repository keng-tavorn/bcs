import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { ForgotForm } from '@/ui/auth/forgot-form'

export async function generateMetadata() {
  const t = await getTranslations('auth.forgot')
  return { title: t('title') }
}

export default async function ForgotPasswordPage() {
  const t = await getTranslations('auth.forgot')
  const tAuth = await getTranslations('auth')
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">{t('title')}</h1>
      <ForgotForm />
      <Link href="/login" className="self-start font-medium text-primary underline underline-offset-4 hover:no-underline">
        {tAuth('backToLogin')}
      </Link>
    </div>
  )
}
