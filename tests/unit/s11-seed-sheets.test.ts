import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { OrgSettingsSchema, riskSettingsOf } from '@/lib/org-settings'
import { daysBefore, earliestAssessmentOpen, parseRiskSheets } from '@/server/seed/risk'
import { s11SettingsFromSheet } from '@/server/seed/settings-s11'
import { INPUT_WORKBOOKS, loadInputWorkbook, type InputWorkbook, type SheetRow } from '@/server/seed/workbook'

// S11-12 (docs/sub-specs/S11.md "การอ่านชีตของไฟล์ระยะ 1"): the supplier-risk rows of the phase-1 workbook as the seed
// reads them — the S11 keys of sheet Settings over the organization's settings, the sheets Risk_* with the draft values
// of SIMEC (OQ-221 to OQ-227), and a row that cannot be read stopping the seed with the sheet and row named. The rows
// played with the real commands and G-9 of the history are checked by `pnpm inputs:check` and `pnpm db:reset:p1`.

const demo = () => OrgSettingsSchema.parse(parseYaml(readFileSync('prisma/seed/org-settings.demo.yaml', 'utf8')))

function settingsSheet(rows: ReadonlyArray<readonly [key: string, value: string | null]>): InputWorkbook {
  const table: SheetRow[] = rows.map(([key, value], i) => ({ row: i + 3, values: { key, value } }))
  return {
    hasSheet: (sheet) => sheet === 'Settings',
    table: () => table,
    keyValues: () => new Map(table.map(({ row, values }) => [values.key!, { value: values.value ?? null, row }])),
  }
}

describe('[FR-RSK-201/AC1] S11-12 settings of the phase-1 workbook', () => {
  it('sets settings.risk and the numbering of RSA and RO from sheet Settings; the demo workbook keeps the defaults', async () => {
    const p1 = s11SettingsFromSheet(await loadInputWorkbook(INPUT_WORKBOOKS.p1), demo())
    expect(riskSettingsOf(p1)).toMatchObject({ overrideMaxDays: 90, aiAssist: true, portalAnswering: true, answerRetentionYears: 10 })
    expect([p1.numbering.RSA?.pattern, p1.numbering.RO?.pattern]).toEqual(['RSA-{BE}-{SEQ5}', 'RO-{BE}-{SEQ5}'])
    const base = demo()
    expect(s11SettingsFromSheet(await loadInputWorkbook(INPUT_WORKBOOKS.demo), base)).toBe(base)
  })

  it('names the row of a value it cannot read', () => {
    expect(() => s11SettingsFromSheet(settingsSheet([['risk.aiAssist', 'maybe']]), demo())).toThrow('ชีต Settings แถว 3 (risk.aiAssist)')
    expect(() => s11SettingsFromSheet(settingsSheet([['risk.overrideMaxDays', '9.5']]), demo())).toThrow('จำนวนเต็ม')
    expect(() => s11SettingsFromSheet(settingsSheet([['risk.overrideMaxDays', null]]), demo())).toThrow('ว่าง')
  })
})

describe('[FR-RSK-201/AC1] S11-12 risk sheets of the phase-1 workbook', () => {
  it('reads the tiers, policy, 12 questions, 20 assessments and 2 overrides; the demo workbook has none', async () => {
    const sheets = parseRiskSheets(await loadInputWorkbook(INPUT_WORKBOOKS.p1))!
    expect(sheets.tiers.map((t) => [t.code, t.minPoints, t.reviewMonths, t.blocksPo, t.requiresExplicitAnswers])).toEqual([
      ['LOW', 0, 36, false, false],
      ['MEDIUM', 20, 24, false, false],
      ['HIGH', 40, 12, true, true],
    ])
    expect(sheets.policy).toEqual({
      screeningTierMap: { processesPersonalData: 'HIGH', accessesSystems: 'MEDIUM', accessesPremises: 'MEDIUM' },
      highRiskCategories: ['PROF'],
      registryFlagBlocks: true,
      mediumOverdueBlocks: false,
      overrideChatButton: false,
    })
    expect(sheets.questions).toHaveLength(12)
    expect(sheets.questions.filter((q) => q.evidenceScopeRequired).map((q) => [q.code, q.evidenceScope])).toEqual([
      ['RQ-IS-01', 'ISO 27001'],
      ['RQ-PRM-02', 'ISO 45001'],
    ])
    expect(sheets.assessments).toHaveLength(20)
    expect(sheets.assessments.filter((a) => a.status === 'COMPLETED' && a.expectedTier === 'HIGH').map((a) => a.supplierCode).sort()).toEqual(['SP0132', 'SP0158', 'SP0159', 'SP0161', 'SP0162', 'SP0164', 'SP0165'])
    expect(sheets.overrides.map((o) => [o.ref, o.supplierCode, o.capGross, o.approver])).toEqual([
      ['RO-2569-00001', 'SP0141', '150000.00', 'coo'],
      ['RO-2569-00002', 'SP0179', '100000.00', 'coo'],
    ])
    expect(sheets.admins).toEqual(['admin', 'admin2'])
    expect(parseRiskSheets(await loadInputWorkbook(INPUT_WORKBOOKS.demo))).toBeNull()
  })

  it('opens the questionnaire from the first assessment of the history: SP0132 completed 2025-12-15, opened 14 days before', async () => {
    const sheets = parseRiskSheets(await loadInputWorkbook(INPUT_WORKBOOKS.p1))!
    const sp0132 = sheets.assessments.find((a) => a.supplierCode === 'SP0132')!
    expect([sp0132.completedOn, sp0132.reviewers]).toEqual(['2025-12-15', []])
    expect(earliestAssessmentOpen(sheets, '2026-11-13')).toBe('2025-12-01')
    expect(daysBefore('2026-03-01', 1)).toBe('2026-02-28')
  })

  it('names the sheet and row of a cell it cannot read', async () => {
    const p1 = await loadInputWorkbook(INPUT_WORKBOOKS.p1)
    const broken = (sheet: string, key: string, value: string | null): InputWorkbook => ({
      ...p1,
      table: (name) => (name === sheet ? p1.table(name).map((r, i) => (i === 0 ? { ...r, values: { ...r.values, [key]: value } } : r)) : p1.table(name)),
    })
    expect(() => parseRiskSheets(broken('Risk_Tiers', 'blocksPo', 'yes'))).toThrow('ชีต Risk_Tiers แถว 3 (blocksPo)')
    expect(() => parseRiskSheets(broken('Risk_Tiers', 'minPoints', '5'))).toThrow('LOW เริ่มที่ 0')
    expect(() => parseRiskSheets(broken('Risk_Policy', 'screeningTierMap', 'processesPersonalData:SEVERE'))).toThrow('ชีต Risk_Policy แถว 3 (screeningTierMap)')
    expect(() => parseRiskSheets(broken('Risk_Questionnaire', 'code', 'Q1'))).toThrow('ชีต Risk_Questionnaire แถว 3 (code)')
    expect(() => parseRiskSheets(broken('Risk_Questionnaire', 'optionsJson', '[{"code":"Y"}]'))).toThrow('ตัวเลือกใช้ไม่ได้')
    expect(() => parseRiskSheets(broken('Risk_Assessments', 'screeningJson', '{"processesPersonalData":"Y"}'))).toThrow('ชีต Risk_Assessments แถว 3 (screeningJson)')
    expect(() => parseRiskSheets(broken('Risk_Overrides', 'capGross', '0'))).toThrow('ชีต Risk_Overrides แถว 3 (capGross)')
  })
})
