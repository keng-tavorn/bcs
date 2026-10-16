import { describe, expect, it } from 'vitest'
import type { OrgSnapshot } from '@/core/doa'
import { reresolveOpenTasks, type OpenTaskOnTree } from '@/core/workflow'
import { orgSnapshot } from '../golden/doa-fixtures'

// S6-08 · the edges of reresolveOpenTasks the golden cases GC-WF-43 and GC-WF-44 leave out (BR-WF-14): a named member,
// a reviewer's position in a department, a task already with the holder or held by a delegate for them, a holder who
// conflicts with the document, and a position nobody holds after the move.

const org = orgSnapshot([], 'fixtures/org-s6.yaml')
const at = new Date('2026-10-06T03:00:00Z')
const id = (code: string) => org.departments.find((d) => d.code === code)!.id
const moved: OrgSnapshot = { ...org, departments: org.departments.map((d) => (d.code === 'CON' ? { ...d, parentId: id('SUP') } : d)) }
const task = (over: Partial<OpenTaskOnTree>): OpenTaskOnTree => ({
  id: 'T',
  resolvedFrom: 'POSITION:VP@OPS',
  approver: { kind: 'POSITION_OF_DEPARTMENT', position: 'VP' },
  chargedDepartmentId: id('CON'),
  assigneeMemberId: 'vp_ops',
  principalMemberId: null,
  conflictMemberIds: ['req_con'],
  ...over,
})

describe('[FR-WF-104/AC2] reresolveOpenTasks after a department moved', () => {
  it('moves a reviewer found by position in a department; leaves a named member alone', () => {
    const qse = moved.departments.map((d) => (d.code === 'QSE' ? { ...d, parentId: id('SUP') } : d))
    const r = reresolveOpenTasks(
      [task({ id: 'R', resolvedFrom: 'POSITION:VP@OPS', approver: { kind: 'POSITION_AT', position: 'VP', department: 'QSE' } }), task({ id: 'M', approver: { kind: 'MEMBER', memberId: 'coo' } })],
      { ...moved, departments: qse },
      at,
    )
    expect(r).toEqual({ reassign: [{ task: 'R', to: 'vp_sup', resolvedFrom: 'POSITION:VP@SUP' }], stuck: [] })
  })

  it('stays with the holder already found — or the delegator a delegate acts for — and refuses a holder in conflict', () => {
    const r = reresolveOpenTasks(
      [task({ id: 'SAME', assigneeMemberId: 'vp_sup' }), task({ id: 'DLG', assigneeMemberId: 'asst_con', principalMemberId: 'vp_sup' }), task({ id: 'CF', conflictMemberIds: ['vp_sup'] })],
      moved,
      at,
    )
    expect(r).toEqual({ reassign: [], stuck: [{ task: 'CF', reason: 'CONFLICT' }] })
  })

  it('a position nobody holds after the move leaves the task where it is', () => {
    const vacant: OrgSnapshot = { ...moved, holders: moved.holders.filter((h) => h.positionCode !== 'VP') }
    expect(reresolveOpenTasks([task({ id: 'V' })], vacant, at)).toEqual({ reassign: [], stuck: [{ task: 'V', reason: 'NOT_FOUND' }] })
  })
})
