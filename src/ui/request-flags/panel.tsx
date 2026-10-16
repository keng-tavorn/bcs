import Link from 'next/link'
import { FLAG_BADGES, StatusBadge } from '../document/badges'
import { Section } from '../request-view/facts'
import { RequestFlagList } from './list'
import type { RequestFlagsView } from './view'

// The flags of a sent request on the web task page and the web request page (S6-13 · FR-INT-103 AC2 AC3): a section of
// its own with the workspace's badge and links (./list.tsx). The page renders nothing when the request has no flag.

const linkClass = 'inline-flex min-h-11 items-center font-medium break-words text-primary underline underline-offset-4 hover:no-underline'

export function RequestFlagsPanel({ view }: { view: RequestFlagsView }) {
  return (
    <Section id="request-flags" title={view.title}>
      <RequestFlagList
        view={view}
        badge={(flag) => <StatusBadge look={FLAG_BADGES[flag.kind]} label={flag.label} />}
        link={(to) => (
          <Link href={to.href} className={linkClass}>
            {to.label}
          </Link>
        )}
      />
    </Section>
  )
}
