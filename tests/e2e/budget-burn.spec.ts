import { type Locator, type Page } from '@playwright/test'
import { expectNoBlockingAxe, expectNoSideways, scene, shot, signIn, startsWithAmount, type Figures, type Person } from './budgets-support'
import { expect, test } from './fixtures'

// S6-18 · FR-BUD-104 AC1 · BR-BUD-17 on the budget dashboard: each line, department and the total shows its used share
// of the current budget (the burn's, rounded down, two decimals) and the fiscal year's forecast at the pace so far — or
// that there is none yet and why — and a line past an alert threshold carries the badge of it, an icon with words. The
// scene (tests/e2e/budgets-scene.ts burn) builds a line of its own through the services: 10,000.00 with a sent PO of
// 9,000.00 and an invoice of 5,000.00, so 90.00 % is used; the forecast is worked out here from the fiscal year's days,
// today and the organization's settings, independently of the service.

interface BurnScene {
  readonly viewer: Person
  readonly line: { readonly id: string; readonly code: string; readonly name: string }
  readonly figures: Figures
  readonly year: { readonly startsOn: string; readonly endsOn: string }
  readonly today: string
  readonly thresholdsBp: readonly number[]
  readonly forecastMinElapsedDays: number
}

const MS_PER_DAY = 86_400_000
const BP_PER_WHOLE = 10_000n
/** The scene's line in satang: funded 10,000.00, committed 4,000.00 + actual 5,000.00 */
const FUNDED = 1_000_000n
const USED = 900_000n

const daysFrom = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / MS_PER_DAY)
/** Basis points as the page writes them: two decimals, nothing rounded again */
const pct = (bp: bigint) => `${bp / 100n}.${String(bp % 100n).padStart(2, '0')}`
const thresholdPct = (bp: number) => (bp % 100 === 0 ? String(bp / 100) : `${Math.floor(bp / 100)}.${String(bp % 100).padStart(2, '0').replace(/0$/, '')}`)

/** The block of one line on the dashboard: a table row on wide screens, a list item on phones */
function lineBlock(page: Page, wide: boolean, code: string): Locator {
  return wide ? page.getByRole('row').filter({ hasText: code }) : page.getByRole('listitem').filter({ has: page.getByRole('link', { name: code, exact: true }) })
}

/** A department's or the total's block */
function totalBlock(page: Page, wide: boolean, label: string): Locator {
  return wide ? page.getByRole('row').filter({ has: page.getByRole('rowheader', { name: label, exact: true }) }) : page.getByRole('region', { name: label, exact: true })
}

test('[FR-BUD-104/AC1] the dashboard shows each line’s used share and year forecast, and the badge of an alert reached, with the department and the total', async ({ page }, testInfo) => {
  // A scene of its own (a PO through approval, sending and an invoice), axe and a screenshot: longer than the default 30 s
  test.slow()
  const wide = testInfo.project.name === 'desktop'
  const s = scene<BurnScene>('burn', testInfo.project.name)
  expect(s.figures).toMatchObject({ planned: '10,000.00', committed: '4,000.00', actual: '5,000.00' })

  // What the page must say, worked out here (BR-BUD-17)
  const usedBp = (USED * BP_PER_WHOLE) / FUNDED
  const yearDays = daysFrom(s.year.startsOn, s.year.endsOn) + 1
  const elapsed = Math.min(Math.max(daysFrom(s.year.startsOn, s.today) + 1, 0), yearDays)
  const forecastBp = elapsed >= s.forecastMinElapsedDays ? (USED * BigInt(yearDays) * BP_PER_WHOLE) / (FUNDED * BigInt(elapsed)) : null
  const reached = s.thresholdsBp.filter((t) => BigInt(t) <= usedBp)
  expect(reached.length, 'the scene’s 90 % passes a threshold of the organization').toBeGreaterThan(0)
  const top = Math.max(...reached)

  await signIn(page, s.viewer.email, s.viewer.code)
  await page.goto('/budgets')
  await expect(page.getByRole('heading', { level: 1, name: 'งบประมาณ' })).toBeVisible()

  const line = lineBlock(page, wide, s.line.code)
  await expect(line.getByRole('link', { name: `งบปัจจุบัน ${s.figures.planned} บาท ของ ${s.line.code}: ดูการนำเข้างบ` })).toHaveText(startsWithAmount(s.figures.planned))
  // One used share, the burn's: 90.00 %, leading to the documents that hold and spend it
  await expect(line.getByRole('link', { name: `ใช้แล้ว ${pct(usedBp)}% ของ ${s.line.code}: ดูเอกสารที่ถือและตัดจ่ายจริง`, exact: true })).toHaveAttribute('href', `/budgets/${s.line.id}#committed`)
  expect((await line.innerText()).match(/ใช้แล้ว [\d.]+%/g)).toEqual([`ใช้แล้ว ${pct(usedBp)}%`])

  // The year's forecast, or that there is none yet and why
  if (forecastBp === null) {
    await expect(line).toContainText('พยากรณ์ทั้งปี: ยังไม่พยากรณ์')
    await expect(line).toContainText('ปีงบเพิ่งเริ่ม ข้อมูลยังน้อยเกินกว่าจะพยากรณ์ได้')
  } else {
    const forecast = line.getByRole('link', { name: `พยากรณ์ทั้งปี ${pct(forecastBp)}% ของ ${s.line.code}: ดูเอกสารที่ถือและตัดจ่ายจริง`, exact: true })
    await expect(forecast).toHaveText(`พยากรณ์ทั้งปี ${pct(forecastBp)}%`)
    await expect(forecast).toHaveAttribute('href', `/budgets/${s.line.id}#committed`)
  }

  // The alert reached as a badge: the gauge and the words, never colour alone (NFR-A11Y-03)
  const used = line.locator('[data-tone]').filter({ hasText: top >= 10_000 ? `ใช้ครบ ${thresholdPct(top)}%` : `ใช้ถึง ${thresholdPct(top)}%` })
  await expect(used).toHaveAttribute('data-tone', top >= 10_000 ? 'danger' : 'warn')
  await expect(used.locator('svg[data-icon="Gauge"]')).toHaveCount(1)
  const over = line.locator('[data-tone]').filter({ hasText: 'พยากรณ์เกินงบ' })
  if (forecastBp !== null && forecastBp > BP_PER_WHOLE) {
    await expect(over).toHaveAttribute('data-tone', 'warn')
    await expect(over.locator('svg[data-icon="TrendingUp"]')).toHaveCount(1)
  } else {
    await expect(over).toHaveCount(0)
  }

  // The department and the total show theirs too (their amounts move with other runs, so the form is checked)
  for (const label of ['รวมฝ่ายบัญชีและการเงิน', 'รวมทั้งองค์กร']) {
    const block = totalBlock(page, wide, label)
    await expect(block, label).toContainText(/ใช้แล้ว \d+\.\d{2}%/)
    await expect(block, label).toContainText(forecastBp === null ? 'พยากรณ์ทั้งปี: ยังไม่พยากรณ์' : /พยากรณ์ทั้งปี \d+\.\d{2}%/)
  }
  await expect(page.getByRole('region', { name: 'ความหมายของยอด' })).toContainText('พยากรณ์ทั้งปี = ใช้แล้ว ÷ จำนวนวันที่ผ่านไปของปีงบ × จำนวนวันทั้งปี')

  await expectNoSideways(page)
  await expectNoBlockingAxe(page)
  await line.scrollIntoViewIfNeeded()
  await shot(page, testInfo, `budget-burn-${wide ? 1440 : 375}`)
})
