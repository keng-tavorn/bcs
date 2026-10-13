'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { hasAmount, type DocType } from './editor-model'

// The amount fields of the DOA simulator (FR-DOA-009 AC4): shown for a document type with an amount, hidden as soon as
// the reader picks a type without one (a bank account change, a policy change). The form is a plain GET form, so the
// page renders the fields and this only follows the type select; without script they stay as the page sent them, and
// the server never reads an amount for a type without one.

export function SimulateAmountFields({ typeSelectId, initialType, children }: { typeSelectId: string; initialType: string; children: ReactNode }) {
  const [type, setType] = useState(initialType)
  useEffect(() => {
    const select = document.getElementById(typeSelectId)
    if (!(select instanceof HTMLSelectElement)) return
    const follow = () => setType(select.value)
    select.addEventListener('change', follow)
    return () => select.removeEventListener('change', follow)
  }, [typeSelectId])
  return <div className={hasAmount(type as DocType) ? 'contents' : 'hidden'}>{children}</div>
}
