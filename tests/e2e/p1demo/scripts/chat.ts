import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { E2E_BASE_URL, E2E_DB } from '../../../support/e2e-env'

// Run by scene 15 of phase 1 (tests/e2e/p1demo/15-chat-request.spec.ts, through ../support.ts script()) against the p1demo
// e2e database only: what happens in the LINE chat and in the background jobs of asking through the chat (S17 · FR-LINE-301),
// on SIMEC of the phase-1 workbook (sheet Org). The scene's row of sheet Demo_Script_P1 names who writes, what they type
// (expectJson.chatText — Thai, so read here rather than passed as an argument) and the photo they send (docSample: its
// file in tests/fixtures/ai-docs/manifest.json). Every step goes through the app: signed webhooks as LINE sends them, the
// fake LINE server of the run, the jobs' own handlers (e2e has no Inngest). Prints JSON on its last line.
//   chat <scene>          the row's actor writes the row's text in the 1:1 chat of SIMEC's LINE account and sends the
//                         row's photo: a text event, the photo's content put on the fake LINE server, an image event; a
//                         chat draft of the member left OPEN by an aborted try is closed first ("ไม่ใช่คำขอ"), so the
//                         chat opens a draft of its own. Prints the draft, its counts and the account's replies
//   chat-jobs <intakeId>  job chat-intake-image for each photo still to fetch (fetchChatImage), then job chat-intake-ai
//                         (the Intake Agent reads the words and the stored photo; AI_MODE=fixture: tests/fixtures/ai/INTAKE),
//                         then that job once more as a retry of the same event would run it. Prints what each run gave,
//                         the readings of the draft (AgentAction rows) and the one it keeps, and the notices queued for
//                         the writer while the jobs ran (Notification rows: what notification-deliver would send)
//   ai-key <scene>        the name of the recorded answer that reading looks for, as the fixture client names it: SIMEC's
//                         types and sites as the agent lists them, the row's words and photo (a FIXTURE_MISSING aid)
//   send-unconfirmed <requestId>
//                         request.submit as the send of LIFF calls it — by the request's requester, on the LIFF channel —
//                         while values the AI filled still wait to be confirmed. Prints the refusal's code and count; a
//                         refused send writes nothing (its transaction is rolled back)
//   drafted <intakeId>    the chat draft once LIFF made the request of it: its status, the request (number, suggested
//                         supplier's code) and its chat_intake.drafted event (its channel, photos attached, AI-assisted)

const LINE_USER_ID = /^U[0-9a-f]{32}$/
/** The kinds of file the AI client takes (src/integrations/ai) */
const MEDIA_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'] as const
type MediaType = (typeof MEDIA_TYPES)[number]
const isMediaType = (value: string): value is MediaType => (MEDIA_TYPES as readonly string[]).includes(value)
const ROOT = path.resolve(import.meta.dirname, '../../../..')

async function main(mode: string | undefined, arg: string | undefined): Promise<unknown> {
  if (new URL(process.env.DATABASE_URL ?? 'postgresql://x/none').pathname !== `/${E2E_DB}`) throw new Error('the scene script of phase 1 runs in the e2e database only')
  if (process.env.E2E_P1DEMO !== '1') throw new Error('the scene script of phase 1 runs in p1demo mode only (E2E_P1DEMO=1)')
  const [{ systemClock }, { makeCtx }, { prisma }, { INPUT_WORKBOOKS, loadInputWorkbook }] = await Promise.all([
    import('@/lib/clock'),
    import('@/server/context'),
    import('@/server/db/client'),
    import('@/server/seed/workbook'),
  ])
  const workbook = await loadInputWorkbook(INPUT_WORKBOOKS.p1)
  const orgCode = workbook.keyValues('Org').get('code')?.value
  if (!orgCode) throw new Error('the Org sheet names no organization code')
  const org = await prisma.organization.findUniqueOrThrow({ where: { code: orgCode }, select: { id: true } })

  /** The scene's row: who writes, the words and the photo */
  async function rowOf(scene: string | undefined) {
    if (!scene || !/^\d{1,3}$/.test(scene)) throw new Error('give the scene number')
    const row = workbook.table('Demo_Script_P1').find((r) => r.values.scene === scene)
    if (!row) throw new Error(`Demo_Script_P1 has no scene ${scene}`)
    const actor = row.values.actor
    const sample = row.values.docSample
    const expectations = JSON.parse(row.values.expectJson ?? '{}') as { chatText?: unknown }
    if (!actor || !sample || typeof expectations.chatText !== 'string' || expectations.chatText.trim() === '') throw new Error(`Demo_Script_P1 row ${row.row}: actor, docSample and expectJson.chatText are needed`)
    const manifest = JSON.parse(await readFile(path.join(ROOT, 'tests/fixtures/ai-docs/manifest.json'), 'utf8')) as { files: Array<{ id: string; file: string; mediaType: string }> }
    const doc = manifest.files.find((f) => f.id === sample)
    if (!doc) throw new Error(`tests/fixtures/ai-docs/manifest.json has no ${sample}`)
    const mediaType = doc.mediaType
    if (!isMediaType(mediaType)) throw new Error(`${sample} is a ${mediaType}, not a kind of file the AI reads`)
    const photo = await readFile(path.join(ROOT, 'tests/fixtures/ai-docs', doc.file))
    return { actor, text: expectations.chatText, photo, mediaType }
  }

  async function memberOf(code: string) {
    const member = await prisma.member.findFirst({ where: { organizationId: org.id, employeeCode: code }, select: { id: true } })
    if (!member) throw new Error(`the organization ${orgCode} has no member ${code}`)
    return member
  }

  async function chat(scene: string | undefined) {
    const [{ dismissChatIntake }, { buildLineWebhook, lineEvents, lineMessageId, newReplyToken, postLineWebhook, signLineWebhook }] = await Promise.all([
      import('@/server/services/chat-intake'),
      import('../../../../scripts/line-simulate'),
    ])
    const row = await rowOf(scene)
    const member = await memberOf(row.actor)
    const linked = await prisma.channelIdentity.findFirst({ where: { organizationId: org.id, memberId: member.id, channel: 'LINE', unlinkedAt: null }, select: { externalUserId: true } })
    if (!linked || !LINE_USER_ID.test(linked.externalUserId)) throw new Error(`${row.actor} is not linked to a LINE account: prepare the phones first (day prepare)`)
    const lineUserId = linked.externalUserId
    const channel = await prisma.lineChannelConfig.findUniqueOrThrow({ where: { organizationId: org.id }, select: { channelKey: true } })
    const secret = process.env.LINE_MESSAGING_CHANNEL_SECRET
    if (!secret) throw new Error('LINE_MESSAGING_CHANNEL_SECRET is not set')
    /** One webhook as LINE sends it, signed with the channel secret of the run (the e2e test value), to SIMEC's channel */
    const send = async (event: ReturnType<typeof lineEvents.message>) => {
      const { body } = buildLineWebhook([event])
      const answer = await postLineWebhook(`${E2E_BASE_URL}/api/webhooks/line/${channel.channelKey}`, body, signLineWebhook(secret, body))
      if (answer.status !== 200) throw new Error(`the webhook answered ${answer.status}`)
    }
    // A draft an aborted try left open within the chat's window would take these messages too (a reading of other words):
    // closed as its owner would ("ไม่ใช่คำขอ")
    const ctx = makeCtx({ organizationId: org.id, actor: { type: 'USER', memberId: member.id }, channel: 'WEB', now: systemClock.now() })
    for (const open of await prisma.chatIntake.findMany({ where: { organizationId: org.id, memberId: member.id, status: 'OPEN' }, select: { id: true } })) {
      const dismissed = await dismissChatIntake(ctx, { intakeId: open.id }, { idempotencyKey: randomUUID(), sender: null })
      if (!dismissed.ok) throw new Error(`the open chat draft was not closed: ${dismissed.error.code}`)
    }
    const tokens = [newReplyToken(), newReplyToken()] as const
    await send(lineEvents.message({ userId: lineUserId, text: row.text, replyToken: tokens[0] }))
    const messageId = lineMessageId()
    const put = await fetch(`${process.env.LINE_API_BASE_URL}/__fake/content`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messageId, contentType: row.mediaType, base64: row.photo.toString('base64') }),
    })
    if (!put.ok) throw new Error(`the fake LINE server did not keep the photo: ${put.status}`)
    await send(lineEvents.image({ userId: lineUserId, messageId, replyToken: tokens[1] }))
    const intake = await prisma.chatIntake.findFirstOrThrow({
      where: { organizationId: org.id, memberId: member.id, status: 'OPEN' },
      select: { id: true, messageCount: true, imageCount: true },
      orderBy: { openedAt: 'desc' },
    })
    const sent = (await (await fetch(`${process.env.LINE_API_BASE_URL}/__fake/messages`)).json()) as { messages: Array<{ kind: string; replyToken: string | null; messages: unknown[] }> }
    const replies = tokens.map((token) => sent.messages.find((m) => m.kind === 'reply' && m.replyToken === token)?.messages ?? [])
    return { intakeId: intake.id, lineUserId, messageCount: intake.messageCount, imageCount: intake.imageCount, replies }
  }

  function idOf(value: string | undefined, what: string): string {
    if (!value || !/^[0-9a-f-]{36}$/.test(value)) throw new Error(`give the ${what} id`)
    return value
  }

  async function chatJobs(value: string | undefined) {
    const intakeId = idOf(value, 'chat draft')
    const [{ fetchChatImage, pendingChatImages }, { chatIntakeAiRun }] = await Promise.all([import('@/server/services/chat-intake'), import('@/server/jobs/chat-intake-ai')])
    const { memberId } = await prisma.chatIntake.findFirstOrThrow({ where: { organizationId: org.id, id: intakeId }, select: { memberId: true } })
    // Notices are written in the transaction of the command that gives them (src/server/notifications/create.ts): counted
    // here, not on the fake LINE server, as e2e has no Inngest to deliver them
    const notices = () => prisma.notification.count({ where: { organizationId: org.id, recipientMemberId: memberId } })
    const noticesBefore = await notices()
    const images: string[] = []
    for (const itemId of await pendingChatImages(org.id, intakeId)) images.push((await fetchChatImage(org.id, itemId, systemClock.now())).status)
    const event = { data: { organizationId: org.id, aggregateId: intakeId } }
    const ai = await chatIntakeAiRun(event, { run: (_id, fn) => fn() })
    const again = await chatIntakeAiRun(event, { run: (_id, fn) => fn() })
    const intake = await prisma.chatIntake.findFirstOrThrow({ where: { organizationId: org.id, id: intakeId }, select: { agentAction: { select: { id: true, status: true, errorCode: true } } } })
    const readings = await prisma.agentAction.count({ where: { organizationId: org.id, subjectType: 'CHAT_INTAKE', subjectId: intakeId } })
    return {
      images,
      ai,
      again,
      readings,
      kept: intake.agentAction?.id ?? null,
      action: intake.agentAction ? { status: intake.agentAction.status, errorCode: intake.agentAction.errorCode } : null,
      notices: (await notices()) - noticesBefore,
    }
  }

  async function sendUnconfirmed(value: string | undefined) {
    const requestId = idOf(value, 'request')
    const { submitRequest } = await import('@/server/services/requests')
    const { requesterMemberId } = await prisma.request.findFirstOrThrow({ where: { organizationId: org.id, id: requestId }, select: { requesterMemberId: true } })
    const ctx = makeCtx({ organizationId: org.id, actor: { type: 'USER', memberId: requesterMemberId }, channel: 'LIFF', now: systemClock.now() })
    const sent = await submitRequest(ctx, { requestId }, { idempotencyKey: randomUUID() })
    return sent.ok ? { code: null, count: null } : { code: sent.error.code, count: sent.error.details?.count ?? null }
  }

  /** What the Intake Agent is given for the row's chat, as runIntake builds it (src/server/services/ai/agents/intake.ts) */
  async function aiKey(scene: string | undefined) {
    const [{ forTenant }, { intakeInputText }, { fixtureKey }] = await Promise.all([import('@/server/db/tenant'), import('@/lib/ai-schemas/agents'), import('@/integrations/ai')])
    const row = await rowOf(scene)
    const db = forTenant(org.id)
    const types = await db.requestType.findMany({ where: { active: true, currentFormVersion: { status: 'PUBLISHED' } }, select: { code: true, nameTh: true, descriptionTh: true }, orderBy: { code: 'asc' } })
    const sites = await db.deliverySite.findMany({ where: { active: true }, select: { code: true, nameTh: true }, orderBy: { code: 'asc' } })
    const text = intakeInputText({ message: row.text, requestTypes: types.map((t) => ({ code: t.code, name: t.nameTh, description: t.descriptionTh })), items: [], sites: sites.map((s) => ({ code: s.code, name: s.nameTh })) })
    return { key: fixtureKey({ purpose: 'INTAKE', text, files: [{ bytes: new Uint8Array(row.photo), mediaType: row.mediaType }] }) }
  }

  async function drafted(value: string | undefined) {
    const intakeId = idOf(value, 'chat draft')
    const intake = await prisma.chatIntake.findFirstOrThrow({
      where: { organizationId: org.id, id: intakeId },
      select: { status: true, requestId: true, request: { select: { number: true, suggestedSupplier: { select: { code: true } } } } },
    })
    const event = await prisma.event.findFirst({ where: { organizationId: org.id, type: 'chat_intake.drafted', aggregateType: 'ChatIntake', aggregateId: intakeId }, select: { channel: true, data: true } })
    const data = (event?.data ?? null) as { images?: unknown; aiAssisted?: unknown } | null
    return {
      status: intake.status,
      requestId: intake.requestId,
      number: intake.request?.number ?? null,
      supplier: intake.request?.suggestedSupplier?.code ?? null,
      event: event ? { channel: event.channel, images: data?.images ?? null, aiAssisted: data?.aiAssisted ?? null } : null,
    }
  }

  try {
    switch (mode) {
      case 'chat':
        return await chat(arg)
      case 'chat-jobs':
        return await chatJobs(arg)
      case 'ai-key':
        return await aiKey(arg)
      case 'send-unconfirmed':
        return await sendUnconfirmed(arg)
      case 'drafted':
        return await drafted(arg)
      default:
        throw new Error(`unknown mode ${mode ?? '(none)'}: chat | chat-jobs | ai-key | send-unconfirmed | drafted`)
    }
  } finally {
    await prisma.$disconnect()
  }
}

const [mode, arg] = process.argv.slice(2)
console.log(JSON.stringify(await main(mode, arg)))
