// The rows of the home's card "สิ่งที่ต้องทำ" (spec §9.10) and how pressing each is: plain data, read by the service and the page

/** The rows of "สิ่งที่ต้องทำ", in the order of the table in §9.10 */
export const TODO_KEYS = ['OVERDUE_TASKS', 'RETURNED', 'QUESTIONS', 'RECEIVING', 'POOL', 'PO_APPROVED', 'INVOICES', 'EXPORTS', 'DRAFTS'] as const
export type TodoKey = (typeof TODO_KEYS)[number]
export type TodoTone = 'DANGER' | 'WARN' | 'NEUTRAL'

export const TODO_TONE: Readonly<Record<TodoKey, TodoTone>> = {
  OVERDUE_TASKS: 'DANGER',
  RETURNED: 'WARN',
  QUESTIONS: 'WARN',
  RECEIVING: 'NEUTRAL',
  POOL: 'NEUTRAL',
  PO_APPROVED: 'NEUTRAL',
  INVOICES: 'NEUTRAL',
  EXPORTS: 'NEUTRAL',
  DRAFTS: 'NEUTRAL',
}
