'use client'

import { Button } from '../shadcn/button'

/** Opens the browser's print dialog for the page; hidden on the paper itself */
export function PrintButton({ label }: { readonly label: string }) {
  return (
    <Button type="button" variant="outline" className="min-h-11 self-start print:hidden lg:min-h-10" onClick={() => window.print()}>
      {label}
    </Button>
  )
}
