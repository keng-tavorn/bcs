import type { AttachmentRule } from '@/core/forms'

// The questions of a form that its attachment rules ask to be answered — the single-source reason ATT-QUOTES takes in
// place of the second and third quotation (BR-FORM-04) — are asked beside the documents, on the step that shows the rules
// and the quotations, not with the request's details: the rules decide whether they are needed once the amount and the
// quotations are known (§9.9 principle 2, ask only what is needed, step by step), and the way to fix a rule that is not
// met leads to them there. The workspace's form and the LIFF form both ask them so (details-items.tsx,
// documents-step.tsx, src/ui/liff/requests/details-step.tsx). Types only, so the first step of the LIFF form reads it at
// no cost to its first JavaScript (§9.4).

/** The ids of the fields an attachment rule asks to be filled, at any depth of its requirement */
export function documentFieldIds(rules: readonly Pick<AttachmentRule, 'require'>[]): ReadonlySet<string> {
  const ids = new Set<string>()
  const walk = (requirement: AttachmentRule['require']): void => {
    if ('attachments' in requirement) return
    if ('all' in requirement) return requirement.all.forEach(walk)
    if ('any' in requirement) return requirement.any.forEach(walk)
    ids.add(requirement.field)
  }
  for (const rule of rules) walk(rule.require)
  return ids
}
