import { newId } from '@/lib/ids'
import { toJsonSafe } from '@/lib/json'
import { logger } from '@/lib/logger'
import { systemDb } from '@/server/db/system'
import { validateEventDraft } from '@/server/events/append'

// Security events from Better Auth flows (auth.login_succeeded / login_failed / login_locked / 2fa_enabled).
// They are not commands on an aggregate, so they are appended directly (still append-only and schema-checked).
// The event belongs to the member's organization when the e-mail maps to exactly one active member;
// otherwise it is a platform-level event (organizationId null). The e-mail itself is not stored in the event.
// `channel` is where the sign-in came from: WEB, or LIFF for a sign-in with a LINE ID token (src/server/auth/liff.ts).

export async function recordAuthEvent(type: string, email: string, data: Record<string, unknown>, now: Date, options: { readonly channel?: 'WEB' | 'LIFF' } = {}): Promise<void> {
  try {
    const members = email
      ? await systemDb.member.findMany({ where: { email, status: { not: 'DEACTIVATED' } }, select: { id: true, organizationId: true } })
      : []
    const target = members.length === 1 ? members[0]! : null
    const aggregateId = target?.id ?? newId()
    const payload = validateEventDraft({
      type,
      aggregateType: 'Auth',
      aggregateId,
      data: { ...data, memberKnown: Boolean(target) },
    })
    await systemDb.event.create({
      data: {
        id: newId(),
        organizationId: target?.organizationId ?? null,
        type,
        aggregateType: 'Auth',
        aggregateId,
        occurredAt: now,
        actorType: target ? 'USER' : 'SYSTEM',
        actorMemberId: target?.id ?? null,
        channel: options.channel ?? 'WEB',
        correlationId: newId(),
        requestId: newId(),
        data: toJsonSafe(payload) as object,
        schemaVersion: 1,
      },
    })
  } catch (error) {
    logger.error({ err: error, type }, 'could not record auth event')
  }
}
