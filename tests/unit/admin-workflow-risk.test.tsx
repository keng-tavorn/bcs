import { NextIntlClientProvider } from 'next-intl'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ConditionBuilder } from '@/ui/admin-workflow/condition-builder'
import { DiffList } from '@/ui/admin-workflow/diff-list'
import {
  OPS_BY_KIND,
  changedParts,
  checkRule,
  isDirty,
  moveRule,
  riskCaseDraftOf,
  riskCaseOf,
  riskFieldKind,
  riskFieldValues,
  ruleDraftOf,
  saveInput,
  type RuleDraft,
  type RuleValue,
} from '@/ui/admin-workflow/model'
import { RiskCaseResult, RiskDryRun } from '@/ui/admin-workflow/risk-dry-run'
import { SubmitPanel } from '@/ui/admin-workflow/submit-panel'
import { useWorkflowWords, type WorkflowContext } from '@/ui/admin-workflow/words'
import { Workbench, type WorkbenchProps } from '@/ui/admin-workflow/workbench'
import en from '../../messages/en.json'
import th from '../../messages/th.json'

// S11-06 (FR-RSK-202 AC1 AC2 · BR-RSK-07 BR-RSK-08): the workflow editor's risk reviewers — rules of RISK_ASSESSMENT
// scope that name no request type, condition rows on the fields of a supplier risk assessment only, one reviewer who
// must pass and the parts of the assessment that reviewer sees, checked as WF_LINT_RISK_* will; their own tab and order;
// what the save sends; the words of their conditions, comparison and lint; the dry-run on screening answers and a tier
// with the version in effect beside the draft. The service, the lint and the engine: tests/integration and tests/golden.

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined, push: () => undefined }) }))

const POS = (position: string, department: string) => ({ kind: 'POSITION_AT' as const, position, department })
const context: WorkflowContext = {
  requestTypes: [
    { code: 'BUY_GOODS', nameTh: 'ซื้อของ', nameEn: 'Buy goods', fields: [] },
    {
      code: 'HIRE_SERVICE',
      nameTh: 'จ้างบริการ',
      nameEn: 'Hire a service',
      fields: [{ id: 'processesPersonalData', type: 'select', labelTh: 'ผู้ขายจะประมวลผลข้อมูลส่วนบุคคลหรือไม่', labelEn: 'Personal data?', options: [{ value: 'Y', labelTh: 'ใช่', labelEn: 'Yes' }, { value: 'N', labelTh: 'ไม่ใช่', labelEn: 'No' }] }],
    },
  ],
  positions: [
    { code: 'DM', nameTh: 'ผู้จัดการฝ่าย', nameEn: 'Department manager', scope: 'DEPARTMENT' },
    { code: 'VP', nameTh: 'รองประธานสายงาน', nameEn: 'Vice president', scope: 'DEPARTMENT' },
  ],
  departments: [
    { id: 'd-hq', code: 'HQ', nameTh: 'สำนักงานใหญ่', nameEn: null, depth: 0 },
    { id: 'd-leg', code: 'LEG', nameTh: 'ฝ่ายกฎหมาย', nameEn: 'Legal', depth: 1 },
    { id: 'd-it', code: 'IT', nameTh: 'ฝ่ายไอที', nameEn: 'IT', depth: 1 },
  ],
  members: [
    { id: 'm-1', nameTh: 'สมชาย ใจดี', nameEn: null, active: true, primaryDepartmentId: 'd-leg' },
    { id: 'm-2', nameTh: 'สมหญิง รักงาน', nameEn: 'Somying Rakngan', active: true, primaryDepartmentId: 'd-it' },
  ],
}

const RV = (code: string, over: Partial<RuleValue> = {}): RuleValue => ({
  code,
  requestTypeCodes: ['BUY_GOODS'],
  when: { field: '$lineCategories', op: 'anyIn', value: ['SAFETY'] },
  reviewers: [POS('DM', 'HQ')],
  fallback: POS('VP', 'HQ'),
  mode: 'ALL',
  quorumCount: null,
  slaMinutes: 480,
  descriptionTh: null,
  ...over,
})
const RR = (code: string, over: Partial<RuleValue> = {}): RuleValue => ({
  code,
  scope: 'RISK_ASSESSMENT',
  riskDomains: ['PRIVACY'],
  requestTypeCodes: [],
  when: { field: 'processesPersonalData', op: 'eq', value: 'Y' },
  reviewers: [POS('DM', 'LEG')],
  fallback: POS('VP', 'HQ'),
  mode: 'ALL',
  quorumCount: null,
  slaMinutes: 960,
  descriptionTh: null,
  ...over,
})
const riskKind = (field: string) => riskFieldKind(field)

describe('[FR-RSK-202/AC2] a risk reviewers rule in the editor (BR-RSK-07, WF_LINT_RISK_*)', () => {
  const rules = [RV('RV-01'), RR('RR-01'), RR('RR-02', { riskDomains: ['INFOSEC'], when: { field: 'accessesSystems', op: 'eq', value: 'Y' } })]
  const base = (over: Partial<RuleDraft> = {}): RuleDraft => ({
    ...ruleDraftOf(null, rules, '8', 'RISK_ASSESSMENT'),
    riskDomains: ['PRIVACY'],
    reviewers: [POS('DM', 'LEG')],
    condition: { join: 'all', rows: [{ field: 'processesPersonalData', op: 'eq', value: 'Y', values: [] }], nested: null },
    ...over,
  })

  it('a new rule of the risk tab takes the next RR code and names no request type', () => {
    const draft = ruleDraftOf(null, rules, '8', 'RISK_ASSESSMENT')
    expect(draft).toMatchObject({ code: 'RR-03', scope: 'RISK_ASSESSMENT', requestTypeCodes: [], riskDomains: [], mode: 'ALL' })
    // The request tab keeps its own numbering
    expect(ruleDraftOf(null, rules, '8').code).toBe('RV-02')
    // An existing rule opens with its scope and parts
    expect(ruleDraftOf(rules[1]!, rules, '8')).toMatchObject({ scope: 'RISK_ASSESSMENT', riskDomains: ['PRIVACY'] })
  })

  it('saves a complete rule with its scope and parts, no request type, and one reviewer who must pass', () => {
    const check = checkRule(base({ riskDomains: ['FINANCE', 'PRIVACY'] }), rules, null, riskKind, 720)
    expect(check).toEqual({
      ok: true,
      rule: {
        code: 'RR-03',
        scope: 'RISK_ASSESSMENT',
        // In the order of the parts, however they were ticked
        riskDomains: ['PRIVACY', 'FINANCE'],
        requestTypeCodes: [],
        when: { field: 'processesPersonalData', op: 'eq', value: 'Y' },
        reviewers: [POS('DM', 'LEG')],
        fallback: null,
        mode: 'ALL',
        quorumCount: null,
        slaMinutes: 480,
        descriptionTh: null,
      },
    })
    // Every assessment, with no condition at all
    expect(checkRule(base({ condition: { join: 'all', rows: [], nested: null } }), rules, null, riskKind, 720)).toMatchObject({ ok: true, rule: { when: {} } })
  })

  it('refuses what the lint would: no part, a field an assessment does not have, more than one reviewer', () => {
    const errors = (over: Partial<RuleDraft>) => {
      const c = checkRule(base(over), rules, null, riskKind, 720)
      return c.ok ? {} : c.errors
    }
    expect(errors({ riskDomains: [] })).toEqual({ riskDomains: 'REQUIRED' })
    expect(errors({ riskDomains: ['BOGUS'] })).toEqual({ riskDomains: 'REQUIRED' })
    // A risk rule needs no request type
    expect(errors({ requestTypeCodes: [] })).toEqual({})
    // ALL whatever the form held: two reviewers are one too many (WF_LINT_RISK_QUORUM)
    expect(errors({ mode: 'COUNT', quorumCount: '1', reviewers: [POS('DM', 'LEG'), POS('DM', 'IT')] })).toEqual({ reviewers: 'ONE_REVIEWER' })
    const wrongField = checkRule(base({ condition: { join: 'all', rows: [{ field: '$amountGross', op: 'gt', value: '1', values: [] }], nested: null } }), rules, null, riskKind, 720)
    expect(wrongField).toEqual({ ok: false, errors: { condition: 'ROWS' }, rowErrors: { 0: 'RISK_FIELD' } })
    // A tier is a word: more or less than it is no comparison
    const tierAbove = checkRule(base({ condition: { join: 'all', rows: [{ field: '$tier', op: 'gt', value: 'LOW', values: [] }], nested: null } }), rules, null, riskKind, 720)
    expect(tierAbove).toEqual({ ok: false, errors: { condition: 'ROWS' }, rowErrors: { 0: 'OP' } })
    expect(errors({ condition: { join: 'any', rows: [{ field: '$tier', op: 'in', value: '', values: ['HIGH'] }, { field: '$category', op: 'anyIn', value: '', values: ['FUEL'] }], nested: null } })).toEqual({})
    expect(errors({ code: 'RV-01' })).toEqual({ code: 'DUPLICATE' })
  })

  it('the fields of an assessment take the values they hold', () => {
    expect([riskFieldKind('accessesPremises'), riskFieldKind('$tier'), riskFieldKind('$payeeType'), riskFieldKind('$category'), riskFieldKind('$amountGross')]).toEqual(['fixed', 'fixed', 'fixed', 'set', 'text'])
    expect(OPS_BY_KIND.fixed).toEqual(['eq', 'ne', 'in'])
    expect([riskFieldValues('processesPersonalData'), riskFieldValues('$inherentTier'), riskFieldValues('$payeeType'), riskFieldValues('$category')]).toEqual([['Y', 'N'], ['LOW', 'MEDIUM', 'HIGH'], ['JURISTIC', 'INDIVIDUAL', 'FOREIGN'], []])
  })

  it('a REQUEST rule stays as it was before S11 and still needs its request types', () => {
    const request = ruleDraftOf(null, rules, '8')
    const check = checkRule({ ...request, requestTypeCodes: ['BUY_GOODS'], reviewers: [POS('DM', 'HQ')] }, rules, null, () => 'text', 720)
    expect(check.ok).toBe(true)
    if (check.ok) expect(['scope', 'riskDomains'].filter((k) => k in check.rule)).toEqual([])
    expect(checkRule({ ...request, reviewers: [POS('DM', 'HQ')] }, rules, null, () => 'text', 720)).toMatchObject({ ok: false, errors: { requestTypes: 'REQUIRED' } })
  })

  it('moves a rule among the rules of its own tab only (NG-4)', () => {
    const mixed = [RV('RV-01'), RR('RR-01'), RV('RV-02'), RR('RR-02')]
    expect(moveRule(mixed, 'RV-02', -1).map((r) => r.code)).toEqual(['RV-02', 'RR-01', 'RV-01', 'RR-02'])
    expect(moveRule(mixed, 'RR-01', 1).map((r) => r.code)).toEqual(['RV-01', 'RR-02', 'RV-02', 'RR-01'])
    expect(moveRule(mixed, 'RR-01', -1).map((r) => r.code)).toEqual(['RV-01', 'RR-01', 'RV-02', 'RR-02'])
    expect(moveRule(mixed, 'RV-02', 1).map((r) => r.code)).toEqual(['RV-01', 'RR-01', 'RV-02', 'RR-02'])
  })

  it('the save sends a risk rule with its scope and parts, and a request rule as before', () => {
    const input = saveInput('v-1', 3, '2026-12-01', ' เพิ่มผู้ตรวจความเสี่ยง ', [RV('RV-01', { scope: 'REQUEST', riskDomains: [] }), RR('RR-01', { riskDomains: ['FINANCE', 'PRIVACY'], mode: 'ANY', quorumCount: 2 })], [])
    expect(input.rules).toEqual([
      RV('RV-01'),
      { ...RR('RR-01'), riskDomains: ['PRIVACY', 'FINANCE'], mode: 'ALL', quorumCount: null },
    ])
    expect('scope' in input.rules[0]!).toBe(false)
  })

  it('a rule read with its scope and the same rule without are no change; its parts are', () => {
    const before = RV('RV-01', { scope: 'REQUEST', riskDomains: [] })
    expect(isDirty({ rules: [before], testCases: [], effectiveDate: '2026-12-01' }, { rules: [RV('RV-01')], testCases: [], effectiveDate: '2026-12-01' })).toBe(false)
    expect(changedParts(before, RV('RV-01'))).toEqual([])
    expect(changedParts(RR('RR-01'), RR('RR-01', { riskDomains: ['INFOSEC', 'PRIVACY'] }))).toEqual(['riskDomains'])
    expect(changedParts(RR('RR-01', { riskDomains: ['INFOSEC', 'PRIVACY'] }), RR('RR-01', { riskDomains: ['PRIVACY', 'INFOSEC'] }))).toEqual([])
  })

  it('an assessment of the dry-run needs who opened it; the tier before the answers is left out when the same', () => {
    expect(riskCaseOf(riskCaseDraftOf(null))).toEqual({ ok: false, errors: { openedById: 'REQUIRED' } })
    expect(riskCaseOf({ ...riskCaseDraftOf('m-1'), tier: 'HIGH', categoryCodes: 'FUEL, IT  FUEL' })).toEqual({
      ok: true,
      value: { screening: { processesPersonalData: 'N', accessesSystems: 'N', accessesPremises: 'N' }, tier: 'HIGH', categoryCodes: ['FUEL', 'IT'], payeeType: 'JURISTIC', openedById: 'm-1' },
    })
    expect(riskCaseOf({ ...riskCaseDraftOf('m-1'), inherentTier: 'MEDIUM' })).toMatchObject({ ok: true, value: { inherentTier: 'MEDIUM' } })
  })
})

// ---------- on screen ----------

const noop = async () => ({ ok: false as const, code: 'FAILED' })
const props = (over: Partial<WorkbenchProps> = {}): WorkbenchProps => ({
  versionId: '0199a000-0000-7000-8000-000000000002',
  code: 'WF-SIMEC',
  versionNo: 2,
  lock: 1,
  editable: true,
  changeReason: null,
  rules: [RV('RV-01'), RV('RV-02'), RR('RR-01')],
  testCases: [],
  baseline: null,
  diff: null,
  lint: { errors: [], warnings: [] },
  context,
  categoryCodes: ['FUEL', 'SAFETY'],
  accountCodes: [],
  effectiveDate: '2026-12-01',
  minEffectiveDate: '2026-11-10',
  slaMaxHours: 720,
  canSimulate: true,
  dryRunDefaults: { requesterMemberId: 'm-1', chargedDepartmentId: 'd-leg' },
  submit: null,
  actions: { save: noop, dryRun: noop, submit: noop },
  ...over,
})

const render = (node: ReactNode, locale: 'th' | 'en' = 'th') =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={locale === 'th' ? th : en} timeZone="Asia/Bangkok">
      {node}
    </NextIntlClientProvider>,
  )
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ')

function WithWords({ children }: { children: (words: ReturnType<typeof useWorkflowWords>) => ReactNode }) {
  return <>{children(useWorkflowWords(context))}</>
}

describe('[FR-RSK-202/AC2] the risk reviewers on screen', () => {
  it('a tab of their own while the RISK module is on or the version holds such rules; the request tab lists its own', () => {
    const on = render(<Workbench {...props({ riskEnabled: true })} />)
    expect(text(on)).toContain('ผู้ตรวจความเสี่ยง')
    // The request rules' tab counts and lists the request rules only
    expect(text(on)).toContain('ข้อผู้ตรวจ (2 ข้อ)')
    expect(on).toContain('aria-label="แก้ข้อ RV-02"')
    expect(on).not.toContain('aria-label="แก้ข้อ RR-01"')
    // RV-02 is the last rule of its tab whatever follows it in the version
    expect(on).toMatch(/<button[^>]*aria-label="ย้ายข้อ RV-02 ลง"[^>]*\sdisabled=""/)
    // Rules that exist are never hidden, even with the module off
    expect(text(render(<Workbench {...props({ riskEnabled: false })} />))).toContain('ผู้ตรวจความเสี่ยง')
    // Nothing of a module that is off (§9.9)
    expect(text(render(<Workbench {...props({ riskEnabled: false, rules: [RV('RV-01')] })} />))).not.toContain('ผู้ตรวจความเสี่ยง')
    expect(text(render(<Workbench {...props({ riskEnabled: true })} />, 'en'))).toContain('Risk reviewers')
  })

  it("says a risk rule's condition in the words of the assessment, never a request form's", () => {
    const html = render(
      <WithWords>
        {(words) => (
          <>
            <p>{words.condition({ all: [{ field: 'processesPersonalData', op: 'eq', value: 'Y' }, { field: '$tier', op: 'in', value: ['HIGH', 'MEDIUM'] }] }, 'RISK_ASSESSMENT')}</p>
            <p>{words.condition({ field: '$category', op: 'anyIn', value: ['FUEL'] }, 'RISK_ASSESSMENT')}</p>
            <p>{words.condition({}, 'RISK_ASSESSMENT')}</p>
            <p>{words.domains(['FINANCE', 'GENERAL'])}</p>
          </>
        )}
      </WithWords>,
    )
    const words = text(html)
    expect(words).toContain('เข้าถึงข้อมูลส่วนบุคคล เท่ากับ ใช่ และ ระดับความเสี่ยง เป็นค่าใดค่าหนึ่งใน สูง, กลาง')
    expect(words).not.toContain('ผู้ขายจะประมวลผลข้อมูลส่วนบุคคลหรือไม่')
    expect(words).toContain('หมวดสินค้า มีค่าใดค่าหนึ่งใน FUEL')
    expect(words).toContain('ทุกใบประเมิน')
    expect(words).toContain('ทั่วไป, การเงิน')
  })

  it('the condition builder of a risk rule offers the fields of an assessment and their values only', () => {
    const html = render(
      <WithWords>
        {(words) => (
          <ConditionBuilder
            id="c"
            scope="RISK_ASSESSMENT"
            draft={{
              join: 'all',
              rows: [
                { field: 'accessesSystems', op: 'in', value: '', values: ['Y'] },
                { field: '$payeeType', op: 'eq', value: 'FOREIGN', values: [] },
                { field: '$amountGross', op: 'gt', value: '1', values: [] },
              ],
              nested: null,
            }}
            onChange={() => undefined}
            fields={[]}
            requestTypes={[]}
            rowErrors={{ 2: 'RISK_FIELD' }}
            categoryCodes={['FUEL']}
            accountCodes={[]}
            words={words}
          />
        )}
      </WithWords>,
    )
    const words = text(html)
    for (const label of ['เข้าถึงข้อมูลส่วนบุคคล', 'เข้าถึงระบบสารสนเทศ', 'เข้าพื้นที่ขององค์กร', 'ระดับความเสี่ยง', 'ระดับตั้งต้น', 'หมวดสินค้า', 'ประเภทผู้รับเงิน']) expect(html).toContain(`>${label}</option>`)
    expect(html).not.toContain('>ยอดรวม VAT</option>')
    expect(html).not.toContain('คำตอบในฟอร์ม')
    expect(html).toMatch(/<input type="checkbox"[^>]*checked=""[^>]*\/>\s*<span>ใช่<\/span>/)
    expect(html).toMatch(/<option value="FOREIGN" selected="">ต่างประเทศ<\/option>/)
    expect(words).toContain('ข้อผู้ตรวจความเสี่ยงใช้ข้อมูลนี้ไม่ได้')
  })

  it('the comparison says a risk rule as one, and its parts before and after', () => {
    const before = [RR('RR-01')]
    const after = [RR('RR-01', { riskDomains: ['PRIVACY', 'INFOSEC'] }), RR('RR-04', { riskDomains: ['FINANCE'], when: { field: '$tier', op: 'eq', value: 'HIGH' }, reviewers: [POS('VP', 'HQ')] })]
    const html = render(<WithWords>{(words) => <DiffList diff={{ added: ['RR-04'], removed: [], changed: [{ code: 'RR-01', fields: ['riskDomains'] }] }} before={before} after={after} words={words} />}</WithWords>)
    const words = text(html)
    expect(words).toContain('ส่วนที่ผู้ตรวจเห็น จาก ข้อมูลส่วนบุคคล เป็น ข้อมูลส่วนบุคคล, ความปลอดภัยสารสนเทศ')
    expect(words).toContain('ผู้ตรวจความเสี่ยง · ระดับความเสี่ยง เท่ากับ สูง · รองประธานสายงาน (VP) ของ สำนักงานใหญ่ (HQ) · ตรวจส่วน การเงิน')
  })

  it('says the lint of a risk rule with its rule and code', () => {
    const errors = [
      { code: 'WF_LINT_RISK_DOMAIN_REQUIRED', rule: 'RR-05' },
      { code: 'WF_LINT_RISK_FIELD', rule: 'RR-06', field: '$amountGross' },
      { code: 'WF_LINT_RISK_QUORUM', rule: 'RR-07' },
    ]
    const html = render(
      <WithWords>
        {(words) => (
          <SubmitPanel
            versionId="v-2"
            draftName="WF-SIMEC ฉบับ 2"
            errors={errors}
            warnings={[]}
            testCasesFailing={[]}
            dryRunDone
            unsaved={false}
            effectiveInPast={false}
            laterVersionScheduled={null}
            allowed
            approver={{ error: 'NONE' }}
            submit={async () => ({ ok: true, assigneeMemberId: 'm-1' })}
            words={words}
          />
        )}
      </WithWords>,
    )
    const words = text(html)
    expect(words).toContain('ข้อ RR-05: ข้อผู้ตรวจความเสี่ยงต้องเลือกส่วนของใบประเมินที่ผู้ตรวจเห็นอย่างน้อยหนึ่งส่วน (รหัส WF_LINT_RISK_DOMAIN_REQUIRED)')
    expect(words).toContain('ข้อ RR-06: เงื่อนไขอ้าง ยอดรวม VAT ซึ่งใบประเมินความเสี่ยงไม่มี')
    expect(words).toContain('(รหัส WF_LINT_RISK_QUORUM)')
  })
})

describe('[FR-RSK-202/AC1] the dry-run of the risk reviewers (BR-RSK-07)', () => {
  it('starts with one assessment to try, opened by the usual requester, and every field to set', () => {
    const html = render(
      <WithWords>
        {(words) => <RiskDryRun versionId="v-2" draftName="WF-SIMEC ฉบับ 2" currentName="WF-SIMEC ฉบับ 1" blocked={null} defaultOpenerId="m-1" context={context} words={words} categoryCodes={['FUEL']} run={noop} />}
      </WithWords>,
    )
    const words = text(html)
    expect(words).toContain('ใบที่ 1 (กำลังแก้)')
    expect(words).toContain('เข้าถึงข้อมูลส่วนบุคคล ไม่ใช่ · เข้าถึงระบบสารสนเทศ ไม่ใช่ · เข้าพื้นที่ขององค์กร ไม่ใช่ · ระดับต่ำ · นิติบุคคล · หมวด ไม่ระบุ · เปิดโดย สมชาย ใจดี')
    for (const label of ['ระดับความเสี่ยงที่ได้', 'ระดับตั้งต้น', 'ประเภทผู้รับเงิน', 'หมวดสินค้าของผู้ขาย', 'ผู้เปิดใบประเมิน']) expect(words).toContain(label)
    expect(html).toMatch(/<option value="m-1" selected="">สมชาย ใจดี<\/option>/)
    expect(words).toContain('รหัสที่มีในระบบ: FUEL')
    expect(html).not.toMatch(/<button[^>]*\sdisabled=""[^>]*>ทดลองหาผู้ตรวจ/)
    expect(words).toContain('ทดลองหาผู้ตรวจ (1 ใบ)')
  })

  it('cannot run with unsaved changes, and says so', () => {
    const html = render(
      <WithWords>
        {(words) => <RiskDryRun versionId="v-2" draftName="WF-SIMEC ฉบับ 2" currentName={null} blocked="มีการแก้ที่ยังไม่ได้บันทึก กดบันทึกร่างด้านล่างก่อน" defaultOpenerId={null} context={context} words={words} categoryCodes={[]} run={noop} />}
      </WithWords>,
    )
    expect(text(html)).toContain('มีการแก้ที่ยังไม่ได้บันทึก กดบันทึกร่างด้านล่างก่อน')
    expect(html).toMatch(/<button[^>]*\sdisabled=""[^>]*>ทดลองหาผู้ตรวจ \(1 ใบ\)<\/button>/)
  })

  it('shows the reviewers of the version in effect beside the draft, what differs, and why none was found', () => {
    const tried = { screening: { processesPersonalData: 'Y' as const, accessesSystems: 'N' as const, accessesPremises: 'N' as const }, tier: 'HIGH' as const, inherentTier: 'MEDIUM' as const, categoryCodes: ['FUEL'], payeeType: 'JURISTIC' as const, openedById: 'm-2' }
    const row = {
      current: { ok: false, slots: [], error: { code: 'REVIEWER_NOT_FOUND', details: { rule: 'RR-01', position: 'DM', department: 'LEG' } } },
      draft: {
        ok: true,
        slots: [
          { ruleCodes: ['RR-01'], memberIds: ['m-1'], riskDomains: ['PRIVACY'] },
          { ruleCodes: ['RR-04'], memberIds: ['m-1'], riskDomains: ['FINANCE'] },
        ],
        error: null,
      },
      changed: true,
    }
    const html = render(<WithWords>{(words) => <RiskCaseResult id="r1" n={1} tried={tried} row={row} currentName="WF-SIMEC ฉบับ 1" draftName="WF-SIMEC ฉบับ 2" words={words} />}</WithWords>)
    const words = text(html)
    expect(words).toContain('ผลของใบที่ 1')
    expect(words).toContain('ระดับสูง (ตั้งต้นกลาง)')
    expect(words).toContain('เปิดโดย สมหญิง รักงาน')
    expect(words).toContain('ผู้ตรวจของร่างต่างจากฉบับที่มีผลอยู่')
    expect(words).toContain('ข้อ RR-01: หาผู้ตรวจไม่ได้ ทั้งผู้ตรวจและผู้สำรองว่างหรือเป็นผู้เปิดใบ ใบประเมินแบบนี้จะส่งไม่ได้')
    expect(words).toContain('ข้อ RR-01: สมชาย ใจดี · ตรวจส่วน ข้อมูลส่วนบุคคล')
    expect(words).toContain('ข้อ RR-04: สมชาย ใจดี · ตรวจส่วน การเงิน')
    // A difference is said in words, not colour alone (NFR-A11Y-03)
    expect(words).toContain('ต่างจากฉบับที่มีผล')

    const none = { current: { ok: true, slots: [], error: null }, draft: { ok: true, slots: [], error: null }, changed: false }
    const same = text(render(<WithWords>{(w) => <RiskCaseResult id="r2" n={2} tried={undefined} row={none} currentName={null} draftName="WF-SIMEC ฉบับ 2" words={w} />}</WithWords>))
    expect(same).toContain('ผู้ตรวจของร่างเหมือนฉบับที่มีผลอยู่')
    expect(same).toContain('ไม่มีข้อที่ตรง ใบประเมินเสร็จทันทีโดยไม่มีผู้ตรวจ')

    const english = text(render(<WithWords>{(w) => <RiskCaseResult id="r1" n={1} tried={tried} row={row} currentName="WF-SIMEC version 1" draftName="WF-SIMEC version 2" words={w} />}</WithWords>, 'en'))
    expect(english).toContain('Rule RR-04: สมชาย ใจดี · checks Finance')
    expect(english).toContain('High tier (initially Medium)')
  })
})
