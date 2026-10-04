import { z } from 'zod'
import { err, ok, type Result } from '@/core/result'
import { liffId as liffIdFormat, lineAccessToken, lineChannelId, lineChannelSecret, lineProviderId } from '@/integrations/line'
import { authorize } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { newChannelKey } from '@/server/crypto/random-key'
import { lockRowsForUpdate } from '@/server/db/sql/locks'
import { forTenant } from '@/server/db/tenant'
import { LINE_CHANNEL_SETTING_FIELDS, type LineChannelSettingField } from '@/server/events/schemas/organization'
import { readLineChannelSettings, type LineChannelSettingsDto } from '@/server/queries/line-channel'
import { defineCommand, runCommand, type CommandFailure, type CommandOutcome, type RunOptions } from '../_pipeline'
import { openLineSecret, sealLineSecret } from './secrets'

// The organization's LINE channel (FR-ADM-006 AC2, §9.2, §6.2 LineChannelConfig): an ORG_ADMIN (admin.channels) saves
// the provider id, the Messaging API channel id, its channel secret and access token, the LIFF ID with its channel id,
// and whether LINE is in use. The secret and the token are sealed with AES-256-GCM before they are written and are never
// shown again — not a single character: the screen learns from getLineChannelSettings only whether each one is set
// (ADR-045 item 2) — nor written into an event, a log or the command's stored result. A secret field left empty keeps the stored value. The first save makes the channel's random
// channelKey — the last part of its webhook URL — which never changes afterwards. Every save records
// organization.settings_updated (section lineChannel) with the names of the fields that changed.

/** Empty or left out: keep what is stored */
const keepOrSet = (format: z.ZodType<string, string>) => z.string().trim().pipe(z.union([z.literal(''), format])).optional()
/** Left out: keep · empty or null: remove · a value: set */
const keepClearOrSet = (format: z.ZodType<string, string>) => z.string().trim().pipe(z.union([z.literal(''), format])).nullable().optional()

export const SaveLineChannelInput = z.strictObject({
  providerId: lineProviderId,
  messagingChannelId: lineChannelId,
  channelSecret: keepOrSet(lineChannelSecret),
  channelAccessToken: keepOrSet(lineAccessToken),
  liffId: keepClearOrSet(liffIdFormat),
  liffChannelId: keepClearOrSet(lineChannelId),
  active: z.boolean(),
  /**
   * The version the screen showed (LineChannelSettingsDto.version); null or left out when it showed no saved channel.
   * Checked on every save (INV-PLT-02): once a channel is saved, a save without it or with another version is
   * CONFLICT_VERSION, so nobody overwrites a save made in between without seeing it.
   */
  expectedVersion: z.number().int().nonnegative().nullable().optional(),
})
export type SaveLineChannelInput = z.input<typeof SaveLineChannelInput>

export interface SaveLineChannelResult {
  readonly channelKey: string
  readonly version: number
  readonly created: boolean
  /** Names only, as in the event */
  readonly changed: readonly LineChannelSettingField[]
}

/** Why a save was refused, in details.reason of VALIDATION_FAILED (details.field names the field) */
export type LineChannelSaveRefusal = 'REQUIRED' | 'NO_CHANGE' | 'PROVIDER_IN_USE'

function refused(field: string, reason: LineChannelSaveRefusal, extra: Record<string, unknown> = {}): CommandFailure {
  return { ok: false, error: { code: 'VALIDATION_FAILED', message: `LINE channel settings refused at ${field}: ${reason}`, details: { field, reason, ...extra } } }
}

const valueOrNull = (value: string | null | undefined): string | null => (value ? value : null)
const inFieldOrder = (fields: Iterable<LineChannelSettingField>) => {
  const set = new Set(fields)
  return LINE_CHANNEL_SETTING_FIELDS.filter((f) => set.has(f))
}

export const saveLineChannelCommand = defineCommand({
  name: 'organization.save_line_channel',
  capability: 'admin.channels',
  input: SaveLineChannelInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<SaveLineChannelResult>> {
    const allowed = await authorize(tx, ctx, 'admin.channels')
    if (!allowed.ok) return { ok: false, error: allowed.error }
    // One save at a time per organization: two first saves cannot both make a row, and the version check reads the latest
    await lockRowsForUpdate(tx, 'Organization', ctx.organizationId, [ctx.organizationId])
    const existing = await tx.lineChannelConfig.findFirst({
      select: {
        channelKey: true,
        providerId: true,
        messagingChannelId: true,
        channelSecretEnc: true,
        channelAccessTokenEnc: true,
        liffId: true,
        liffChannelId: true,
        active: true,
        version: true,
      },
    })
    // The screen sends the version it showed, or none when it showed no saved channel: anything else means a save in
    // between (or a client that skipped the check), and is refused rather than silently overwriting it
    const current = existing?.version ?? null
    if ((input.expectedVersion ?? null) !== current) {
      return { ok: false, error: { code: 'CONFLICT_VERSION', message: 'the LINE channel settings were saved by someone else', details: { current } } }
    }
    const secret = valueOrNull(input.channelSecret)
    const token = valueOrNull(input.channelAccessToken)
    const seal = (field: 'channelSecret' | 'channelAccessToken', plain: string) => sealLineSecret(ctx.organizationId, field, plain)
    const event = (created: boolean, changed: readonly LineChannelSettingField[]) =>
      ({ type: 'organization.settings_updated', aggregateType: 'Organization', aggregateId: ctx.organizationId, data: { section: 'lineChannel', created, changed } }) as const

    if (!existing) {
      if (!secret) return refused('channelSecret', 'REQUIRED')
      if (!token) return refused('channelAccessToken', 'REQUIRED')
      const values = {
        providerId: input.providerId,
        messagingChannelId: input.messagingChannelId,
        liffId: valueOrNull(input.liffId),
        liffChannelId: valueOrNull(input.liffChannelId),
        active: input.active,
      }
      const row = await tx.lineChannelConfig.create({
        data: { organizationId: ctx.organizationId, channelKey: newChannelKey(), ...values, channelSecretEnc: seal('channelSecret', secret), channelAccessTokenEnc: seal('channelAccessToken', token) },
        select: { channelKey: true, version: true },
      })
      const changed = inFieldOrder([
        'providerId',
        'messagingChannelId',
        'channelSecret',
        'channelAccessToken',
        'active',
        ...(values.liffId ? (['liffId'] as const) : []),
        ...(values.liffChannelId ? (['liffChannelId'] as const) : []),
      ])
      return { ok: true, result: { channelKey: row.channelKey, version: row.version, created: true, changed }, events: [event(true, changed)] }
    }

    const next = {
      providerId: input.providerId,
      messagingChannelId: input.messagingChannelId,
      liffId: input.liffId === undefined ? existing.liffId : valueOrNull(input.liffId),
      liffChannelId: input.liffChannelId === undefined ? existing.liffChannelId : valueOrNull(input.liffChannelId),
      active: input.active,
    }
    const changed = new Set<LineChannelSettingField>((Object.keys(next) as Array<keyof typeof next>).filter((field) => next[field] !== existing[field]))
    const sealed: { channelSecretEnc?: string; channelAccessTokenEnc?: string } = {}
    // A secret typed again unchanged is not a change; one that no longer opens is replaced
    if (secret && openLineSecret(ctx.organizationId, 'channelSecret', existing.channelSecretEnc) !== secret) {
      sealed.channelSecretEnc = seal('channelSecret', secret)
      changed.add('channelSecret')
    }
    if (token && openLineSecret(ctx.organizationId, 'channelAccessToken', existing.channelAccessTokenEnc) !== token) {
      sealed.channelAccessTokenEnc = seal('channelAccessToken', token)
      changed.add('channelAccessToken')
    }
    if (changed.size === 0) return refused('(input)', 'NO_CHANGE')
    // LINE user ids differ per provider (§9.2): moving to another provider while members are linked would leave every
    // link pointing at ids the new provider never issued. Members unlink first (FR-LINE-001 AC3), then the provider moves.
    // The link command takes the same Organization row lock (lockLineChannelForLinking, ./linking.ts), so a link cannot
    // slip in between this count and the update.
    if (changed.has('providerId')) {
      const linked = await tx.channelIdentity.count({ where: { channel: 'LINE', providerKey: existing.providerId, unlinkedAt: null } })
      if (linked > 0) return refused('providerId', 'PROVIDER_IN_USE', { linked })
    }
    const row = await tx.lineChannelConfig.update({
      where: { organizationId: ctx.organizationId },
      data: { ...next, ...sealed, version: { increment: 1 } },
      select: { channelKey: true, version: true },
    })
    const names = inFieldOrder(changed)
    return { ok: true, result: { channelKey: row.channelKey, version: row.version, created: false, changed: names }, events: [event(false, names)] }
  },
})

/** FR-ADM-006 AC2: saves the channel settings (ORG_ADMIN). */
export function saveLineChannelSettings(ctx: Ctx, input: SaveLineChannelInput, options: RunOptions) {
  return runCommand(ctx, saveLineChannelCommand, input, options)
}

/** The settings screen (admin.channels): every field; of the channel secret and access token only whether each is set. */
export async function getLineChannelSettings(ctx: Ctx): Promise<Result<LineChannelSettingsDto>> {
  const allowed = await forTenant(ctx.organizationId).$transaction((tx) => authorize(tx, ctx, 'admin.channels'))
  if (!allowed.ok) return err(allowed.error.code, allowed.error.message, allowed.error.details)
  return ok(await readLineChannelSettings(ctx.organizationId, (field, sealed) => openLineSecret(ctx.organizationId, field, sealed)))
}
