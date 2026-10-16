'use client'

import { useEffect, useRef } from 'react'

// A hidden field of a GET form that carries one parameter of the page's current address, read when the form is sent:
// tabs change the address without asking the server (DocTabs, ?tab=…), so the value the page was drawn with may be
// stale by then. A new period on /reports/workflow keeps the tab the reader is on.
export function AddressParamField({ name, initial }: { name: string; initial: string }) {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const input = ref.current
    const form = input?.form
    if (!input || !form) return
    const sync = () => {
      const value = new URL(window.location.href).searchParams.get(name)
      if (value) input.value = value
    }
    form.addEventListener('submit', sync)
    return () => form.removeEventListener('submit', sync)
  }, [name])
  return <input ref={ref} type="hidden" name={name} defaultValue={initial} />
}
