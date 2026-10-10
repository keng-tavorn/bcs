import Link from 'next/link'
import { Notice } from '../form/notice'
import { ListEmpty, Page, PageHeader } from '../page/page'
import { Button } from '../shadcn/button'

// What an insight page shows a member the service refused: whose page it is, and the way to where they can go.
// The texts arrive translated. Plain information in --info (§9.9 token table): the page is someone else's, nothing is
// pending or nearly due, so never the --warn of "รอดำเนินการและใกล้ครบกำหนด".
export function Refused({ title, message, href, linkLabel }: { title: string; message: string; href: string; linkLabel: string }) {
  return (
    <Page>
      <PageHeader title={title} />
      <div className="flex max-w-2xl flex-col gap-4">
        <Notice tone="info">{message}</Notice>
        <Link href={href} className="inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline">
          {linkLabel}
        </Link>
      </div>
    </Page>
  )
}

/** An empty result that says what to do next (§9.9 rule 8), inside the page's card (ListEmpty) */
export function EmptyState({ title, hint, href, linkLabel }: { title: string; hint: string; href?: string; linkLabel?: string }) {
  return (
    <ListEmpty
      title={title}
      hint={hint}
      actions={
        href && linkLabel ? (
          <Button asChild variant="outline" className="min-h-11 lg:min-h-10">
            <Link href={href}>{linkLabel}</Link>
          </Button>
        ) : null
      }
    />
  )
}
