import { formatDocumentNumber, scopeKey } from '@/core/numbering'
import { OrgSettingsSchema } from '@/lib/org-settings'
import type { Ctx } from '@/server/context'
import { takeNextSequenceValue } from '@/server/db/sql/numbering'
import type { TenantTx } from '@/server/db/tenant'

// Document numbers (spec §7.3, FR-DOA-008, BR-NUM-01 to BR-NUM-03). A command issues its number inside its own
// transaction, at the moment the document is submitted (a draft has no number), with the organization's pattern and
// reset period from Organization.settings.numbering (OQ-12). The value comes from a locked DocumentSequence row.

export type NumberedDocument = 'PR' | 'PO' | 'GR' | 'RQ'
/** Documents of S8 whose rule is optional in settings (an organization saved before S8 has none) */
export type IssuedDocument = NumberedDocument | 'AP' | 'WHT_CERT' | 'PAY' | 'BAC'

// The rule of an S8 or S9 document an organization has not set: the pattern of OQ-12 ("the same form for every
// document") with the document's own prefix. TODO(OQ-12)
const OPTIONAL_DEFAULT_RULES = {
  AP: { pattern: 'AP-{BE}-{SEQ5}', reset: 'YEARLY' },
  WHT_CERT: { pattern: '{BE}/{SEQ5}', reset: 'YEARLY' },
  PAY: { pattern: 'PAY-{BE}-{SEQ5}', reset: 'YEARLY' },
  BAC: { pattern: 'BAC-{BE}-{SEQ5}', reset: 'YEARLY' },
} as const
const isOptional = (d: IssuedDocument): d is keyof typeof OPTIONAL_DEFAULT_RULES => d in OPTIONAL_DEFAULT_RULES

export interface IssueNumberInput {
  readonly document: IssuedDocument
  /** Code of the charged department; needed when the pattern has {DEPT} */
  readonly department?: string | null
}

/** The next number of a document type, issued inside `tx` at ctx.now (Thai time decides year and month). */
export async function issueDocumentNumber(tx: TenantTx, ctx: Ctx, input: IssueNumberInput): Promise<string> {
  const org = await tx.organization.findUniqueOrThrow({ where: { id: ctx.organizationId }, select: { settings: true } })
  const numbering = OrgSettingsSchema.shape.numbering.parse((org.settings as { numbering?: unknown } | null)?.numbering)
  const rule = isOptional(input.document) ? (numbering[input.document] ?? OPTIONAL_DEFAULT_RULES[input.document]) : numbering[input.document]
  const context = { at: ctx.now, department: input.department ?? null }
  const scope = scopeKey(input.document, rule.pattern, rule.reset, context)
  const seq = await takeNextSequenceValue(tx, ctx.organizationId, input.document, scope, rule.pattern)
  return formatDocumentNumber(rule.pattern, { ...context, seq })
}
