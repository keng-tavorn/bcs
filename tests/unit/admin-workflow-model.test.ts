import { describe, expect, it } from 'vitest'
import {
  changedParts,
  checkRule,
  codesOf,
  conditionDraftOf,
  conditionOf,
  documentDraftOf,
  documentOf,
  fieldKind,
  hoursText,
  isDirty,
  moveRule,
  nextRuleCode,
  normalizeBaht,
  putRule,
  ruleDraftOf,
  ruleIndexOf,
  rowError,
  saveInput,
  slaMinutesOf,
  type ConditionValue,
  type RuleDraft,
  type RuleValue,
} from '@/ui/admin-workflow/model'

// S6-06 (FR-WF-103 AC1 AC2, BR-WF-07 BR-WF-11): the workflow editor's model — a condition of §7.9 with anyIn as rows
// and back, a rule's form checked as the lint and the service will, the order of the rules moved with buttons (NG-4),
// a document of the dry-run or of a test case with money as baht, and what the save sends.

const POS = (position: string, department: string) => ({ kind: 'POSITION_AT' as const, position, department })
const kindOf = (field: string) => fieldKind(field, field === 'processesPersonalData' ? { options: ['Y', 'N'] } : undefined)
const RV = (code: string, over: Partial<RuleValue> = {}): RuleValue => ({
  code,
  requestTypeCodes: ['BUY_GOODS'],
  when: { field: '$lineCategories', op: 'anyIn', value: ['SAFETY', 'FUEL'] },
  reviewers: [POS('DM', 'QSE')],
  fallback: POS('VP', 'OPS'),
  mode: 'ALL',
  quorumCount: null,
  slaMinutes: 480,
  descriptionTh: null,
  ...over,
})
const rules = [RV('RV-01'), RV('RV-02', { requestTypeCodes: ['CONTRACT_WORK'], when: { field: '$amountGross', op: 'gt', value: '1000000.00' } })]

describe('[FR-WF-103/AC1] a condition as rows (BR-WF-07)', () => {
  it('reads every shape the rows can show and writes the same condition back', () => {
    const shapes: ConditionValue[] = [
      {},
      { field: '$amountGross', op: 'gt', value: '1000000.00' },
      { all: [{ field: '$budgetAccountCodes', op: 'anyIn', value: ['121101', '121201'] }, { field: '$amountGross', op: 'gt', value: '500000.00' }] },
      { any: [{ field: 'processesPersonalData', op: 'eq', value: 'Y' }, { field: '$requestType', op: 'in', value: ['HIRE_SERVICE', 'IT_PURCHASE'] }] },
      { field: 'singleSourceJustification', op: 'notEmpty' },
    ]
    for (const when of shapes) expect(conditionOf(conditionDraftOf(when), kindOf), JSON.stringify(when)).toEqual(when)
  })

  it('keeps a condition with groups inside groups as it is', () => {
    const nested: ConditionValue = { all: [{ any: [{ field: '$amountGross', op: 'gt', value: '1.00' }] }, { field: '$requestType', op: 'eq', value: 'BUY_GOODS' }] }
    const draft = conditionDraftOf(nested)
    expect(draft).toEqual({ join: 'all', rows: [], nested })
    expect(conditionOf(draft, kindOf)).toBe(nested)
  })

  it('money is written as baht with two decimals; each kind of field takes its own operators and values', () => {
    expect(conditionOf({ join: 'all', rows: [{ field: '$amountGross', op: 'gte', value: '1,000,000', values: [] }], nested: null }, kindOf)).toEqual({ field: '$amountGross', op: 'gte', value: '1000000.00' })
    expect(rowError({ field: '', op: '', value: '', values: [] }, kindOf)).toBe('FIELD')
    expect(rowError({ field: '$lineCategories', op: 'gt', value: '1', values: [] }, kindOf)).toBe('OP')
    expect(rowError({ field: '$lineCategories', op: 'anyIn', value: '', values: [] }, kindOf)).toBe('VALUES')
    expect(rowError({ field: '$amountGross', op: 'gt', value: '1.555', values: [] }, kindOf)).toBe('MONEY')
    expect(rowError({ field: 'processesPersonalData', op: 'eq', value: '', values: [] }, kindOf)).toBe('VALUE')
    expect(rowError({ field: 'processesPersonalData', op: 'empty', value: '', values: [] }, kindOf)).toBeNull()
    expect([kindOf('$amountNet'), kindOf('$requestType'), kindOf('$budgetAccountCodes'), kindOf('processesPersonalData'), kindOf('site')]).toEqual(['money', 'requestType', 'set', 'choice', 'text'])
  })

  it('reads baht and codes as typed', () => {
    expect([normalizeBaht('2,642,900'), normalizeBaht('0.5'), normalizeBaht('007'), normalizeBaht('1.234'), normalizeBaht('abc')]).toEqual(['2642900.00', '0.50', '7.00', null, null])
    expect(codesOf(' SAFETY, FUEL  SAFETY,,')).toEqual(['SAFETY', 'FUEL'])
  })
})

describe('[FR-WF-103/AC1] a rule as its form (BR-WF-11)', () => {
  it('opens a rule as it is and saves it unchanged', () => {
    const draft = ruleDraftOf(rules[1]!, rules, '8')
    expect(draft).toMatchObject({ code: 'RV-02', slaHours: '8', quorumCount: '', mode: 'ALL' })
    const check = checkRule(draft, rules, 'RV-02', kindOf, 720)
    expect(check).toEqual({ ok: true, rule: rules[1] })
    expect(changedParts(rules[1], check.ok ? check.rule : rules[1]!)).toEqual([])
  })

  it('a new rule takes the next free code and an empty reviewer to fill', () => {
    const draft = ruleDraftOf(null, rules, '8')
    expect(draft).toMatchObject({ code: 'RV-03', requestTypeCodes: [], reviewers: [{ kind: 'POSITION_AT', position: '', department: '' }], fallback: null })
    expect(nextRuleCode([])).toBe('RV-01')
  })

  it('refuses what the lint or the service would, field by field', () => {
    const base: RuleDraft = { ...ruleDraftOf(null, rules, '8'), requestTypeCodes: ['BUY_GOODS'], reviewers: [POS('DM', 'FIN')] }
    expect(checkRule(base, rules, null, kindOf, 720).ok).toBe(true)
    const errors = (d: Partial<RuleDraft>) => {
      const c = checkRule({ ...base, ...d }, rules, null, kindOf, 720)
      return c.ok ? {} : c.errors
    }
    expect(errors({ code: 'rv 3' })).toEqual({ code: 'CODE' })
    expect(errors({ code: 'RV-01' })).toEqual({ code: 'DUPLICATE' })
    expect(errors({ requestTypeCodes: [] })).toEqual({ requestTypes: 'REQUIRED' })
    expect(errors({ reviewers: [POS('DM', '')] })).toEqual({ reviewers: 'INCOMPLETE' })
    expect(errors({ reviewers: [POS('DM', 'FIN'), POS('DM', 'QSE')] })).toEqual({ reviewers: 'ONE_REVIEWER' })
    expect(errors({ mode: 'COUNT', quorumCount: '1' })).toEqual({ reviewers: 'TWO_REVIEWERS' })
    for (const quorumCount of ['0', '3', 'two', '']) expect(errors({ mode: 'COUNT', reviewers: [POS('DM', 'FIN'), POS('DM', 'QSE')], quorumCount }), quorumCount).toEqual({ quorumCount: 'QUORUM' })
    expect(errors({ fallback: POS('', 'OPS') })).toEqual({ fallback: 'INCOMPLETE' })
    for (const slaHours of ['0', '-1', 'abc', '721']) expect(errors({ slaHours }), slaHours).toEqual({ slaHours: 'SLA' })
    expect(errors({ descriptionTh: 'ก'.repeat(501) })).toEqual({ descriptionTh: 'TOO_LONG' })
    const rowsWrong = checkRule({ ...base, condition: { join: 'all', rows: [{ field: '$amountGross', op: 'gt', value: 'x', values: [] }], nested: null } }, rules, null, kindOf, 720)
    expect(rowsWrong).toEqual({ ok: false, errors: { condition: 'ROWS' }, rowErrors: { 0: 'MONEY' } })
  })

  it('a COUNT rule keeps its count; the SLA is read in hours', () => {
    const draft: RuleDraft = { ...ruleDraftOf(null, rules, '8'), requestTypeCodes: ['IT_PURCHASE'], mode: 'COUNT', quorumCount: '2', reviewers: [POS('DM', 'FIN'), POS('DM', 'PROC'), POS('DM', 'QSE')], slaHours: '7.5' }
    const check = checkRule(draft, rules, null, kindOf, 720)
    expect(check.ok && check.rule).toMatchObject({ code: 'RV-03', mode: 'COUNT', quorumCount: 2, slaMinutes: 450, when: {} })
    expect([hoursText(480), hoursText(450), slaMinutesOf('16', 720), slaMinutesOf('0.01', 720)]).toEqual(['8', '7.5', 960, 1])
  })

  it('moves rules with buttons, puts a rule in place or at the end, and knows what changed', () => {
    expect(moveRule(rules, 'RV-02', -1).map((r) => r.code)).toEqual(['RV-02', 'RV-01'])
    expect(moveRule(rules, 'RV-01', -1).map((r) => r.code)).toEqual(['RV-01', 'RV-02'])
    expect(putRule(rules, RV('RV-03'), null).map((r) => r.code)).toEqual(['RV-01', 'RV-02', 'RV-03'])
    const edited = RV('RV-01', { slaMinutes: 960, fallback: null })
    expect(putRule(rules, edited, 'RV-01')[0]).toBe(edited)
    expect(changedParts(rules[0], edited)).toEqual(['fallback', 'sla'])
    const saved = { rules, testCases: [], effectiveDate: '2026-11-01' }
    expect(isDirty(saved, { ...saved })).toBe(false)
    expect(isDirty(saved, { ...saved, rules: moveRule(rules, 'RV-02', -1) })).toBe(true)
    expect(isDirty(saved, { ...saved, effectiveDate: '2026-12-01' })).toBe(true)
  })
})

describe('[FR-WF-103/AC2] a document of the dry-run or a test case, and the save', () => {
  it('reads the amounts as baht, the codes as lists and only the answers given', () => {
    const draft = { ...documentDraftOf(null, 'HIRE_SERVICE'), amountGross: '2,642,900', lineCategories: 'SAFETY, FUEL', fields: { processesPersonalData: 'Y', accessesSystems: '' } }
    expect(documentOf(draft)).toEqual({ ok: true, value: { requestType: 'HIRE_SERVICE', amountGross: '2642900.00', lineCategories: ['SAFETY', 'FUEL'], budgetAccountCodes: [], fields: { processesPersonalData: 'Y' } } })
    expect(documentOf({ ...draft, amountNet: '2,470,000' })).toMatchObject({ ok: true, value: { amountNet: '2470000.00' } })
    expect(documentOf({ ...draft, requestType: '', amountGross: '' })).toEqual({ ok: false, errors: { requestType: 'REQUIRED', amountGross: 'REQUIRED' } })
    expect(documentOf({ ...draft, amountGross: '1.234' })).toEqual({ ok: false, errors: { amountGross: 'MONEY' } })
    expect(documentOf({ ...draft, amountNet: '3,000,000' })).toEqual({ ok: false, errors: { amountNet: 'NET_ABOVE_GROSS' } })
    const value = documentOf(draft)
    expect(value.ok && documentDraftOf(value.value)).toMatchObject({ amountGross: '2642900.00', lineCategories: 'SAFETY, FUEL', fields: { processesPersonalData: 'Y' } })
  })

  it('sends the draft as the service reads it: the count only for COUNT, the reason trimmed', () => {
    const input = saveInput('v-1', 3, '2026-11-01', '  เพิ่มผู้ตรวจ  ', [RV('RV-01', { quorumCount: 2 })], [])
    expect(input).toEqual({ versionId: 'v-1', version: 3, effectiveDate: '2026-11-01', changeReason: 'เพิ่มผู้ตรวจ', rules: [RV('RV-01')], testCases: [] })
    expect([ruleIndexOf('rules.3.code'), ruleIndexOf('effectiveDate'), ruleIndexOf(undefined)]).toEqual([3, null, null])
  })
})
