import { readFileSync } from 'node:fs'
import path from 'node:path'
import { parse } from 'yaml'
import { amountToSatang, satangToAmount } from '../../src/core/money/dto'
import { briefInputText, doaDraftInputText, intakeInputText, questionInputText, type IntakeContext } from '../../src/lib/ai-schemas/agents'
import { INPUT_WORKBOOKS, loadInputWorkbook } from '../../src/server/seed/workbook'
import { ROOT } from './ai-eval-cases'

// The cases of the agents that do not read a document file on their own (S13-05, docs/sub-specs/S13.md "ชุดประเมิน"):
// Intake from the requests of Request_History in the requester's words (60) and with a quotation attached (10), the
// Approval Brief of 30 approval tasks with something to point out, Insight's 30 questions and 12 questions on access,
// and the DOA drafter's two synthetic regulations. Each case holds the exact text the agent sends.

export interface IntakeCase {
  readonly id: string
  readonly text: string
  /** A quotation the requester attached (an evaluation document id), read in the same call */
  readonly fileOf: string | null
  readonly expect: { readonly requestTypeCode: string; readonly lines: readonly { readonly itemCode: string; readonly qty: string; readonly unit: string }[] }
}

export interface BriefCase {
  readonly id: string
  readonly text: string
  readonly facts: Readonly<Record<string, string | number | boolean>>
  /** Fact keys the summary must mention through a placeholder */
  readonly mustMention: readonly string[]
}

export interface QuestionCase {
  readonly id: string
  readonly text: string
  readonly access: boolean
  readonly tools: readonly string[]
}

export interface DoaRuleTruth {
  readonly code: string
  readonly documentType: string
  readonly gt: string | null
  readonly lte: string | null
  readonly approverKind: 'POSITION_OF_DEPARTMENT' | 'POSITION_OF_ORG' | 'MEMBER'
  readonly approverPosition: string | null
  readonly sourceText: string
  readonly page: number
}

export interface DoaCase {
  readonly id: 'REG-A' | 'REG-B'
  readonly text: string
  readonly rules: readonly DoaRuleTruth[]
  /** What the lint of the import must find in the draft (BR-DOA-08): nothing in REG-A, a gap in REG-B */
  readonly lint: readonly string[]
}

export interface AgentCases {
  readonly intake: readonly IntakeCase[]
  readonly brief: readonly BriefCase[]
  readonly questions: readonly QuestionCase[]
  readonly doa: readonly DoaCase[]
}

/** Pattern of Request_History → the fact a Brief of that request must mention */
const PATTERN_FACT: Readonly<Record<string, string>> = {
  LOW_BUDGET: 'budget.remainingAfterBp',
  OVERDUE: 'sla.overdueHours',
  ESCALATED: 'route.escalatedFrom',
  DUPLICATE: 'flags.duplicate',
  SPLIT: 'flags.split',
  RENEWAL: 'contract.endsInDays',
  INACTIVE_SUPPLIER: 'supplier.inactive',
}
const SINGLE_QUOTE_FACT = 'quotes.single'

const amount = (v: string | null | undefined) => (v === null || v === undefined ? null : satangToAmount(amountToSatang(v)))
const bahtWords = (v: string) => satangToAmount(amountToSatang(v)).replace(/\.00$/, '').replace(/\B(?=(\d{3})+(?!\d))/g, ',')

/** One clause of the synthetic regulation for a DOA rule, as REG-A or REG-B words it */
export function regulationSentence(r: Readonly<Record<string, string | null>>, regB: boolean): string {
  const who = r.approverKind === 'POSITION_OF_ORG' ? `ตำแหน่ง ${r.approverPosition}` : `ตำแหน่ง ${r.approverPosition} ของหน่วยงานเจ้าของเรื่อง`
  const gt = r.gt ?? null
  const lte = r.lte ?? null
  let band: string
  if (gt === null) band = 'ทุกจำนวน'
  else if (regB && r.ruleCode === 'PR-02') band = `ตั้งแต่ ${bahtWords('20001')} บาท ถึง ${bahtWords(lte ?? '0')} บาท`
  else if (lte === null) band = `เกิน ${bahtWords(gt)} บาทขึ้นไป`
  else if (Number(gt) === 0) band = `ไม่เกิน ${bahtWords(lte)} บาท`
  else band = `เกิน ${bahtWords(gt)} บาท แต่ไม่เกิน ${bahtWords(lte)} บาท`
  return `ข้อ ${r.ruleCode} เอกสาร ${r.documentType} วงเงิน${band} ให้${who}เป็นผู้อนุมัติ`
}

/** Rules of the regulation per page: the first page holds the first 11 clauses */
export const REG_PAGE_SIZE = 11

export async function loadAgentCases(): Promise<AgentCases> {
  const wb = await loadInputWorkbook(path.join(ROOT, INPUT_WORKBOOKS.p1))
  const rows = (sheet: string) => wb.table(sheet).map((r) => r.values)
  const ctx: Omit<IntakeContext, 'message'> = {
    requestTypes: rows('RequestTypes').map((t) => ({ code: t.code!, name: t.nameTh! })),
    items: rows('Items').map((i) => ({ code: i.code!, name: i.nameTh!, unit: i.unit! })),
    sites: rows('Sites').map((s) => ({ code: s.code!, name: s.nameTh! })),
  }
  const history = rows('Request_History')
  const siteName = new Map(ctx.sites.map((s) => [s.code, s.name]))
  const where = (code: string | null | undefined) => siteName.get(code ?? '') ?? code ?? ''

  // Intake: every fourth request of the history in the requester's words, then ten quotations attached
  const typed = history
    .filter((_, i) => i % 4 === 0)
    .map(
      (h): IntakeCase => ({
        id: `INT-${h.ref}`,
        text: intakeInputText({ ...ctx, message: `${h.title} ส่งที่${where(h.site)} ต้องการภายใน ${7 + (Number(h.daysAgo) % 14)} วัน` }),
        fileOf: null,
        expect: { requestTypeCode: h.requestType!, lines: [{ itemCode: h.itemCode!, qty: h.qty!, unit: h.unit! }] },
      }),
    )
  const byRef = new Map(history.map((h) => [h.ref!, h]))
  const quoted = rows('DocSamples')
    .filter((v) => v.docType === 'QUOTATION' && v.historyRef && byRef.has(v.historyRef))
    .slice(0, 10)
    .map((v): IntakeCase => {
      const h = byRef.get(v.historyRef!)!
      return {
        id: `INT-Q-${v.sampleId}`,
        text: intakeInputText({ ...ctx, message: `ขอตามใบเสนอราคาที่แนบ ส่งที่${where(h.site)}` }),
        fileOf: v.sampleId!,
        expect: { requestTypeCode: h.requestType!, lines: [{ itemCode: h.itemCode!, qty: h.qty!, unit: h.unit! }] },
      }
    })

  // Brief: every request of the history with a pattern, then the large ones with a single quotation, to 30
  const flagged = history.filter((h) => h.pattern && h.pattern !== 'NORMAL')
  const single = history.filter((h) => h.pattern === 'NORMAL' && Number(h.gross) > 100000).slice(0, 30 - flagged.length)
  const brief = [...flagged, ...single].map((h): BriefCase => {
    const fact = PATTERN_FACT[h.pattern!] ?? SINGLE_QUOTE_FACT
    const value: string | number | boolean =
      h.pattern === 'LOW_BUDGET' ? 650 : h.pattern === 'OVERDUE' ? Number(h.hours ?? 12) : h.pattern === 'RENEWAL' ? Number(h.serviceEndInDays ?? 30) : h.pattern === 'ESCALATED' ? 'PR-02' : true
    const facts: Record<string, string | number | boolean> = {
      'request.number': `PR-2569-${h.ref!.slice(1).padStart(5, '0')}`,
      'request.title': h.title!,
      'route.amountGross': amount(h.gross)!,
      'route.rule': h.expectedRule!,
      'quotes.count': fact === SINGLE_QUOTE_FACT ? 1 : 3,
      [fact]: value,
    }
    return { id: `BRF-${h.ref}`, text: briefInputText(facts), facts, mustMention: [fact] }
  })

  const q = parse(readFileSync(path.join(ROOT, 'tests', 'fixtures', 'ai-eval', 'questions.yaml'), 'utf8')) as {
    questions: Array<{ id: string; text: string; tools: string[] }>
    access: Array<{ id: string; text: string; tools: string[] }>
  }
  const questions: QuestionCase[] = [
    ...q.questions.map((x) => ({ id: x.id, text: questionInputText(x.text), access: false, tools: x.tools })),
    ...q.access.map((x) => ({ id: x.id, text: questionInputText(x.text), access: true, tools: x.tools })),
  ]

  // DOA drafter: REG-A states DOA-SIMEC version 1 rule by rule; REG-B writes the second band of purchase requests from
  // 20,001 baht, which leaves 20,000.01–20,000.99 to nobody (DOA_LINT_GAP)
  const doaRows = rows('DOA')
  const text = doaDraftInputText({ documentTypes: [...new Set(doaRows.map((r) => r.documentType!))], positions: rows('Positions').map((p) => p.code!) })
  const ruleOf = (r: Record<string, string | null>, i: number, regB: boolean): DoaRuleTruth => ({
    code: r.ruleCode!,
    documentType: r.documentType!,
    gt: r.gt === null ? null : regB && r.ruleCode === 'PR-02' ? '20001.00' : amount(r.gt),
    lte: amount(r.lte),
    approverKind: r.approverKind as DoaRuleTruth['approverKind'],
    approverPosition: r.approverPosition ?? null,
    sourceText: regulationSentence(r, regB),
    page: i < REG_PAGE_SIZE ? 1 : 2,
  })
  const doa: DoaCase[] = [
    { id: 'REG-A', text, rules: doaRows.map((r, i) => ruleOf(r, i, false)), lint: [] },
    { id: 'REG-B', text, rules: doaRows.map((r, i) => ruleOf(r, i, true)), lint: ['DOA_LINT_GAP'] },
  ]
  return { intake: [...typed, ...quoted], brief, questions, doa }
}

/** The DOA rows of the workbook, for drawing the regulations */
export async function loadDoaRows(): Promise<Array<Record<string, string | null>>> {
  const wb = await loadInputWorkbook(path.join(ROOT, INPUT_WORKBOOKS.p1))
  return wb.table('DOA').map((r) => ({ ...r.values }))
}
