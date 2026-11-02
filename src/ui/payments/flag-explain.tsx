'use client'

import { Flag } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Badge } from '../shadcn/badge'
import { Popover, PopoverContent, PopoverTrigger } from '../shadcn/popover'

// A flag of an item of a payment run with what it means (NEW-116 · FR-PAY-101 AC13): pointed at or pressed, the words of
// BR-PAY-06 open beside it and close again when the pointer leaves, on Esc or on a press elsewhere. A screen reader
// hears them with the flag's name, so nothing depends on opening it, and the focus stays where it is.

const LEAVE_MS = 150

export function FlagExplained({ label, text }: { label: string; text: string }) {
  const [open, setOpen] = useState(false)
  const leaving = useRef<ReturnType<typeof setTimeout> | null>(null)
  const stay = () => {
    if (leaving.current) clearTimeout(leaving.current)
    leaving.current = null
  }
  const leave = () => {
    stay()
    leaving.current = setTimeout(() => setOpen(false), LEAVE_MS)
  }
  useEffect(() => stay, [])
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Badge asChild variant="warn" data-tone="warn" className="cursor-pointer text-base whitespace-normal hover:underline md:text-sm">
          <button
            type="button"
            onPointerEnter={(e) => {
              if (e.pointerType !== 'mouse') return
              stay()
              setOpen(true)
            }}
            onPointerLeave={(e) => {
              if (e.pointerType === 'mouse') leave()
            }}
            // A press opens it and leaves it open, whether or not the pointer had opened it already
            onClick={(e) => {
              e.preventDefault()
              stay()
              setOpen(true)
            }}
          >
            <Flag aria-hidden="true" />
            {label}
            <span className="sr-only">: {text}</span>
          </button>
        </Badge>
      </PopoverTrigger>
      <PopoverContent
        aria-label={label}
        align="start"
        collisionPadding={16}
        className="w-[min(22rem,calc(100vw-2rem))] text-base text-ink md:text-sm"
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => e.preventDefault()}
        onPointerEnter={stay}
        onPointerLeave={leave}
      >
        {text}
      </PopoverContent>
    </Popover>
  )
}
