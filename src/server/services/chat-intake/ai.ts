import { z } from 'zod'
import { err, ok, type Result } from '@/core/result'
import { AI_LIMITS } from '@/lib/ai-config'
import { CHAT_AI_READING_WINDOW_MS } from '@/lib/constants'
import { transition, CHAT_INTAKE_MACHINE } from '@/core/state-machines'
import { makeCtx, systemCtx, type Ctx } from '@/server/context'
import { forTenant } from '@/server/db/tenant'
import { defineCommand, runCommand, type CommandFailure, type CommandOutcome } from '../_pipeline'
import { getAgentAction, intakeFromMessage, isAgentAvailable } from '../ai'

// The AI part of asking through the chat (S17-08 · BR-LINE-13 · FR-LINE-301 AC5 AC6 · ADR-162). Job chat-intake-ai, never
// the webhook: once the chat draft's messages settle and none of its photos is still being fetched, the Intake Agent of S13
// reads what was typed and the stored photos through its public API (isAgentAvailable, intakeFromMessage), with the ctx
// of the draft's owner (channel LINE_CHAT), and the idempotency key chat_intake:<chatIntakeId>:<seq> of the latest item
// the call takes in. The same messages again (the job tried again) give the same AgentAction without calling the model;
// a new message, a new key. The id is linked in a step of its own (chat_intake.link_agent_action), so a retry of the link
// never calls again. Nothing is said in the chat when the reading ends (LIFF shows it). AI off, the agent off, no credits
// or a failed call: the chat and LIFF work on as without AI (EG-1 NG-5 · AC6).

/** The text cut to at most `max` UTF-16 units (what zod's max counts), never through a character */
function upTo(text: string, max: number): string {
  if (text.length <= max) return text
  let out = ''
  for (const ch of text) {
    if (out.length + ch.length > max) break
    out += ch
  }
  return out
}

export const CHAT_AI_JOB = 'chat-intake-ai'

export type ChatAiRead =
  | { readonly status: 'READ'; readonly agentActionId: string; readonly idempotencyKey: string }
  | { readonly status: 'SKIPPED'; readonly reason: string }

/** Codes another try may fix: the job throws and Inngest runs the step again */
const TRANSIENT: ReadonlySet<string> = new Set(['RATE_LIMITED', 'INTERNAL'])

/** One reading of a chat draft as it stands now (a step of job chat-intake-ai) */
export async function readChatIntakeWithAi(organizationId: string, intakeId: string, now: Date): Promise<ChatAiRead> {
  const intake = await forTenant(organizationId).chatIntake.findFirst({
    where: { id: intakeId },
    select: {
      status: true,
      purgedAt: true,
      text: true,
      memberId: true,
      member: { select: { status: true } },
      agentAction: { select: { idempotencyKey: true } },
      items: { select: { seq: true, kind: true, fetchStatus: true, fileId: true }, orderBy: { seq: 'asc' } },
    },
  })
  if (!intake || intake.status !== 'OPEN' || intake.purgedAt !== null) return { status: 'SKIPPED', reason: 'NOT_OPEN' }
  if (intake.member.status !== 'ACTIVE') return { status: 'SKIPPED', reason: 'MEMBER_INACTIVE' }
  // A photo still on its way: its image_fetched starts the next reading, with it
  if (intake.items.some((i) => i.kind === 'IMAGE' && i.fetchStatus === 'PENDING')) return { status: 'SKIPPED', reason: 'IMAGES_PENDING' }
  // What the Intake Agent takes at most (AI_LIMITS): a draft may hold more photos (bcsGo/chatIntake maxImages up to 10)
  // and 2,000 characters counted as LINE counts them, so the reading takes the first photos and the text cut to what
  // the agent takes, instead of being refused and never read
  const fileIds = intake.items.flatMap((i) => (i.fetchStatus === 'STORED' && i.fileId ? [i.fileId] : [])).slice(0, AI_LIMITS.intakeMaxFiles)
  const text = upTo(intake.text ?? '', AI_LIMITS.maxInputTextChars)
  if (!text.trim() && fileIds.length === 0) return { status: 'SKIPPED', reason: 'NOTHING_TO_READ' }
  const lastSeq = intake.items.at(-1)?.seq ?? 0
  const idempotencyKey = `chat_intake:${intakeId}:${lastSeq}`
  // The reading of these very messages is linked already: nothing to do
  if (intake.agentAction?.idempotencyKey === idempotencyKey) return { status: 'SKIPPED', reason: 'READ_ALREADY' }
  const ctx = makeCtx({ organizationId, actor: { type: 'USER', memberId: intake.memberId }, channel: 'LINE_CHAT', now })
  const available = await isAgentAvailable(ctx, 'INTAKE')
  if (!available.available) return { status: 'SKIPPED', reason: available.reason ?? 'AI_UNAVAILABLE' }
  const read = await intakeFromMessage(ctx, { chatIntakeId: intakeId, text, fileIds, idempotencyKey }, { idempotencyKey })
  if (!read.ok) {
    if (TRANSIENT.has(read.error.code)) throw new Error(`the chat draft's reading did not finish (${read.error.code}); the job tries again`)
    return { status: 'SKIPPED', reason: read.error.code }
  }
  return { status: 'READ', agentActionId: read.data.agentActionId, idempotencyKey }
}

const fail = (code: 'FORBIDDEN' | 'NOT_FOUND' | 'INVALID_STATE_TRANSITION' | 'VALIDATION_FAILED', message: string): CommandFailure => ({ ok: false, error: { code, message } })

/** chat_intake.link_agent_action: the system keeps the id of the latest reading of an OPEN draft */
export const linkChatIntakeAgentActionCommand = defineCommand({
  name: 'chat_intake.link_agent_action',
  capability: 'request.create',
  input: z.strictObject({ intakeId: z.uuid(), agentActionId: z.uuid() }),
  async execute(tx, input, ctx): Promise<CommandOutcome<{ agentActionId: string }>> {
    if (ctx.actor.type !== 'SYSTEM') return fail('FORBIDDEN', 'readings are linked by the system only')
    const intake = await tx.chatIntake.findFirst({ where: { id: input.intakeId }, select: { id: true, status: true } })
    if (!intake) return fail('NOT_FOUND', 'no such chat draft')
    if (!transition(CHAT_INTAKE_MACHINE, intake.status, 'chat_intake.link_agent_action').ok) return fail('INVALID_STATE_TRANSITION', `the chat draft is ${intake.status}`)
    // Only a reading of this very draft
    const action = await tx.agentAction.findFirst({ where: { id: input.agentActionId, subjectType: 'CHAT_INTAKE', subjectId: intake.id }, select: { id: true } })
    if (!action) return fail('VALIDATION_FAILED', 'the AI action is not a reading of this chat draft')
    // A newer message may have been read and linked first: an older reading never replaces it (ids are uuid v7, in order)
    const changed = await tx.chatIntake.updateMany({
      where: { id: intake.id, status: 'OPEN', OR: [{ agentActionId: null }, { agentActionId: { lt: action.id } }] },
      data: { agentActionId: action.id, version: { increment: 1 } },
    })
    if (changed.count === 0) return fail('INVALID_STATE_TRANSITION', 'a newer reading is linked already')
    return { ok: true, result: { agentActionId: action.id }, events: [{ type: 'chat_intake.ai_requested', aggregateType: 'ChatIntake', aggregateId: intake.id, data: { agentActionId: action.id } }] }
  },
})

/** The link step of the job: a newer reading linked already, or a draft closed meanwhile, is not an error */
export async function linkChatIntakeAgentAction(organizationId: string, intakeId: string, agentActionId: string, now: Date): Promise<'LINKED' | 'SKIPPED'> {
  const result = await runCommand(systemCtx(organizationId, now, CHAT_AI_JOB), linkChatIntakeAgentActionCommand, { intakeId, agentActionId }, { idempotencyKey: `${CHAT_AI_JOB}:link:${agentActionId}` })
  if (result.ok) return 'LINKED'
  if (TRANSIENT.has(result.error.code)) throw new Error(`linking the chat draft's reading did not finish (${result.error.code})`)
  return 'SKIPPED'
}

// ---------- what LIFF shows of the reading (S17-08 · BR-LINE-13) ----------

export interface ChatAiValue {
  /** The form path the value fills, as aiAssist names it (title, lines.0.quantity, deliverySiteId, …) */
  readonly path: string
  /** The value in words: a name for a site, a supplier or a type, as proposed otherwise */
  readonly text: string
  /** One of the paths confirmed one by one (BR-AI-16: money, quantities, tax id, branch, the type, low confidence) */
  readonly mustConfirm: boolean
}

export type ChatAiView =
  | { readonly status: 'NONE' }
  | { readonly status: 'READING' }
  | { readonly status: 'READY'; readonly agentActionId: string; readonly requestTypeCode: string | null; readonly values: readonly ChatAiValue[] }

export interface Review {
  readonly proposed: Readonly<Record<string, string>>
  readonly requiredPaths: readonly string[]
}

export const reviewOf = (value: unknown): Review | null => {
  if (!value || typeof value !== 'object') return null
  const r = value as { proposed?: unknown; requiredPaths?: unknown }
  if (!r.proposed || typeof r.proposed !== 'object' || !Array.isArray(r.requiredPaths)) return null
  return { proposed: r.proposed as Record<string, string>, requiredPaths: r.requiredPaths.filter((p): p is string => typeof p === 'string') }
}

/**
 * The reading of the member's own chat draft for its LIFF page (getAgentAction checks it is theirs): reading, ready with
 * its values in words, or nothing (no AI, the call failed, expired or was cleared). Anyone else's draft: NOT_FOUND.
 * Reading: the reading of the draft is under way (its action PENDING), or none is linked yet while the Intake Agent is
 * available to the owner, the draft has words or a photo to read and its last message came within
 * CHAT_AI_READING_WINDOW_MS — job chat-intake-ai links the reading only once the model has answered.
 */
export async function chatIntakeAiView(ctx: Ctx, intakeId: string, locale: 'th' | 'en'): Promise<Result<ChatAiView>> {
  if (ctx.actor.type !== 'USER' || !z.uuid().safeParse(intakeId).success) return err('NOT_FOUND', 'no such chat draft')
  const db = forTenant(ctx.organizationId)
  const intake = await db.chatIntake.findFirst({
    where: { id: intakeId, memberId: ctx.actor.memberId },
    select: { agentActionId: true, status: true, text: true, lastMessageAt: true, items: { where: { kind: 'IMAGE', fetchStatus: { in: ['PENDING', 'STORED'] } }, select: { id: true }, take: 1 } },
  })
  if (!intake) return err('NOT_FOUND', 'no such chat draft')
  if (intake.status !== 'OPEN') return ok({ status: 'NONE' })
  if (!intake.agentActionId) {
    const something = (intake.text ?? '').trim() !== '' || intake.items.length > 0
    const recent = ctx.now.getTime() - intake.lastMessageAt.getTime() < CHAT_AI_READING_WINDOW_MS
    return ok(something && recent && (await isAgentAvailable(ctx, 'INTAKE')).available ? { status: 'READING' } : { status: 'NONE' })
  }
  const action = await getAgentAction(ctx, intake.agentActionId)
  if (!action.ok || !action.data.content) return ok({ status: 'NONE' })
  if (action.data.status === 'PENDING') return ok({ status: 'READING' })
  const review = action.data.status === 'DRAFT' ? reviewOf(action.data.content.review) : null
  if (!review) return ok({ status: 'NONE' })
  const ids = (prefix: string) => Object.entries(review.proposed).flatMap(([p, v]) => (p === prefix ? [v] : []))
  const [sites, suppliers, types] = await Promise.all([
    db.deliverySite.findMany({ where: { id: { in: ids('deliverySiteId') } }, select: { id: true, nameTh: true } }),
    db.supplier.findMany({ where: { id: { in: ids('suggestedSupplierId') } }, select: { id: true, nameTh: true, nameEn: true } }),
    db.requestType.findMany({ where: { code: { in: ids('requestTypeCode') }, active: true }, select: { code: true, nameTh: true, nameEn: true } }),
  ])
  const named = (rows: ReadonlyArray<{ readonly nameTh: string; readonly nameEn?: string | null }>) => rows.map((r) => (locale === 'en' ? r.nameEn : null) ?? r.nameTh)[0]
  const required = new Set(review.requiredPaths)
  const values: ChatAiValue[] = []
  let requestTypeCode: string | null = null
  for (const [path, value] of Object.entries(review.proposed)) {
    if (path === 'requestTypeCode') {
      // Only a type the member can pick in the list
      if (types.some((t) => t.code === value)) requestTypeCode = value
      continue
    }
    const text =
      path === 'deliverySiteId'
        ? named(sites.filter((s) => s.id === value))
        : path === 'suggestedSupplierId'
          ? named(suppliers.filter((s) => s.id === value))
          : value
    if (text) values.push({ path, text, mustConfirm: required.has(path) })
  }
  return ok({ status: 'READY', agentActionId: action.data.id, requestTypeCode, values })
}
