import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createAnthropic } from '@ai-sdk/anthropic'
import { APICallError, generateText, NoObjectGeneratedError, NoOutputGeneratedError, Output, type FilePart, type LanguageModelUsage } from 'ai'
import type { z } from 'zod'
import { AGENT_OF_PURPOSE, EFFORT_OF_AGENT, MAX_OUTPUT_TOKENS, type AiPurposeName } from '@/lib/ai-config'
import { PROMPTS } from './prompts'
import { wireSchema } from './wire-schema'

// The one place that calls Claude (P-3, ADR-060, ADR-141, ADR-142). Two modes:
// - live: the Anthropic provider of the AI SDK with structured outputs through output_config.format (never a forced
//   tool, which current models refuse; nullable text travels as "" per ./wire-schema), no model fallback of any kind, and the model that really answered returned
//   so a different one fails the call (AI_MODEL_MISMATCH) — the evaluation gate is tied to the model.
// - fixture: answers recorded under tests/fixtures/ai/<purpose>/<sha256>.json (or handed in by a test), keyed by the
//   file or the normalized text; local and tests only (src/lib/env.ts refuses it elsewhere).
// The adapter knows nothing of tenants, permissions or credits: the services of src/server/services/ai/agents check
// those first and record the result in AgentAction.

export const AI_FILE_MEDIA_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'] as const
export type AiFileMediaType = (typeof AI_FILE_MEDIA_TYPES)[number]

export interface AiFile {
  readonly bytes: Uint8Array
  readonly mediaType: AiFileMediaType
}

export interface AiRequest<T> {
  readonly purpose: AiPurposeName
  /** The model the caller resolved with modelFor(); the answer must come from exactly this model */
  readonly model: string
  readonly schema: z.ZodType<T>
  /** Data for the model, sent inside <data> after the files; never part of the cached system prompt */
  readonly text?: string
  readonly files?: readonly AiFile[]
}

export interface AiUsage {
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite: number
}

/** AgentAction.errorCode of a failed call (docs/sub-specs/S13.md "รหัส error") */
export type AiCallErrorCode = 'AI_MODEL_MISMATCH' | 'AI_OUTPUT_INVALID' | 'AI_REFUSED' | 'AI_FILE_TOO_LONG' | 'FIXTURE_MISSING' | 'EXTERNAL_SERVICE_ERROR'

interface AiCallBase {
  readonly promptVersion: string
  /** The model that answered (absent when no answer came back) */
  readonly model?: string
  readonly usage: AiUsage
  readonly latencyMs: number
}
export type AiCallResult<T> = (AiCallBase & { readonly ok: true; readonly model: string; readonly output: T }) | (AiCallBase & { readonly ok: false; readonly errorCode: AiCallErrorCode })

export interface AiClient {
  readonly mode: 'fixture' | 'live'
  /** Reads files (and text) into the structure of `schema` */
  extract<T>(request: AiRequest<T>): Promise<AiCallResult<T>>
  /** Writes text (into the structure of `schema`) from data only */
  write<T>(request: Omit<AiRequest<T>, 'files'>): Promise<AiCallResult<T>>
}

export const NO_USAGE: AiUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

const sha256 = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex')

/** Text as the fixture key sees it: Unicode NFC, runs of white space as one space, trimmed */
export const normalizeText = (text: string) => text.normalize('NFC').replace(/\s+/g, ' ').trim()

/**
 * The fixture key of a request: `<purpose>/<sha256>` of the one file when a file comes alone (the sha256 the evaluation
 * manifest lists), else of the normalized text, else of the files' hashes and the text together.
 */
export function fixtureKey(request: Pick<AiRequest<unknown>, 'purpose' | 'text' | 'files'>): string {
  const files = request.files ?? []
  const text = request.text === undefined ? '' : normalizeText(request.text)
  let digest: string
  if (files.length === 1 && text === '') digest = sha256(files[0]!.bytes)
  else if (files.length === 0) digest = sha256(text)
  else digest = sha256(`${files.map((f) => sha256(f.bytes)).join(',')}|${text}`)
  return `${request.purpose}/${digest}`
}

/** A recorded answer (tests/fixtures/ai/<purpose>/<sha256>.json) */
export interface FixtureAnswer {
  readonly promptVersion: string
  readonly model: string
  /** The structured answer as the model returned it; null = the model refused */
  readonly output: unknown
  readonly usage?: Partial<AiUsage>
}

export interface FixtureOptions {
  /** Answers by fixtureKey(); found here first, then on disk */
  readonly answers?: ReadonlyMap<string, FixtureAnswer>
  /** Folder of the recorded answers; default tests/fixtures/ai under the working directory */
  readonly dir?: string
}

const usageOf = (u: Partial<AiUsage> | undefined): AiUsage => ({ ...NO_USAGE, ...u })

function readFixture(dir: string, key: string): FixtureAnswer | undefined {
  try {
    return JSON.parse(readFileSync(path.join(dir, `${key}.json`), 'utf8')) as FixtureAnswer
  } catch {
    return undefined
  }
}

export function createFixtureClient(options: FixtureOptions = {}): AiClient {
  const dir = options.dir ?? path.join(process.cwd(), 'tests', 'fixtures', 'ai')
  const run = async <T>(request: AiRequest<T>): Promise<AiCallResult<T>> => {
    const promptVersion = PROMPTS[request.purpose].version
    const key = fixtureKey(request)
    const answer = options.answers?.get(key) ?? readFixture(dir, key)
    // A recording of another prompt is stale: the answer would not be what this prompt gets (ADR-143)
    if (!answer || answer.promptVersion !== promptVersion) return { ok: false, errorCode: 'FIXTURE_MISSING', promptVersion, usage: NO_USAGE, latencyMs: 0 }
    const usage = usageOf(answer.usage)
    const base = { promptVersion, model: answer.model, usage, latencyMs: 0 }
    if (answer.model !== request.model) return { ...base, ok: false, errorCode: 'AI_MODEL_MISMATCH' }
    if (answer.output === null) return { ...base, ok: false, errorCode: 'AI_REFUSED' }
    const parsed = request.schema.safeParse(answer.output)
    if (!parsed.success) return { ...base, ok: false, errorCode: 'AI_OUTPUT_INVALID' }
    return { ...base, ok: true, output: parsed.data }
  }
  return { mode: 'fixture', extract: run, write: run }
}

export interface LiveOptions {
  readonly apiKey: string
  /** Tests hand in a fetch that answers like the Messages API; nothing else should */
  readonly fetch?: typeof globalThis.fetch
}

const usageFrom = (u: LanguageModelUsage | undefined): AiUsage => ({
  input: u?.inputTokenDetails?.noCacheTokens ?? Math.max(0, (u?.inputTokens ?? 0) - (u?.inputTokenDetails?.cacheReadTokens ?? 0) - (u?.inputTokenDetails?.cacheWriteTokens ?? 0)),
  output: u?.outputTokens ?? 0,
  cacheRead: u?.inputTokenDetails?.cacheReadTokens ?? 0,
  cacheWrite: u?.inputTokenDetails?.cacheWriteTokens ?? 0,
})

// The API's answer to a document over its page or token limits: the person fills the form instead (BR-AI-12)
const TOO_LONG = /too long|too many pages|maximum.{0,40}pages|exceeds.{0,40}(?:pages|context|tokens)/i

export function createLiveClient(options: LiveOptions): AiClient {
  // No `fallbacks` provider option and no fallback beta: a refused or failed call ends here (ADR-141)
  const anthropic = createAnthropic({ apiKey: options.apiKey, ...(options.fetch ? { fetch: options.fetch } : {}) })

  const run = async <T>(request: AiRequest<T>): Promise<AiCallResult<T>> => {
    const prompt = PROMPTS[request.purpose]
    const agent = AGENT_OF_PURPOSE[request.purpose]
    const started = performance.now()
    const latency = () => Math.round(performance.now() - started)
    const fail = (errorCode: AiCallErrorCode, model: string | undefined, usage: AiUsage): AiCallResult<T> => ({
      ok: false,
      errorCode,
      promptVersion: prompt.version,
      ...(model === undefined ? {} : { model }),
      usage,
      latencyMs: latency(),
    })
    // PDF goes as a document block, images as image blocks (the provider picks the block from the media type)
    const parts: (FilePart | { type: 'text'; text: string })[] = (request.files ?? []).map((f) => ({ type: 'file', data: f.bytes, mediaType: f.mediaType }))
    parts.push({ type: 'text', text: `<data>\n${request.text ?? ''}\n</data>` })

    try {
      const result = await generateText({
        model: anthropic(request.model),
        system: { role: 'system', content: prompt.system, providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } } },
        messages: [{ role: 'user', content: parts }],
        output: Output.object({ schema: await wireSchema(request.schema) }),
        maxOutputTokens: MAX_OUTPUT_TOKENS[agent],
        providerOptions: { anthropic: { structuredOutputMode: 'outputFormat', effort: EFFORT_OF_AGENT[agent] } },
      })
      const model = result.response.modelId
      const usage = usageFrom(result.usage)
      if (model !== request.model) return fail('AI_MODEL_MISMATCH', model, usage)
      if (result.finishReason === 'content-filter') return fail('AI_REFUSED', model, usage)
      let output: T
      try {
        output = result.output as T
      } catch {
        return fail('AI_OUTPUT_INVALID', model, usage)
      }
      const parsed = request.schema.safeParse(output)
      if (!parsed.success) return fail('AI_OUTPUT_INVALID', model, usage)
      return { ok: true, output: parsed.data, promptVersion: prompt.version, model, usage, latencyMs: latency() }
    } catch (error) {
      if (NoObjectGeneratedError.isInstance(error)) {
        const model = error.response?.modelId
        const usage = usageFrom(error.usage)
        if (model !== undefined && model !== request.model) return fail('AI_MODEL_MISMATCH', model, usage)
        return fail(error.finishReason === 'content-filter' ? 'AI_REFUSED' : 'AI_OUTPUT_INVALID', model, usage)
      }
      if (NoOutputGeneratedError.isInstance(error)) return fail('AI_OUTPUT_INVALID', undefined, NO_USAGE)
      if (APICallError.isInstance(error) && error.statusCode === 400 && TOO_LONG.test(error.responseBody ?? error.message)) {
        return fail('AI_FILE_TOO_LONG', undefined, NO_USAGE)
      }
      return fail('EXTERNAL_SERVICE_ERROR', undefined, NO_USAGE)
    }
  }
  return { mode: 'live', extract: run, write: run }
}

let override: AiClient | null = null

/** The client of the running process from AI_MODE (src/lib/env.ts has already refused live without a key) */
export function getAiClient(env: { AI_MODE?: 'fixture' | 'live' | undefined; ANTHROPIC_API_KEY?: string | undefined }): AiClient {
  if (override) return override
  if (env.AI_MODE === 'fixture') return createFixtureClient()
  if (env.AI_MODE === 'live' && env.ANTHROPIC_API_KEY) return createLiveClient({ apiKey: env.ANTHROPIC_API_KEY })
  throw new Error('AI_MODE is not set, or live without ANTHROPIC_API_KEY (src/lib/env.ts)')
}

/** Tests replace the client of the process (answers they hand in); null restores AI_MODE */
export function setAiClientForTests(client: AiClient | null): void {
  override = client
}
