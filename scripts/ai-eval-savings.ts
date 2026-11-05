import path from 'node:path'
import { amountToSatang } from '../src/core/money/dto'
import type { SavingsItemDto, SavingsLineDto } from '../src/server/services/assistants/savings'
import { amountFactOf, savingsFacts, savingsNoteText, type SavingsFacts } from '../src/server/services/ai/agents/savings-facts'
import { INPUT_WORKBOOKS, loadInputWorkbook } from '../src/server/seed/workbook'
import { ROOT } from './lib/ai-eval-cases'

// The cases of the savings explanation for scripts/ai-eval.ts (NEW-136 · ADR-084 item 5 · BR-AI-11): 24 savings of the four kinds of §7.21,
// six each, drawn from the goods and agreed prices of the phase 1 workbook with figures worked in satang the way
// findSavings works them. Each case holds the saving as the page's DTO, so its facts and the text Claude reads come
// from the agent's own code (savings-facts.ts): the evaluation measures the call the page makes.

export interface SavingsCase {
  readonly id: string
  readonly item: SavingsItemDto
  readonly facts: SavingsFacts
  readonly text: string
  /** The fact the explanation must name through its placeholder: saving, or spent when an agreement only ends */
  readonly mustMention: 'saving' | 'spent'
}

/** Cases of each kind */
const PER_KIND = 6
const QTY = [10, 25, 40, 6, 120, 15, 60, 8] as const
const REASONS = ['ผู้ขายรายเดิมส่งของถึงหน้างานได้เร็วกว่า', null, 'ราคาตกลงไม่รวมค่าขนส่งถึงหน้างาน'] as const
const STAGES = ['PENDING_APPROVAL', 'POOL'] as const

type Row = Record<string, string | null>
const satang = (baht: string) => amountToSatang(baht)
/** A price times basis points, down to whole baht (the workbook's prices are whole baht) */
const pct = (s: bigint, bp: number) => ((s * BigInt(bp)) / 1_000_000n) * 100n
const name = (th: string) => ({ th, en: null })

export async function loadSavingsCases(): Promise<SavingsCase[]> {
  const wb = await loadInputWorkbook(path.join(ROOT, INPUT_WORKBOOKS.p1))
  const rows = (sheet: string) => wb.table(sheet).map((r) => r.values as Row)
  const goods = rows('Items').filter((i) => i.isService !== 'Y' && i.refUnitPrice)
  const agreed = goods.filter((i) => i.agreedUnitPrice && i.agreementSupplier)
  const suppliers = rows('Suppliers')
  const supplierName = new Map(suppliers.map((s) => [s.code!, s.nameTh!]))
  const sites = rows('Sites').map((s) => s.nameTh!)
  const departments = rows('Departments').map((d) => d.nameTh!)
  const pick = <T>(list: readonly T[], i: number) => list[(i * 7) % list.length]!
  let requestNo = 300
  const line = (i: number, description: string, uom: string, quantity: number, priceSatang: bigint, supplier: string | null): SavingsLineDto => ({
    request: { id: `eval-req-${requestNo}`, number: `PR-2569-${String(requestNo++).padStart(5, '0')}`, title: description, department: name(pick(departments, i)), stage: STAGES[i % 2]! },
    lineNo: 1 + (i % 3),
    description,
    uom,
    quantity: String(quantity),
    unitPriceSatang: String(priceSatang),
    supplier: supplier ? name(supplier) : null,
  })
  const agreement = (id: string, supplier: string, priceSatang: bigint, validTo: string) => ({ id, supplier: name(supplier), unitPriceSatang: String(priceSatang), validFrom: '2026-01-01', validTo })

  const items: SavingsItemDto[] = []
  for (let i = 0; i < PER_KIND; i++) {
    const it = pick(goods, i)
    const ref = satang(it.refUnitPrice!)
    const price = pct(ref, 11_500 + 500 * (i % 4))
    const qty = QTY[i]!
    items.push({
      kind: 'PRICE_ABOVE_HISTORY',
      key: `PRICE_ABOVE_HISTORY:eval-${i}`,
      savingSatang: String((price - ref) * BigInt(qty)),
      line: line(i, it.nameTh!, it.unit!, qty, price, pick(suppliers, i + 3).nameTh!),
      referenceSatang: String(ref),
      minSatang: String(pct(ref, 9_500)),
      maxSatang: String(pct(ref, 10_400)),
      deviationBp: Number(((price - ref) * 10_000n) / ref),
      count: 3 + (i % 5),
      purchases: [],
    })
  }
  for (let i = 0; i < PER_KIND; i++) {
    const it = pick(agreed, i)
    const low = satang(it.agreedUnitPrice!)
    const price = pct(low, 10_800 + 400 * (i % 3))
    const qty = QTY[i + 1]!
    const deals = [agreement(`eval-agr-${i}`, supplierName.get(it.agreementSupplier!) ?? it.agreementSupplier!, low, '2027-01-01')]
    if (i % 2 === 1) deals.push(agreement(`eval-agr-${i}-b`, pick(suppliers, i + 11).nameTh!, pct(low, 10_300), '2026-12-31'))
    items.push({
      kind: 'OFF_AGREEMENT',
      key: `OFF_AGREEMENT:eval-${i}`,
      savingSatang: String((price - low) * BigInt(qty)),
      line: line(i, it.nameTh!, it.unit!, qty, price, i === 4 ? null : pick(suppliers, i + 5).nameTh!),
      offAgreementReason: REASONS[i % 3]!,
      item: name(it.nameTh!),
      agreedSatang: String(low),
      agreementId: deals[0]!.id,
      agreements: deals,
    })
  }
  for (let i = 0; i < PER_KIND; i++) {
    const it = pick(goods, i + 2)
    const low = satang(it.refUnitPrice!)
    const count = 2 + (i % 3)
    const lines = Array.from({ length: count }, (_, j) => {
      const price = j === 0 ? low : pct(low, 10_000 + 600 * j + 200 * (i % 2))
      const qty = QTY[(i + j) % QTY.length]!
      return { ...line(i + j, it.nameTh!, it.unit!, qty, price, pick(suppliers, i + j).nameTh!), savingSatang: String((price - low) * BigInt(qty)), lowest: j === 0 }
    })
    items.push({
      kind: 'SAME_ITEM_DEPARTMENTS',
      key: `SAME_ITEM_DEPARTMENTS:eval-${i}`,
      savingSatang: String(lines.reduce((s, l) => s + BigInt(l.savingSatang), 0n)),
      description: it.nameTh!,
      uom: it.unit!,
      site: i % 3 === 2 ? null : name(pick(sites, i)),
      departments: Math.min(count, 2 + (i % 2)),
      lowestSatang: String(low),
      lines,
    })
  }
  for (let i = 0; i < PER_KIND; i++) {
    const it = pick(agreed, i + 3)
    const price = satang(it.agreedUnitPrice!)
    const count = 2 + (i % 5)
    const daysLeft = 7 + 4 * i
    const validTo = new Date(Date.UTC(2026, 10, 20 + daysLeft)).toISOString().slice(0, 10)
    items.push({
      kind: 'AGREEMENT_EXPIRING',
      key: `AGREEMENT_EXPIRING:eval-${i}`,
      savingSatang: null,
      item: name(it.nameTh!),
      agreement: agreement(`eval-exp-${i}`, supplierName.get(it.agreementSupplier!) ?? it.agreementSupplier!, price, validTo),
      daysLeft,
      spentSatang: String(price * BigInt(QTY[i]! * count)),
      count,
      purchases: [],
    })
  }
  return items.map((item, n) => {
    const facts = savingsFacts(item)
    return { id: `SAV-${String(n + 1).padStart(2, '0')}-${item.kind}`, item, facts, text: savingsNoteText(facts), mustMention: amountFactOf(item) }
  })
}
