import { getTranslations } from 'next-intl/server'
import { z } from 'zod'
import { BOARD_SUBJECTS, type BoardFilter, type BoardRowDto, type BoardSubject, type BoardTaskDto } from '@/server/services/board'
import { formatDateTime } from '@/ui/format'
import type { BoardDocumentView } from '@/ui/insight/board-documents'
import type { BoardRowView } from '@/ui/insight/board-table'
import { hoursText } from '@/ui/insight/format'
import { documentHref, type LinkRights } from '@/ui/insight/links'
import type { StateKind } from '@/ui/request-view/status'

// Turns the board's rows into the translated, formatted views of /board/pending and /board/pending/[memberId]
// (spec §11.1): ages in business hours with one decimal, times in Thai time with the Buddhist-era year.

// The translator's type comes from a call: an instantiation expression over the namespace costs the checker far more
const _boardTranslator = () => getTranslations('board')
export type BoardT = Awaited<ReturnType<typeof _boardTranslator>>
type Params = Record<string, string | string[] | undefined>

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)

/** The board's filters from the address (GET): a department and a kind of document; anything else is ignored */
export function boardFilter(params: Params): BoardFilter {
  const department = one(params.department)
  const type = one(params.type)
  return {
    ...(department && z.uuid().safeParse(department).success ? { departmentId: department } : {}),
    ...(type && (BOARD_SUBJECTS as readonly string[]).includes(type) ? { subjectType: type as BoardSubject } : {}),
  }
}

/** The filters again as a query string ("?department=…&type=…" or ""), so a person's page keeps them */
export function filterQuery(filter: BoardFilter): string {
  const q = new URLSearchParams()
  if (filter.departmentId) q.set('department', filter.departmentId)
  if (filter.subjectType) q.set('type', filter.subjectType)
  const s = q.toString()
  return s ? `?${s}` : ''
}

/** The board's rows: every figure, the two ages too, leads to the person's documents, its link named with its unit */
export function boardRowViews(t: BoardT, rows: readonly BoardRowDto[], query: string): BoardRowView[] {
  return rows.map((r) => {
    const href = `/board/pending/${r.memberId}${query}`
    const oldest = hoursText(r.oldestMinutes)
    const average = hoursText(r.averageMinutes)
    return {
      id: r.memberId,
      name: r.name,
      href,
      nameLabel: t('table.nameLink', { name: r.name }),
      open: { text: String(r.open), label: t('table.openLink', { count: r.open, name: r.name }) },
      overdue: { count: r.overdue, text: String(r.overdue), label: t('table.overdueLink', { count: r.overdue, name: r.name }) },
      waiting: { count: r.waitingForRequester, text: String(r.waitingForRequester), label: t('table.waitingLink', { count: r.waitingForRequester, name: r.name }) },
      oldest: { text: oldest, label: t('table.oldestLink', { hours: oldest, name: r.name }) },
      average: { text: average, label: t('table.averageLink', { hours: average, name: r.name }) },
    }
  })
}

const subjectOf = (type: string): BoardSubject => ((BOARD_SUBJECTS as readonly string[]).includes(type) ? (type as BoardSubject) : 'REQUEST')

/** The title of a document on the board: its number and subject, or what it is when it has no number */
function titleOf(t: BoardT, task: BoardTaskDto): string {
  const subject = subjectOf(task.subjectType)
  if (subject === 'ORG_AUTHORITY_CHANGE') return t('document.change')
  if (subject === 'VARIANCE') return t('document.variance', { number: task.label || '-' })
  return task.label || t(`subject.${subject}`)
}

export function boardDocumentViews(t: BoardT, locale: string, row: BoardRowDto, viewerMemberId: string, rights: LinkRights, now: Date): BoardDocumentView[] {
  const mine = row.memberId === viewerMemberId
  return row.tasks.map((task) => {
    const states: Array<{ kind: StateKind; text: string }> = []
    if (task.status === 'INFO_REQUESTED') states.push({ kind: 'question', text: t('document.waitingForRequester') })
    else {
      states.push({ kind: 'waiting', text: t('document.waited', { hours: hoursText(task.ageMinutes) }) })
      if (task.dueAt) states.push(task.overdue ? { kind: 'overdue', text: t('document.overdue', { time: formatDateTime(locale, task.dueAt) }) } : { kind: 'due', text: t('document.due', { time: formatDateTime(locale, task.dueAt) }) })
    }
    const title = titleOf(t, task)
    const again = task.remindAgainAt && Date.parse(task.remindAgainAt) > now.getTime() ? task.remindAgainAt : null
    return {
      id: task.taskId,
      title,
      // the reader's own task opens where they decide it
      href: mine ? `/tasks/${task.taskId}` : documentHref({ type: subjectOf(task.subjectType), id: task.subjectId, poId: task.poId }, rights),
      meta: t('document.meta', { kind: t(`subject.${subjectOf(task.subjectType)}`), time: formatDateTime(locale, task.assignedAt) }),
      states,
      // the button only where the service would send the reminder: a task waiting for a decision that the reader sees
      // other than as AUDITOR (BR-AUTH-04 — remindTask refuses the same)
      remind: task.canRemind
        ? { label: t('remind.button', { name: row.name }), ariaLabel: t('remind.buttonFull', { name: row.name, document: title }), hint: again ? t('remind.recent', { time: formatDateTime(locale, again) }) : null }
        : null,
    }
  })
}

/** The reader sees some of these documents waiting for a decision but may not remind them: they read them as AUDITOR */
export const readsOnly = (row: BoardRowDto): boolean => row.tasks.some((task) => task.status === 'OPEN' && !task.canRemind)
