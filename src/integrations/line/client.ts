import { z } from 'zod'
import { MS_PER_SECOND } from '@/lib/constants'
import { LineApiError, lineStatusFailure, type LineErrorDetail, type LineOperation } from './errors'
import { LINE_RICH_MENU_AREAS_MAX, LINE_RICH_MENU_BULK_USERS_MAX, lineMessageProblems, type LineMessage } from './limits'
import type {
  LineBotInfo,
  LineCallOptions,
  LinePushOptions,
  LineReplyOptions,
  LineRichMenu,
  LineRichMenuImageType,
  LineRichMenuWithId,
  LineSendResult,
  LineWebhookEndpoint,
  LineWebhookTestResult,
} from './types'

// LINE Messaging API client (BR-LINE-09, §4.7 rule 5): push, reply, rich menus, bot info and the webhook settings of one
// channel. Requests go to two hosts, as at LINE: api.line.me for everything and api-data.line.me for rich menu images;
// both come from the environment (LINE_API_BASE_URL, LINE_DATA_API_BASE_URL), which outside local accepts LINE itself
// only, so the channel access token never leaves for another host (redirects are refused for the same reason).
// Every call has a time limit; a failure is a LineApiError that says whether trying again can help (./errors.ts).

/** Most calls: LINE answers in well under a second */
export const LINE_REQUEST_TIMEOUT_MS = 5 * MS_PER_SECOND
/** Uploading a rich menu image (up to 1 MB) */
export const LINE_UPLOAD_TIMEOUT_MS = 15 * MS_PER_SECOND
/** LINE's webhook test waits for the endpoint to answer before it answers us */
export const LINE_WEBHOOK_TEST_TIMEOUT_MS = 15 * MS_PER_SECOND

export interface LineClientOptions {
  /** e.g. https://api.line.me (no trailing slash needed) */
  readonly apiBaseUrl: string
  /** e.g. https://api-data.line.me */
  readonly dataApiBaseUrl: string
  /** Tests may route requests; defaults to the global fetch */
  readonly fetch?: typeof fetch
}

/** The Messaging API of one channel, authorized by its channel access token. */
export interface LineChannelApi {
  pushMessage(to: string, messages: readonly LineMessage[], options?: LinePushOptions): Promise<LineSendResult>
  replyMessage(replyToken: string, messages: readonly LineMessage[], options?: LineReplyOptions): Promise<LineSendResult>
  getBotInfo(options?: LineCallOptions): Promise<LineBotInfo>
  getWebhookEndpoint(options?: LineCallOptions): Promise<LineWebhookEndpoint>
  setWebhookEndpoint(endpoint: string, options?: LineCallOptions): Promise<void>
  /** Asks LINE to send a test webhook to `endpoint` (or to the URL set at LINE when omitted) and report the answer */
  testWebhookEndpoint(endpoint?: string, options?: LineCallOptions): Promise<LineWebhookTestResult>
  createRichMenu(menu: LineRichMenu, options?: LineCallOptions): Promise<string>
  uploadRichMenuImage(richMenuId: string, image: Uint8Array, contentType: LineRichMenuImageType, options?: LineCallOptions): Promise<void>
  setDefaultRichMenu(richMenuId: string, options?: LineCallOptions): Promise<void>
  /** The rich menu every user without one of their own sees; null when none is set */
  getDefaultRichMenuId(options?: LineCallOptions): Promise<string | null>
  cancelDefaultRichMenu(options?: LineCallOptions): Promise<void>
  linkRichMenuToUser(userId: string, richMenuId: string, options?: LineCallOptions): Promise<void>
  unlinkRichMenuFromUser(userId: string, options?: LineCallOptions): Promise<void>
  /** One menu to many users at once (at most LINE_RICH_MENU_BULK_USERS_MAX); LINE answers 202 and applies it shortly after */
  bulkLinkRichMenu(richMenuId: string, userIds: readonly string[], options?: LineCallOptions): Promise<void>
  /** Takes the menu of their own from many users at once, so they see the default again */
  bulkUnlinkRichMenus(userIds: readonly string[], options?: LineCallOptions): Promise<void>
  /** The rich menu linked to this user; null when none is (the default then applies) */
  getUserRichMenuId(userId: string, options?: LineCallOptions): Promise<string | null>
  listRichMenus(options?: LineCallOptions): Promise<LineRichMenuWithId[]>
  deleteRichMenu(richMenuId: string, options?: LineCallOptions): Promise<void>
}

export interface LineClient {
  channel(accessToken: string): LineChannelApi
}

const RETRY_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const SentMessages = z.object({
  sentMessages: z.array(z.object({ id: z.string(), quoteToken: z.string().optional() })).optional(),
})
const BotInfo = z.object({
  userId: z.string().min(1),
  basicId: z.string(),
  premiumId: z.string().optional(),
  displayName: z.string(),
  pictureUrl: z.string().optional(),
  chatMode: z.string(),
  markAsReadMode: z.string(),
})
const WebhookEndpoint = z.object({ endpoint: z.string().optional(), active: z.boolean().optional() })
const WebhookTest = z.object({ success: z.boolean(), timestamp: z.string(), statusCode: z.number(), reason: z.string(), detail: z.string() })
const RichMenuIdOnly = z.object({ richMenuId: z.string().min(1) })
const RichMenuList = z.object({
  richmenus: z.array(
    z.object({
      richMenuId: z.string().min(1),
      size: z.object({ width: z.number(), height: z.number() }),
      selected: z.boolean(),
      name: z.string(),
      chatBarText: z.string(),
      areas: z.array(z.object({ bounds: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }), action: z.looseObject({ type: z.string() }) })),
    }),
  ),
})
const ErrorBody = z.object({
  message: z.string().optional(),
  details: z.array(z.object({ message: z.string().optional(), property: z.string().optional() })).optional(),
})

const trimBase = (url: string) => url.replace(/\/+$/, '')
const required = (value: string, what: string): string => {
  if (value === '') throw new TypeError(`${what} is required`)
  return value
}

/**
 * A LINE user id inside a path: "U" and letters or digits (LINE's are "U" + 32 hex digits). Anything else is refused
 * before a request is made: "all" is LINE's word for every user (/v2/bot/user/all/richmenu sets the default menu of the
 * whole account), and "." or ".." would be resolved by the URL parser into another endpoint.
 */
export const LINE_USER_ID_IN_PATH = /^U[0-9A-Za-z]{1,64}$/
/** A rich menu id inside a path: "richmenu-" and letters or digits, as LINE makes them */
export const LINE_RICH_MENU_ID_IN_PATH = /^richmenu-[0-9A-Za-z]{1,64}$/

/** A path segment from a value the caller passed: letters, digits and "-" only, so it can never change the path. */
function segment(value: string, pattern: RegExp, what: string): string {
  // The value is not repeated: a LINE user id is personal data (NFR-SEC-09)
  if (!pattern.test(value)) throw new TypeError(`${what} is not an id LINE makes`)
  return value
}
const userSegment = (userId: string) => segment(userId, LINE_USER_ID_IN_PATH, 'the LINE user id')
/** The users of one bulk call: 1 to LINE_RICH_MENU_BULK_USERS_MAX, each a LINE user id */
function bulkUsers(userIds: readonly string[]): string[] {
  if (userIds.length === 0 || userIds.length > LINE_RICH_MENU_BULK_USERS_MAX) throw new Error(`a bulk call takes 1 to ${LINE_RICH_MENU_BULK_USERS_MAX} users`)
  return userIds.map(userSegment)
}
const richMenuSegment = (richMenuId: string) => segment(richMenuId, LINE_RICH_MENU_ID_IN_PATH, 'the rich menu id')

interface Answer {
  readonly status: number
  readonly body: unknown
  readonly requestId: string | null
  readonly headers: Headers
}

export function createLineClient(options: LineClientOptions): LineClient {
  const apiBase = trimBase(options.apiBaseUrl)
  const dataBase = trimBase(options.dataApiBaseUrl)
  const doFetch = options.fetch ?? fetch

  return {
    channel(accessToken: string): LineChannelApi {
      if (accessToken.trim() === '') throw new TypeError('a channel access token is required')

      async function send(
        operation: LineOperation,
        url: string,
        init: { method: string; headers?: Record<string, string>; body?: string | Uint8Array<ArrayBuffer> },
        call: LineCallOptions | undefined,
        defaultTimeoutMs: number,
        /** statuses that are an answer, not a failure (e.g. 404 = no rich menu linked) */
        accepted: readonly number[] = [],
      ): Promise<Answer> {
        const timeout = AbortSignal.timeout(call?.timeoutMs ?? defaultTimeoutMs)
        const signal = call?.signal ? AbortSignal.any([timeout, call.signal]) : timeout
        let response: Response
        let text: string
        try {
          response = await doFetch(url, {
            method: init.method,
            headers: { authorization: `Bearer ${accessToken}`, ...init.headers },
            ...(init.body === undefined ? {} : { body: init.body }),
            signal,
            redirect: 'error',
          })
          text = await response.text()
        } catch {
          // The cause can quote the URL (a LINE user id) or the request: only its kind is kept
          const reason = timeout.aborted ? 'TIMEOUT' : call?.signal?.aborted ? 'ABORTED' : 'NETWORK'
          throw new LineApiError({ operation, kind: 'transient', reason })
        }
        let body: unknown = null
        if (text !== '') {
          try {
            body = JSON.parse(text)
          } catch {
            body = null
          }
        }
        const requestId = response.headers.get('x-line-request-id')
        if (response.ok || accepted.includes(response.status)) return { status: response.status, body, requestId, headers: response.headers }
        const parsed = ErrorBody.safeParse(body)
        const details: LineErrorDetail[] = parsed.success ? (parsed.data.details ?? []).map((d) => ({ message: d.message ?? '', property: d.property ?? null })) : []
        throw new LineApiError({
          operation,
          ...lineStatusFailure(response.status),
          status: response.status,
          lineMessage: parsed.success ? (parsed.data.message ?? null) : null,
          details,
          requestId,
        })
      }

      function read<T>(operation: LineOperation, schema: z.ZodType<T>, answer: Answer): T {
        const parsed = schema.safeParse(answer.body)
        if (!parsed.success) throw new LineApiError({ operation, kind: 'transient', reason: 'BAD_RESPONSE', status: answer.status, requestId: answer.requestId })
        return parsed.data
      }

      const json = (body: unknown) => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

      function checkMessages(operation: LineOperation, messages: readonly LineMessage[]): void {
        const problems = lineMessageProblems(messages)
        if (problems.length > 0) {
          throw new LineApiError({
            operation,
            kind: 'permanent',
            reason: 'LIMIT_EXCEEDED',
            details: problems.map((p) => ({ message: `${p.limit}: ${p.actual} > ${p.max}`, property: p.path })),
          })
        }
      }

      const sent = (operation: LineOperation, answer: Answer, duplicate: boolean, requestId: string | null): LineSendResult => {
        const body = read(operation, SentMessages, answer)
        return { sentMessages: (body.sentMessages ?? []).map((m) => ({ id: m.id, quoteToken: m.quoteToken ?? null })), duplicate, requestId }
      }

      return {
        async pushMessage(to, messages, call) {
          checkMessages('push', messages)
          if (call?.retryKey !== undefined && !RETRY_KEY.test(call.retryKey)) throw new TypeError('the retry key must be a UUID')
          const answer = await send(
            'push',
            `${apiBase}/v2/bot/message/push`,
            {
              method: 'POST',
              headers: { 'content-type': 'application/json', ...(call?.retryKey ? { 'x-line-retry-key': call.retryKey } : {}) },
              body: JSON.stringify({ to: required(to, 'the recipient'), messages, ...(call?.notificationDisabled ? { notificationDisabled: true } : {}) }),
            },
            call,
            LINE_REQUEST_TIMEOUT_MS,
            call?.retryKey ? [409] : [],
          )
          if (answer.status === 409) {
            // LINE accepted this retry key before: the messages went out then (Messaging API "Retry failed requests")
            const accepted = answer.headers.get('x-line-accepted-request-id')
            if (!accepted) throw new LineApiError({ operation: 'push', ...lineStatusFailure(409), status: 409, requestId: answer.requestId })
            return sent('push', answer, true, accepted)
          }
          return sent('push', answer, false, answer.requestId)
        },

        async replyMessage(replyToken, messages, call) {
          checkMessages('reply', messages)
          required(replyToken, 'the reply token')
          const answer = await send(
            'reply',
            `${apiBase}/v2/bot/message/reply`,
            { method: 'POST', ...json({ replyToken, messages, ...(call?.notificationDisabled ? { notificationDisabled: true } : {}) }) },
            call,
            LINE_REQUEST_TIMEOUT_MS,
          )
          return sent('reply', answer, false, answer.requestId)
        },

        async getBotInfo(call) {
          const info = read('botInfo', BotInfo, await send('botInfo', `${apiBase}/v2/bot/info`, { method: 'GET' }, call, LINE_REQUEST_TIMEOUT_MS))
          return { ...info, premiumId: info.premiumId ?? null, pictureUrl: info.pictureUrl ?? null }
        },

        async getWebhookEndpoint(call) {
          // 404: no webhook URL set yet
          const answer = await send('getWebhookEndpoint', `${apiBase}/v2/bot/channel/webhook/endpoint`, { method: 'GET' }, call, LINE_REQUEST_TIMEOUT_MS, [404])
          if (answer.status === 404) return { endpoint: '', active: false }
          const body = read('getWebhookEndpoint', WebhookEndpoint, answer)
          return { endpoint: body.endpoint ?? '', active: body.active ?? false }
        },

        async setWebhookEndpoint(endpoint, call) {
          await send('setWebhookEndpoint', `${apiBase}/v2/bot/channel/webhook/endpoint`, { method: 'PUT', ...json({ endpoint }) }, call, LINE_REQUEST_TIMEOUT_MS)
        },

        async testWebhookEndpoint(endpoint, call) {
          const answer = await send(
            'testWebhookEndpoint',
            `${apiBase}/v2/bot/channel/webhook/test`,
            { method: 'POST', ...json(endpoint === undefined ? {} : { endpoint }) },
            call,
            LINE_WEBHOOK_TEST_TIMEOUT_MS,
          )
          return read('testWebhookEndpoint', WebhookTest, answer)
        },

        async createRichMenu(menu, call) {
          if (menu.areas.length > LINE_RICH_MENU_AREAS_MAX) {
            throw new LineApiError({ operation: 'createRichMenu', kind: 'permanent', reason: 'LIMIT_EXCEEDED', details: [{ message: `areas: ${menu.areas.length} > ${LINE_RICH_MENU_AREAS_MAX}`, property: 'areas' }] })
          }
          const answer = await send('createRichMenu', `${apiBase}/v2/bot/richmenu`, { method: 'POST', ...json(menu) }, call, LINE_REQUEST_TIMEOUT_MS)
          return read('createRichMenu', RichMenuIdOnly, answer).richMenuId
        },

        async uploadRichMenuImage(richMenuId, image, contentType, call) {
          await send(
            'uploadRichMenuImage',
            `${dataBase}/v2/bot/richmenu/${richMenuSegment(richMenuId)}/content`,
            { method: 'POST', headers: { 'content-type': contentType }, body: new Uint8Array(image) },
            call,
            LINE_UPLOAD_TIMEOUT_MS,
          )
        },

        async setDefaultRichMenu(richMenuId, call) {
          await send('setDefaultRichMenu', `${apiBase}/v2/bot/user/all/richmenu/${richMenuSegment(richMenuId)}`, { method: 'POST' }, call, LINE_REQUEST_TIMEOUT_MS)
        },

        async getDefaultRichMenuId(call) {
          const answer = await send('getDefaultRichMenu', `${apiBase}/v2/bot/user/all/richmenu`, { method: 'GET' }, call, LINE_REQUEST_TIMEOUT_MS, [404])
          return answer.status === 404 ? null : read('getDefaultRichMenu', RichMenuIdOnly, answer).richMenuId
        },

        async cancelDefaultRichMenu(call) {
          await send('cancelDefaultRichMenu', `${apiBase}/v2/bot/user/all/richmenu`, { method: 'DELETE' }, call, LINE_REQUEST_TIMEOUT_MS)
        },

        async linkRichMenuToUser(userId, richMenuId, call) {
          const path = `/v2/bot/user/${userSegment(userId)}/richmenu/${richMenuSegment(richMenuId)}`
          await send('linkRichMenu', `${apiBase}${path}`, { method: 'POST' }, call, LINE_REQUEST_TIMEOUT_MS)
        },

        async unlinkRichMenuFromUser(userId, call) {
          await send('unlinkRichMenu', `${apiBase}/v2/bot/user/${userSegment(userId)}/richmenu`, { method: 'DELETE' }, call, LINE_REQUEST_TIMEOUT_MS)
        },

        async bulkLinkRichMenu(richMenuId, userIds, call) {
          await send('bulkLinkRichMenu', `${apiBase}/v2/bot/richmenu/bulk/link`, { method: 'POST', ...json({ richMenuId: richMenuSegment(richMenuId), userIds: bulkUsers(userIds) }) }, call, LINE_REQUEST_TIMEOUT_MS)
        },

        async bulkUnlinkRichMenus(userIds, call) {
          await send('bulkUnlinkRichMenu', `${apiBase}/v2/bot/richmenu/bulk/unlink`, { method: 'POST', ...json({ userIds: bulkUsers(userIds) }) }, call, LINE_REQUEST_TIMEOUT_MS)
        },

        async getUserRichMenuId(userId, call) {
          const answer = await send('getUserRichMenu', `${apiBase}/v2/bot/user/${userSegment(userId)}/richmenu`, { method: 'GET' }, call, LINE_REQUEST_TIMEOUT_MS, [404])
          return answer.status === 404 ? null : read('getUserRichMenu', RichMenuIdOnly, answer).richMenuId
        },

        async listRichMenus(call) {
          return read('listRichMenus', RichMenuList, await send('listRichMenus', `${apiBase}/v2/bot/richmenu/list`, { method: 'GET' }, call, LINE_REQUEST_TIMEOUT_MS)).richmenus
        },

        async deleteRichMenu(richMenuId, call) {
          await send('deleteRichMenu', `${apiBase}/v2/bot/richmenu/${richMenuSegment(richMenuId)}`, { method: 'DELETE' }, call, LINE_REQUEST_TIMEOUT_MS)
        },
      }
    },
  }
}
