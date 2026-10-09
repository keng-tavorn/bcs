'use client'

import { RotateCw } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useTransition } from 'react'
import { Button } from '../shadcn/button'

// A home card that could not load says so inside itself, with a way to try again; the other cards stay as they are
// (FR-VIS-006 AC6). Trying again asks the server for the page again; nothing changes (a GET).

export function CardError({ title, hint, retry }: { title: string; hint: string; retry: string }) {
  const router = useRouter()
  const [pending, start] = useTransition()
  return (
    <div role="alert" className="flex flex-col items-start gap-2 py-2">
      <p className="font-medium text-danger-ink">{title}</p>
      <p className="text-ink-muted">{hint}</p>
      <Button type="button" variant="outline" disabled={pending} onClick={() => start(() => router.refresh())}>
        <RotateCw aria-hidden="true" />
        {retry}
      </Button>
    </div>
  )
}
