import { CircleUserRound } from 'lucide-react'
import type { ReactNode } from 'react'
import { SHELL_PANELS } from './panels'

// The user menu of the top bar (FR-PLT-013 AC3, §9.10): who is signed in and in which roles, the language, and signing
// out. A <details> of the shell's panel group, like the bell: opening one closes the other, so no panel opens over another.

export function UserMenu({ label, name, detail, children }: { label: string; name: string; detail?: string; children: ReactNode }) {
  return (
    <details name={SHELL_PANELS} className="md:relative">
      <summary
        aria-label={label}
        className="inline-flex size-11 cursor-pointer list-none items-center justify-center rounded-full text-ink transition-colors duration-150 hover:bg-surface lg:size-10 [&::-webkit-details-marker]:hidden"
      >
        <CircleUserRound className="size-6" aria-hidden="true" />
      </summary>
      <div className="fixed inset-x-4 top-14 z-30 mt-2 flex flex-col md:absolute md:inset-x-auto md:top-auto md:right-0 md:w-80 gap-4 rounded-md border border-line bg-bg p-4 shadow-md">
        <div className="flex flex-col gap-1">
          <p className="font-semibold text-ink">{name}</p>
          {detail ? <p className="text-base text-ink-muted md:text-sm">{detail}</p> : null}
        </div>
        <div className="border-t border-line pt-4">{children}</div>
      </div>
    </details>
  )
}
