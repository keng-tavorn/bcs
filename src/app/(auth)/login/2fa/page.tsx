import { getTranslations } from 'next-intl/server'
import { safeNextPath } from '@/lib/next-path'
import { TwoFactorForm } from '@/ui/auth/two-factor-form'

export async function generateMetadata() {
  const t = await getTranslations('auth.twoFactor')
  return { title: t('title') }
}

export default async function TwoFactorPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const next = safeNextPath((await searchParams).next)
  const t = await getTranslations('auth.twoFactor')
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">{t('title')}</h1>
      <TwoFactorForm next={next} />
    </div>
  )
}
