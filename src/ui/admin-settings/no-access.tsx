import Link from 'next/link'
import { Notice } from '../form/notice'

// What a settings page shows a member the service refused (FORBIDDEN): whose page it is and the way back. The texts
// arrive translated.
export function NoAccess({ title, message, homeLabel }: { title: string; message: string; homeLabel: string }) {
  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <h1 className="text-2xl font-semibold">{title}</h1>
      <Notice tone="danger">{message}</Notice>
      <Link href="/" className="inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline">
        {homeLabel}
      </Link>
    </div>
  )
}
