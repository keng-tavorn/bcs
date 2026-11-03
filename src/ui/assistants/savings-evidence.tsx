'use client'

import { ChevronDown } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { cn } from '../cn'
import { Button } from '../shadcn/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../shadcn/collapsible'

// The evidence of one saving (NEW-123 · FR-VIS-008 AC1): closed until the reader asks for it, so the list reads as one
// line of what was found each; the button says what it does next ("ดูหลักฐาน" or "ซ่อนหลักฐาน") and the table follows it
// in the reading order. Opened by a press only (NG-13).

export function SavingsEvidence({ id, show, hide, children }: { id: string; show: string; hide: string; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="basis-full">
      <CollapsibleTrigger asChild>
        <Button variant="ghost" aria-controls={id} className="min-h-11 px-2 text-primary lg:min-h-9">
          <ChevronDown className={cn('size-4 transition-transform duration-150 motion-reduce:transition-none', open ? 'rotate-180' : '')} aria-hidden="true" />
          {open ? hide : show}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent id={id} className="mt-2 flex flex-col gap-2">
        {children}
      </CollapsibleContent>
    </Collapsible>
  )
}
