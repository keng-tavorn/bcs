import { getLocale, getTranslations } from 'next-intl/server'
import { listReceivable } from '@/server/services/receiving/view'
import { formatDateTime } from '@/ui/format'
import { LIFF_START_PATH } from '@/ui/liff/bootstrap'
import { LiffContent, LiffFrame } from '@/ui/liff/frame'
import { LiffReceivableList, LiffWebAnchor } from '@/ui/liff/home/work-lists'
import { LiffGate } from '@/ui/liff/liff-gate'
import { LiffLink } from '@/ui/liff/liff-link'
import { LiffNotice } from '@/ui/liff/notice'
import { liffHref } from '../_lib/links'
import { liffPage } from '../_lib/session'

export async function generateMetadata() {
  const t = await getTranslations('liffLists')
  return { title: t('gr.title') }
}

// /liff/gr, the rich menu's "ตรวจรับ" (FR-LINE-303 AC3 · §9.4 · S17-04): the POs the member may receive now — the first
// page of the web's /receiving list from the same service (listReceivable: scope and separation of duties of gr.post,
// BR-SOD-02 BR-SOD-07), oldest sent first, each opening /liff/gr/[poId] where it is received with photos. Someone who
// does not receive goods, or has nothing to receive, sees an empty list with the way home; POs separation of duties
// keeps from them are counted, not listed. The service decides who sees what; the menu is not a permission (BR-AUTH-05).
export default async function LiffReceivableListPage() {
  const [page, t, locale] = await Promise.all([liffPage(), getTranslations('liffLists'), getLocale()])
  if (page.kind !== 'member') {
    return (
      <LiffFrame title={t('gr.title')}>
        <LiffContent>
          <LiffGate mode="member" state={page.kind} />
        </LiffContent>
      </LiffFrame>
    )
  }
  const result = await listReceivable(page.ctx)
  const data = result.ok && result.data.receives ? result.data : null
  const name = (n: { th: string; en: string | null }) => (locale === 'en' && n.en ? n.en : n.th)
  const rows = (data?.rows ?? []).map((c) => ({
    id: c.id,
    href: liffHref(`/receiving/${c.id}`) ?? `/receiving/${c.id}`,
    title: `${c.number ?? '—'} · ${name(c.supplier)}`,
    lines: [
      ...(c.site ? [t('gr.site', { site: name(c.site) })] : []),
      ...(c.requests.length ? [t('gr.requests', { numbers: c.requests.map((r) => r.number ?? '—').join(', ') })] : []),
      ...(c.sentAt ? [t('gr.sent', { at: formatDateTime(locale, c.sentAt) })] : []),
      t('gr.outstanding', { left: c.outstandingLines, lines: c.lineCount }),
    ],
  }))
  return (
    <LiffFrame title={t('gr.title')} back={{ href: LIFF_START_PATH, label: t('home') }}>
      <LiffContent>
        <p className="text-ink-muted">{t('gr.intro')}</p>
        {rows.length ? (
          <>
            <p className="font-medium text-ink">{t('gr.count', { count: rows.length })}</p>
            <LiffReceivableList rows={rows} label={t('gr.list')} />
          </>
        ) : (
          <div className="flex flex-col gap-2 border-y border-line py-5">
            <p className="font-medium text-ink">{t('gr.empty')}</p>
            <p className="text-ink-muted">{t('gr.emptyHint')}</p>
            <LiffLink href={LIFF_START_PATH}>{t('home')}</LiffLink>
          </div>
        )}
        {data && data.blocked.length ? <LiffNotice tone="info">{t('gr.blocked', { count: data.blocked.length })}</LiffNotice> : null}
        {data && data.pageCount > 1 ? <LiffWebAnchor href="/receiving" text={t('gr.more', { total: data.total })} webHint={t('webHint')} /> : null}
      </LiffContent>
    </LiffFrame>
  )
}
