import { getTranslations } from 'next-intl/server'
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@/lib/constants'
import { ResetForm } from '@/ui/auth/reset-form'

export async function generateMetadata() {
  const t = await getTranslations('auth.reset')
  return { title: t('title') }
}

// Better Auth checks the e-mailed token and redirects here with ?token=… (or ?error=INVALID_TOKEN).
export default async function ResetPasswordPage({ searchParams }: { searchParams: Promise<{ token?: string; error?: string }> }) {
  const { token, error } = await searchParams
  const t = await getTranslations('auth.reset')
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">{t('title')}</h1>
      <ResetForm token={!error && token ? token : null} min={PASSWORD_MIN_LENGTH} max={PASSWORD_MAX_LENGTH} />
    </div>
  )
}
