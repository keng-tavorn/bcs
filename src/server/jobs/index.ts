import { getEnv } from '@/lib/env'
import { aiActionsExpire } from './ai-actions-expire'
import { aiAgentRun } from './ai-agent-run'
import { aiCreditMonthly } from './ai-credit-monthly'
import { approvalTaskResume } from './approval-task-resume'
import { approvalTaskSla } from './approval-task-sla'
import { consolidationRound } from './consolidation'
import { dailyDigest } from './daily-digest'
import { delegationRevoked, delegationWindow } from './delegation-window'
import { doaVersionActivate } from './doa-version-activate'
import { draftExpiry } from './draft-expiry'
import { lineRichMenu } from './line-rich-menu'
import { lineWebhook, lineWebhookSweep } from './line-webhook'
import { notificationDeliver } from './notification-deliver'
import { orgAuthorityApply } from './org-authority-apply'
import { outboxSweeper } from './outbox-sweeper'
import { reportSchedules } from './report-schedules'
import { stagingDemoReset } from './staging-demo-reset'
import { stagingFirstSeed } from './staging-first-seed'

// Every Inngest function served at /api/inngest (spec §4.6). One file per function; add it here.
export const functions = [
  outboxSweeper,
  orgAuthorityApply,
  doaVersionActivate,
  draftExpiry,
  consolidationRound,
  reportSchedules,
  notificationDeliver,
  // S5-07 and S5-08: the SLA timers, the delegation periods and the daily summary
  approvalTaskSla,
  approvalTaskResume,
  delegationWindow,
  delegationRevoked,
  dailyDigest,
  // S5-02: LINE webhook events the webhook handed over, and the sweep of events nothing finished (BR-LINE-05)
  lineWebhook,
  lineWebhookSweep,
  // S5-04: the rich menu of a LINE user follows their link (FR-LINE-004 AC3)
  lineRichMenu,
  // S13-02: AI results that expire or are cleared, and the month's AI credits (ADR-145)
  aiActionsExpire,
  aiCreditMonthly,
  // S13-07: the background call of the Document Agent (and of Intake and the DOA drafter as they come)
  aiAgentRun,
  // ADR-055 and ADR-056: the first seed and the demo reset of staging, started by hand from the Inngest dashboard;
  // never registered anywhere else
  ...(getEnv().APP_ENV === 'staging' ? [stagingFirstSeed, stagingDemoReset] : []),
]
