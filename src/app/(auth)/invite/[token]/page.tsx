import { getTranslations } from 'next-intl/server'
import { PASSWORD_MIN_LENGTH } from '@/lib/constants'
import { InviteForm } from '@/ui/auth/invite-form'
import { acceptInvitationAction } from './actions'

export async function generateMetadata() {
  const t = await getTranslations('auth.invite')
  return { title: t('title') }
}

// Opening the link only shows the form (GET never changes state, BR-TOK-03); accepting is a POST server action.
export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const t = await getTranslations('auth.invite')
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">{t('title')}</h1>
      <InviteForm token={decodeURIComponent(token)} min={PASSWORD_MIN_LENGTH} accept={acceptInvitationAction} />
    </div>
  )
}
