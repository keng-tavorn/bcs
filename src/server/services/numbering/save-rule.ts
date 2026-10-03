import { z } from 'zod'
import { err } from '@/core/result'
import type { Ctx } from '@/server/context'
import type { RunOptions } from '../_pipeline'
import { saveOrgSettings } from '../organization/settings'
import { NUMBERED_DOCUMENTS, RESET_PERIODS } from './admin'

// The numbering page saves one document's rule at a time (FR-ADM-004) through organization.save_settings
// (admin.numbering). The command merges the rule into the numbering section it reads after locking the organization
// row, so the other documents keep the rules stored at that moment (never a copy read earlier), and it checks the
// changed rule against AC2–AC3 inside its transaction.

const SaveRuleInput = z.strictObject({
  document: z.enum(NUMBERED_DOCUMENTS),
  pattern: z.string().trim().min(1).max(100),
  reset: z.enum(RESET_PERIODS),
})

export async function saveNumberingRule(ctx: Ctx, input: z.input<typeof SaveRuleInput>, options: RunOptions) {
  const parsed = SaveRuleInput.safeParse(input)
  if (!parsed.success) return err('VALIDATION_FAILED', 'invalid number rule', { field: parsed.error.issues[0]?.path.join('.') ?? '(input)' })
  const { document, pattern, reset } = parsed.data
  return saveOrgSettings(ctx, { section: 'numbering', document, value: { pattern, reset } }, options)
}
