import { consolidationRound } from './consolidation'
import { doaVersionActivate } from './doa-version-activate'
import { draftExpiry } from './draft-expiry'
import { notificationDeliver } from './notification-deliver'
import { orgAuthorityApply } from './org-authority-apply'
import { outboxSweeper } from './outbox-sweeper'
import { reportSchedules } from './report-schedules'

// Every Inngest function served at /api/inngest (spec §4.6). One file per function; add it here.
export const functions = [outboxSweeper, orgAuthorityApply, doaVersionActivate, draftExpiry, consolidationRound, reportSchedules, notificationDeliver]
