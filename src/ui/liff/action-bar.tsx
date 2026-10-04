import type { ReactNode } from 'react'
import { cn } from './cn'
import { LIFF_COLUMN, LIFF_GUTTER } from './content'

// The bar of a LIFF page that decides something (§9.4: "แถบปุ่มตัดสินติดล่างจอ", §9.9 principle 5): the buttons stay at the
// bottom of the screen while the page scrolls, and at the end of the page they sit below the last line, so they never
// cover it. Put it right after <LiffContent>. Buttons are at least 44 px high (Button); a refusal belongs inside the bar,
// next to the button it is about. The bottom keeps clear of the home indicator (safe-area inset).

export function LiffActionBar({ label, children, className }: { readonly label: string; readonly children: ReactNode; readonly className?: string }) {
  return (
    <section aria-label={label} className="sticky bottom-0 z-20 border-t border-line bg-bg pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
      <div className={cn(LIFF_COLUMN, LIFF_GUTTER, 'flex flex-col gap-2', className)}>{children}</div>
    </section>
  )
}
