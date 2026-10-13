import { documentTypeOfSubject } from '@/core/doa'
import type { RegisteredSubject, SubjectAdapter } from './index'

// The empty adapter P1-07 leaves in every subject file until its lane writes the real one (ADR-068): no number, owner,
// conflicts or department; deciding is refused VALIDATION_FAILED reason SUBJECT (the tier-1 answer for a subject
// without its flow) and the task stays open; no chat button and no e-mail link, LIFF allowed; the task list as its page.

export function emptyAdapter(type: RegisteredSubject): SubjectAdapter {
  return {
    facts: async (_tx, id) => ({
      type,
      id,
      documentType: documentTypeOfSubject(type),
      number: null,
      title: null,
      changeKind: null,
      poId: null,
      ownerMemberId: null,
      conflictMemberIds: [],
      chargedDepartmentId: null,
    }),
    labels: (facts) => ({ label: facts.number ?? facts.title ?? facts.documentType, title: facts.title }),
    href: () => '/tasks',
    decide: async () => ({ ok: false, error: { code: 'VALIDATION_FAILED', message: `${type} tasks are decided by their own flow`, details: { reason: 'SUBJECT' } } }),
    allowsRequestInfo: false,
    channels: { chatButton: () => false, emailLink: false, liff: true },
    sodContext: (facts) => ({ requesterMemberIds: facts.conflictMemberIds }),
  }
}
