import { describe, expect, it } from 'vitest'
import { isValidLineSignature } from '@/integrations/line'
import { parseLineWebhook } from '@/server/line/webhook/body'
import {
  buildLineWebhook,
  DEFAULT_SIMULATED_USER_ID,
  defaultWebhookUrl,
  eventFor,
  lineEvents,
  newLineUserId,
  newWebhookEventId,
  parseSimulateArgs,
  redelivered,
  signLineWebhook,
} from '../../scripts/line-simulate'

// pnpm line:simulate (S5-02): the webhooks it sends are signed as LINE signs them (BR-LINE-03), shaped as LINE documents
// its events, and a redelivery keeps the event's id (BR-LINE-04). Its signing is written on its own, so these tests
// check it against fixed values and against the app's own check (src/integrations/line/signature.ts).

const SECRET = '0123456789abcdef0123456789abcdef'
const OTHER_SECRET = 'fedcba9876543210fedcba9876543210'
const EMPTY = '{"destination":"U00000000000000000000000000000000","events":[]}'

describe('[BR-LINE-03] line:simulate signs a webhook as LINE does: base64(HMAC-SHA256(channel secret, raw body))', () => {
  it('gives the fixed signature of a known body and secret', () => {
    expect(signLineWebhook(SECRET, EMPTY)).toBe('4RuzQe5ynlcY/Q1UqnA2wWHpO3m0lBkZBamjQ2YJec4=')
    // Thai text is signed as its UTF-8 bytes
    const thai = '{"destination":"U00000000000000000000000000000000","events":[{"type":"message","message":{"type":"text","text":"สวัสดี"}}]}'
    expect(signLineWebhook(SECRET, thai)).toBe('qsGqHLKRadE/ghay3ys+oHUkNPr7MrXkq/qE5kfvJY0=')
    expect(signLineWebhook(SECRET, new TextEncoder().encode(thai))).toBe(signLineWebhook(SECRET, thai))
  })

  it('agrees with the app’s check, and the app refuses another secret or a changed byte', () => {
    const { body } = buildLineWebhook([lineEvents.follow({ userId: newLineUserId() })])
    const signature = signLineWebhook(SECRET, body)
    expect(isValidLineSignature(SECRET, body, signature)).toBe(true)
    expect(isValidLineSignature(OTHER_SECRET, body, signature)).toBe(false)
    expect(isValidLineSignature(SECRET, body.replace('"follow"', '"unfollow"'), signature)).toBe(false)
    expect(isValidLineSignature(SECRET, body, signLineWebhook(OTHER_SECRET, body))).toBe(false)
  })

  it('refuses to sign without a secret', () => {
    expect(() => signLineWebhook('', EMPTY)).toThrow(TypeError)
  })
})

describe('[BR-LINE-04] line:simulate builds LINE’s event objects; a redelivery keeps the webhookEventId', () => {
  it('makes ULID event ids that differ every time and sort by time', () => {
    const ids = Array.from({ length: 50 }, () => newWebhookEventId())
    for (const id of ids) expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(new Set(ids).size).toBe(ids.length)
    expect(newWebhookEventId(1_000) < newWebhookEventId(2_000)).toBe(true)
  })

  it('builds follow, unfollow, postback and message events as LINE sends them', () => {
    const userId = newLineUserId()
    const follow = lineEvents.follow({ userId, unblocked: true })
    expect(follow).toMatchObject({ type: 'follow', mode: 'active', source: { type: 'user', userId }, deliveryContext: { isRedelivery: false }, follow: { isUnblocked: true } })
    expect(follow.replyToken).toMatch(/^[0-9a-f]{32}$/)
    // LINE sends no reply token with an unfollow
    expect(lineEvents.unfollow({ userId }).replyToken).toBeUndefined()
    expect(lineEvents.postback({ userId, data: 'v=1&a=approve&k=x' }).postback).toEqual({ data: 'v=1&a=approve&k=x' })
    expect(lineEvents.message({ userId, text: 'ข้อความ' }).message).toMatchObject({ type: 'text', text: 'ข้อความ' })
    expect(lineEvents.follow({ userId, groupId: 'C0123' }).source).toEqual({ type: 'group', groupId: 'C0123', userId })
  })

  it('marks a redelivery and keeps its id, reply token and time', () => {
    const event = lineEvents.postback({ userId: newLineUserId(), data: 'v=1&a=approve&k=x' })
    const again = redelivered(event)
    expect(again).toEqual({ ...event, deliveryContext: { isRedelivery: true } })
  })

  it('produces a body the app reads, without keeping the text of a message', () => {
    const userId = newLineUserId()
    const { body, json } = buildLineWebhook([lineEvents.message({ userId, text: 'ราคาส่วนลด 15%' }), lineEvents.follow({ userId })])
    expect(JSON.parse(body)).toEqual(json)
    const parsed = parseLineWebhook(new TextEncoder().encode(body))
    expect(parsed).toMatchObject({ ok: true, unreadable: 0 })
    if (!parsed.ok) throw new Error('unreadable')
    expect(parsed.events.map((e) => [e.type, e.webhookEventId])).toEqual(json.events.map((e) => [e.type, e.webhookEventId]))
    expect(parsed.events[0]!.payload).toMatchObject({ source: 'user', userId, messageType: 'text', redelivery: false })
    expect(JSON.stringify(parsed.events)).not.toContain('ราคาส่วนลด')
  })
})

describe('[BR-LINE-03] the command line of pnpm line:simulate', () => {
  it('reads the kind and the options', () => {
    expect(parseSimulateArgs(['follow'])).toEqual({
      ok: true,
      args: { kind: 'follow', userId: DEFAULT_SIMULATED_USER_ID, data: null, text: 'สวัสดี', unblocked: false, url: null, channelKey: null, org: null, secret: null },
    })
    const user = newLineUserId()
    const parsed = parseSimulateArgs(['postback', '--data', 'v=1&a=approve&k=1', '--user', user, '--channel-key', 'A'.repeat(24), '--secret', SECRET, '--url', 'http://127.0.0.1:1/x'])
    expect(parsed).toMatchObject({ ok: true, args: { kind: 'postback', data: 'v=1&a=approve&k=1', userId: user, channelKey: 'A'.repeat(24), secret: SECRET, url: 'http://127.0.0.1:1/x' } })
    if (!parsed.ok) throw new Error('refused')
    expect(eventFor(parsed.args)).toMatchObject({ type: 'postback', source: { userId: user }, postback: { data: 'v=1&a=approve&k=1' } })
    expect(parseSimulateArgs(['follow', '--unblocked'])).toMatchObject({ ok: true, args: { unblocked: true } })
  })

  it('refuses a missing or unknown kind, a postback without data, a malformed user id or key, and unknown options', () => {
    for (const argv of [[], ['ping'], ['postback'], ['follow', '--user', 'not-a-line-user'], ['follow', '--channel-key', 'short'], ['follow', '--colour', 'red'], ['follow', '--user']]) {
      expect(parseSimulateArgs(argv).ok).toBe(false)
    }
  })

  it('sends to APP_URL/api/webhooks/line/<channelKey>', () => {
    expect(defaultWebhookUrl('http://localhost:3000/', 'abcdefghijklmnopqrstuvwx')).toBe('http://localhost:3000/api/webhooks/line/abcdefghijklmnopqrstuvwx')
    expect(defaultWebhookUrl('https://bcs.example', 'abcdefghijklmnopqrstuv-_')).toBe('https://bcs.example/api/webhooks/line/abcdefghijklmnopqrstuv-_')
  })
})
