import { systemClock } from '@/lib/clock'
import { inngest } from '@/server/inngest'
import { runAllRiskReviewDaily } from '@/server/services/risk'

// Job risk-review-daily (S11-09 · FR-RSK-205 AC2 · BR-RSK-10 BR-RSK-13 BR-RSK-14): every morning at 07:15 Asia/Bangkok,
// for each organization with RISK on — the reassessments due at remindOn (a RiskReview SCHEDULED, a new assessment opened
// for the supplier and the reminder e-mail), overrides about to lapse and lapsed (EXPIRED), questionnaire versions whose
// time has come, reviews of suppliers no longer ACTIVE, and the suppliers whose state moves with the day. The day is in
// every command's idempotency key, so a retry or a second run the same day changes nothing more.

export const RISK_REVIEW_DAILY_CRON = 'TZ=Asia/Bangkok 15 7 * * *'

export const riskReviewDaily = inngest.createFunction({ id: 'risk-review-daily', retries: 1, triggers: [{ cron: RISK_REVIEW_DAILY_CRON }] }, async ({ step }) =>
  step.run('daily', () => runAllRiskReviewDaily(systemClock.now())),
)
