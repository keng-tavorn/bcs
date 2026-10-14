import { FLAG_BADGES } from '../../document/badge-looks'
import { RequestFlagList } from '../../request-flags/list'
import type { RequestFlagsView } from '../../request-flags/view'
import { LiffSection } from '../content'
import { LiffLink } from '../liff-link'
import { LiffStatusBadge } from '../status-badge'

// The flags of a sent request on the LIFF task page (S6-13 · FR-INT-103 AC2 AC3): the web task page's section in the LIFF
// column, with the LIFF badge and links between LIFF pages — plain elements and SVG, no shadcn/ui or Workspace component
// (ADR-052, §9.4). The page renders nothing when the request has no flag.

const linkClass = 'inline-flex min-h-11 items-center font-medium break-words text-primary underline underline-offset-4 hover:no-underline'

export function LiffRequestFlags({ view }: { view: RequestFlagsView }) {
  return (
    <LiffSection id="request-flags" title={view.title}>
      <RequestFlagList
        view={view}
        badge={(flag) => <LiffStatusBadge look={FLAG_BADGES[flag.kind]} label={flag.label} />}
        link={(to) => (
          <LiffLink href={to.href} className={linkClass}>
            {to.label}
          </LiffLink>
        )}
      />
    </LiffSection>
  )
}
