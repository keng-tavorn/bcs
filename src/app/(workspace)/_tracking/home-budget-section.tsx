import Link from 'next/link'
import { LowBadge } from '@/ui/budgets/badges'
import type { HomeBudgetAmount, HomeBudgetView } from './home-budget'

// The budget summary of the home page (./home-budget.ts), drawn as the home draws its work: a heading, then rows
// separated by rules — no card, no chart, no big number with a small label (§9.9). Money right-aligned in tabular
// digits under one heading that says what the amounts are and their unit (§9.9 principle 6); every amount, and every
// line with the words of its warning, is a link to what makes it up (§9.9: every number leads to its list).

const LINK = 'text-primary underline underline-offset-4 hover:no-underline'
const MORE = 'inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline'

/** An amount: a link to what makes it up, named with the amount, what it is of and where it leads */
function Amount({ amount }: { amount: HomeBudgetAmount }) {
  return (
    <Link href={amount.href} aria-label={amount.label} className={`money shrink-0 font-semibold ${LINK}`}>
      {amount.text}
    </Link>
  )
}

export function HomeBudgetSection({ view }: { view: HomeBudgetView }) {
  return (
    <section aria-labelledby="my-budget" className="flex flex-col gap-3">
      <h2 id="my-budget" className="text-xl font-semibold">
        {view.labels.title}
      </h2>
      {view.kind === 'EMPTY' ? (
        <div className="flex flex-col gap-1 border-y border-line py-4">
          <p className="font-medium text-ink">{view.title}</p>
          <p className="text-ink-muted">{view.hint}</p>
          {view.importLink ? (
            <Link href={view.importLink.href} className={MORE}>
              {view.importLink.text}
            </Link>
          ) : null}
        </div>
      ) : (
        <>
          <p className="text-ink-muted">{view.scopeLine}</p>
          <div className="flex flex-col">
            <p className="pb-1 text-right text-base text-ink-muted md:text-sm" aria-hidden="true">
              {view.labels.amountHeading}
            </p>
            <ul aria-label={view.labels.list} className="flex flex-col divide-y divide-line border-y border-line">
              <li className="flex items-start justify-between gap-4 py-3">
                <div className="flex min-w-0 flex-col">
                  <span className="font-semibold text-ink">{view.totalLabel}</span>
                  <Link href={view.planned.href} aria-label={view.planned.label} className={`tabular self-start ${LINK}`}>
                    {view.planned.text}
                  </Link>
                </div>
                <Amount amount={view.available} />
              </li>
              {view.low.map((line) => (
                <li key={line.id} className="flex items-start justify-between gap-4 py-3">
                  {/* The line and how low it is, one link to its page: the share left is a number too */}
                  <Link href={line.href} className="group flex min-w-0 flex-col gap-0.5">
                    <span className="font-semibold break-words text-primary underline underline-offset-4 group-hover:no-underline">{line.title}</span>
                    <LowBadge label={line.warning} out={line.out} className="tabular" />
                  </Link>
                  <Amount amount={line.available} />
                </li>
              ))}
              {view.noneLow ? <li className="py-3 text-ink-muted">{view.noneLow}</li> : null}
            </ul>
          </div>
          <Link href={view.all.href} className={MORE}>
            {view.all.text}
          </Link>
        </>
      )}
    </section>
  )
}
