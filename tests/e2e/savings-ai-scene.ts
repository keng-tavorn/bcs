import { randomUUID } from 'node:crypto'
import { setAiClientForTests, type AiClient } from '@/integrations/ai'
import { PROMPT_VERSIONS } from '@/lib/ai-config'
import { systemClock } from '@/lib/clock'
import { makeCtx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { explainSaving } from '@/server/services/ai'
import { savingsOpportunities } from '@/server/services/assistants/savings'
import { E2E_DB } from '../support/e2e-env'

// Run by tests/e2e/savings.spec.ts against the e2e database only (NEW-134 · FR-VIS-008 AC3): the explanation a member
// asks for, written through the same service the page's button calls (explainSaving) with an answer of the model made
// here, since the e2e app plays recorded answers only and the drill's title is new each run. The AI module and the
// Insight agent are switched on and off by tests/e2e/ai-document-scene.ts.
//   explain <memberCode> <requestNumber>   explains the member's saving "above past prices" of that request; prints it
if (new URL(process.env.DATABASE_URL ?? 'postgresql://x/none').pathname !== `/${E2E_DB}`) throw new Error('the savings AI scene runs in the e2e database only')
const [mode, code, number] = process.argv.slice(2)
if (mode !== 'explain' || !code || !number) throw new Error('usage: savings-ai-scene.ts explain <memberCode> <requestNumber>')

/** What the model answers: every value a placeholder of the saving's facts (BR-AI-27) */
const SENTENCES = ['คำขอ {{v:request}} ขอราคา {{v:price}} บาท สูงกว่าค่ากลาง {{v:reference}} บาท อยู่ {{v:deviation}}', 'ถ้าซื้อที่ค่ากลางจะถูกลง {{v:saving}} บาท']
const client: AiClient = {
  mode: 'fixture',
  extract: async () => {
    throw new Error('not used')
  },
  write: async (request) => ({ ok: true, promptVersion: PROMPT_VERSIONS[request.purpose], model: request.model, output: request.schema.parse({ sentences: SENTENCES }), usage: { input: 600, output: 80, cacheRead: 0, cacheWrite: 0 }, latencyMs: 900 }),
}
setAiClientForTests(client)

const org = await prisma.organization.findFirstOrThrow({ where: { code: 'DEMO' }, select: { id: true } })
const member = await prisma.member.findFirstOrThrow({ where: { organizationId: org.id, employeeCode: code }, select: { id: true } })
const ctx = makeCtx({ organizationId: org.id, actor: { type: 'USER', memberId: member.id }, channel: 'WEB', now: systemClock.now() })
const list = await savingsOpportunities(ctx)
if (!list.ok) throw new Error(JSON.stringify(list.error))
const item = list.data.items.find((i) => i.kind === 'PRICE_ABOVE_HISTORY' && i.line.request.number === number)
if (!item) throw new Error(`no saving above past prices for ${number} in ${code}'s list`)
const note = await explainSaving(ctx, { key: item.key }, { idempotencyKey: randomUUID() })
if (!note.ok) throw new Error(JSON.stringify(note.error))
console.log(JSON.stringify({ status: note.data.status, sentences: note.data.sentences }))
await prisma.$disconnect()
