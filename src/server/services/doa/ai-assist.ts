import type { DoaRuleSnapshot } from '@/core/doa'
import type { TenantTx } from '@/server/db/tenant'
import { ruleJson } from '@/server/doa/snapshot'
import { registerAssistSubject } from '../ai/assist-contract'

// The values of a DOA version by path for the DOA drafter (BR-AI-17 BR-AI-22 of S13, FR-AI-308 AC3): rules.<code> — one
// rule as a stable text of what it decides (document type, amount band, approver, SLA). doa.import_draft takes the
// draft in and every rule must be confirmed in that call (final); a rule the person changed in the YAML counts as
// confirmed and the action is EDITED with what changed.

/** JSON with its keys in order, so a rule written by the drafter and read back from the database compare equal */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

/** One rule as its path's value: what it decides, as stored */
export function doaRuleText(rule: { readonly documentType: string; readonly when: unknown; readonly steps: unknown }): string {
  return stable({ documentType: rule.documentType, when: rule.when, steps: rule.steps })
}

/** The rule of the drafter as it will be stored (ruleJson), as its path's value */
export const draftRuleText = (rule: DoaRuleSnapshot): string => doaRuleText(ruleJson(rule))

export async function readDoaVersionForAssist(tx: TenantTx, id: string): Promise<Record<string, string> | null> {
  const rules = await tx.doaRule.findMany({ where: { doaVersionId: id }, select: { code: true, documentType: true, when: true, steps: true } })
  if (rules.length === 0) return null
  return Object.fromEntries(rules.map((r) => [`rules.${r.code}`, doaRuleText(r)]))
}

registerAssistSubject('DOA_VERSION', { purposes: ['DOA_DRAFT'], final: true, read: readDoaVersionForAssist })
