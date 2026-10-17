import { expect, test } from '../fixtures'
import { baht, literally, th } from '../demo/support'
import { askBcsAi, bpText, s13 } from './ai-steps'
import { budgetLineOf, day, expectedOf, fiscalYearOf, p1Sheet, sceneOf, signInAs, todayInBangkok, userOf } from './support'

// Scene 14 of phase 1 (sheet Demo_Script_P1, area ASK_AI · S13 · FR-AI-307 FR-AI-309 · BR-AI-03 BR-AI-07): the row's actor
// asks BCS AI from the search (⌘K) the row's question; the Insight Agent names the tool that answers it (the recorded LIVE
// plan of exactly these words), the code runs it under the asker's rights, and the budget lines of this fiscal year come
// back ordered by what is left, the row's line first, below the organization's low mark, each with "เปิด" to its page.
// In AI_MODE=fixture the sentences of the second call cannot be recorded (they are keyed by the database's values), so
// the answer is the table of what the tool returned, "AI สรุปคำตอบนี้ไม่ได้ จึงแสดงข้อมูลจากระบบแทน" (expectJson
// fixtureKind; on the demo day with the real AI it is sentences, liveKind). A member without the budget pages asks the
// same and gets "ไม่พบข้อมูลในสิทธิ์ของคุณ". What is left on each line comes from the database on the day the scene runs
// (scene 6 spends on the row's line before), never from the sheet.

interface BudgetRow {
  readonly code: string
  readonly fiscalYear: string
  readonly planned: string
  readonly available: string
}
interface Asked {
  readonly status: string
  readonly tools: readonly string[] | null
  readonly kind: string | null
  readonly errorCode: string | null
}

/** A decimal written as text in units of 10^-places, with integer math ("0.1", 4 → 1000n; "10", 2 → 1000n) */
function decimalIn(text: string | undefined, places: number): bigint {
  const m = new RegExp(`^(\\d+)(?:\\.(\\d{1,${places}}))?$`).exec(text ?? '')
  if (!m) throw new Error(`not a decimal of at most ${places} places: ${text ?? '(empty)'}`)
  return BigInt(m[1]!) * 10n ** BigInt(places) + BigInt((m[2] ?? '').padEnd(places, '0'))
}

test('@p1demo [FR-AI-307/AC2] [FR-AI-307/AC4] [FR-AI-309/AC2] [FR-AI-309/AC3] scene 14: the CEO asks BCS AI which budget is running out and gets the lines from the system, the lowest first with its link; a member without budget rights gets nothing', async ({
  page,
}) => {
  test.setTimeout(5 * 60_000)
  const sheet = await p1Sheet()
  const scene = sceneOf(sheet, 14)
  const question = expectedOf<string>(scene, 'questionTh')
  const denied = userOf(sheet, expectedOf<string>(scene, 'deniedMember'))
  expect(scene.others, 'the member without budget rights is the other one who acts').toEqual([denied.code])
  // The low mark is the organization's (sheet Settings digest.budgetLowPct, a fraction) in percent, in bp without floats
  const lowPct = expectedOf<number>(scene, 'lowPct')
  const lowBp = decimalIn(sheet.settings.get('digest.budgetLowPct'), 4)
  expect(lowBp, `digest.budgetLowPct is ${lowPct}%`).toBe(decimalIn(String(lowPct), 2))

  // The lines of this fiscal year as the database has them now, ordered by what is left (rounded down, in bp)
  const fiscalYear = fiscalYearOf(todayInBangkok())
  const lines = day<BudgetRow[]>('budgets')
    .filter((l) => l.fiscalYear === fiscalYear && BigInt(l.planned) > 0n)
    .map((l) => ({ ...l, bp: Number((BigInt(l.available) * 10_000n) / BigInt(l.planned)), low: BigInt(l.available) * 10_000n < BigInt(l.planned) * lowBp }))
    .sort((a, b) => a.bp - b.bp)
  const first = budgetLineOf(sheet, expectedOf<string>(scene, 'firstRowKey'))
  expect(lines[0]?.code, `the line with the least left in ${fiscalYear}`).toBe(first.code)
  expect(lines[1]?.bp ?? Infinity, `${first.code} alone has the least left`).toBeGreaterThan(lines[0]!.bp)
  for (const key of expectedOf<string[]>(scene, 'expectedBudgetKeys')) {
    const code = budgetLineOf(sheet, key).code
    expect(lines.find((l) => l.code === code)?.low, `${code} is below ${lowPct}% left`).toBe(true)
  }
  const target = s13<{ id: string; code: string }>('line', first.code)
  expect(target.code).toBe(first.code)

  // The CEO asks from ⌘K: the tool's rows come back as the table, the lowest line first with its link (FR-AI-309 AC2 AC3)
  await signInAs(page, sheet, scene.actor)
  const answer = await askBcsAi(page, question)
  expect(expectedOf<string>(scene, 'fixtureKind')).toBe('TABLE')
  await expect(answer.getByText(th('aiAssist.ask.tableNote'), { exact: true })).toBeVisible({ timeout: 30_000 })
  const sources = answer.getByRole('region', { name: th('aiAssist.ask.sources') })
  const top = sources.getByRole('listitem').first()
  await expect(top).toContainText(`${th('aiAssist.ask.cells.code')} ${first.code}`)
  await expect(top).toContainText(`${th('aiAssist.ask.cells.remainingBp')} ${bpText(lines[0]!.bp)}`)
  await expect(top).toContainText(`${th('aiAssist.ask.cells.available')} ${baht(BigInt(lines[0]!.available))}`)
  const open = top.getByRole('link', { name: th('aiAssist.ask.open'), exact: true })
  const linkPrefix = expectedOf<string>(scene, 'linkPrefix')
  await expect(open).toHaveAttribute('href', `${linkPrefix}${target.id}`)
  // The question is an L0 action with the tools it used and the kind of answer it gave (FR-AI-307 AC5)
  expect(s13<Asked | null>('question', scene.actor)).toMatchObject({ status: 'DRAFT', tools: expectedOf<string[]>(scene, 'plannedTools'), kind: expectedOf<string>(scene, 'fixtureKind') })
  await open.click()
  await expect(page).toHaveURL(new RegExp(`${literally(linkPrefix)}${target.id}$`))
  await expect(page.getByText(first.code).filter({ visible: true }).first()).toBeVisible()

  // The same question by a member whose rights open no budget page: nothing from the system (FR-AI-307 AC4)
  await page.context().clearCookies()
  await signInAs(page, sheet, denied.code)
  const refused = await askBcsAi(page, question)
  await expect(refused.getByText(th('aiAssist.ask.notFound'), { exact: true })).toBeVisible({ timeout: 30_000 })
  await expect(refused.getByRole('region', { name: th('aiAssist.ask.sources') })).toHaveCount(0)
  await expect(refused.getByText(first.code)).toHaveCount(0)
  expect(s13<Asked | null>('question', denied.code)).toMatchObject({ status: 'DRAFT', tools: expectedOf<string[]>(scene, 'plannedTools'), kind: expectedOf<string>(scene, 'deniedKind') })
})
