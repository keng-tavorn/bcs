// The AI adapter without a key (S13-01, ADR-141 ADR-142 ADR-143): recorded answers in fixture mode, and live mode
// against a stand-in for the Messages API that records what the adapter sends.
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  createFixtureClient,
  createLiveClient,
  fixtureKey,
  getAiClient,
  normalizeText,
  PROMPTS,
  type FixtureAnswer,
} from '@/integrations/ai'
import { AI_AGENTS, AI_PURPOSES, EVAL_GATES, isGated, modelFor, MODEL_PRICES, PROMPT_VERSIONS, requiredGateTier } from '@/lib/ai-config'

const Schema = z.strictObject({ docNo: z.string().nullable(), gross: z.string().nullable() })
const SONNET = 'claude-sonnet-5-5'
const PDF = { bytes: new TextEncoder().encode('%PDF-1.7 quotation'), mediaType: 'application/pdf' as const }
const PNG = { bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]), mediaType: 'image/png' as const }

const answer = (over: Partial<FixtureAnswer> = {}): FixtureAnswer => ({
  promptVersion: PROMPT_VERSIONS.QUOTATION_READ,
  model: SONNET,
  output: { docNo: 'QT-001', gross: '129684.00' },
  usage: { input: 1200, output: 80 },
  ...over,
})

describe('[BR-AI-09] prompts carry the version ai-config names (ADR-143)', () => {
  it('[BR-AI-09] every purpose has a prompt and its version equals PROMPT_VERSIONS', () => {
    expect(Object.keys(PROMPTS).sort()).toEqual([...AI_PURPOSES].sort())
    for (const purpose of AI_PURPOSES) {
      expect(PROMPTS[purpose].version, purpose).toBe(PROMPT_VERSIONS[purpose])
      expect(PROMPTS[purpose].version, purpose).toMatch(new RegExp(`^${purpose}@[1-9][0-9]*$`))
    }
  })

  it('[BR-AI-09] the model of each agent comes from its variable, then AI_MODEL_DEFAULT, then OQ-145', () => {
    expect(modelFor('DOCUMENT', {})).toBe(SONNET)
    expect(modelFor('INTAKE', {})).toBe('claude-haiku-5-5')
    expect(modelFor('DOA_DRAFTER', {})).toBe('claude-opus-5-5')
    expect(modelFor('INTAKE', { AI_MODEL_DEFAULT: 'claude-opus-5-5' })).toBe('claude-opus-5-5')
    expect(modelFor('INTAKE', { AI_MODEL_DEFAULT: 'claude-opus-5-5', AI_MODEL_INTAKE: SONNET })).toBe(SONNET)
    for (const agent of AI_AGENTS) expect(Object.hasOwn(MODEL_PRICES, modelFor(agent, {})), agent).toBe(true)
  })

  it('[BR-AI-11] production needs a REAL gate, every other environment a SYNTHETIC one, and a gate names one exact set', () => {
    expect(requiredGateTier('production')).toBe('REAL')
    for (const env of ['local', 'preview', 'staging']) expect(requiredGateTier(env)).toBe('SYNTHETIC')
    const gate = { agent: 'DOCUMENT', purpose: 'QUOTATION_READ', promptVersion: 'QUOTATION_READ@1', model: SONNET, tier: 'SYNTHETIC', report: 'r.md' } as const
    expect(isGated([gate], { ...gate })).toBe(true)
    expect(isGated([gate], { ...gate, model: 'claude-opus-5-5' })).toBe(false)
    expect(isGated([gate], { ...gate, promptVersion: 'QUOTATION_READ@2' })).toBe(false)
    expect(isGated([gate], { ...gate, tier: 'REAL' })).toBe(false)
    // Every gate in the code names a prompt that exists and a priced model
    for (const g of EVAL_GATES) {
      expect(PROMPTS[g.purpose].version === g.promptVersion || g.promptVersion.startsWith(`${g.purpose}@`), g.report).toBe(true)
      expect(Object.hasOwn(MODEL_PRICES, g.model), g.report).toBe(true)
    }
  })
})

describe('[BR-AI-11] fixture mode answers from recorded results without a key (ADR-142)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bcs-ai-fixtures-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('[BR-AI-11] keys a lone file by its sha256 and text by its normalized form', () => {
    expect(fixtureKey({ purpose: 'QUOTATION_READ', files: [PDF] })).toBe(
      `QUOTATION_READ/${createHash('sha256').update(PDF.bytes).digest('hex')}`,
    )
    expect(fixtureKey({ purpose: 'BRIEF', text: ' งบ  เหลือ\n\n น้อย ' })).toBe(fixtureKey({ purpose: 'BRIEF', text: 'งบ เหลือ น้อย' }))
    expect(normalizeText('a\t\tb ')).toBe('a b')
    expect(fixtureKey({ purpose: 'INTAKE', text: 'x', files: [PDF] })).not.toBe(fixtureKey({ purpose: 'INTAKE', files: [PDF] }))
    expect(fixtureKey({ purpose: 'INTAKE', files: [PDF, PNG] })).not.toBe(fixtureKey({ purpose: 'INTAKE', files: [PNG, PDF] }))
  })

  it('[BR-AI-11] returns a recorded answer from disk with its model and tokens', async () => {
    const key = fixtureKey({ purpose: 'QUOTATION_READ', files: [PDF] })
    mkdirSync(path.join(dir, 'QUOTATION_READ'), { recursive: true })
    writeFileSync(path.join(dir, `${key}.json`), JSON.stringify(answer()))
    const result = await createFixtureClient({ dir }).extract({ purpose: 'QUOTATION_READ', model: SONNET, schema: Schema, files: [PDF] })
    expect(result).toMatchObject({ ok: true, model: SONNET, promptVersion: 'QUOTATION_READ@1', output: { docNo: 'QT-001', gross: '129684.00' } })
    expect(result.usage).toEqual({ input: 1200, output: 80, cacheRead: 0, cacheWrite: 0 })
  })

  it('[BR-AI-11] fails without a recording, with a recording of another prompt, another model, a refusal or a bad shape', async () => {
    const key = fixtureKey({ purpose: 'QUOTATION_READ', files: [PNG] })
    const call = (a?: FixtureAnswer) =>
      createFixtureClient({ dir, answers: new Map(a ? [[key, a]] : []) }).extract({ purpose: 'QUOTATION_READ', model: SONNET, schema: Schema, files: [PNG] })
    expect(await call()).toMatchObject({ ok: false, errorCode: 'FIXTURE_MISSING' })
    expect(await call(answer({ promptVersion: 'QUOTATION_READ@0' }))).toMatchObject({ ok: false, errorCode: 'FIXTURE_MISSING' })
    expect(await call(answer({ model: 'claude-opus-5-5' }))).toMatchObject({ ok: false, errorCode: 'AI_MODEL_MISMATCH', model: 'claude-opus-5-5' })
    expect(await call(answer({ output: null }))).toMatchObject({ ok: false, errorCode: 'AI_REFUSED' })
    expect(await call(answer({ output: { docNo: 7 } }))).toMatchObject({ ok: false, errorCode: 'AI_OUTPUT_INVALID' })
  })

  it('[BR-AI-11] the process client follows AI_MODE and refuses to guess when it is not set', () => {
    expect(getAiClient({ AI_MODE: 'fixture' }).mode).toBe('fixture')
    expect(getAiClient({ AI_MODE: 'live', ANTHROPIC_API_KEY: 'sk-ant-test' }).mode).toBe('live')
    expect(() => getAiClient({})).toThrow(/AI_MODE/)
    expect(() => getAiClient({ AI_MODE: 'live' })).toThrow(/ANTHROPIC_API_KEY/)
  })
})

/** A stand-in for POST /v1/messages that records each request and answers with `reply` */
function fakeMessagesApi(reply: (body: Record<string, unknown>) => { status?: number; json: unknown }) {
  const calls: { body: Record<string, unknown>; headers: Headers; url: string }[] = []
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    calls.push({ body, headers: new Headers(init?.headers), url: String(input) })
    const r = reply(body)
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } })
  }) as typeof globalThis.fetch
  return { fetch, calls }
}

const message = (over: Record<string, unknown> = {}) => ({
  id: 'msg_test',
  type: 'message',
  role: 'assistant',
  model: SONNET,
  content: [{ type: 'text', text: JSON.stringify({ docNo: 'QT-001', gross: '129684.00' }) }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 900, output_tokens: 60, cache_creation_input_tokens: 300, cache_read_input_tokens: 0 },
  ...over,
})

describe('[BR-AI-11] live mode: structured outputs, no model fallback, and the model that answered (ADR-141)', () => {
  it('[BR-AI-11] sends output_config.format with the schema, no forced tool and no fallback of any kind', async () => {
    const api = fakeMessagesApi(() => ({ json: message() }))
    const client = createLiveClient({ apiKey: 'sk-ant-test', fetch: api.fetch })
    const result = await client.extract({ purpose: 'QUOTATION_READ', model: SONNET, schema: Schema, files: [PDF, PNG], text: 'ไฟล์ใบเสนอราคา' })
    expect(result).toMatchObject({ ok: true, model: SONNET, output: { docNo: 'QT-001', gross: '129684.00' } })
    expect(result.usage).toEqual({ input: 900, output: 60, cacheRead: 0, cacheWrite: 300 })

    expect(api.calls).toHaveLength(1)
    const { body, headers } = api.calls[0]!
    expect(body.model).toBe(SONNET)
    const outputConfig = body.output_config as { format?: { type: string; schema: unknown }; effort?: string }
    expect(outputConfig.format?.type).toBe('json_schema')
    expect(outputConfig.format?.schema).toMatchObject({ type: 'object', properties: { docNo: {}, gross: {} } })
    expect(outputConfig.effort).toBe('medium')
    expect(body).not.toHaveProperty('tool_choice')
    expect(body).not.toHaveProperty('tools')
    expect(body).not.toHaveProperty('fallbacks')
    expect(headers.get('anthropic-beta') ?? '').not.toMatch(/fallback/)
    // The fixed system prompt is cached (5-minute TTL), the document blocks come before the data
    expect(JSON.stringify(body.system)).toMatch(/"cache_control":\{"type":"ephemeral"\}/)
    expect(JSON.stringify(body.system)).not.toMatch(/"ttl"/)
    const content = (body.messages as { content: { type: string }[] }[])[0]!.content
    expect(content.map((b) => b.type)).toEqual(['document', 'image', 'text'])
  })

  it('[BR-AI-11] a response from another model fails with AI_MODEL_MISMATCH and keeps its tokens', async () => {
    const api = fakeMessagesApi(() => ({ json: message({ model: 'claude-opus-5-5' }) }))
    const result = await createLiveClient({ apiKey: 'sk-ant-test', fetch: api.fetch }).extract({ purpose: 'QUOTATION_READ', model: SONNET, schema: Schema, files: [PDF] })
    expect(result).toMatchObject({ ok: false, errorCode: 'AI_MODEL_MISMATCH', model: 'claude-opus-5-5' })
    expect(result.usage.output).toBe(60)
    expect(api.calls).toHaveLength(1)
  })

  it('[BR-AI-11] a refusal, a bad shape, a document over the limits and an API error each fail once, never on another model', async () => {
    const run = async (reply: { status?: number; json: unknown }) => {
      const api = fakeMessagesApi(() => reply)
      const result = await createLiveClient({ apiKey: 'sk-ant-test', fetch: api.fetch }).extract({ purpose: 'QUOTATION_READ', model: SONNET, schema: Schema, files: [PDF] })
      expect(new Set(api.calls.map((c) => c.body.model))).toEqual(new Set([SONNET]))
      return result
    }
    expect(await run({ json: message({ stop_reason: 'refusal', content: [{ type: 'text', text: '' }] }) })).toMatchObject({ ok: false, errorCode: 'AI_REFUSED' })
    expect(await run({ json: message({ content: [{ type: 'text', text: '{"docNo": 7}' }] }) })).toMatchObject({ ok: false, errorCode: 'AI_OUTPUT_INVALID' })
    const tooLong = { type: 'error', error: { type: 'invalid_request_error', message: 'A maximum of 600 PDF pages may be provided.' } }
    expect(await run({ status: 400, json: tooLong })).toMatchObject({ ok: false, errorCode: 'AI_FILE_TOO_LONG' })
    const denied = { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }
    expect(await run({ status: 401, json: denied })).toMatchObject({ ok: false, errorCode: 'EXTERNAL_SERVICE_ERROR' })
  })
})
