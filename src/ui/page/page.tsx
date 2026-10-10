import type { ReactNode } from 'react'
import { cn } from '../cn'
import { Card, CardContent, CardHeader, CardTitle } from '../shadcn/card'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from '../shadcn/empty'

// The frame of a Workspace page (spec §9.9 §9.10, S16-10): the title at 24 px with a line of what the page is for on the
// page's white, then the page's work on --surface in white cards with a 1 px border and no shadow — the way the home
// lays out its cards. A card holds one unit of work (the filters, the list, a form), never every line of it. Strings
// arrive translated.

/** The page's title, what it is for, and its own actions (one main button at most, §9.10) */
export function PageHeader({ title, intro, actions, children }: { title: string; intro?: ReactNode; actions?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
      <div className="flex max-w-3xl min-w-0 flex-col gap-1">
        <h1 className="text-2xl font-semibold break-words">{title}</h1>
        {intro ? <p className="text-ink-muted">{intro}</p> : null}
        {children}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  )
}

/** The page's work on --surface: edge to edge on a phone, a rounded band inside the content's width on a computer */
export function PageBody({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('-mx-4 flex flex-col gap-4 bg-surface px-4 py-4 lg:mx-0 lg:gap-6 lg:rounded-lg lg:p-6', className)}>{children}</div>
}

/** Header and body together: the page's frame */
export function Page({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-6">{children}</div>
}

/**
 * One white card on the surface: an optional title (16 px, weight 600) that names the region for screen readers, its
 * actions beside it, and its content at the body's size
 */
export function Panel({
  title,
  id,
  actions,
  children,
  className,
  label,
}: {
  title?: ReactNode
  /** The title's id, so the card is a region named by it */
  id?: string
  actions?: ReactNode
  children: ReactNode
  className?: string
  /** Names the card when it has no title */
  label?: string
}) {
  const named = title && id ? { role: 'region' as const, 'aria-labelledby': id } : label ? { role: 'region' as const, 'aria-label': label } : {}
  return (
    <Card {...named} className={cn('min-w-0 gap-3 bg-bg text-base', className)}>
      {title ? (
        <CardHeader className={actions ? 'flex flex-wrap items-center justify-between gap-2' : undefined}>
          <CardTitle>
            <h2 id={id} className="text-base font-semibold">
              {title}
            </h2>
          </CardTitle>
          {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
        </CardHeader>
      ) : null}
      <CardContent className="flex min-w-0 flex-col gap-3">{children}</CardContent>
    </Card>
  )
}

/**
 * An empty list says what is missing and the next step (§9.9 principle 8): never "no data" alone. Inside a card, so the
 * dashed border of the shadcn Empty is not drawn twice.
 */
export function ListEmpty({ title, hint, actions, className }: { title: string; hint?: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <Empty className={cn('border-0 p-4', className)}>
      <EmptyHeader>
        <EmptyTitle className="text-base">{title}</EmptyTitle>
        {hint ? <EmptyDescription className="text-base md:text-sm">{hint}</EmptyDescription> : null}
      </EmptyHeader>
      {actions ? <EmptyContent className="flex-row flex-wrap justify-center">{actions}</EmptyContent> : null}
    </Empty>
  )
}
