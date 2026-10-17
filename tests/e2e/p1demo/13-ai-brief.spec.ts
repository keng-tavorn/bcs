import { expect, test } from '../fixtures'
import { baht, th } from '../demo/support'
import { rowWith } from '../tasks-support'
import { s13 } from './ai-steps'
import { columnOf, countedOf, day, expectedOf, p1Sheet, satangOf, sceneOf, signInAs, userOf } from './support'

// Scene 13 of phase 1 (sheet Demo_Script_P1, area AI_BRIEF · S13 · FR-AI-301 · BR-AI-01 BR-AI-03 BR-AI-20 BR-AI-27): the
// approver of the request scene 12 sent (expectJson.requestOfScene) opens its task and sees the "สรุปจาก AI" box apart on
// the decision bar: "AI อาจผิดพลาด ตรวจกับเอกสาร", the sentences, and under them the facts the code builds for this reader
// now — the amount on the DOA's basis and its rule, the budget left after the request, the quotations, the supplier's POs,
// the hours left. Every value in a sentence is a placeholder the code fills in from those facts. The box has no button;
// the reason for a single supplier is in the request's details on the page, not in the box. The scene decides nothing.
// The e2e app has no Inngest: ./scripts/s13.ts plays the job ai-approval-brief with the row's sentences (the facts carry
// the real clock, so no recorded answer can match), then reads the Brief as the approver reads it. The facts the row
// leaves to the database (expectJson.factsFromDb, and the budget left, which depends on the fiscal year of the run date)
// are compared with what the database says beside them.

interface BriefPlayed {
  readonly taskId: string
  readonly number: string
  readonly requestStatus: string
  readonly result: string
  readonly action: { readonly status: string; readonly errorCode: string | null } | null
  readonly status: string
  readonly facts: ReadonlyArray<{ readonly key: string; readonly text: string }>
  readonly sentences: readonly string[] | null
  readonly db: { readonly budgetAvailable: string | null; readonly supplierPoCount: number; readonly supplierLastPoGross: string | null }
}
interface TaskFacts {
  readonly id: string
  readonly status: string
  readonly assignee: string
  readonly decision: string | null
}

/** The facts the box shows as money (src/app/_lib/brief-present.ts) */
const MONEY_FACTS = new Set(['amount', 'budgetRemaining', 'supplierLastPoAmount'])
/** A fact as the box writes it: money in baht, an enum in words, the rest as it is */
function shownValue(key: string, text: string): string {
  if (MONEY_FACTS.has(key)) return th('aiAssist.brief.values.baht', { amount: text })
  try {
    return th(`aiAssist.brief.values.${text}`)
  } catch {
    return text
  }
}

test('@p1demo [FR-AI-301/AC1] [FR-AI-301/AC2] [FR-AI-301/AC3] scene 13: the approver opens the backhoe task and sees the AI summary apart, every number from the system and no button to decide', async ({
  page,
}) => {
  test.setTimeout(5 * 60_000)
  const sheet = await p1Sheet()
  const scene = sceneOf(sheet, 13)
  const asked = sceneOf(sheet, expectedOf<number>(scene, 'requestOfScene'))
  const approver = userOf(sheet, scene.actor)
  expect([scene.expectedApprover, scene.expectedRule], `the approver of scene ${asked.scene}'s request opens its task`).toEqual([asked.expectedApprover, asked.expectedRule])
  expect(approver.code).toBe(scene.expectedApprover)
  const rowFacts = expectedOf<Record<string, string | number>>(scene, 'facts')
  // The facts the row writes are those of scene 12's row: its amount on the DOA's basis and its rule
  expect([satangOf(String(rowFacts.amount)), rowFacts.amountBasis, rowFacts.doaRule]).toEqual([countedOf(sheet, asked), sheet.doa.amountBasis, asked.expectedRule])

  // The job of the task (played): the row's sentences, then the Brief as the approver reads it
  const brief = s13<BriefPlayed>('brief', String(scene.scene))
  expect(brief.result, `the Brief was written (${JSON.stringify(brief.action)})`).toBe('DRAFT')
  expect(brief.status).toBe('READY')
  expect(brief.requestStatus).toBe('PENDING_APPROVAL')
  const facts = new Map(brief.facts.map((f) => [f.key, f.text]))
  for (const [key, value] of Object.entries(rowFacts)) {
    const text = key === 'amount' ? baht(satangOf(String(value))!) : String(value)
    expect(facts.get(key), `fact ${key}`).toBe(text)
  }
  // The facts of the database: the line's balance after the request (the fiscal year of today), the supplier's POs
  expect(brief.db.budgetAvailable, `${asked.budgetKey} has a balance`).not.toBeNull()
  expect(facts.get('budgetRemaining'), 'the budget left after the request').toBe(baht(BigInt(brief.db.budgetAvailable!)))
  for (const key of expectedOf<string[]>(scene, 'factsFromDb')) expect(facts.has(key), `fact ${key}`).toBe(true)
  expect(facts.get('supplierPoCount')).toBe(String(brief.db.supplierPoCount))
  expect(brief.db.supplierPoCount, `the POs of ${asked.supplier} the history made`).toBe(expectedOf<number>(scene, 'supplierPoCountFromHistory'))
  expect(facts.get('supplierLastPoAmount')).toBe(baht(BigInt(brief.db.supplierLastPoGross!)))
  const hoursLeft = Number(facts.get('slaHoursLeft'))
  expect(Number.isInteger(hoursLeft) && hoursLeft >= 0, 'hours left of the SLA').toBe(true)
  // AC2: every value in a sentence is a fact, filled in by the code
  const sentences = expectedOf<string[]>(scene, 'briefSentences').map((s) =>
    s.replace(/\{\{v:([^}]+)\}\}/g, (_, key: string) => {
      const value = facts.get(key)
      if (value === undefined) throw new Error(`sentence placeholder ${key} is not a fact of the Brief`)
      return value
    }),
  )
  expect(brief.sentences).toEqual(sentences)

  // The approver on the web: their tasks, the request of scene 12, the box on the decision bar
  await signInAs(page, sheet, approver.code)
  await page.goto('/tasks')
  const row = rowWith(page.getByRole('list', { name: th('tasks.listLabel') }), brief.number)
  await expect(row).toContainText(baht(columnOf(asked, 'gross')))
  await row.getByRole('link').click()
  await expect(page).toHaveURL(new RegExp(`/tasks/${brief.taskId}$`))
  const box = page.getByRole('region', { name: th('aiAssist.brief.title') })
  await expect(box.getByText(th('aiAssist.brief.note'), { exact: true })).toBeVisible()
  for (const sentence of sentences) await expect(box.getByText(sentence, { exact: true })).toBeVisible()
  // The facts as the box shows them, read now for this reader (the hours left may have turned over since the script)
  const labels = await box.locator('dt').allInnerTexts()
  const values = await box.locator('dd').allInnerTexts()
  const shown = new Map(labels.map((label, i) => [label.trim(), values[i]?.trim() ?? '']))
  for (const fact of brief.facts) {
    const label = th(`aiAssist.brief.facts.${fact.key}`)
    if (fact.key === 'slaHoursLeft') expect([fact.text, String(Number(fact.text) - 1)], label).toContain(shown.get(label))
    else expect(shown.get(label), label).toBe(shownValue(fact.key, fact.text))
  }
  // AC3: nothing in the box decides
  await expect(box.getByRole('button')).toHaveCount(expectedOf<number>(scene, 'boxButtons'))
  // The reason for a single supplier is the request's, outside the box
  const reason = expectedOf<string>(asked, 'singleSupplierReasonTh')
  expect(expectedOf<boolean>(scene, 'reasonOutsideBox')).toBe(true)
  await expect(page.getByText(reason, { exact: true }).filter({ visible: true }).first()).toBeVisible()
  await expect(box.getByText(reason)).toHaveCount(0)

  // The scene decides nothing: the task stays open with the approver
  expect(expectedOf<boolean>(scene, 'decide')).toBe(false)
  const request = day<{ status: string; tasks: TaskFacts[] }>('latest', asked.actor, String(columnOf(asked, 'net')))
  expect(request.status).toBe('PENDING_APPROVAL')
  expect(request.tasks.find((t) => t.id === brief.taskId)).toMatchObject({ status: 'OPEN', assignee: approver.code, decision: null })
})
