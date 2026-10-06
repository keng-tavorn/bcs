import Link from 'next/link'
import { Notice } from '../form/notice'

// What an insight page shows a member the service refused: whose page it is, and the way to where they can go.
// The texts arrive translated. Plain information in --info (§9.9 token table): the page is someone else's, nothing is
// pending or nearly due, so never the --warn of "รอดำเนินการและใกล้ครบกำหนด".
export function Refused({ title, message, href, linkLabel }: { title: string; message: string; href: string; linkLabel: string }) {
  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <h1 className="text-2xl font-semibold">{title}</h1>
      <Notice tone="info">{message}</Notice>
      <Link href={href} className="inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline">
        {linkLabel}
      </Link>
    </div>
  )
}

/** An empty result that says what to do next (§9.9 rule 8) */
export function EmptyState({ title, hint, href, linkLabel }: { title: string; hint: string; href?: string; linkLabel?: string }) {
  return (
    <div className="flex flex-col gap-2 border-y border-line py-6">
      <p className="font-medium text-ink">{title}</p>
      <p className="text-ink-muted">{hint}</p>
      {href && linkLabel ? (
        <Link href={href} className="inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline">
          {linkLabel}
        </Link>
      ) : null}
    </div>
  )
}
