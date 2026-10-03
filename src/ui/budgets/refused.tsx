import Link from 'next/link'
import { Notice } from '../form/notice'

// What a budget page shows a member the service refused: whose page it is, and the way back to where they can go
// (the budgets page for someone who may see budgets, home otherwise). The texts arrive translated.
export function Refused({ title, message, href, linkLabel }: { title: string; message: string; href: string; linkLabel: string }) {
  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <h1 className="text-2xl font-semibold">{title}</h1>
      <Notice tone="warning">{message}</Notice>
      <Link href={href} className="inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline">
        {linkLabel}
      </Link>
    </div>
  )
}
