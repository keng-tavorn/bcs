import type { FormProblemView, SettingsFailure, SettingsOutcome } from './outcome'

// Shapes of the form import of /admin/request-types/[code] (FR-ADM-005 AC1), shared by the page (server), its actions
// and the import form (client).

export interface FormChangesView {
  readonly addedFields: readonly string[]
  readonly removedFields: readonly string[]
  readonly changedFields: readonly string[]
  readonly addedRules: readonly string[]
  readonly removedRules: readonly string[]
  readonly changedRules: readonly string[]
  readonly visibilityChanged: boolean
  readonly linesChanged: boolean
}

export type FormCheckView =
  | {
      readonly valid: true
      readonly fields: number
      readonly rules: number
      readonly changes: FormChangesView
      readonly noChange: boolean
      readonly basedOnVersionNo: number | null
      readonly nextVersionNo: number
    }
  | { readonly valid: false; readonly problems: readonly FormProblemView[] }

export type CheckFormAction = (code: string, json: string) => Promise<{ readonly ok: true; readonly check: FormCheckView } | SettingsFailure>
export type PublishFormAction = (input: { code: string; json: string; basedOnVersionNo: number | null }, idempotencyKey: string) => Promise<SettingsOutcome>
