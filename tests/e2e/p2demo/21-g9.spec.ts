import { exportedFile, sha256, sheetRows, shownChecksum } from '../insight-support'
import { p1Sheet, signInAs } from '../p1demo/support'
import { expect, test } from '../fixtures'
import { dayFromToday, p2Expected, p2SceneOf, p2Sheet, s11Status } from './support'

// Scene 21 of the day of phase 2 (S11-15 · S11-11 · BR-RSK-15 · KPI G-9 · GC-RSK-69 to 72 · docs/sub-specs/S11.md "Demo
// ของขั้น" 21): the actor opens /reports/risk for the row's period — from its first day to yesterday (DAY_BEFORE_DEMO),
// so the PO scene 16 sends today is not in it — and reads G-9 of the seed's history: the row's share (bp) of the HIGH
// suppliers whose first PO went out in the period, numerator and denominator, each supplier in the table with what it
// passed with (an assessment for those the row lists as assessed, an override for the others · BR-RSK-15). The rest of
// the report is as of now, not of the period: the suppliers by tier and the separate row "never assessed" are the row's
// (the seed's) moved by the assessments the scenes before this one completed today — the scene script lists them with
// the supplier's tier before (scene 16 makes SP0160 HIGH: one more HIGH, one fewer never assessed); the overrides are
// the seed's expired ones and those still open — one after scene 17 (its expectJson.override.expectedNo), none when that
// scene did not run. Scene 20's run of the daily job touches only its own supplier, so none of this moves with it. The
// Excel export downloads with the checksum the page shows, one row per supplier of G-9 with its source. When the PO of
// scene 16 went out today as its supplier's first, the same report up to today reads expectJson.afterScene16. The
// numbers come from the code, never from the AI.

const TIER_TH: Readonly<Record<string, string>> = { HIGH: 'สูง', MEDIUM: 'กลาง', LOW: 'ต่ำ', NONE: 'ไม่เคยประเมิน' }
const percent = (bp: number) => `${Math.trunc(bp / 100)}.${String(bp % 100).padStart(2, '0')}%`

interface ReportFacts {
  readonly today: string
  readonly completedToday: readonly { readonly code: string; readonly tier: string; readonly before: string | null }[]
  readonly newToday: number
  readonly firstHighToday: readonly string[]
  readonly overrides: readonly { readonly number: string; readonly status: string; readonly expiresOn: string }[]
}
interface G9 {
  readonly bp: number
  readonly numerator: number
  readonly denominator: number
}

test('@p2demo [FR-RSK-204/AC2] [FR-RSK-204/AC3] scene 21: G-9 of the seed is the row\'s share, with the suppliers by tier, the never-assessed row, the overrides, and an Excel export', async ({ page }) => {
  test.setTimeout(3 * 60_000)
  const [sheet, p1] = await Promise.all([p2Sheet(), p1Sheet()])
  const scene = p2SceneOf(sheet, 21)
  const period = p2Expected<{ from: string; to: string }>(scene, 'period')
  const g9 = p2Expected<G9 & { high: string[]; assessed: string[]; override: string[] }>(scene, 'g9')
  const overrides = p2Expected<{ expired: string[]; openAfterScene17: number }>(scene, 'overrides')
  expect(p2Expected<string>(scene, 'export')).toBe('XLSX')
  const to = period.to === 'DAY_BEFORE_DEMO' ? dayFromToday(-1) : period.to
  const facts = s11Status<ReportFacts>('report-facts')

  await signInAs(page, p1, scene.actor)
  await page.goto(`${p2Expected<string>(scene, 'route')}?from=${period.from}&to=${to}`)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('รายงานความเสี่ยงคู่ค้า')

  // G-9 of the period
  const shareOf = async (expected: G9) => {
    const figures = page.getByRole('region', { name: 'ผู้ขายความเสี่ยงสูงที่ประเมินครบก่อน PO แรก (G-9)' }).getByRole('definition')
    await expect(figures.nth(0)).toHaveText(percent(expected.bp))
    await expect(figures.nth(1)).toHaveText(`${expected.numerator} ราย`)
    await expect(figures.nth(2)).toHaveText(`${expected.denominator} ราย`)
  }
  await shareOf(g9)
  const counted = page.getByRole('table', { name: 'ผู้ขายความเสี่ยงสูงที่ PO แรกส่งในช่วงนี้ พร้อมสิ่งที่ใช้ผ่านด่าน' })
  await expect(counted.locator('tbody tr')).toHaveCount(g9.high.length)
  for (const code of g9.high) {
    const passedWith = g9.assessed.includes(code) ? 'ใบประเมินที่เสร็จแล้ว' : g9.override.includes(code) ? 'การอนุมัติข้าม' : null
    expect(passedWith, code).not.toBeNull()
    await expect(counted.locator('tbody tr').filter({ hasText: code })).toContainText(passedWith!)
  }

  // the suppliers by tier as of now: the seed's, moved by what the scenes completed today
  // (a supplier that joined today — scene 1 of S7 — is never assessed until its own assessment completes)
  const tiers: Record<string, number> = { ...p2Expected<Record<string, number>>(scene, 'tiers'), NONE: p2Expected<number>(scene, 'neverAssessed') + facts.newToday }
  for (const done of facts.completedToday) {
    const before = done.before ?? 'NONE'
    tiers[before] = (tiers[before] ?? 0) - 1
    tiers[done.tier] = (tiers[done.tier] ?? 0) + 1
  }
  const byTier = page.getByRole('table', { name: 'จำนวนผู้ขายต่อระดับความเสี่ยง' })
  for (const [tier, count] of Object.entries(tiers)) {
    const row = byTier.getByRole('row').filter({ has: page.getByRole('rowheader', { name: TIER_TH[tier]!, exact: true }) })
    await expect(row.getByRole('cell'), tier).toHaveText(String(count))
  }

  // the overrides: the seed's expired, and the one scene 17 had approved still open
  const fromScene17 = p2Expected<{ expectedNo: string }>(p2SceneOf(sheet, 17), 'override').expectedNo
  const open = facts.overrides.filter((o) => o.status === 'APPROVED' && o.expiresOn >= facts.today).map((o) => o.number)
  if (open.includes(fromScene17)) expect(open).toHaveLength(overrides.openAfterScene17)
  const overridePanel = page.getByRole('region', { name: 'การอนุมัติข้ามด่านความเสี่ยง' })
  await expect(overridePanel).toContainText(`เปิดอยู่ ${open.length} รายการ · หมดอายุ ${overrides.expired.length} รายการ`)
  const overrideTable = page.getByRole('table', { name: 'การอนุมัติข้ามที่อนุมัติแล้ว พร้อมยอดที่ใช้และผู้ขอ' })
  for (const number of overrides.expired) await expect(overrideTable.getByRole('row').filter({ has: page.getByRole('link', { name: number, exact: true }) })).toContainText('หมดอายุ')
  for (const number of open) await expect(overrideTable.getByRole('row').filter({ has: page.getByRole('link', { name: number, exact: true }) })).toContainText('เปิดอยู่')

  // Excel of the G-9 table, with the checksum the page shows
  const bytes = await exportedFile(page, 'ส่งออก Excel')
  expect(sha256(bytes)).toBe(await shownChecksum(page))
  const [header, ...rows] = await sheetRows(bytes, 8)
  expect(header![0]).toBe('รหัสผู้ขาย')
  expect(header![7]).toBe('รหัสที่มา')
  expect(rows.map((r) => r[0]).sort()).toEqual([...g9.high].sort())
  for (const r of rows) expect(r[7], r[0]).toBe(g9.assessed.includes(r[0]!) ? 'ASSESSMENT' : 'OVERRIDE')

  // up to today, once scene 16's PO went out as its supplier's first (the only one today at the HIGH gate)
  const scene16 = p2SceneOf(sheet, 16).supplier!
  if (facts.firstHighToday.length === 1 && facts.firstHighToday[0] === scene16) {
    await page.goto(`${p2Expected<string>(scene, 'route')}?from=${period.from}&to=${facts.today}`)
    await shareOf(p2Expected<G9>(scene, 'afterScene16'))
  }
})
