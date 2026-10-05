'use client'

import type { ComponentProps } from 'react'
import { LiffReviewStep as ReviewStep, LiffSent as Sent, SaveFailureText as SaveFailure, type LiffReviewProps } from './review-step'
import { StepWords } from './step-words'

// Step 3 of the LIFF request form, "ตรวจและส่ง", the confirmation once the request is sent, and why a save was refused
// (./review-step.tsx), each drawn with its words (./step-words.tsx). The form loads this module when it shows one of
// them or the requester reaches step 2 (./request-form.tsx), never with the page (§9.4).

export function LiffReviewStep(props: LiffReviewProps) {
  return (
    <StepWords>
      <ReviewStep {...props} />
    </StepWords>
  )
}

export function LiffSent(props: ComponentProps<typeof Sent>) {
  return (
    <StepWords>
      <Sent {...props} />
    </StepWords>
  )
}

export function SaveFailureText(props: ComponentProps<typeof SaveFailure>) {
  return (
    <StepWords>
      <SaveFailure {...props} />
    </StepWords>
  )
}
