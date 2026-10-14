import { getEnv } from '@/lib/env'
import { aiActionsExpire } from './ai-actions-expire'
import { aiAgentRun } from './ai-agent-run'
import { aiApprovalBrief } from './ai-approval-brief'
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
import { workflowVersionActivate } from './workflow-version-activate'
import { backtestRun } from './backtest-run'
import { renewalReminders } from './renewal-reminders'
import { budgetOverrunLapse } from './budget-overrun-lapse'
import { budgetBurnAlerts } from './budget-burn-alerts'

// Every Inngest function served at /api/inngest (spec §4.6). One file per function; add it here.
export const functions = [
  outboxSweeper,
  orgAuthorityApply,
  doaVersionActivate,
  // S6-04: a workflow version published for later supersedes the one before it at its date
  workflowVersionActivate,
  backtestRun,
  draftExpiry,
  // S6-12: the service lines that end soon (BR-FORM-08)
  renewalReminders,
  // S6-16: approved over-budget approvals not used go back (BR-BUD-15)
  budgetOverrunLapse,
  // S6-18: budget alerts once per line, alert and fiscal year (BR-BUD-17)
  budgetBurnAlerts,
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
  // S13-09: the Approval Brief of a task on an approval step
  aiApprovalBrief,
  // ADR-055 and ADR-056: the first seed and the demo reset of staging, started by hand from the Inngest dashboard;
  // never registered anywhere else
  ...(getEnv().APP_ENV === 'staging' ? [stagingFirstSeed, stagingDemoReset] : []),
]
