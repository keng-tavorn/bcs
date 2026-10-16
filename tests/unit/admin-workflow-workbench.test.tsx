import { NextIntlClientProvider } from 'next-intl'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ConditionBuilder } from '@/ui/admin-workflow/condition-builder'
import type { RuleValue } from '@/ui/admin-workflow/model'
import { SubmitPanel, type SubmitPanelProps } from '@/ui/admin-workflow/submit-panel'
import { useWorkflowWords, type WorkflowContext } from '@/ui/admin-workflow/words'
import { Workbench, type WorkbenchProps } from '@/ui/admin-workflow/workbench'
import en from '../../messages/en.json'
import th from '../../messages/th.json'

// S6-06 (FR-WF-103 AC1 AC2): the workflow workbench as it first draws — a draft's rules in words with their edit, move
// and remove buttons (no dragging, NG-4), the tabs of the draft, a published version read only — the condition
// builder's rows, and the send that stays closed until the dry-run ran on the latest save and says what is missing.
// Interactions with the server: tests/integration/workflow-view.test.ts and the e2e spec admin-workflows.

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
    { id: 'd-ops', code: 'OPS', nameTh: 'สายปฏิบัติการ', nameEn: null, depth: 1 },
    { id: 'd-qse', code: 'QSE', nameTh: 'ฝ่ายความปลอดภัย', nameEn: 'Safety', depth: 2 },
  ],
  members: [{ id: 'm-1', nameTh: 'สมชาย ใจดี', nameEn: null, active: true, primaryDepartmentId: 'd-qse' }],
}
const rules: RuleValue[] = [
  { code: 'RV-01', requestTypeCodes: ['BUY_GOODS'], when: { field: '$lineCategories', op: 'anyIn', value: ['SAFETY', 'FUEL'] }, reviewers: [POS('DM', 'QSE')], fallback: POS('VP', 'OPS'), mode: 'ANY', quorumCount: null, slaMinutes: 480, descriptionTh: null },
  { code: 'RV-02', requestTypeCodes: ['HIRE_SERVICE'], when: { all: [{ field: 'processesPersonalData', op: 'eq', value: 'Y' }, { field: '$amountGross', op: 'gt', value: '1000000.00' }] }, reviewers: [POS('DM', 'QSE')], fallback: null, mode: 'ALL', quorumCount: null, slaMinutes: 960, descriptionTh: null },
]
const noop = async () => ({ ok: false as const, code: 'FAILED' })
const props = (over: Partial<WorkbenchProps> = {}): WorkbenchProps => ({
  versionId: '0199a000-0000-7000-8000-000000000002',
  code: 'WF-SIMEC',
  versionNo: 2,
  lock: 1,
  editable: true,
  changeReason: null,
  rules,
  testCases: [],
  baseline: { code: 'WF-SIMEC', versionNo: 1, relation: 'IN_EFFECT', rules },
  diff: { added: [], removed: [], changed: [] },
  lint: { errors: [], warnings: [{ code: 'WF_LINT_NO_FALLBACK', rule: 'RV-02', key: 'WF_LINT_NO_FALLBACK:RV-02' }] },
  context,
  categoryCodes: ['FUEL', 'SAFETY'],
  accountCodes: [],
  effectiveDate: '2026-11-01',
  minEffectiveDate: '2026-10-07',
  slaMaxHours: 720,
  canSimulate: true,
  dryRunDefaults: { requesterMemberId: 'm-1', chargedDepartmentId: 'd-qse' },
  submit: { allowed: true, dryRunDone: false, effectiveInPast: false, laterVersionScheduled: null, testCasesFailing: [], approver: { ref: 'DOA-DEMO ฉบับ 1 ข้อ DOA-CHG-01', approvers: [{ id: 'm-1', nameTh: 'สมชาย ใจดี', nameEn: null }] } },
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

describe('[FR-WF-103/AC1] the workbench of a draft', () => {
  it('lists the rules in words with their buttons, and the tabs of a draft', () => {
    const html = render(<Workbench {...props()} />)
    const words = text(html)
    expect(words).toContain('หมวดของรายการ มีค่าใดค่าหนึ่งใน SAFETY, FUEL')
    expect(words).toContain('ผู้ขายจะประมวลผลข้อมูลส่วนบุคคลหรือไม่ เท่ากับ ใช่ และ ยอดรวม VAT มากกว่า 1,000,000.00 บาท')
    expect(words).toContain('ผู้จัดการฝ่าย (DM) ของ ฝ่ายความปลอดภัย (QSE)')
    expect(words).toContain('ฝ่ายใดฝ่ายหนึ่งผ่านก็พอ · ภายใน 8 ชม.ทำการ')
    expect(words).toContain('ผู้สำรอง: รองประธานสายงาน (VP) ของ สายปฏิบัติการ (OPS)')
    expect(words).toContain('ไม่มีผู้สำรอง')
    for (const label of ['แก้ข้อ RV-01', 'ย้ายข้อ RV-01 ขึ้น', 'ย้ายข้อ RV-02 ลง', 'ลบข้อนี้: RV-02']) expect(html).toContain(`aria-label="${label}"`)
    // Moving the first rule up or the last down does nothing, so those buttons are off
    expect(html).toMatch(/<button[^>]*aria-label="ย้ายข้อ RV-01 ขึ้น"[^>]*\sdisabled=""/)
    for (const tab of ['ข้อผู้ตรวจ', 'ทดลองส่ง', 'เทียบกับฉบับก่อน', 'ตรวจและส่งขออนุมัติ']) expect(words).toContain(tab)
    expect(words).toContain('บันทึกร่าง WF-SIMEC ฉบับ 2')
    expect(words).toContain('เพิ่มข้อผู้ตรวจ')
    // No dragging anywhere (NG-4)
    expect(html).not.toContain('draggable')
  })

  it('a published version is read only: no edit, move, remove or save, and no send', () => {
    const html = render(<Workbench {...props({ editable: false, submit: null })} />)
    expect(html).not.toContain('aria-label="แก้ข้อ RV-01"')
    expect(html).not.toContain('ลบข้อนี้')
    expect(text(html)).not.toContain('บันทึกร่าง WF-SIMEC')
    expect(text(html)).not.toContain('ตรวจและส่งขออนุมัติ')
  })

  it('draws in English as well', () => {
    const words = text(render(<Workbench {...props()} />, 'en'))
    expect(words).toContain('Line categories includes any of SAFETY, FUEL')
    expect(words).toContain('Department manager (DM) of Safety (QSE)')
    expect(words).toContain('Save draft WF-SIMEC version 2')
  })
})

function WithWords({ children }: { children: (words: ReturnType<typeof useWorkflowWords>) => ReactNode }) {
  return <>{children(useWorkflowWords(context))}</>
}

const submitProps = (over: Partial<SubmitPanelProps> = {}): Omit<SubmitPanelProps, 'words'> => ({
  versionId: 'v-2',
  draftName: 'WF-SIMEC ฉบับ 2',
  errors: [],
  warnings: [{ code: 'WF_LINT_NO_FALLBACK', rule: 'RV-02', key: 'WF_LINT_NO_FALLBACK:RV-02' }],
  testCasesFailing: [],
  dryRunDone: true,
  unsaved: false,
  effectiveInPast: false,
  laterVersionScheduled: null,
  allowed: true,
  approver: { ref: 'DOA-DEMO ฉบับ 1 ข้อ DOA-CHG-01', approvers: [{ id: 'm-1', nameTh: 'สมชาย ใจดี', nameEn: null }] },
  submit: async () => ({ ok: true, assigneeMemberId: 'm-1' }),
  ...over,
})

describe('[FR-WF-103/AC2] the send of a draft', () => {
  it('stays closed until the dry-run ran on the latest save, and says what is missing', () => {
    const html = render(<WithWords>{(words) => <SubmitPanel {...submitProps({ dryRunDone: false, testCasesFailing: ['น้ำมันต้องไปฝ่ายจัดซื้อ'] })} words={words} />}</WithWords>)
    expect(html).toMatch(/<button[^>]*\sdisabled=""[^>]*>ส่งขออนุมัติเผยแพร่<\/button>/)
    const words = text(html)
    expect(words).toContain('ยังไม่ได้ทดลองส่งร่างล่าสุด ไปที่แท็บทดลองส่งแล้วกดทดลองส่ง')
    expect(words).toContain('กรณีทดสอบไม่ผ่าน: น้ำมันต้องไปฝ่ายจัดซื้อ')
  })

  it('opens when everything holds, lists each warning to tick and names the approver', () => {
    const html = render(<WithWords>{(words) => <SubmitPanel {...submitProps()} words={words} />}</WithWords>)
    expect(html).not.toMatch(/<button[^>]*\sdisabled=""[^>]*>ส่งขออนุมัติเผยแพร่<\/button>/)
    const words = text(html)
    expect(words).toContain('ข้อ RV-02: ไม่มีผู้สำรอง (รหัส WF_LINT_NO_FALLBACK)')
    expect(html).toContain('type="checkbox"')
    expect(words).toContain('ฉบับนี้จะส่งให้ สมชาย ใจดี อนุมัติตาม DOA-DEMO ฉบับ 1 ข้อ DOA-CHG-01')
  })

  it('a lint error keeps it closed and is said with its rule and code', () => {
    const html = render(<WithWords>{(words) => <SubmitPanel {...submitProps({ errors: [{ code: 'WF_LINT_UNKNOWN_FIELD', rule: 'RV-03', field: 'processesPersonalData' }] })} words={words} />}</WithWords>)
    expect(text(html)).toContain('ข้อ RV-03: เงื่อนไขอ้างช่อง ผู้ขายจะประมวลผลข้อมูลส่วนบุคคลหรือไม่ ที่ไม่มีในฟอร์มของทุกประเภทที่ข้อนี้ใช้ (รหัส WF_LINT_UNKNOWN_FIELD)')
    expect(html).toMatch(/<button[^>]*\sdisabled=""[^>]*>ส่งขออนุมัติเผยแพร่<\/button>/)
  })
})

describe('[FR-WF-103/AC1] the condition builder', () => {
  it('draws each row as field, operator and value; a list of options is ticked', () => {
    const html = render(
      <WithWords>
        {(words) => (
          <ConditionBuilder
            id="c"
            draft={{
              join: 'any',
              rows: [
                { field: 'processesPersonalData', op: 'in', value: '', values: ['Y'] },
                { field: '$amountGross', op: 'gt', value: '1,000,000.00', values: [] },
              ],
              nested: null,
            }}
            onChange={() => undefined}
            fields={context.requestTypes[1]!.fields}
            requestTypes={context.requestTypes.map((r) => ({ code: r.code, label: r.nameTh }))}
            rowErrors={{ 1: 'MONEY' }}
            categoryCodes={[]}
            accountCodes={[]}
            words={words}
          />
        )}
      </WithWords>,
    )
    const words = text(html)
    expect(words).toContain('เงื่อนไขแถวที่ 1')
    expect(words).toContain('ตรงแถวใดแถวหนึ่งก็พอ (หรือ)')
    expect(html).toMatch(/<input type="radio"[^>]*checked=""[^>]*\/>\s*<span>ตรงแถวใดแถวหนึ่งก็พอ/)
    expect(words).toContain('คำตอบในฟอร์ม: ผู้ขายจะประมวลผลข้อมูลส่วนบุคคลหรือไม่')
    expect(html).toMatch(/<input type="checkbox"[^>]*checked=""[^>]*\/>\s*<span>ใช่<\/span>/)
    expect(words).toContain('ใส่ยอดเป็นบาท ทศนิยมไม่เกิน 2 ตำแหน่ง เช่น 1,000,000.00')
    expect(html).toContain('aria-label="ลบเงื่อนไขแถวที่ 2"')
  })
})
