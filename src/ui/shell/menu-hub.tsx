import Link from 'next/link'
import { Page, PageBody, PageHeader, Panel } from '../page/page'
import { Item, ItemContent, ItemGroup, ItemMedia, ItemTitle } from '../shadcn/item'
import { menuIcon } from './menu-icons'

// A hub of the sidebar's footer (§9.10 "ตั้งค่าของฉัน" · "ผู้ดูแลองค์กร"): the pages of its group the member may open,
// each a row with its icon and words, in menu order. Strings arrive translated. In the frame of every Workspace page
// (S16-10): the title and what the hub is for on the page's white, the rows in one white card on --surface.

export interface HubEntry {
  readonly key: string
  readonly href: string
  readonly label: string
}

export function MenuHub({ title, intro, entries }: { title: string; intro: string; entries: readonly HubEntry[] }) {
  return (
    <Page>
      <PageHeader title={title} intro={intro} />
      <PageBody>
        <Panel className="max-w-2xl">
          <nav aria-label={title}>
            <ItemGroup className="gap-2">
              {entries.map((entry) => {
                const Icon = menuIcon(entry.key)
                // ItemGroup is a list: each row is its item, holding the link
                return (
                  <div key={entry.key} role="listitem">
                    <Item asChild variant="outline" className="min-h-12 bg-bg text-base md:text-[0.9375rem]">
                      <Link href={entry.href}>
                        <ItemMedia className="size-9 rounded-md bg-primary-tint text-primary">
                          <Icon className="size-5" aria-hidden="true" />
                        </ItemMedia>
                        <ItemContent>
                          <ItemTitle className="text-base font-medium text-ink md:text-[0.9375rem]">{entry.label}</ItemTitle>
                        </ItemContent>
                      </Link>
                    </Item>
                  </div>
                )
              })}
            </ItemGroup>
          </nav>
        </Panel>
      </PageBody>
    </Page>
  )
}
