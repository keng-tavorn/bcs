import { Pagination, PaginationContent, PaginationItem, PaginationLink, PaginationNext, PaginationPrevious } from '../shadcn/pagination'

// The pages of a tab of /finance/payments (§9.10 Pagination): previous, the page numbers and next as plain links (the
// page is in the address, so a link opens it), each at least 44 px tall to touch. Shown only when there is more than one
// page. The words of "page n of m" arrive translated.

export function RunPagination({ page, pageCount, hrefOf, label }: { page: number; pageCount: number; hrefOf: (page: number) => string; label: string }) {
  if (pageCount <= 1) return null
  const pages = Array.from({ length: pageCount }, (_, i) => i + 1)
  return (
    <div className="flex flex-col items-center gap-2">
      <Pagination>
        <PaginationContent className="flex-wrap justify-center">
          {page > 1 ? (
            <PaginationItem>
              <PaginationPrevious href={hrefOf(page - 1)} className="min-h-11" />
            </PaginationItem>
          ) : null}
          {pages.map((p) => (
            <PaginationItem key={p}>
              <PaginationLink href={hrefOf(p)} isActive={p === page} className="size-11">
                {p}
              </PaginationLink>
            </PaginationItem>
          ))}
          {page < pageCount ? (
            <PaginationItem>
              <PaginationNext href={hrefOf(page + 1)} className="min-h-11" />
            </PaginationItem>
          ) : null}
        </PaginationContent>
      </Pagination>
      <p className="text-ink-muted">{label}</p>
    </div>
  )
}
