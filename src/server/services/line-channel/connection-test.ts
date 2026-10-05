import { err, ok, type Result } from '@/core/result'
import { getLineClient, isLineApiError, liffChannelIdOf, LINE_REQUEST_TIMEOUT_MS, LINE_WEBHOOK_TEST_TIMEOUT_MS, type LineCallOptions, type LineChannelApi } from '@/integrations/line'
import { MS_PER_SECOND } from '@/lib/constants'
import { getEnv } from '@/lib/env'
import { authorize } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { forTenant } from '@/server/db/tenant'
import { lineWebhookUrl, readLineChannelStored } from '@/server/queries/line-channel'
import { openLineSecret } from './secrets'

// The "test connection" button of the LINE settings (FR-ADM-006 AC3): five checks, each PASS or FAIL with what to do in
// plain words (messages lineSettings.checks.<check>.<reason>, Thai and English):
//  1. accessToken      — LINE accepts the stored channel access token (bot info)
//  2. webhookUrl       — the webhook URL set at LINE is APP_URL/api/webhooks/line/<channelKey> and "Use webhook" is on
//  3. webhookReachable — LINE can reach that URL: LINE's own webhook test sends a signed webhook there and reports the
//                        answer; our route answers 401 to a signature made with another secret (BR-LINE-03), which
//                        tells that the channel secret saved here is not this channel's
//  4. liffId           — a LIFF ID is set with the channel id it belongs to, and it is the LIFF app this BCS environment
//                        runs: ADR-024 gives each environment one LIFF app, whose pages start with NEXT_PUBLIC_LIFF_ID
//                        and whose ID tokens liff.ts verifies with LINE_LIFF_CHANNEL_ID (BR-LINE-02)
//  5. richMenus        — both rich menus of §9.5 are stored and exist at LINE
// The access token is checked first; the three other calls to LINE need it and then run side by side. The whole test has
// one time budget, under the time limit of a server function: a call still running when it ends is reported as
// 'unreachable' (cause TIMEOUT), so the screen always gets a report. The webhook URL is always APP_URL's — never one a
// caller passes — so this can only ever ask LINE to send a test webhook to this system. Nothing is changed, here or at
// LINE, and no secret is part of the answer. Only an ORG_ADMIN (admin.channels) runs it.

export const LINE_CONNECTION_CHECKS = ['accessToken', 'webhookUrl', 'webhookReachable', 'liffId', 'richMenus'] as const
export type LineConnectionCheckId = (typeof LINE_CONNECTION_CHECKS)[number]

/** Every reason a check can give: the keys of lineSettings.checks.<check> besides `title` */
export const LINE_CHECK_REASONS = {
  accessToken: ['ok', 'tokenUnreadable', 'unauthorized', 'forbidden', 'unreachable', 'rejected'],
  webhookUrl: ['ok', 'needsAccessToken', 'notSet', 'mismatch', 'inactive', 'unreachable', 'rejected'],
  webhookReachable: ['ok', 'needsAccessToken', 'couldNotConnect', 'timeout', 'signatureRefused', 'errorStatus', 'unclassified', 'unreachable', 'rejected'],
  liffId: ['ok', 'notSet', 'channelNotSet', 'channelMismatch', 'envNotSet', 'envMismatch'],
  richMenus: ['ok', 'notCreated', 'needsAccessToken', 'missingAtLine', 'unreachable', 'rejected'],
} as const satisfies Record<LineConnectionCheckId, readonly string[]>

type ReasonOf<C extends LineConnectionCheckId> = (typeof LINE_CHECK_REASONS)[C][number]

/** The whole test ends within this long, every call to LINE included (a server function has a time limit; 10 s on some plans) */
export const LINE_CONNECTION_TEST_BUDGET_MS = 8 * MS_PER_SECOND

export interface LineConnectionCheck {
  readonly id: LineConnectionCheckId
  readonly status: 'PASS' | 'FAIL'
  /** 'ok' when it passed */
  readonly reason: string
  /** Key in the lineSettings messages: checks.<id>.<reason>; the text says what to do */
  readonly messageKey: string
  /** Values for the message (URLs, HTTP status, LINE's own words); never a secret */
  readonly params: Readonly<Record<string, string | number>>
}

export interface LineConnectionReport {
  /** Every check passed */
  readonly passed: boolean
  readonly checks: readonly LineConnectionCheck[]
  /** The webhook URL this organization's channel must have at LINE */
  readonly webhookUrl: string
}

export interface LineConnectionTestOptions {
  /** A shorter time budget (tests); never longer than LINE_CONNECTION_TEST_BUDGET_MS */
  readonly budgetMs?: number
}

function check<C extends LineConnectionCheckId>(id: C, reason: ReasonOf<C>, params: Record<string, string | number> = {}): LineConnectionCheck {
  return { id, status: reason === 'ok' ? 'PASS' : 'FAIL', reason, messageKey: `checks.${id}.${reason}`, params }
}

/** A failed call to LINE as the reason of a check: LINE could not answer now, or refused (with its status and words). */
function callFailure(error: unknown): { reason: 'unreachable' | 'rejected'; params: Record<string, string | number> } {
  if (!isLineApiError(error)) throw error
  if (error.kind === 'transient') return { reason: 'unreachable', params: { cause: error.status ?? error.reason } }
  return { reason: 'rejected', params: { status: error.status ?? error.reason, detail: error.lineMessage ?? '' } }
}

const sameUrl = (a: string, b: string) => {
  try {
    return new URL(a).href === new URL(b).href
  } catch {
    return false
  }
}

/** The time limit of one call: its usual one, cut to what is left of the test's budget (a call never outlives it). */
type Budget = (usualMs: number) => LineCallOptions

function budgetOf(budgetMs: number): Budget {
  const end = performance.now() + budgetMs
  return (usualMs) => ({ timeoutMs: Math.max(1, Math.min(usualMs, Math.floor(end - performance.now()))) })
}

async function accessTokenCheck(api: LineChannelApi | null, budget: Budget): Promise<LineConnectionCheck> {
  if (!api) return check('accessToken', 'tokenUnreadable')
  try {
    const bot = await api.getBotInfo(budget(LINE_REQUEST_TIMEOUT_MS))
    return check('accessToken', 'ok', { botName: bot.displayName, basicId: bot.basicId })
  } catch (error) {
    if (isLineApiError(error) && error.reason === 'UNAUTHORIZED') return check('accessToken', 'unauthorized')
    if (isLineApiError(error) && error.reason === 'FORBIDDEN') return check('accessToken', 'forbidden')
    const failed = callFailure(error)
    return check('accessToken', failed.reason, failed.params)
  }
}

async function webhookUrlCheck(api: LineChannelApi, expected: string, budget: Budget): Promise<LineConnectionCheck> {
  try {
    const { endpoint, active } = await api.getWebhookEndpoint(budget(LINE_REQUEST_TIMEOUT_MS))
    if (endpoint === '') return check('webhookUrl', 'notSet', { expected })
    if (!sameUrl(endpoint, expected)) return check('webhookUrl', 'mismatch', { expected, registered: endpoint })
    if (!active) return check('webhookUrl', 'inactive', { expected })
    return check('webhookUrl', 'ok', { expected })
  } catch (error) {
    const failed = callFailure(error)
    return check('webhookUrl', failed.reason, { ...failed.params, expected })
  }
}

/** Our webhook answers 401 when the signature was made with another secret (BR-LINE-03, S5-02) */
const SIGNATURE_REFUSED_STATUS = 401

async function webhookReachableCheck(api: LineChannelApi, expected: string, budget: Budget): Promise<LineConnectionCheck> {
  try {
    const test = await api.testWebhookEndpoint(expected, budget(LINE_WEBHOOK_TEST_TIMEOUT_MS))
    if (test.success) return check('webhookReachable', 'ok', { expected })
    switch (test.reason) {
      case 'COULD_NOT_CONNECT':
        return check('webhookReachable', 'couldNotConnect', { expected })
      case 'REQUEST_TIMEOUT':
        return check('webhookReachable', 'timeout', { expected })
      case 'ERROR_STATUS_CODE':
        return test.statusCode === SIGNATURE_REFUSED_STATUS
          ? check('webhookReachable', 'signatureRefused', { expected })
          : check('webhookReachable', 'errorStatus', { expected, statusCode: test.statusCode })
      default:
        return check('webhookReachable', 'unclassified', { expected, detail: test.detail })
    }
  } catch (error) {
    const failed = callFailure(error)
    return check('webhookReachable', failed.reason, { ...failed.params, expected })
  }
}

/** The LIFF app of this BCS environment (ADR-024): NEXT_PUBLIC_LIFF_ID and LINE_LIFF_CHANNEL_ID */
interface EnvironmentLiff {
  readonly liffId: string | null
  readonly liffChannelId: string | null
}

function environmentLiff(): EnvironmentLiff {
  const env = getEnv()
  return { liffId: env.NEXT_PUBLIC_LIFF_ID?.trim() || null, liffChannelId: env.LINE_LIFF_CHANNEL_ID?.trim() || null }
}

function liffIdCheck(liffId: string | null, liffChannelId: string | null, environment: EnvironmentLiff): LineConnectionCheck {
  if (!liffId) return check('liffId', 'notSet')
  if (!liffChannelId) return check('liffId', 'channelNotSet', { liffId })
  if (liffChannelIdOf(liffId) !== liffChannelId) return check('liffId', 'channelMismatch', { liffId, liffChannelId })
  // While ADR-024 holds, LIFF runs with the environment's app whatever the organization saved: a different pair would
  // pass here and fail at every LIFF sign-in
  if (!environment.liffId || !environment.liffChannelId) return check('liffId', 'envNotSet', { liffId })
  if (environment.liffId !== liffId || environment.liffChannelId !== liffChannelId) {
    return check('liffId', 'envMismatch', { liffId, liffChannelId, envLiffId: environment.liffId, envLiffChannelId: environment.liffChannelId })
  }
  return check('liffId', 'ok', { liffId })
}

async function richMenusCheck(api: LineChannelApi | null, linked: string | null, unlinked: string | null, budget: Budget): Promise<LineConnectionCheck> {
  if (!linked || !unlinked) return check('richMenus', 'notCreated')
  if (!api) return check('richMenus', 'needsAccessToken')
  try {
    const atLine = new Set((await api.listRichMenus(budget(LINE_REQUEST_TIMEOUT_MS))).map((m) => m.richMenuId))
    const missing = [...(atLine.has(unlinked) ? [] : ['UNLINKED']), ...(atLine.has(linked) ? [] : ['LINKED'])]
    return missing.length ? check('richMenus', 'missingAtLine', { missing: missing.join(', ') }) : check('richMenus', 'ok')
  } catch (error) {
    const failed = callFailure(error)
    return check('richMenus', failed.reason, failed.params)
  }
}

/** FR-ADM-006 AC3: runs the checks against LINE for the organization's saved channel (ORG_ADMIN). */
export async function testLineConnection(ctx: Ctx, options: LineConnectionTestOptions = {}): Promise<Result<LineConnectionReport>> {
  const allowed = await forTenant(ctx.organizationId).$transaction((tx) => authorize(tx, ctx, 'admin.channels'))
  if (!allowed.ok) return err(allowed.error.code, allowed.error.message, allowed.error.details)
  const stored = await readLineChannelStored(ctx.organizationId)
  if (!stored) return err('NOT_FOUND', 'the LINE channel is not saved yet', { what: 'lineChannel' })

  const asked = options.budgetMs
  const budget = budgetOf(asked !== undefined && Number.isFinite(asked) ? Math.min(Math.max(0, asked), LINE_CONNECTION_TEST_BUDGET_MS) : LINE_CONNECTION_TEST_BUDGET_MS)
  const webhookUrl = lineWebhookUrl(getEnv().APP_URL, stored.channelKey)
  const token = openLineSecret(ctx.organizationId, 'channelAccessToken', stored.sealed.channelAccessToken)
  const tokenApi = token === null ? null : getLineClient().channel(token)

  const accessToken = await accessTokenCheck(tokenApi, budget)
  // The calls below need a token LINE accepts; without one they would only repeat the first failure
  const api = accessToken.status === 'PASS' ? tokenApi : null
  const [webhookUrlResult, webhookReachable, richMenus] = await Promise.all([
    api ? webhookUrlCheck(api, webhookUrl, budget) : check('webhookUrl', 'needsAccessToken', { expected: webhookUrl }),
    api ? webhookReachableCheck(api, webhookUrl, budget) : check('webhookReachable', 'needsAccessToken', { expected: webhookUrl }),
    richMenusCheck(api, stored.richMenuLinkedId, stored.richMenuUnlinkedId, budget),
  ])
  const checks = [accessToken, webhookUrlResult, webhookReachable, liffIdCheck(stored.liffId, stored.liffChannelId, environmentLiff()), richMenus]
  return ok({ passed: checks.every((c) => c.status === 'PASS'), checks, webhookUrl })
}
