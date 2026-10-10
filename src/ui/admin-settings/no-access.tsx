import Link from 'next/link'
import { Notice } from '../form/notice'
import { Page, PageHeader } from '../page/page'

// What an admin or settings page shows a member the service refused (FORBIDDEN): whose page it is and the way back, in
// the page's frame (S16-10). The texts arrive translated.
export function NoAccess({ title, message, homeLabel }: { title: string; message: string; homeLabel: string }) {
  return (
    <Page>
      <PageHeader title={title} />
      <div className="flex max-w-2xl flex-col gap-4">
        <Notice tone="danger">{message}</Notice>
        <Link href="/" className="inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline">
          {homeLabel}
        </Link>
      </div>
    </Page>
  )
}
