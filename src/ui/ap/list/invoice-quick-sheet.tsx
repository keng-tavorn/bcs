'use client'

import { useRouter } from 'next/navigation'
import { useState, type ReactNode } from 'react'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '../../shadcn/sheet'

// The quick view of one invoice from the list (NEW-117): a Sheet the address opens (?view=<id>), so the row's link is a
// plain link that works from the keyboard and the browser's back closes it. Esc, the close button or a press outside
// take the view out of the address; focus goes back to the row's "ดูเร็ว". It only reads: what is inside comes from the
// server already drawn, and nothing here sends anything.

export function InvoiceQuickSheet({
  title,
  description,
  closeHref,
  invoiceId,
  children,
}: {
  title: string
  description: string
  /** The list's address without the view */
  closeHref: string
  /** The invoice, whose row's "ดูเร็ว" gets focus back */
  invoiceId: string
  children: ReactNode
}) {
  const router = useRouter()
  const [open, setOpen] = useState(true)
  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (next) return
        setOpen(false)
        router.replace(closeHref, { scroll: false })
      }}
    >
      <SheetContent
        className="overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-md"
        onCloseAutoFocus={(event) => {
          const back = [...document.querySelectorAll<HTMLElement>(`[data-quick-view="${CSS.escape(invoiceId)}"]`)].find((el) => el.offsetParent !== null)
          if (!back) return
          event.preventDefault()
          back.focus()
        }}
      >
        <SheetHeader className="pr-12">
          <SheetTitle className="text-lg">{title}</SheetTitle>
          <SheetDescription>{description}</SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-6 px-4 pb-6">{children}</div>
      </SheetContent>
    </Sheet>
  )
}
