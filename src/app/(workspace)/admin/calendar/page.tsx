import { getLocale, getTranslations } from 'next-intl/server'
import { buddhistYear, formatEnglishBeDate, formatThaiDate } from '@/core/thai/date'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { getCalendarAdminView, type CalendarHolidayDto } from '@/server/services/calendar'
import { BusinessHoursForm } from '@/ui/admin-settings/business-hours-form'
import { HolidayImportForm } from '@/ui/admin-settings/holiday-import-form'
import { NoAccess } from '@/ui/admin-settings/no-access'
import { getSession } from '../../../_lib/session'
import { checkHolidayImportAction, importHolidaysAction, saveBusinessHoursAction } from './actions'

export async function generateMetadata() {
  const t = await getTranslations('adminSettings.calendar')
  return { title: t('title') }
}

// Business calendar and holidays (FR-ADM-003, §9.1 /admin/*). Wide screens: business hours then the holidays on the
// left, the import on the right. Phones: hours, import, then the list (DOM order), so the actions come first.
export default async function CalendarPage() {
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  const [t, tCommon, locale] = await Promise.all([getTranslations('adminSettings.calendar'), getTranslations('adminSettings'), getLocale()])
  if (!ctx) return null
  const view = await getCalendarAdminView(ctx)
  if (!view.ok) return <NoAccess title={t('title')} message={tCommon('forbidden')} homeLabel={tCommon('homeLink')} />
  const { hours, holidays, fromYear, importYears } = view.data
  const beYear = (year: number) => buddhistYear(`${year}-07-01`)
  const formatDate = (date: string) => (locale === 'en' ? formatEnglishBeDate(date) : formatThaiDate(date))
  const byYear = new Map<number, CalendarHolidayDto[]>()
  for (const h of holidays) {
    const year = buddhistYear(h.date)
    byYear.set(year, [...(byYear.get(year) ?? []), h])
  }

  return (
    <div className="flex flex-col gap-8">
      <div className="flex max-w-3xl flex-col gap-2">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="text-ink-muted">{t('intro')}</p>
      </div>

      <div className="flex flex-col gap-10 lg:grid lg:grid-cols-[minmax(0,1fr)_24rem] lg:grid-rows-[auto_1fr] lg:items-start lg:gap-x-12">
        <section aria-labelledby="hours" className="flex flex-col gap-4 lg:col-start-1 lg:row-start-1">
          <h2 id="hours" className="text-xl font-semibold">
            {t('hoursTitle')}
          </h2>
          <BusinessHoursForm initial={{ workdays: hours.workdays, start: hours.start, end: hours.end }} timezone={hours.timezone} save={saveBusinessHoursAction} />
        </section>

        <section aria-labelledby="import" className="flex flex-col gap-4 lg:col-start-2 lg:row-span-2 lg:row-start-1">
          <h2 id="import" className="text-xl font-semibold">
            {t('importTitle')}
          </h2>
          <HolidayImportForm
            templateHref="/admin/calendar/template"
            years={{ from: beYear(importYears.from), to: beYear(importYears.to) }}
            check={checkHolidayImportAction}
            importRows={importHolidaysAction}
          />
        </section>

        <section aria-labelledby="holidays" className="flex flex-col gap-4 border-t border-line pt-6 lg:col-start-1 lg:row-start-2">
          <h2 id="holidays" className="text-xl font-semibold">
            {t('holidaysTitle', { year: beYear(fromYear) })}
          </h2>
          {holidays.length === 0 ? (
            <p className="text-ink-muted">{t('holidaysEmpty')}</p>
          ) : (
            [...byYear.entries()].map(([year, items]) => (
              <section key={year} aria-labelledby={`year-${year}`} className="flex flex-col gap-2">
                <h3 id={`year-${year}`} className="text-lg font-semibold">
                  {t('yearHeading', { year, count: items.length })}
                </h3>
                <ul className="flex flex-col divide-y divide-line border-y border-line">
                  {items.map((h) => (
                    <li key={h.date} className="flex flex-col gap-0.5 py-2.5 sm:flex-row sm:items-baseline sm:gap-6">
                      <span className="tabular shrink-0 font-medium sm:w-56">
                        {formatDate(h.date)} <span className="font-normal text-ink-muted">· {t('holidayDay', { weekday: t(`weekdays.${h.weekday}`) })}</span>
                      </span>
                      <span>{h.nameTh}</span>
                    </li>
                  ))}
                </ul>
              </section>
            ))
          )}
        </section>
      </div>
    </div>
  )
}
