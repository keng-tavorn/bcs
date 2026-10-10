import Link from 'next/link'
import { getLocale, getTranslations } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { listDepartments } from '@/server/queries/org'
import { BOARD_SUBJECTS, boardView } from '@/server/services/board'
import { formatDateTime } from '@/ui/format'
import { BoardTable } from '@/ui/insight/board-table'
import { Refused } from '@/ui/insight/refused'
import { FilterBar, FilterSelect } from '@/ui/page/filters'
import { ListEmpty, Page, PageBody, PageHeader, Panel } from '@/ui/page/page'
import { Button } from '@/ui/shadcn/button'
import { getSession } from '../../../_lib/session'
import { readBoardFilter } from './_filters'
import { boardRowViews, filterQuery } from './_present'

export async function generateMetadata() {
  const t = await getTranslations('board')
  return { title: t('title') }
}

const linkClass = 'inline-flex min-h-11 items-center font-medium text-primary underline underline-offset-4 hover:no-underline'

// The board "เอกสารค้างที่ใคร" (spec §9.1 /board/pending, §11.1, FR-VIS-001 AC1, demo scene 9): every person holding
// open documents within what the reader may see (board.pending.view: the whole organization for EXECUTIVE,
// PROCUREMENT, FINANCE and AUDITOR, a head's departments, everyone their own), the people with work past its SLA first,
// each figure leading to the person's documents. Filters by the holder's department and the kind of document (GET, in
// the address: ./_filters). The page's frame (S16-10): title, scope and the time counted to on the page's white, then
// the filters and the people each in a white card on --surface.
export default async function BoardPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  if (!ctx) return null
  const [t, locale] = await Promise.all([getTranslations('board'), getLocale()])
  const filter = await readBoardFilter(searchParams)
  const result = await boardView(ctx, filter)
  if (!result.ok) return <Refused title={t('title')} message={t('forbidden')} href="/" linkLabel={t('home')} />

  const { rows, scope, asOf } = result.data
  const departments = await listDepartments(ctx)
  const query = filterQuery(filter)
  const filtered = Boolean(filter.departmentId || filter.subjectType)
  const departmentName = (d: { nameTh: string; nameEn: string | null }) => (locale === 'en' && d.nameEn ? d.nameEn : d.nameTh)

  return (
    <Page>
      <PageHeader title={t('title')} intro={t('intro')}>
        <p className="font-medium text-ink">{t(`scope.${scope}`)}</p>
        <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-ink">
          <span>{t('asOf', { time: formatDateTime(locale, asOf) })}</span>
          {/* a full reload: an installed app has no reload button of its own */}
          <a href={`/board/pending${query}`} className={linkClass}>
            {t('refresh')}
          </a>
        </p>
      </PageHeader>

      <PageBody>
        {/* keyed on the filters: "clear filters" shows the cleared choices, not the ones last picked */}
        <FilterBar
          key={query}
          action="/board/pending"
          label={t('filters.label')}
          submit={t('filters.submit')}
          footer={
            filtered ? (
              <div className="border-t border-line pt-3">
                <Link href="/board/pending" className={linkClass}>
                  {t('filters.clear')}
                </Link>
              </div>
            ) : null
          }
        >
          <FilterSelect
            id="board-department"
            name="department"
            label={t('filters.department')}
            all={t('filters.allDepartments')}
            defaultValue={filter.departmentId ?? ''}
            options={departments.filter((d) => d.active).map((d) => ({ value: d.id, label: departmentName(d) }))}
          />
          <FilterSelect
            id="board-type"
            name="type"
            label={t('filters.type')}
            all={t('filters.allTypes')}
            defaultValue={filter.subjectType ?? ''}
            options={BOARD_SUBJECTS.map((s) => ({ value: s, label: t(`subject.${s}`) }))}
          />
        </FilterBar>

        <Panel id="board-people" title={t('table.title', { count: rows.length })}>
          {rows.length === 0 ? (
            filtered ? (
              <ListEmpty
                title={t('empty.filteredTitle')}
                hint={t('empty.filteredHint')}
                actions={
                  <Button asChild variant="outline" className="min-h-11 lg:min-h-10">
                    <Link href="/board/pending">{t('filters.clear')}</Link>
                  </Button>
                }
              />
            ) : (
              <ListEmpty
                title={t('empty.title')}
                hint={t('empty.hint')}
                actions={
                  <Button asChild variant="outline" className="min-h-11 lg:min-h-10">
                    <Link href="/tasks">{t('empty.link')}</Link>
                  </Button>
                }
              />
            )
          ) : (
            <>
              <p className="text-base text-ink-muted md:text-sm">{t('table.hint')}</p>
              <BoardTable
                rows={boardRowViews(t, rows, query)}
                labels={{
                  caption: t('table.caption'),
                  person: t('table.person'),
                  open: t('table.open'),
                  overdue: t('table.overdue'),
                  waiting: t('table.waiting'),
                  oldest: t('table.oldest'),
                  average: t('table.average'),
                  overdueWord: t('table.overdueWord'),
                  waitingWord: t('table.waitingWord'),
                }}
              />
            </>
          )}
        </Panel>
      </PageBody>
    </Page>
  )
}
