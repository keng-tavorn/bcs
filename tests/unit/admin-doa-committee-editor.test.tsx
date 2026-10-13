import { NextIntlClientProvider } from 'next-intl'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { DoaEditor, type DoaEditorProps } from '@/ui/admin-doa/editor'
import { applyDraft, changedParts, draftInput, draftOf, emptyDraft, type PolicyState, type RuleState } from '@/ui/admin-doa/editor-model'
import en from '../../messages/en.json'
import th from '../../messages/th.json'

// S6-02 (FR-WF-102 AC3): the DOA editor's row holds a committee — the members ticked from the positions, the votes it
// needs (majority, everyone, any one, or a set number) — keeps it when the row is saved again, sends it to the server
// action as the service reads it, and the table shows it in words. Interactions with the server: tests/integration.

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined }) }))

const PC = (n: number) => ({ kind: 'POSITION_OF_ORG', position: `PC${n}` }) as const
const KEY = (n: number) => `POSITION_OF_ORG:PC${n}`
const DM = { kind: 'POSITION_OF_DEPARTMENT', position: 'DM' } as const
const committeeRule: RuleState = {
  key: 1,
  code: 'PR-02',
  documentType: 'PURCHASE_REQUEST',
  band: { lowerKind: 'gt', lower: '10000000', upper: null },
  steps: [{ approver: PC(1), slaMinutes: 960, committee: { approvers: [PC(1), PC(2), PC(3)], quorum: 'MAJORITY', quorumCount: null } }],
  isNew: false,
}
const rules = (): RuleState[] => [
  { key: 0, code: 'PR-01', documentType: 'PURCHASE_REQUEST', band: { lowerKind: 'gt', lower: '0', upper: '10000000' }, steps: [{ approver: DM, slaMinutes: 480 }], isNew: false },
  committeeRule,
]
const target = (key: number) => ({ key, documentType: 'PURCHASE_REQUEST' as const, newKey: 9 })

describe('[FR-WF-102/AC3] the editor row of a committee', () => {
  it('opens with its members and quorum, and saves unchanged when nothing is edited', () => {
    const draft = draftOf(committeeRule)
    expect(draft).toMatchObject({ committee: true, members: [KEY(1), KEY(2), KEY(3)], quorum: 'MAJORITY', quorumCount: '', approver: KEY(1), slaHours: '16' })
    const saved = applyDraft(rules(), target(1), draft)
    expect(saved.ok && saved.rules[1]).toEqual(committeeRule)
    expect(changedParts(committeeRule, committeeRule)).toEqual([])
  })

  it('turns one approver into a committee by count, and the change shows as the approver', () => {
    const start = rules()
    const draft = { ...draftOf(start[0]!), committee: true, members: [KEY(1), KEY(2), KEY(3)], quorum: 'COUNT' as const, quorumCount: '2' }
    const saved = applyDraft(start, target(0), draft)
    if (!saved.ok) throw new Error(JSON.stringify(saved.errors))
    expect(saved.rules[0]!.steps).toEqual([{ approver: PC(1), slaMinutes: 480, committee: { approvers: [PC(1), PC(2), PC(3)], quorum: 'COUNT', quorumCount: 2 } }])
    expect(changedParts(start[0], saved.rules[0]!)).toEqual(['approver'])
  })

  it('needs two different members, and a count from 1 to the members chosen', () => {
    const base = { ...emptyDraft(rules(), 'PURCHASE_REQUEST'), code: 'PR-09', upper: '', slaHours: '8', committee: true }
    expect(applyDraft(rules(), { key: 'new', documentType: 'PURCHASE_REQUEST', newKey: 9 }, { ...base, members: [KEY(1), KEY(1)] })).toEqual({ ok: false, errors: { members: 'MEMBERS' } })
    for (const quorumCount of ['0', '4', 'two', '']) {
      expect(applyDraft(rules(), { key: 'new', documentType: 'PURCHASE_REQUEST', newKey: 9 }, { ...base, members: [KEY(1), KEY(2), KEY(3)], quorum: 'COUNT', quorumCount }), quorumCount).toEqual({ ok: false, errors: { quorumCount: 'QUORUM_COUNT' } })
    }
  })

  it('switching the committee off goes back to one approver', () => {
    const saved = applyDraft(rules(), target(1), { ...draftOf(committeeRule), committee: false, approver: 'POSITION_OF_ORG:CEO' })
    expect(saved.ok && saved.rules[1]!.steps).toEqual([{ approver: { kind: 'POSITION_OF_ORG', position: 'CEO' }, slaMinutes: 960 }])
  })

  it('sends the committee to the server action as the service reads it', () => {
    const policy: PolicyState = { amountBasis: 'GROSS', selfApprovalPolicy: 'ESCALATE_NEXT_BAND', collapseDuplicateApprovers: true, stepUpThreshold: '100,000.00', approverMayReceive: false, requesterMayReceive: true, doaAdminSeparated: false }
    const input = draftInput('00000000-0000-7000-8000-000000000000', rules(), policy, '2026-11-01', 'เพิ่มคณะกรรมการ')
    expect('rules' in input && input.rules[1]!.steps).toEqual([{ approver: PC(1), slaMinutes: 960, committee: { approvers: [PC(1), PC(2), PC(3)], quorum: 'MAJORITY', quorumCount: null } }])
    expect('rules' in input && input.rules[0]!.steps).toEqual([{ approver: DM, slaMinutes: 480 }])
  })
})

describe('[FR-WF-102/AC3] the editor table says a committee in words, in Thai and in English', () => {
  const props = (): DoaEditorProps => ({
    sourceVersionId: '00000000-0000-7000-8000-000000000000',
    code: 'DOA-WF',
    sourceVersionNo: 1,
    nextVersionNo: 2,
    defaultEffectiveDate: '2026-11-01',
    minEffectiveDate: '2026-10-14',
    policy: { amountBasis: 'GROSS', selfApprovalPolicy: 'ESCALATE_NEXT_BAND', collapseDuplicateApprovers: true, stepUpThreshold: '10000000', approverMayReceive: false, requesterMayReceive: true, doaAdminSeparated: false },
    rules: rules().map(({ key: _key, isNew: _isNew, ...r }) => r),
    positions: [...[1, 2, 3].map((n) => ({ code: `PC${n}`, nameTh: `กรรมการ ${n}`, nameEn: `Member ${n}`, scope: 'ORG' as const })), { code: 'DM', nameTh: 'ผู้จัดการฝ่าย', nameEn: 'Department manager', scope: 'DEPARTMENT' as const }],
    members: [],
    save: async () => ({ ok: true, versionId: 'v', code: 'DOA-WF', versionNo: 2 }),
  })
  it.each([
    ['th' as const, th, 'คณะกรรมการ กรรมการ 1 (PC1) ระดับองค์กร, กรรมการ 2 (PC2) ระดับองค์กร, กรรมการ 3 (PC3) ระดับองค์กร เสียงข้างมาก'],
    ['en' as const, en, 'Committee Member 1 (PC1), organization-wide, Member 2 (PC2), organization-wide, Member 3 (PC3), organization-wide, majority vote'],
  ])('%s', (locale, messages, words) => {
    const html = renderToStaticMarkup(
      <NextIntlClientProvider locale={locale} messages={messages} timeZone="Asia/Bangkok">
        <DoaEditor {...props()} />
      </NextIntlClientProvider>,
    )
    expect(html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')).toContain(words)
  })
})
