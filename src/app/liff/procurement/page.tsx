import { getTranslations } from 'next-intl/server'
import { PROCUREMENT_SUMMARY_PO_STATUSES, procurementSummary } from '@/server/services/procurement/summary'
import { LIFF_START_PATH } from '@/ui/liff/bootstrap'
import { LiffContent, LiffFrame, LiffSection } from '@/ui/liff/frame'
import { LiffCountList, LiffWebAnchor } from '@/ui/liff/home/work-lists'
import { LiffGate } from '@/ui/liff/liff-gate'
import { LiffLink } from '@/ui/liff/liff-link'
import { LiffNotice } from '@/ui/liff/notice'
import { posHref } from '../../(workspace)/_tracking/list-filters'
import { liffPage } from '../_lib/session'

export async function generateMetadata() {
  const t = await getTranslations('liffLists')
  return { title: t('procurement.title') }
}

// /liff/procurement, the rich menu's "งานจัดซื้อ" (FR-LINE-303 AC4 · §9.4 · S17-04): purchasing's work in numbers — the
// lines waiting in the pool (the urgent ones among them) and the POs at each step — read only, each opening its list on
// the web outside LINE, where the work is done. procurement.pool.view is checked in the service (procurementSummary): a
// member without it sees that the page is not for them, and no number at all. The menu is not a permission (BR-AUTH-05).
export default async function LiffProcurementPage() {
  const [page, t, tp] = await Promise.all([liffPage(), getTranslations('liffLists'), getTranslations('purchaseOrder')])
  if (page.kind !== 'member') {
    return (
      <LiffFrame title={t('procurement.title')}>
        <LiffContent>
          <LiffGate mode="member" state={page.kind} />
        </LiffContent>
      </LiffFrame>
    )
  }
  const result = await procurementSummary(page.ctx)
  return (
    <LiffFrame title={t('procurement.title')} back={{ href: LIFF_START_PATH, label: t('home') }}>
      <LiffContent>
        {result.ok ? (
          <>
            <p className="text-ink-muted">{t('procurement.intro')}</p>
            <LiffSection id="liff-procurement-pool" title={t('procurement.pool')}>
              <p className="text-lg font-semibold text-ink tabular-nums">{t('procurement.poolCount', { count: result.data.poolLines })}</p>
              {result.data.urgentLines ? <p className="text-ink">{t('procurement.urgent', { count: result.data.urgentLines })}</p> : null}
              <LiffWebAnchor href="/procurement/pool" text={t('procurement.openPool')} webHint={t('webHint')} />
            </LiffSection>
            <LiffSection id="liff-procurement-pos" title={t('procurement.pos')}>
              <LiffCountList
                label={t('procurement.posList')}
                webHint={t('webHint')}
                rows={PROCUREMENT_SUMMARY_PO_STATUSES.map((status) => ({
                  key: status,
                  label: tp(`status.${status}`),
                  count: t('procurement.poCount', { count: result.data.posByStatus[status] }),
                  href: posHref('/procurement/pos', { status }),
                }))}
              />
            </LiffSection>
          </>
        ) : (
          <>
            <LiffNotice tone="warning" role="status">
              <p className="font-medium">{t('procurement.denied')}</p>
              <p className="text-ink-muted">{t('procurement.deniedHint')}</p>
            </LiffNotice>
            <LiffLink href={LIFF_START_PATH}>{t('home')}</LiffLink>
          </>
        )}
      </LiffContent>
    </LiffFrame>
  )
}
