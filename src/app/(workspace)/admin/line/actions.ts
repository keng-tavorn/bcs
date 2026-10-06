'use server'

import { revalidatePath } from 'next/cache'
import { getTranslations } from 'next-intl/server'
import { z } from 'zod'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import type { Ctx } from '@/server/context'
import { getLineChannelSettings, saveLineChannelSettings, testLineConnection } from '@/server/services/line-channel'
import { readLineRichMenuImages, replaceLineRichMenus } from '@/server/services/line-link'
import type {
  ConnectionTestOutcome,
  LineAdminFailure,
  LineChannelInputView,
  LineChannelView,
  RichMenusOutcome,
  SaveLineChannelOutcome,
} from '@/ui/admin-line/types'
import { getSession } from '../../../_lib/session'
import { toLineChannelView } from './view'

// Browser-facing adapters for /admin/line (FR-ADM-006 AC2 AC3, §9.5). Each checks the session; the services check
// admin.channels (ORG_ADMIN) every time (BR-AUTH-05) — a member who is not an administrator is refused there, whatever
// the page showed. The secret and the token typed in the form go to the save command and nowhere else: no answer, log or
// event carries them, and the answers carry the channel as getLineChannelSettings shows it (set or not set).

const NO_SESSION: LineAdminFailure = { ok: false, code: 'UNAUTHENTICATED' }
const submissionKey = z.uuid()

async function currentCtx(): Promise<Ctx | null> {
  return ctxFromSession(await getSession(), 'WEB', systemClock.now())
}

function failure(error: { code: string; details?: Readonly<Record<string, unknown>> }, view?: LineChannelView): LineAdminFailure {
  const d = error.details ?? {}
  const status = typeof d.status === 'number' || typeof d.status === 'string' ? String(d.status) : undefined
  return {
    ok: false,
    code: error.code,
    ...(typeof d.field === 'string' ? { field: d.field } : {}),
    ...(typeof d.reason === 'string' ? { reason: d.reason } : {}),
    ...(typeof d.linked === 'number' ? { linked: d.linked } : {}),
    ...(status ? { status } : {}),
    ...(typeof d.requestId === 'string' ? { requestId: d.requestId } : {}),
    ...(view ? { view } : {}),
  }
}

/** The channel as saved now, for the page to show after a change (null when the reader may not see it) */
async function currentView(ctx: Ctx): Promise<LineChannelView | undefined> {
  const settings = await getLineChannelSettings(ctx)
  return settings.ok ? toLineChannelView(settings.data) : undefined
}

/** FR-ADM-006 AC2: saves the channel; a save over someone else's answers CONFLICT_VERSION with what is saved now */
export async function saveLineChannelAction(input: LineChannelInputView, idempotencyKey: string): Promise<SaveLineChannelOutcome> {
  const ctx = await currentCtx()
  if (!ctx) return NO_SESSION
  if (!submissionKey.safeParse(idempotencyKey).success) return { ok: false, code: 'VALIDATION_FAILED', field: 'idempotencyKey' }
  const text = (value: unknown) => (typeof value === 'string' ? value : '')
  const saved = await saveLineChannelSettings(
    ctx,
    {
      providerId: text(input?.providerId),
      messagingChannelId: text(input?.messagingChannelId),
      // Write-only: empty keeps what is stored
      channelSecret: text(input?.channelSecret),
      channelAccessToken: text(input?.channelAccessToken),
      // Empty removes
      liffId: text(input?.liffId),
      liffChannelId: text(input?.liffChannelId),
      active: input?.active === true,
      expectedVersion: typeof input?.expectedVersion === 'number' ? input.expectedVersion : null,
    },
    { idempotencyKey },
  )
  if (!saved.ok) return failure(saved.error, saved.error.code === 'CONFLICT_VERSION' ? await currentView(ctx) : undefined)
  revalidatePath('/admin/line')
  const view = await currentView(ctx)
  return view ? { ok: true, view } : NO_SESSION
}

/** FR-ADM-006 AC3: every check with its result and what to do, in the reader's language (lineSettings.checks) */
export async function testLineConnectionAction(): Promise<ConnectionTestOutcome> {
  const ctx = await currentCtx()
  if (!ctx) return NO_SESSION
  const report = await testLineConnection(ctx)
  if (!report.ok) return failure(report.error)
  const t = await getTranslations('lineSettings')
  // The keys come from the service (checks.<check>.<reason>, all of them in the messages: tested with the service)
  const say = t as unknown as (key: string, values?: Record<string, string | number>) => string
  return {
    ok: true,
    passed: report.data.passed,
    checks: report.data.checks.map((check) => ({
      id: check.id,
      passed: check.status === 'PASS',
      title: say(`checks.${check.id}.title`),
      message: say(check.messageKey, { ...check.params }),
    })),
  }
}

/** §9.5, D-02: makes both rich menus again from assets/line and gives every linked member the new LINKED one */
export async function replaceRichMenusAction(idempotencyKey: string): Promise<RichMenusOutcome> {
  const ctx = await currentCtx()
  if (!ctx) return NO_SESSION
  if (!submissionKey.safeParse(idempotencyKey).success) return { ok: false, code: 'VALIDATION_FAILED', field: 'idempotencyKey' }
  // Nothing is read from disk for someone the service would refuse anyway
  const allowed = await getLineChannelSettings(ctx)
  if (!allowed.ok) return failure(allowed.error)
  let images: Awaited<ReturnType<typeof readLineRichMenuImages>>
  try {
    images = await readLineRichMenuImages()
  } catch {
    // The pictures did not ship with the route (next.config.ts outputFileTracingIncludes) or cannot be read
    return { ok: false, code: 'VALIDATION_FAILED', field: 'images', reason: 'UNREADABLE' }
  }
  const replaced = await replaceLineRichMenus(ctx, images, { idempotencyKey })
  if (!replaced.ok) return failure(replaced.error, replaced.error.code === 'CONFLICT_VERSION' ? await currentView(ctx) : undefined)
  revalidatePath('/admin/line')
  const view = await currentView(ctx)
  if (!view) return NO_SESSION
  const { relinked, relinkRefused, relinkFailed, defaultSet } = replaced.data
  return { ok: true, view, relinked, relinkRefused, relinkFailed, defaultSet }
}
