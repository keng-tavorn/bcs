import { z } from 'zod'
import { err, ok, type Result } from '@/core/result'
import { newId } from '@/lib/ids'
import { PUSH_DEVICES_PER_MEMBER_MAX } from '@/lib/constants'
import { authorize } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { sealSecret } from '@/server/crypto/secret-box'
import { lockRowsForUpdate } from '@/server/db/sql/locks'
import { revokePushTokenInOtherOrganizations } from '@/server/db/sql/push-devices'
import { forTenant, type TenantTx } from '@/server/db/tenant'
import type { EventDraft } from '@/server/events/append'
import type { NotificationDraft } from '@/server/notifications/create'
import { pushTokenContext, pushTokenHash } from '@/server/notifications/push-token'
import { requireModule } from '../modules'
import { defineCommand, runCommand, type CommandOutcome, type RunOptions } from '../_pipeline'

// Devices of the BCS Go app that receive push (S17-10, FR-PLT-301 AC1 AC2, BR-APP-12, BR-AUTH-12, ADR-165):
//  - push_device.register: the member's own phone, from inside the app (channel APP: the app's web pages, signed in) of
//    an organization with module BCS_GO on (BR-APP-13). The token is sealed with ENCRYPTION_KEY (AES-256-GCM with the
//    key id, NFR-SEC-07) and its sha256 keeps one row in use per token: the same token of another member of this
//    organization, or of anyone in another organization, is revoked (REPLACED) in the same transaction, so a phone
//    receives one person's push. The same token again only refreshes the row. At most PUSH_DEVICES_PER_MEMBER_MAX in
//    use: the one seen longest ago goes (REPLACED). The owner hears of a new device by e-mail (security.notice).
//  - push_device.revoke: the owner's own device, from the settings page (USER) or when signing out in the app (LOGOUT).
//    No module check: a device is always taken away. Someone else's device is NOT_FOUND, for an ORG_ADMIN too.
//  - deactivating a member revokes every device of theirs in the deactivation's transaction (revokeMemberDevices,
//    BR-AUTH-12 with BR-AUTH-06); delivery revokes a device FCM no longer knows (UNREGISTERED, BR-NOTI-07).
// A token never leaves this module in an event, a result, a log or an error (NFR-SEC-09).

const PUSH_TOKEN = /^[A-Za-z0-9_:.-]{20,4096}$/
const APP_VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,6}$/
export const PUSH_PLATFORMS = ['ANDROID', 'IOS'] as const

const RegisterInput = z.strictObject({
  token: z.string(),
  platform: z.enum(PUSH_PLATFORMS),
  appVersion: z.string().regex(APP_VERSION),
  deviceLabel: z.string().trim().min(1).max(60).optional(),
})

const RevokeInput = z.strictObject({ deviceId: z.uuid(), reason: z.enum(['USER', 'LOGOUT']) })

export interface PushDeviceDto {
  readonly id: string
  readonly platform: (typeof PUSH_PLATFORMS)[number]
  readonly appVersion: string
  readonly deviceLabel: string | null
  readonly registeredAt: string
  readonly lastSeenAt: string
}

const revokedEvent = (deviceId: string, reason: string): EventDraft => ({ type: 'push_device.revoked', aggregateType: 'PushDevice', aggregateId: deviceId, data: { reason } })

const memberOf = (ctx: Ctx): string | null => (ctx.actor.type === 'USER' ? ctx.actor.memberId : null)

export const registerPushDeviceCommand = defineCommand({
  name: 'push_device.register',
  capability: 'self.pushDevices',
  input: RegisterInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ deviceId: string; registered: boolean }>> {
    const memberId = memberOf(ctx)
    if (!memberId) return { ok: false, error: { code: 'FORBIDDEN', message: 'members only' } }
    const allowed = await authorize(tx, ctx, 'self.pushDevices', { ownerMemberIds: [memberId] })
    if (!allowed.ok) return { ok: false, error: allowed.error }
    // BR-APP-12: registered in the app the member signed in to
    if (ctx.channel !== 'APP') return { ok: false, error: { code: 'FORBIDDEN', message: 'a device registers from inside the BCS Go app', details: { reason: 'CHANNEL' } } }
    const bcsGo = await requireModule(ctx, 'BCS_GO', tx)
    if (!bcsGo.ok) return { ok: false, error: bcsGo.error }
    if (!PUSH_TOKEN.test(input.token)) return { ok: false, error: { code: 'VALIDATION_FAILED', message: 'not a push token', details: { field: 'token', reason: 'PUSH_TOKEN' } } }

    await lockRowsForUpdate(tx, 'Member', ctx.organizationId, [memberId])
    const tokenHash = pushTokenHash(input.token)
    const events: EventDraft[] = []
    // A phone receives one person's push: the token in use anywhere else ends here (BR-AUTH-12)
    await revokePushTokenInOtherOrganizations(tx, { organizationId: ctx.organizationId, tokenHash, now: ctx.now, correlationId: ctx.correlationId, requestId: ctx.requestId })
    const inUse = await tx.pushDevice.findFirst({ where: { tokenHash, revokedAt: null }, select: { id: true, memberId: true } })
    if (inUse && inUse.memberId === memberId) {
      // The same phone again (turned on again in the app): the row is seen now with the app's version, under the same id;
      // registered again in the audit, without a second e-mail to the owner
      await tx.pushDevice.update({ where: { id: inUse.id }, data: { lastSeenAt: ctx.now, appVersion: input.appVersion, ...(input.deviceLabel ? { deviceLabel: input.deviceLabel } : {}), version: { increment: 1 } } })
      return {
        ok: true,
        result: { deviceId: inUse.id, registered: false },
        events: [{ type: 'push_device.registered', aggregateType: 'PushDevice', aggregateId: inUse.id, data: { platform: input.platform, appVersion: input.appVersion } }],
      }
    }
    if (inUse) {
      await tx.pushDevice.update({ where: { id: inUse.id }, data: { revokedAt: ctx.now, revokeReason: 'REPLACED', version: { increment: 1 } } })
      events.push(revokedEvent(inUse.id, 'REPLACED'))
    }

    const deviceId = newId()
    await tx.pushDevice.create({
      data: {
        id: deviceId,
        organizationId: ctx.organizationId,
        memberId,
        platform: input.platform,
        tokenEnc: sealSecret(input.token, pushTokenContext(ctx.organizationId, deviceId)),
        tokenHash,
        appVersion: input.appVersion,
        deviceLabel: input.deviceLabel ?? null,
        registeredAt: ctx.now,
        lastSeenAt: ctx.now,
      },
    })
    events.push({ type: 'push_device.registered', aggregateType: 'PushDevice', aggregateId: deviceId, data: { platform: input.platform, appVersion: input.appVersion } })

    // At most PUSH_DEVICES_PER_MEMBER_MAX in use: the device seen longest ago makes room
    const active = await tx.pushDevice.findMany({ where: { memberId, revokedAt: null }, orderBy: [{ lastSeenAt: 'desc' }, { id: 'desc' }], select: { id: true } })
    for (const old of active.slice(PUSH_DEVICES_PER_MEMBER_MAX)) {
      await tx.pushDevice.update({ where: { id: old.id }, data: { revokedAt: ctx.now, revokeReason: 'REPLACED', version: { increment: 1 } } })
      events.push(revokedEvent(old.id, 'REPLACED'))
    }

    const notice: NotificationDraft = {
      recipientMemberId: memberId,
      templateKey: 'security.notice',
      data: { kind: 'PUSH_DEVICE_REGISTERED' },
      urgency: 'IMMEDIATE',
      dedupeKey: `security.notice:push_device:${deviceId}`,
      subjectType: 'Member',
      subjectId: memberId,
    }
    return { ok: true, result: { deviceId, registered: true }, events, notifications: [notice] }
  },
})

export const revokePushDeviceCommand = defineCommand({
  name: 'push_device.revoke',
  capability: 'self.pushDevices',
  input: RevokeInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ deviceId: string }>> {
    const memberId = memberOf(ctx)
    if (!memberId) return { ok: false, error: { code: 'FORBIDDEN', message: 'members only' } }
    const allowed = await authorize(tx, ctx, 'self.pushDevices', { ownerMemberIds: [memberId] })
    if (!allowed.ok) return { ok: false, error: allowed.error }
    await lockRowsForUpdate(tx, 'PushDevice', ctx.organizationId, [input.deviceId])
    // Someone else's device is not found, whoever asks (ORG_ADMIN too): deactivation is how it goes for another member
    const device = await tx.pushDevice.findFirst({ where: { id: input.deviceId, memberId }, select: { id: true, revokedAt: true } })
    if (!device) return { ok: false, error: { code: 'NOT_FOUND', message: 'no such device' } }
    if (device.revokedAt) return { ok: false, error: { code: 'INVALID_STATE_TRANSITION', message: 'the device is revoked already' } }
    await tx.pushDevice.update({ where: { id: device.id }, data: { revokedAt: ctx.now, revokeReason: input.reason, version: { increment: 1 } } })
    return { ok: true, result: { deviceId: device.id }, events: [revokedEvent(device.id, input.reason)] }
  },
})

/** Registers the member's own phone for push, from inside the BCS Go app (FR-PLT-301 AC1) */
export function registerPushDevice(ctx: Ctx, input: z.input<typeof RegisterInput>, options: RunOptions) {
  return runCommand(ctx, registerPushDeviceCommand, input, options)
}

/** Takes one of the member's own devices off push (FR-PLT-301 AC2: the settings page, or signing out in the app) */
export function revokePushDevice(ctx: Ctx, input: z.input<typeof RevokeInput>, options: RunOptions) {
  return runCommand(ctx, revokePushDeviceCommand, input, options)
}

/**
 * BR-AUTH-12 with BR-AUTH-06: deactivating a member revokes every device of theirs, in the deactivation's transaction
 * (the revoker of src/server/services/members/revokers.ts)
 */
export async function revokeMemberDevices(tx: TenantTx, memberId: string, now: Date): Promise<{ count: number; events: EventDraft[] }> {
  const devices = await tx.pushDevice.findMany({ where: { memberId, revokedAt: null }, select: { id: true }, orderBy: { id: 'asc' } })
  if (devices.length === 0) return { count: 0, events: [] }
  await tx.pushDevice.updateMany({ where: { id: { in: devices.map((d) => d.id) }, revokedAt: null }, data: { revokedAt: now, revokeReason: 'DEACTIVATED', version: { increment: 1 } } })
  return { count: devices.length, events: devices.map((d) => revokedEvent(d.id, 'DEACTIVATED')) }
}

/** The member's own devices in use, newest seen first, for /settings/notifications */
export async function listMyPushDevices(ctx: Ctx): Promise<Result<readonly PushDeviceDto[]>> {
  const memberId = memberOf(ctx)
  if (!memberId) return err('FORBIDDEN', 'members only')
  return forTenant(ctx.organizationId).$transaction(async (tx) => {
    const allowed = await authorize(tx, ctx, 'self.pushDevices', { ownerMemberIds: [memberId] })
    if (!allowed.ok) return err(allowed.error.code, allowed.error.message, allowed.error.details)
    const rows = await tx.pushDevice.findMany({
      where: { memberId, revokedAt: null },
      orderBy: [{ lastSeenAt: 'desc' }, { id: 'desc' }],
      select: { id: true, platform: true, appVersion: true, deviceLabel: true, registeredAt: true, lastSeenAt: true },
    })
    return ok(rows.map((r) => ({ id: r.id, platform: r.platform, appVersion: r.appVersion, deviceLabel: r.deviceLabel, registeredAt: r.registeredAt.toISOString(), lastSeenAt: r.lastSeenAt.toISOString() })))
  })
}
