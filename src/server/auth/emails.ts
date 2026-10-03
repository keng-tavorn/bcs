import { inviteEmail, resetPasswordEmail, type EmailLocale } from '@/channels/email/templates/auth'
import { INVITATION_TTL_MS, MS_PER_HOUR, MS_PER_MINUTE, PASSWORD_RESET_TTL_SECONDS } from '@/lib/constants'
import { MS_PER_SECOND } from '@/lib/constants'
import { getEnv } from '@/lib/env'
import { logger } from '@/lib/logger'
import { getEmailProvider } from '@/integrations/email-provider'

// Account e-mails. Sent after the database transaction commits; a failure is logged and reported to the
// caller (the admin can resend the invitation), never retried with a stale link.

export async function sendInvitationEmail(p: {
  to: string
  orgName: string
  inviterName: string | null
  token: string
  locale?: EmailLocale
}): Promise<boolean> {
  const link = `${getEnv().APP_URL}/invite/${encodeURIComponent(p.token)}`
  const mail = inviteEmail(p.locale ?? 'th', { orgName: p.orgName, inviterName: p.inviterName, link, expiresHours: INVITATION_TTL_MS / MS_PER_HOUR })
  try {
    await getEmailProvider().send({ to: p.to, ...mail })
    return true
  } catch (error) {
    logger.error({ err: error }, 'invitation e-mail could not be sent')
    return false
  }
}

export async function sendPasswordResetEmail(p: { email: string; url: string; locale?: EmailLocale }): Promise<void> {
  const mail = resetPasswordEmail(p.locale ?? 'th', { link: p.url, expiresMinutes: (PASSWORD_RESET_TTL_SECONDS * MS_PER_SECOND) / MS_PER_MINUTE })
  await getEmailProvider().send({ to: p.email, ...mail })
}
