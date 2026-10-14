'use client'

import { useTranslations } from 'next-intl'
import { useEffect, useRef } from 'react'
import { Notice } from '../form/notice'
import { failureKey, type PoS8Failure } from './outcome'

// A refusal in words with its fix (§9.9 rule 7), never the raw code, said inside the form that sent it and taking the
// focus when it appears, so the member who pressed the button and a screen reader are there too.

export function usePoS8FailureText() {
  const t = useTranslations('poChange.errors')
  return (failure: PoS8Failure) => t(failureKey(failure) as 'other', { lineNo: failure.lineNo ?? '-', left: failure.left ?? '-', requestId: failure.requestId ?? '-' })
}

export function Refusal({ failure }: { failure: PoS8Failure }) {
  const text = usePoS8FailureText()(failure)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    box.current?.focus()
  }, [])
  return (
    <div ref={box} tabIndex={-1} className="outline-none">
      <Notice tone="danger">{text}</Notice>
    </div>
  )
}
