import Link from 'next/link'
import { getLocale, getTranslations } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { listDepartments } from '@/server/queries/org'
import { BOARD_SUBJECTS, boardView } from '@/server/services/board'
import { Button } from '@/ui/form/button'
import { formatDateTime } from '@/ui/format'
import { BoardTable } from '@/ui/insight/board-table'
import { EmptyState, Refused } from '@/ui/insight/refused'
import { getSession } from '../../../_lib/session'
import { boardFilter, boardRowViews, filterQuery } from './_present'

export async function generateMetadata() {
  const t = await getTranslations('board')
  return { title: t('title') }
}

const linkClass = 'inline-flex min-h-11 items-center font-medium text-primary underline underline-offset-4 hover:no-underline'
const selectClass = 'h-11 w-full rounded-md border border-input bg-bg px-3 text-base text-ink'

// The board "เอกสารค้างที่ใคร" (spec §9.1 /board/pending, §11.1, FR-VIS-001 AC1, demo scene 9): every person holding
// open documents within what the reader may see (board.pending.view: the whole organization for EXECUTIVE,
// PROCUREMENT, FINANCE and AUDITOR, a head's departments, everyone their own), the people with work past its SLA first,
// each figure leading to the person's documents. Filters by the holder's department and the kind of document (GET).
export default async function BoardPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  if (!ctx) return null
  const [t, locale] = await Promise.all([getTranslations('board'), getLocale()])
  const filter = boardFilter(await searchParams)
  const result = await boardView(ctx, filter)
  if (!result.ok) return <Refused title={t('title')} message={t('forbidden')} href="/" linkLabel={t('home')} />

  const { rows, scope, asOf } = result.data
  const departments = await listDepartments(ctx)
  const query = filterQuery(filter)
  const filtered = Boolean(filter.departmentId || filter.subjectType)
  const departmentName = (d: { nameTh: string; nameEn: string | null }) => (locale === 'en' && d.nameEn ? d.nameEn : d.nameTh)

  return (
    <div className="flex flex-col gap-6">
      <div className="flex max-w-4xl flex-col gap-2">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="text-ink-muted">{t('intro')}</p>
        <p className="font-medium text-ink">{t(`scope.${scope}`)}</p>
        <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-ink">
          <span>{t('asOf', { time: formatDateTime(locale, asOf) })}</span>
          {/* a full reload: an installed app has no reload button of its own */}
          <a href={`/board/pending${query}`} className={linkClass}>
            {t('refresh')}
          </a>
        </p>
      </div>

      {/* keyed on the filters: "clear filters" shows the cleared choices, not the ones last picked */}
      <form key={query} method="get" action="/board/pending" className="flex flex-col gap-3 border-y border-line py-4 md:flex-row md:items-end">
        <div className="flex flex-col gap-1.5 md:w-72">
          <label htmlFor="board-department" className="font-medium text-ink">
            {t('filters.department')}
          </label>
          <select id="board-department" name="department" defaultValue={filter.departmentId ?? ''} className={selectClass}>
            <option value="">{t('filters.allDepartments')}</option>
            {departments
              .filter((d) => d.active)
              .map((d) => (
                <option key={d.id} value={d.id}>
                  {departmentName(d)}
                </option>
              ))}
          </select>
        </div>
        <div className="flex flex-col gap-1.5 md:w-64">
          <label htmlFor="board-type" className="font-medium text-ink">
            {t('filters.type')}
          </label>
          <select id="board-type" name="type" defaultValue={filter.subjectType ?? ''} className={selectClass}>
            <option value="">{t('filters.allTypes')}</option>
            {BOARD_SUBJECTS.map((s) => (
              <option key={s} value={s}>
                {t(`subject.${s}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-wrap items-center gap-x-4">
          <Button type="submit" variant="secondary">
            {t('filters.submit')}
          </Button>
          {filtered ? (
            <Link href="/board/pending" className={linkClass}>
              {t('filters.clear')}
            </Link>
          ) : null}
        </div>
      </form>

      <section aria-labelledby="board-people" className="flex flex-col gap-3">
        <h2 id="board-people" className="text-xl font-semibold">
          {t('table.title', { count: rows.length })}
        </h2>
        {rows.length === 0 ? (
          filtered ? (
            <EmptyState title={t('empty.filteredTitle')} hint={t('empty.filteredHint')} href="/board/pending" linkLabel={t('filters.clear')} />
          ) : (
            <EmptyState title={t('empty.title')} hint={t('empty.hint')} href="/tasks" linkLabel={t('empty.link')} />
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
                hours: t('table.hours'),
                overdueWord: t('table.overdueWord'),
                waitingWord: t('table.waitingWord'),
              }}
            />
          </>
        )}
      </section>
    </div>
  )
}
