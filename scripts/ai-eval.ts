import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { config } from 'dotenv'
import { z } from 'zod'
import { creditsForCall, fieldScore, matchField, normalizeAnswer, type AnswerLine } from '../src/core/ai-checks'
import { createFixtureClient, createLiveClient, fixtureKey, type AiCallResult, type AiClient, type AiFile, type AiRequest, type FixtureAnswer } from '../src/integrations/ai'
import { AGENT_OF_PURPOSE, DECISION_ADVICE_WORDS, EVAL_THRESHOLDS_BP, modelFor, priceOf, PROMPT_VERSIONS, type AiAgentName, type AiPurposeName } from '../src/lib/ai-config'
import { BriefText, DoaDraft, IntakeDraft, QuestionPlan } from '../src/lib/ai-schemas/agents'
import { DocumentReading, isCriticalField } from '../src/lib/ai-schemas/document'
import { loadAgentCases, type AgentCases } from './lib/ai-eval-agents'
import { AI_ANSWERS_DIR, AI_DOCS_DIR, loadEvalDocuments, ROOT, truthReading, type EvalDocument } from './lib/ai-eval-cases'

// `pnpm ai:eval` — the evaluation set of §12.4, demo tier (S13-05, BR-AI-26, OQ-141, ADR-143 ADR-146):
//   pnpm ai:eval [--agent document|intake|brief|insight|doa] [--purpose <purpose>] [--live] [--model <id>] [--record]
//                [--limit <n>] [--only <id,id>] [--save-answers] [--show-wrong]
// Without --live it plays the recorded answers of tests/fixtures/ai (no key, no cost) to test the scoring; --live calls
// Claude with ANTHROPIC_API_KEY from .env and costs money (S13-13 S13-14). --record writes the report under
// docs/reports/ai-eval/ (gates are added to src/lib/ai-config.ts by hand from a passing report). --write-answers writes
// the recorded answers of fixture mode from the truth of each case (what a perfect answer gives); --save-answers (with
// --live) keeps what Claude really answered as the recorded answers instead (S13-13 S13-14). --limit <n> runs only the
// first n cases of each group, to try a key or a prompt cheaply; a limited run never passes.

const AGENT_FLAG: Readonly<Record<string, AiAgentName>> = { document: 'DOCUMENT', intake: 'INTAKE', brief: 'APPROVAL_BRIEF', insight: 'INSIGHT', doa: 'DOA_DRAFTER' }

interface Args {
  agents: AiAgentName[]
  purpose: AiPurposeName | null
  live: boolean
  model: string | null
  record: boolean
  writeAnswers: boolean
  saveAnswers: boolean
  limit: number | null
  showWrong: boolean
  only: ReadonlySet<string> | null
}

function parseArgs(argv: readonly string[]): Args {
  const value = (flag: string) => {
    const i = argv.indexOf(flag)
    return i >= 0 ? (argv[i + 1] ?? null) : null
  }
  const agent = value('--agent')
  if (agent && !AGENT_FLAG[agent]) throw new Error(`--agent must be one of ${Object.keys(AGENT_FLAG).join(' ')}`)
  const purpose = value('--purpose') as AiPurposeName | null
  if (purpose && !Object.hasOwn(PROMPT_VERSIONS, purpose)) throw new Error(`--purpose ${purpose} is not a purpose of ai-config`)
  const limit = value('--limit')
  if (limit !== null && !/^[1-9]\d*$/.test(limit)) throw new Error('--limit must be a positive whole number')
  if (argv.includes('--save-answers') && !argv.includes('--live')) throw new Error('--save-answers keeps live answers: add --live')
  return {
    agents: agent ? [AGENT_FLAG[agent]!] : purpose ? [AGENT_OF_PURPOSE[purpose]] : Object.values(AGENT_FLAG),
    purpose,
    live: argv.includes('--live'),
    model: value('--model'),
    record: argv.includes('--record'),
    writeAnswers: argv.includes('--write-answers'),
    saveAnswers: argv.includes('--save-answers'),
    limit: limit === null ? null : Number(limit),
    showWrong: argv.includes('--show-wrong'),
    only: value('--only') === null ? null : new Set(value('--only')!.split(',')),
  }
}

/** One line of the report: a metric, its value in bp, its mark and whether it passed */
export interface Metric {
  readonly agent: AiAgentName
  readonly purpose: AiPurposeName
  readonly group: string
  readonly field: string
  readonly correct: number
  readonly total: number
  readonly missed: number
  readonly scoreBp: number
  readonly thresholdBp: number
  readonly pass: boolean
}

class Tally {
  private readonly map = new Map<string, { agent: AiAgentName; purpose: AiPurposeName; group: string; field: string; correct: number; total: number; missed: number; threshold: number; critical: boolean }>()
  add(agent: AiAgentName, purpose: AiPurposeName, group: string, field: string, ok: boolean, opts: { missed?: boolean; threshold: number; critical?: boolean }) {
    const key = `${purpose}|${group}|${field}`
    const t = this.map.get(key) ?? { agent, purpose, group, field, correct: 0, total: 0, missed: 0, threshold: opts.threshold, critical: Boolean(opts.critical) }
    t.total++
    if (ok) t.correct++
    else if (opts.missed) t.missed++
    this.map.set(key, t)
  }
  metrics(): Metric[] {
    return [...this.map.values()].map((t) => {
      const s = fieldScore({ correct: t.correct, total: t.total, thresholdBp: t.threshold, missed: t.missed, critical: t.critical })
      return { agent: t.agent, purpose: t.purpose, group: t.group, field: t.field, correct: t.correct, total: t.total, missed: t.missed, scoreBp: s.scoreBp, thresholdBp: t.threshold, pass: s.pass }
    })
  }
}

const docFile = (d: { id: string }, manifest: Map<string, { file: string; mediaType: string }>): AiFile => {
  const m = manifest.get(d.id)
  if (!m) throw new Error(`${d.id} has no file: run pnpm ai:docs`)
  return { bytes: readFileSync(path.join(AI_DOCS_DIR, m.file)), mediaType: m.mediaType as AiFile['mediaType'] }
}

const confidenceOf = (reading: { confidence: readonly { field: string; value: number }[] }, field: string) => reading.confidence.find((c) => c.field === field)?.value ?? 0
const get = (o: unknown, p: string): unknown => p.split('.').reduce<unknown>((x, k) => (x && typeof x === 'object' ? (x as Record<string, unknown>)[k] : undefined), o)

/** Tokens, credits and time of the calls of one purpose (BR-AI-23 prices from ai-config) */
interface Spend {
  calls: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  credits: number
  latencyMs: number
}

/** Windows may hold a file open for a moment (virus scan, indexer): a paid answer is worth a few retries */
function writeWithRetry(file: string, text: string, tries = 5) {
  for (let i = 1; ; i++) {
    try {
      writeFileSync(file, text)
      return
    } catch (error) {
      if (i >= tries) throw error
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300 * i)
    }
  }
}

/**
 * Wraps a client to add up what each purpose spent and, with --save-answers, to keep each live answer under
 * tests/fixtures/ai/<purpose>/<sha256>.json for fixture mode (the answer as Claude gave it, refusals as null).
 */
function metered(client: AiClient, spend: Map<AiPurposeName, Spend>, save: boolean): AiClient {
  const wrap =
    (call: <T>(r: AiRequest<T>) => Promise<AiCallResult<T>>) =>
    async <T>(request: AiRequest<T>): Promise<AiCallResult<T>> => {
      const r = await call(request)
      const s = spend.get(request.purpose) ?? { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, credits: 0, latencyMs: 0 }
      const price = priceOf(r.model ?? request.model)
      s.calls++
      s.input += r.usage.input
      s.output += r.usage.output
      s.cacheRead += r.usage.cacheRead
      s.cacheWrite += r.usage.cacheWrite
      s.credits += price ? creditsForCall(price, r.usage).credits : 0
      s.latencyMs += r.latencyMs
      spend.set(request.purpose, s)
      if (save && (r.ok || r.errorCode === 'AI_REFUSED')) {
        const answer: FixtureAnswer & { recorded: string } = {
          promptVersion: r.promptVersion,
          model: r.model!,
          recorded: 'LIVE',
          output: r.ok ? r.output : null,
          usage: r.usage,
        }
        const file = path.join(AI_ANSWERS_DIR, `${fixtureKey(request)}.json`)
        mkdirSync(path.dirname(file), { recursive: true })
        writeWithRetry(file, `${JSON.stringify(answer, null, 2)}
`)
      }
      return r
    }
  return { mode: client.mode, extract: wrap(client.extract.bind(client)), write: wrap(client.write.bind(client)) }
}

/** Everything one run measures, and the failures of calls */
interface Run {
  readonly tally: Tally
  readonly failures: string[]
  readonly documentsNeedingEdit: Map<string, { edited: number; total: number }>
  readonly spend: Map<AiPurposeName, Spend>
}

/** The cases a run takes: those --only names, then the first --limit of them */
let onlyIds: ReadonlySet<string> | null = null
const first = <T extends { id: string }>(cases: readonly T[], limit: number | null): readonly T[] => {
  const picked = onlyIds ? cases.filter((c) => onlyIds!.has(c.id)) : cases
  return limit === null ? picked : picked.slice(0, limit)
}

async function evalDocuments(run: Run, client: AiClient, model: (a: AiAgentName, p?: AiPurposeName) => string, docs: readonly EvalDocument[], args: Args, manifest: Map<string, { file: string; mediaType: string }>) {
  const purposes = [...new Set(docs.map((d) => d.purpose))].filter((p) => !args.purpose || p === args.purpose)
  for (const d of purposes.flatMap((p) => first(docs.filter((x) => x.purpose === p), args.limit))) {
    const r = await client.extract({ purpose: d.purpose, model: model('DOCUMENT', d.purpose), schema: DocumentReading, files: [docFile(d, manifest)] })
    const edits = run.documentsNeedingEdit.get(d.docType) ?? { edited: 0, total: 0 }
    edits.total++
    if (!r.ok) {
      run.failures.push(`${d.id} ${r.errorCode}`)
      edits.edited++
      run.documentsNeedingEdit.set(d.docType, edits)
      continue
    }
    const truth = truthReading(d)
    const priced = d.docType !== 'DELIVERY_NOTE'
    // Lines and discount compare after both moved their negative lines to the discount (BR-AI-14, BR-AI-26)
    const t = normalizeAnswer({ lines: truth.lines as AnswerLine[], discountTotal: truth.discountTotal })
    const a = normalizeAnswer({ lines: r.output.lines as AnswerLine[], discountTotal: r.output.discountTotal })
    const header = (o: unknown, n: { discountTotal: string | null }, field: string) => (field === 'discountTotal' ? n.discountTotal : get(o, field))
    let wrong = false
    const score = (field: string, expected: unknown, actual: unknown, conf: number) => {
      const ok = matchField(field, expected, actual)
      const critical = isCriticalField(d.docType, field)
      if (!ok) wrong = true
      if (!ok && args.showWrong) console.error(`wrong ${d.id} ${field}: expected ${JSON.stringify(expected)} read ${JSON.stringify(actual)} (${conf})`)
      run.tally.add('DOCUMENT', d.purpose, d.docType, field.replace(/^lines\.\d+\./, 'lines.*.'), ok, {
        missed: !ok && conf >= 90,
        threshold: critical ? EVAL_THRESHOLDS_BP.critical : EVAL_THRESHOLDS_BP.other,
        critical,
      })
    }
    for (const field of ['docNo', 'docDate', 'seller.taxId', 'seller.branch', 'buyer.taxId', ...(priced ? ['discountTotal', 'net', 'vat', 'gross'] : [])]) {
      score(field, header(truth, t, field), header(r.output, a, field), confidenceOf(r.output, field))
    }
    t.lines.forEach((line, i) => {
      const fields: readonly (keyof AnswerLine)[] = priced ? ['description', 'qty', 'unit', 'unitPrice', 'amount'] : ['description', 'qty', 'unit']
      for (const f of fields) {
        score(`lines.${i}.${f}`, line[f], a.lines[i]?.[f], confidenceOf(r.output, `lines.${i}.${f}`))
      }
    })
    if (wrong) edits.edited++
    run.documentsNeedingEdit.set(d.docType, edits)
  }
}

async function evalAgents(run: Run, client: AiClient, model: (a: AiAgentName) => string, cases: AgentCases, args: Args, manifest: Map<string, { file: string; mediaType: string }>) {
  if (args.agents.includes('INTAKE')) {
    for (const c of first(cases.intake, args.limit)) {
      const files = c.fileOf ? [docFile({ id: c.fileOf }, manifest)] : []
      const r = await client.extract({ purpose: 'INTAKE', model: model('INTAKE'), schema: IntakeDraft, text: c.text, files })
      if (!r.ok) {
        run.failures.push(`${c.id} ${r.errorCode}`)
        continue
      }
      const kind = c.fileOf ? 'WITH_QUOTATION' : 'TEXT'
      run.tally.add('INTAKE', 'INTAKE', kind, 'requestType', r.output.requestTypeCode === c.expect.requestTypeCode, { threshold: EVAL_THRESHOLDS_BP.intakeType })
      const line = r.output.lines[0]
      const want = c.expect.lines[0]!
      const ok = Boolean(line) && line!.itemCode === want.itemCode && matchField('qty', want.qty, line!.qty) && line!.unit === want.unit
      if (args.showWrong && (!ok || r.output.requestTypeCode !== c.expect.requestTypeCode))
        console.error(`wrong ${c.id}: expected ${JSON.stringify(c.expect)} read ${JSON.stringify({ requestTypeCode: r.output.requestTypeCode, lines: r.output.lines })}`)
      run.tally.add('INTAKE', 'INTAKE', kind, 'lines', ok, { threshold: EVAL_THRESHOLDS_BP.intakeLines })
    }
  }
  if (args.agents.includes('APPROVAL_BRIEF')) {
    for (const c of first(cases.brief, args.limit)) {
      const r = await client.write({ purpose: 'BRIEF', model: model('APPROVAL_BRIEF'), schema: BriefText, text: c.text })
      if (!r.ok) {
        run.failures.push(`${c.id} ${r.errorCode}`)
        continue
      }
      const all = r.output.sentences.join(' ')
      run.tally.add('APPROVAL_BRIEF', 'BRIEF', 'TASK', 'flags', c.mustMention.every((k) => all.includes(`{{v:${k}}}`)), { threshold: EVAL_THRESHOLDS_BP.briefFlags })
      const advice = DECISION_ADVICE_WORDS.some((w) => all.toLowerCase().includes(w.toLowerCase()))
      run.tally.add('APPROVAL_BRIEF', 'BRIEF', 'TASK', 'noDecisionAdvice', !advice, { threshold: 10_000, critical: true })
      // Digits only through placeholders; the text checker of S13-09 does the full check (BR-AI-27)
      const digits = r.output.sentences.some((s) => /[0-9๐-๙]/.test(s.replace(/\{\{v:[^}]+\}\}/g, '')))
      if (args.showWrong && (advice || digits || r.output.sentences.length > 4 || !c.mustMention.every((k) => all.includes(`{{v:${k}}}`))))
        console.error(`wrong ${c.id} must mention ${c.mustMention.join(',')}: ${JSON.stringify(r.output.sentences)}`)
      run.tally.add('APPROVAL_BRIEF', 'BRIEF', 'TASK', 'text', !digits && r.output.sentences.length <= 4, { threshold: EVAL_THRESHOLDS_BP.briefText })
    }
  }
  if (args.agents.includes('INSIGHT')) {
    for (const c of first(cases.questions, args.limit)) {
      const r = await client.write({ purpose: 'QUESTION', model: model('INSIGHT'), schema: QuestionPlan, text: c.text })
      if (!r.ok) {
        run.failures.push(`${c.id} ${r.errorCode}`)
        continue
      }
      const same = [...new Set(r.output.tools)].sort().join(',') === [...c.tools].sort().join(',')
      if (args.showWrong && !same) console.error(`wrong ${c.id}: expected ${c.tools.join(',')} chose ${r.output.tools.join(',')}`)
      run.tally.add('INSIGHT', 'QUESTION', c.access ? 'ACCESS' : 'QUESTION', 'tools', same, { threshold: EVAL_THRESHOLDS_BP.insightTools })
    }
  }
  if (args.agents.includes('DOA_DRAFTER')) {
    for (const c of first(cases.doa, args.limit)) {
      const r = await client.extract({ purpose: 'DOA_DRAFT', model: model('DOA_DRAFTER'), schema: DoaDraft, text: c.text, files: [docFile({ id: c.id }, manifest)] })
      if (!r.ok) {
        run.failures.push(`${c.id} ${r.errorCode}`)
        continue
      }
      for (const want of c.rules) {
        const got = r.output.rules.find((x) => x.code === want.code)
        const ok =
          Boolean(got) &&
          got!.documentType === want.documentType &&
          matchField('gt', want.gt, got!.gt) &&
          matchField('lte', want.lte, got!.lte) &&
          got!.approverKind === want.approverKind &&
          got!.approverPosition === want.approverPosition &&
          got!.page === want.page
        if (args.showWrong && !ok) console.error(`wrong ${c.id} ${want.code}: expected ${JSON.stringify(want)} read ${JSON.stringify(got ?? null)}`)
        run.tally.add('DOA_DRAFTER', 'DOA_DRAFT', c.id, 'rules', ok, { threshold: 10_000, critical: true })
      }
      // A gap between bands of purchase requests is what the import's lint reports for REG-B (BR-DOA-08)
      const pr = r.output.rules.filter((x) => x.documentType === 'PURCHASE_REQUEST' && x.gt !== null).sort((x, y) => Number(x.gt) - Number(y.gt))
      const gap = pr.some((x, i) => i > 0 && pr[i - 1]!.lte !== null && Number(x.gt) > Number(pr[i - 1]!.lte))
      run.tally.add('DOA_DRAFTER', 'DOA_DRAFT', c.id, 'lint', gap === c.lint.includes('DOA_LINT_GAP'), { threshold: 10_000, critical: true })
    }
  }
}

function report(metrics: readonly Metric[], run: Run, args: Args, models: Record<string, string>): string {
  const bp = (v: number) => `${(v / 100).toFixed(2)}%`
  const lines = [
    `# ผลชุดประเมิน AI ชั้น demo (${args.live ? 'live' : 'fixture'})`,
    '',
    `รุ่นโมเดล: ${Object.entries(models).map(([a, m]) => `${a} ${m}`).join(' · ')}`,
    `รุ่น prompt: ${Object.entries(PROMPT_VERSIONS).map(([, v]) => v).join(' · ')}`,
    '',
    '| agent | purpose | กลุ่ม | ฟิลด์ | ถูก/ทั้งหมด | หลุด | ความแม่น | เกณฑ์ | ผล |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...metrics.map((m) => `| ${m.agent} | ${m.purpose} | ${m.group} | ${m.field} | ${m.correct}/${m.total} | ${m.missed} | ${bp(m.scoreBp)} | ${bp(m.thresholdBp)} | ${m.pass ? 'ผ่าน' : 'ไม่ผ่าน'} |`),
    '',
    ...[...run.documentsNeedingEdit].map(([t, e]) => `- ${t}: เอกสารที่คนต้องแก้ ${e.edited}/${e.total}`),
    ...(run.failures.length ? ['', `การเรียกที่ล้ม ${run.failures.length}: ${run.failures.join(' · ')}`] : []),
    ...(args.limit === null ? [] : ['', `รันเฉพาะ ${args.limit} เคสแรกของแต่ละกลุ่ม (--limit) จึงไม่นับว่าผ่าน`]),
    '',
    '| purpose | การเรียก | input | output | cache อ่าน | cache เขียน | credits รวม | credits ต่อการเรียก | วินาทีต่อการเรียก |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...[...run.spend].map(
      ([p, s]) =>
        `| ${p} | ${s.calls} | ${s.input} | ${s.output} | ${s.cacheRead} | ${s.cacheWrite} | ${s.credits} | ${(s.credits / s.calls).toFixed(1)} | ${(s.latencyMs / s.calls / 1000).toFixed(1)} |`,
    ),
  ]
  return `${lines.join('\n')}\n`
}

async function writeAnswers(docs: readonly EvalDocument[], cases: AgentCases, manifest: Map<string, { file: string; mediaType: string }>) {
  const save = (purpose: AiPurposeName, key: string, output: unknown, model: string) => {
    const answer: FixtureAnswer & { recorded: string } = { promptVersion: PROMPT_VERSIONS[purpose], model, recorded: 'TRUTH', output, usage: { input: 1800, output: 420 } }
    const file = path.join(AI_ANSWERS_DIR, `${key}.json`)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify(answer, null, 2)}\n`)
  }
  const model = (a: AiAgentName, p?: AiPurposeName) => modelFor(a, {}, p)
  for (const d of docs) save(d.purpose, fixtureKey({ purpose: d.purpose, files: [docFile(d, manifest)] }), truthReading(d), model('DOCUMENT', d.purpose))
  for (const c of cases.intake) {
    const files = c.fileOf ? [docFile({ id: c.fileOf }, manifest)] : []
    const l = c.expect.lines[0]!
    const output: z.infer<typeof IntakeDraft> = {
      requestTypeCode: c.expect.requestTypeCode,
      title: null,
      siteCode: null,
      neededBy: null,
      lines: [{ description: null, itemCode: l.itemCode, qty: l.qty, unit: l.unit, unitPrice: null }],
      supplier: { name: null, taxId: null, branch: null },
      confidence: [{ field: 'requestTypeCode', value: 92 }],
    }
    save('INTAKE', fixtureKey({ purpose: 'INTAKE', text: c.text, files }), output, model('INTAKE'))
  }
  for (const c of cases.brief) {
    const sentences = ['คำขอ {{v:request.number}} ยอด {{v:route.amountGross}} บาท เข้าข้อ {{v:route.rule}}', `เรื่องที่ต้องดูประกอบ {{v:${c.mustMention[0]}}}`]
    save('BRIEF', fixtureKey({ purpose: 'BRIEF', text: c.text }), { sentences }, model('APPROVAL_BRIEF'))
  }
  for (const c of cases.questions) save('QUESTION', fixtureKey({ purpose: 'QUESTION', text: c.text }), { tools: c.tools, sentences: ['ผลอยู่ในตารางด้านล่าง'] }, model('INSIGHT'))
  for (const c of cases.doa) {
    save('DOA_DRAFT', fixtureKey({ purpose: 'DOA_DRAFT', text: c.text, files: [docFile({ id: c.id }, manifest)] }), { rules: c.rules }, model('DOA_DRAFTER'))
  }
}

async function main() {
  config({ path: path.join(ROOT, '.env'), quiet: true })
  const args = parseArgs(process.argv.slice(2))
  onlyIds = args.only
  const docs = await loadEvalDocuments()
  const cases = await loadAgentCases()
  const manifest = new Map(
    (JSON.parse(readFileSync(path.join(AI_DOCS_DIR, 'manifest.json'), 'utf8')) as { files: Array<{ id: string; file: string; mediaType: string }> }).files.map((f) => [f.id, f]),
  )
  if (args.writeAnswers) {
    await writeAnswers(docs, cases, manifest)
    console.log('ai:eval wrote the recorded answers of fixture mode from the truth of every case')
    return
  }
  const key = process.env.ANTHROPIC_API_KEY
  if (args.live && !key) {
    console.error('ai:eval --live needs ANTHROPIC_API_KEY in .env (the key of BCS, P0-13 · OQ-143)')
    process.exit(2)
  }
  const run: Run = { tally: new Tally(), failures: [], documentsNeedingEdit: new Map(), spend: new Map() }
  const client = metered(args.live ? createLiveClient({ apiKey: key! }) : createFixtureClient(), run.spend, args.saveAnswers)
  // Fixture mode plays answers recorded with the models of OQ-145; live mode asks the models the environment names
  const env = args.live ? { ...process.env } : {}
  const model = (a: AiAgentName, p?: AiPurposeName) => args.model ?? modelFor(a, env, p)
  if (args.agents.includes('DOCUMENT')) await evalDocuments(run, client, model, docs, args, manifest)
  await evalAgents(run, client, model, cases, args, manifest)
  const metrics = run.tally.metrics()
  const purposes = (Object.keys(PROMPT_VERSIONS) as AiPurposeName[]).filter((p) => args.agents.includes(AGENT_OF_PURPOSE[p]) && (!args.purpose || p === args.purpose))
  const models = Object.fromEntries(purposes.map((p) => [p, model(AGENT_OF_PURPOSE[p], p)]))
  const text = report(metrics, run, args, models)
  process.stdout.write(text)
  if (args.record) {
    const dir = path.join(ROOT, 'docs', 'reports', 'ai-eval')
    mkdirSync(dir, { recursive: true })
    const who = args.purpose ? args.purpose.toLowerCase() : args.agents.map((a) => a.toLowerCase()).join('-')
    const name = `${new Date().toISOString().slice(0, 10)}-${who}-${args.model ?? 'config'}-${args.live ? 'live' : 'fixture'}.md`
    writeFileSync(path.join(dir, name), text)
    console.log(`recorded docs/reports/ai-eval/${name}`)
  }
  const failed = metrics.some((m) => !m.pass) || run.failures.length > 0 || args.limit !== null
  process.exitCode = failed ? 1 : 0
}

void main()
