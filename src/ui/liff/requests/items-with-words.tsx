'use client'

import type { ComponentProps } from 'react'
import { ItemsStep } from '../../request-form/details-items'
import { StepWords } from './step-words'

// Step 2 of the LIFF request form, "รายการที่ขอ" — the workspace's items step (src/ui/request-form/details-items.tsx) —
// drawn with its words (./step-words.tsx). The form loads this module when the requester gets to the step
// (./request-form.tsx), never with the page (§9.4).

export function LiffItemsStep(props: ComponentProps<typeof ItemsStep>) {
  return (
    <StepWords>
      <ItemsStep {...props} />
    </StepWords>
  )
}
