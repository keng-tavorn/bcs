import { describe, expect, it } from 'vitest'
import { parseRiskReviewers, parseWorkflowReviewers } from '@/server/seed/workflow'
import type { InputWorkbook } from '@/server/seed/workbook'

// S11-06 (BR-RSK-07 · OQ-223): the seed reads sheet Risk_Reviewers (its rows come with S11-12) as the RISK_ASSESSMENT rules
// of version 1 of the organization's workflow, after the request rules of Workflow_Reviewers; a wrong row stops the seed
// with a Thai message naming it.

type Row = Record<string, string | null>
const book = (sheets: Record<string, Row[]>): InputWorkbook => ({
  hasSheet: (s) => s in sheets,
  table: (s) => (sheets[s] ?? []).map((values, i) => ({ row: i + 2, values })) as ReturnType<InputWorkbook['table']>,
  keyValues: () => new Map(),
})
const REQUEST: Row = { ruleCode: 'RV-01', requestType: 'IT_PURCHASE', whenJson: '{}', reviewerPosition: 'DM', reviewerDepartment: 'IT', fallbackPosition: 'VP', fallbackDepartment: 'SUP', mode: 'ALL', slaBusinessHours: '8', descriptionTh: null }
const RISK: Row = {
  ruleCode: 'RR-02',
  conditionTh: 'เข้าถึงระบบ',
  reviewerPosition: 'DM',
  reviewerDepartment: 'IT',
  fallbackPosition: 'VP',
  fallbackDepartment: 'SUP',
  riskDomains: 'INFOSEC',
  slaBusinessHours: '16',
  whenJson: '{"field":"accessesSystems","op":"eq","value":"Y"}',
  descriptionTh: null,
}

describe('[FR-RSK-202] [BR-RSK-07] the seed of the risk reviewers', () => {
  it('appends the RISK rules after the request rules of the same version', () => {
    const input = parseWorkflowReviewers(book({ Workflow_Reviewers: [REQUEST], Risk_Reviewers: [RISK, { ...RISK, ruleCode: 'RR-04', riskDomains: 'FINANCE, GENERAL', whenJson: '{"field":"$tier","op":"eq","value":"HIGH"}' }] }), 'SIMEC')!
    expect(input.code).toBe('WF-SIMEC')
    expect(input.rules.map((r) => [r.code, r.scope ?? 'REQUEST', r.requestTypeCodes, r.riskDomains ?? [], r.sortOrder, r.slaBusinessMinutes])).toEqual([
      ['RV-01', 'REQUEST', ['IT_PURCHASE'], [], 0, 480],
      ['RR-02', 'RISK_ASSESSMENT', [], ['INFOSEC'], 1, 960],
      ['RR-04', 'RISK_ASSESSMENT', [], ['FINANCE', 'GENERAL'], 2, 960],
    ])
    expect(input.rules[1]).toMatchObject({ mode: 'ALL', quorumCount: null, fallback: { kind: 'POSITION_AT', position: 'VP', department: 'SUP' }, descriptionTh: 'เข้าถึงระบบ' })
  })

  it('a workbook without the sheet keeps its request rules only; without Workflow_Reviewers there is no workflow', () => {
    expect(parseWorkflowReviewers(book({ Workflow_Reviewers: [REQUEST] }), 'SIMEC')!.rules.map((r) => r.code)).toEqual(['RV-01'])
    expect(parseRiskReviewers(book({}), 0)).toEqual([])
    expect(parseWorkflowReviewers(book({ Risk_Reviewers: [RISK] }), 'SIMEC')).toBeNull()
  })

  it('a row with no domain, an unknown domain, a bad condition or SLA stops the seed naming its row', () => {
    const fails = (over: Row) => () => parseRiskReviewers(book({ Risk_Reviewers: [RISK, { ...RISK, ...over }] }), 0)
    expect(fails({ riskDomains: null })).toThrow('ชีต Risk_Reviewers แถว 3: ช่อง riskDomains ว่าง')
    expect(fails({ riskDomains: 'INFOSEC LEGAL' })).toThrow('ชีต Risk_Reviewers แถว 3: riskDomains มีค่าที่ไม่รู้จัก LEGAL')
    expect(fails({ whenJson: '{"field":' })).toThrow('ชีต Risk_Reviewers แถว 3: whenJson อ่านเป็นเงื่อนไขไม่ได้')
    expect(fails({ slaBusinessHours: '0' })).toThrow('ชีต Risk_Reviewers แถว 3: slaBusinessHours ต้องเป็นจำนวนเต็มบวก')
  })
})
