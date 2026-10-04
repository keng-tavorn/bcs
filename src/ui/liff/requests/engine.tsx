'use client'

import { useEffect, useLayoutEffect, type RefObject } from 'react'
import { applicableRules, compareFormQuotations, draftPayload, formInput, formReducer, needsServiceEndDate, problemsOf, totalsOf, visibleFieldIds, type FormValues } from '../../request-form/model'
import type { Attachment, RequestFormData } from '../../request-form/types'
import { useAutosave, type Autosave, type AutosaveOptions, type SaveState } from '../../request-form/use-autosave'
import { previewLinesOf } from './start'

// The engine of the LIFF request form, loaded on the requester's first touch of the form (./request-form.tsx), never
// with the first screen (§9.4: the first JavaScript of a LIFF page): the workspace's form rules (model.ts — core/forms
// and core/money, which the server runs again) and the workspace's autosave of drafts (use-autosave.ts, FR-INT-006).

export { draftPayload, formReducer, previewLinesOf }

/** Everything the rules say about the form as it is now (the same as the workspace's form works out on every keystroke) */
export function evaluate(data: RequestFormData, values: FormValues, attachments: readonly Attachment[]) {
  const purchase = data.type.documentType === 'PURCHASE_REQUEST'
  const totals = purchase ? totalsOf(values, data.vatRateBp) : null
  const input = formInput(values, attachments, totals, data.type.code)
  const { nets, lowest } = compareFormQuotations(values, data.vatRateBp)
  return {
    totals,
    input,
    visible: visibleFieldIds(data.form, input),
    endDateRequired: purchase && needsServiceEndDate(data.form, input),
    rules: applicableRules(data.form, input),
    nets,
    lowest,
    problems: problemsOf(data, values, input, lowest),
  }
}

export type Evaluation = ReturnType<typeof evaluate>

/**
 * The draft's autosave, mounted once the requester touched the form. It hands its controls to the form through `apiRef`
 * (stable functions) and tells it the save state; an edit made before it was mounted (`pendingEditRef`) counts as the first.
 */
export function AutosaveHost({
  options,
  apiRef,
  pendingEditRef,
  onState,
}: {
  readonly options: AutosaveOptions
  readonly apiRef: RefObject<Autosave | null>
  readonly pendingEditRef: RefObject<boolean>
  readonly onState: (state: SaveState, requestId: string | null) => void
}) {
  const autosave = useAutosave(options)
  useLayoutEffect(() => {
    apiRef.current = autosave
  })
  const { changed, state, requestId } = autosave
  useEffect(() => {
    if (!pendingEditRef.current) return
    pendingEditRef.current = false
    changed()
  }, [changed, pendingEditRef])
  useEffect(() => {
    onState(state, requestId)
  }, [onState, state, requestId])
  return null
}
