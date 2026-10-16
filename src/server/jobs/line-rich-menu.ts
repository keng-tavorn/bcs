import { z } from 'zod'
import { inngest } from '@/server/inngest'
import { membersOfMenuSubject, runLineRichMenuSync, syncLineRichMenusOf, type LineRichMenuGroupOutcome, type LineRichMenuSyncOutcome } from '@/server/services/line-link'

// Job `line-rich-menu` (FR-LINE-004 AC3, FR-LINE-303 AC2, §9.5, BR-LINE-17): sets the rich menu of LINE users to what
// they should see now — UNLINKED, or their member's set by role (BR-LINE-16).
//  - line.linked / line.unlinked: that link's LINE user. The link and unlink requests switch it at once already; this
//    run is the retry when LINE failed there, and the only switch for an unlink that came with a deactivation
//    (FR-AUTH-003 AC2), which must not call LINE inside its transaction.
//  - member.role_granted / member.role_revoked (the member), position.assigned / position.unassigned (the holder),
//    delegation.started / ended / revoked (the delegate): that member's linked LINE users.
//  - doa_version.published / superseded / withdrawn and workflow_version.published / superseded / withdrawn: every
//    linked member, since who approves may have changed for anyone (superseded is also what job doa-version-activate
//    and its workflow twin write when a version approved in advance takes effect).
// The outbox hands every event to Inngest right after the commit (the outbox-sweeper within a minute when Inngest was
// away), and Inngest retries a transient failure of LINE, so the menu changes within a minute. Every run reads the
// links, roles, positions, delegations and versions as they are now, never what the event said: runs in any order end
// with the right menu.

/** Retries of a run whose LINE call failed for a while (Inngest's backoff spreads them over a few minutes) */
export const LINE_RICH_MENU_JOB_RETRIES = 5

/** The events of one person's menu: the link, their roles, positions and delegations (function line-rich-menu) */
export const LINE_RICH_MENU_MEMBER_EVENTS = [
  'line.linked',
  'line.unlinked',
  'member.role_granted',
  'member.role_revoked',
  'position.assigned',
  'position.unassigned',
  'delegation.started',
  'delegation.ended',
  'delegation.revoked',
] as const
/** The events of everyone's menu: a DOA or workflow version (function line-rich-menu-versions; Inngest takes ten triggers per function) */
export const LINE_RICH_MENU_VERSION_EVENTS = ['doa_version.published', 'doa_version.superseded', 'doa_version.withdrawn', 'workflow_version.published', 'workflow_version.superseded', 'workflow_version.withdrawn'] as const
/** The events the job switches menus for (BR-LINE-17) */
export const LINE_RICH_MENU_EVENTS = [...LINE_RICH_MENU_MEMBER_EVENTS, ...LINE_RICH_MENU_VERSION_EVENTS] as const
type MenuEvent = (typeof LINE_RICH_MENU_EVENTS)[number]

/** What the outbox sends for an event (src/server/services/_pipeline.ts eventOutboxDraft); a run of before S17 had no type: a link event */
export const LineRichMenuJobPayload = z.object({ organizationId: z.uuid(), aggregateId: z.uuid(), type: z.enum(LINE_RICH_MENU_EVENTS).optional() })

export interface LineRichMenuJobStep {
  run<T>(id: string, fn: () => Promise<T>): Promise<T>
}

/** What the aggregate of each event is, for the members whose menu it may change (read now by the service) */
function subjectOf(type: Exclude<MenuEvent, 'line.linked' | 'line.unlinked'>): 'MEMBER' | 'POSITION_ASSIGNMENT' | 'DELEGATION' | 'ALL' {
  if (type === 'member.role_granted' || type === 'member.role_revoked') return 'MEMBER'
  if (type === 'position.assigned' || type === 'position.unassigned') return 'POSITION_ASSIGNMENT'
  if (type === 'delegation.started' || type === 'delegation.ended' || type === 'delegation.revoked') return 'DELEGATION'
  return 'ALL'
}

/** One run, called directly by tests with their own step */
export async function lineRichMenuRun(event: { data: unknown }, step: LineRichMenuJobStep): Promise<LineRichMenuSyncOutcome | LineRichMenuGroupOutcome | { readonly ignored: 'NOT_A_MENU_EVENT' }> {
  const payload = LineRichMenuJobPayload.safeParse(event.data)
  if (!payload.success) return { ignored: 'NOT_A_MENU_EVENT' }
  const { organizationId, aggregateId, type = 'line.linked' } = payload.data
  if (type === 'line.linked' || type === 'line.unlinked') return step.run('switch', () => runLineRichMenuSync(organizationId, aggregateId))
  const members = await step.run('members', () => membersOfMenuSubject(organizationId, subjectOf(type), aggregateId))
  return step.run('switch-members', () => syncLineRichMenusOf(organizationId, members))
}

const handler = async ({ event, step }: { event: { data: unknown }; step: { run: (id: string, fn: () => Promise<unknown>) => Promise<unknown> } }) =>
  lineRichMenuRun(event, { run: <T>(id: string, fn: () => Promise<T>) => step.run(id, fn) as Promise<T> })

export const lineRichMenu = inngest.createFunction(
  { id: 'line-rich-menu', retries: LINE_RICH_MENU_JOB_RETRIES, triggers: LINE_RICH_MENU_MEMBER_EVENTS.map((e) => ({ event: `bcs/${e}` as const })) },
  handler,
)

/** The same run for a DOA or workflow version; one run at a time per organization, so two versions never send bulk calls at once */
export const lineRichMenuVersions = inngest.createFunction(
  {
    id: 'line-rich-menu-versions',
    retries: LINE_RICH_MENU_JOB_RETRIES,
    concurrency: { limit: 1, key: 'event.data.organizationId' },
    triggers: LINE_RICH_MENU_VERSION_EVENTS.map((e) => ({ event: `bcs/${e}` as const })),
  },
  handler,
)
