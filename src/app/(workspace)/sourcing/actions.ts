'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import type { AppError } from '@/core/result'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import type { Ctx } from '@/server/context'
import { addRfxLines, createRfx, inviteToRfx, openRfx, removeRfxLine, setScorecard, uninviteFromRfx, updateRfx } from '@/server/services/sourcing'
import type { RfxOutcome } from '@/ui/sourcing/setup-model'
import { getSession } from '../../_lib/session'

// Browser-facing adapters of the internal sourcing screens (S10-12): "เปิด RFx" from the pool, /sourcing/new and every
// step of /sourcing/[id]/edit. Each takes the session, checks the key and ids are well formed, and hands the input to
// the command of rfx.ts, whose schema parses it and which checks SOURCING, sourcing.manage, the state machine and the
// version again (BR-AUTH-05). A refusal comes back as its code and screen-safe details only (§14.2).

const uuid = z.uuid()
type Answer = { readonly ok: true; readonly data?: unknown } | { readonly ok: false; readonly error: AppError }

function refused(error: AppError): RfxOutcome {
  const d = error.details ?? {}
  return {
    ok: false,
    code: error.code,
    ...(typeof d.reason === 'string' ? { reason: d.reason } : {}),
    ...(typeof d.earliest === 'string' ? { earliest: d.earliest } : {}),
  }
}

async function run(key: string, ids: readonly string[], call: (ctx: Ctx) => Promise<Answer>, after?: (data: unknown) => RfxOutcome): Promise<RfxOutcome> {
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  if (!ctx) return { ok: false, code: 'UNAUTHENTICATED' }
  if (!uuid.safeParse(key).success || ids.some((id) => !uuid.safeParse(id).success)) return { ok: false, code: 'VALIDATION_FAILED' }
  const r = await call(ctx)
  if (!r.ok) return refused(r.error)
  revalidatePath('/sourcing', 'layout')
  revalidatePath('/procurement/pool')
  return after ? after(r.data) : { ok: true }
}

const made = (data: unknown): RfxOutcome => ({ ok: true, rfxEventId: (data as { rfxEventId: string }).rfxEventId })

export interface NewRfxInput {
  readonly kind: 'RFQ' | 'RFP' | 'RFI'
  readonly title: string
  readonly titleEn: string
  readonly description: string
  readonly descriptionEn: string
  readonly allowPartialBids: boolean
  readonly allowVatInclusiveBids: boolean
  /** From the pool: the request lines; for a need: its category and lines */
  readonly requestLineIds?: readonly string[]
  readonly need?: { readonly categoryCode: string; readonly lines: ReadonlyArray<NeedLineInput> }
}

export interface NeedLineInput {
  readonly description: string
  readonly quantity: string
  readonly uom: string
  readonly catalogItemId: string | null
  readonly refUnitPrice: string | null
}

const text = (v: string): string | null => (v.trim() ? v.trim() : null)
const needLine = (l: NeedLineInput) => ({
  description: l.description.trim(),
  quantity: l.quantity.trim(),
  uom: l.uom.trim(),
  ...(l.catalogItemId ? { catalogItemId: l.catalogItemId } : {}),
  ...(text(l.refUnitPrice ?? '') ? { refUnitPrice: text(l.refUnitPrice ?? '') } : {}),
})

/** rfx.create from the pool's lines or from a need; answers the new RFx's id */
export async function createRfxAction(input: NewRfxInput, key: string): Promise<RfxOutcome> {
  const source = input.requestLineIds?.length
    ? { kind: 'REQUEST_LINES' as const, requestLineIds: [...input.requestLineIds] }
    : { kind: 'NEED' as const, categoryCode: input.need?.categoryCode ?? '', lines: (input.need?.lines ?? []).map(needLine) }
  return run(
    key,
    input.requestLineIds ?? [],
    (ctx) =>
      createRfx(
        ctx,
        {
          kind: input.kind,
          title: input.title.trim(),
          titleEn: text(input.titleEn),
          description: input.description.trim(),
          descriptionEn: text(input.descriptionEn),
          source: source as Parameters<typeof createRfx>[1]['source'],
          allowPartialBids: input.allowPartialBids,
          allowVatInclusiveBids: input.allowVatInclusiveBids,
        },
        { idempotencyKey: key },
      ),
    made,
  )
}

export interface GeneralInput {
  readonly title: string
  readonly titleEn: string
  readonly description: string
  readonly descriptionEn: string
  readonly allowPartialBids: boolean
  readonly allowVatInclusiveBids: boolean
  readonly sealed: boolean
  readonly unsealReason: string
}

export async function updateRfxAction(rfxEventId: string, version: number, input: GeneralInput, key: string): Promise<RfxOutcome> {
  return run(key, [rfxEventId], (ctx) =>
    updateRfx(
      ctx,
      {
        rfxEventId,
        expectedVersion: version,
        title: input.title.trim(),
        titleEn: text(input.titleEn),
        description: input.description.trim(),
        descriptionEn: text(input.descriptionEn),
        allowPartialBids: input.allowPartialBids,
        allowVatInclusiveBids: input.allowVatInclusiveBids,
        sealed: input.sealed,
        ...(!input.sealed && text(input.unsealReason) ? { unsealReason: text(input.unsealReason)! } : {}),
      },
      { idempotencyKey: key },
    ),
  )
}

export async function addNeedLineAction(rfxEventId: string, version: number, categoryCode: string, line: NeedLineInput, key: string): Promise<RfxOutcome> {
  return run(key, [rfxEventId, ...(line.catalogItemId ? [line.catalogItemId] : [])], (ctx) =>
    addRfxLines(ctx, { rfxEventId, expectedVersion: version, source: { kind: 'NEED', categoryCode, lines: [needLine(line)] } }, { idempotencyKey: key }),
  )
}

export async function removeRfxLineAction(rfxEventId: string, version: number, rfxLineId: string, key: string): Promise<RfxOutcome> {
  return run(key, [rfxEventId, rfxLineId], (ctx) => removeRfxLine(ctx, { rfxEventId, expectedVersion: version, rfxLineId }, { idempotencyKey: key }))
}

export async function inviteAction(rfxEventId: string, version: number, owner: { readonly supplierId?: string; readonly applicationId?: string }, key: string): Promise<RfxOutcome> {
  const ownerId = owner.supplierId ?? owner.applicationId ?? ''
  return run(key, [rfxEventId, ownerId], (ctx) =>
    inviteToRfx(ctx, { rfxEventId, expectedVersion: version, ...(owner.supplierId ? { supplierId: owner.supplierId } : { applicationId: owner.applicationId! }) }, { idempotencyKey: key }),
  )
}

export async function uninviteAction(rfxEventId: string, version: number, inviteId: string, reason: string, key: string): Promise<RfxOutcome> {
  return run(key, [rfxEventId, inviteId], (ctx) => uninviteFromRfx(ctx, { rfxEventId, expectedVersion: version, inviteId, reason: reason.trim() }, { idempotencyKey: key }))
}

export interface ScorecardFormInput {
  readonly criteria: ReadonlyArray<{ readonly code: string; readonly nameTh: string; readonly nameEn: string; readonly weightBp: number; readonly kind: 'PRICE' | 'QUALITY' }>
  readonly evaluatorMemberIds: readonly string[]
}

export async function setScorecardAction(rfxEventId: string, version: number, input: ScorecardFormInput, key: string): Promise<RfxOutcome> {
  return run(key, [rfxEventId, ...input.evaluatorMemberIds], (ctx) =>
    setScorecard(
      ctx,
      {
        rfxEventId,
        expectedVersion: version,
        criteria: input.criteria.map((c) => ({ code: c.code.trim(), nameTh: c.nameTh.trim(), ...(text(c.nameEn) ? { nameEn: text(c.nameEn) } : {}), weightBp: c.weightBp, kind: c.kind })),
        evaluatorMemberIds: [...input.evaluatorMemberIds],
      },
      { idempotencyKey: key },
    ),
  )
}

export async function openRfxAction(rfxEventId: string, version: number, closesAt: string, fewerInvitesReason: string, key: string): Promise<RfxOutcome> {
  return run(key, [rfxEventId], (ctx) =>
    openRfx(ctx, { rfxEventId, expectedVersion: version, closesAt, ...(text(fewerInvitesReason) ? { fewerInvitesReason: text(fewerInvitesReason)! } : {}) }, { idempotencyKey: `rfx.open:${rfxEventId}:${version}` }),
  )
}
