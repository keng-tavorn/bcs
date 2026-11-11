import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { portalRfx } from '@/server/portal/queries-rfx'
import { isUuid } from '@/server/queries/requests'
import { BidForm, type BidFormWords } from '@/ui/portal/bid-form'
import { PortalFrame, PortalNotice } from '@/ui/portal/frame'
import { one, pageOrg, pageSession, Unavailable, type SearchParams } from '../../../_lib/page'
import { contactLocale, fileErrorWords, rfxErrorText, type PortalT } from '../../_lib/words'

// /portal/[org]/rfx/[id]/bid (S10-07 · FR-SRC-202 AC2 · BR-RFX-07 08): the contact of an ACTIVE supplier bids, step by step
// (BidForm: prices, delivery and note, files, check and send), or answers an RFI (its answer and files); a bid already
// sent is changed and sent again until the close. The form starts from the bid as last saved or sent. Closed, declined,
// an application's contact or a supplier not ACTIVE: the page says so and links back to the RFx.

const OPEN_STATES = new Set(['NOT_SUBMITTED', 'DRAFT', 'SUBMITTED', 'RECONFIRM'])
const SCANS = ['PENDING', 'CLEAN', 'INFECTED', 'NOT_SCANNED', 'NOT_REQUIRED'] as const

function wordsOf(t: PortalT, validityDays: number): BidFormWords {
  return {
    stepOf: t('rfx.bid.stepOf', { n: '{n}', total: '{total}' }),
    steps: { prices: t('rfx.bid.steps.prices'), terms: t('rfx.bid.steps.terms'), files: t('rfx.bid.steps.files'), review: t('rfx.bid.steps.review'), answer: t('rfx.bid.steps.answer') },
    unitPrice: t('rfx.bid.unitPrice'),
    quantity: t('rfx.bid.quantity', { quantity: '{quantity}', uom: '{uom}' }),
    currency: t('rfx.bid.currency'),
    notOffered: t('rfx.bid.notOffered'),
    vatIncluded: t('rfx.bid.vatIncluded'),
    vatIncludedHint: t('rfx.bid.vatIncludedHint'),
    priceInvalid: t('rfx.bid.priceInvalid'),
    deliveryDays: t('rfx.bid.deliveryDays'),
    promisedDeliveryOn: t('rfx.bid.promisedDeliveryOn'),
    note: t('rfx.bid.note'),
    answer: t('rfx.bid.answer'),
    validity: t('rfx.bid.validity', { days: validityDays }),
    filesHint: t('rfx.bid.filesHint'),
    fileChoose: t('rfx.bid.fileChoose'),
    fileUpload: t('rfx.bid.fileUpload'),
    fileUploading: t('rfx.bid.fileUploading'),
    fileRemove: t('rfx.bid.fileRemove'),
    fileNone: t('rfx.bid.fileNone'),
    scan: Object.fromEntries(SCANS.map((s) => [s, t(`rfx.bid.scan.${s}`)])),
    fileError: t('rfx.bid.fileError'),
    fileErrors: fileErrorWords(t),
    lineAmount: t('rfx.bid.lineAmount'),
    net: t('rfx.bid.net'),
    vat: t('rfx.bid.vat'),
    gross: t('rfx.bid.gross'),
    vatNotRegistered: t('rfx.bid.vatNotRegistered'),
    vatRateMissing: t('rfx.bid.vatRateMissing'),
    missing: t('rfx.bid.missing', { lines: '{lines}' }),
    noPrice: t('rfx.bid.noPrice'),
    back: t('rfx.bid.back'),
    next: t('rfx.bid.next'),
    saveDraft: t('rfx.bid.saveDraft'),
    submit: t('rfx.bid.submit'),
    submitAgain: t('rfx.bid.submitAgain'),
    actions: t('rfx.bid.actions'),
  }
}

export default async function PortalBidPage({ params, searchParams }: { params: Promise<{ org: string; id: string }>; searchParams: SearchParams }) {
  const { org: orgCode, id } = await params
  const org = await pageOrg(orgCode)
  if (!org) return <Unavailable />
  const session = await pageSession(org)
  if (!session) redirect(`/portal/${org.code}/login`)
  if (!isUuid(id)) redirect(`/portal/${org.code}/rfx?error=NOT_FOUND`)
  const locale = contactLocale(session.state.contact)
  const [t, q, rfx] = await Promise.all([getTranslations({ locale, namespace: 'portal' }), searchParams, portalRfx(session.state.ctx, id)])
  if (!rfx) redirect(`/portal/${org.code}/rfx?error=NOT_FOUND`)
  const en = locale === 'en'
  const base = `/portal/${org.code}`
  const number = rfx.number ?? t('rfx.list.noNumber')
  const rfi = rfx.kind === 'RFI'
  const error = one(q.error)
  const back = (
    <a href={`${base}/rfx/${rfx.id}`} className="text-primary underline underline-offset-4">
      {t('rfx.bid.backToRfx')}
    </a>
  )
  const title = rfi ? t('rfx.bid.titleRfi', { number }) : t('rfx.bid.title', { number })
  if (!OPEN_STATES.has(rfx.portalStatus) || rfx.bidder !== 'SUPPLIER') {
    return (
      <PortalFrame organization={org.nameTh} title={title}>
        <PortalNotice tone="info">{rfx.bidder === 'APPLICATION' ? t('rfx.detail.applicationWaits') : rfx.bidder === 'NOT_ACTIVE' ? t('rfx.detail.notActive') : t('rfx.bid.closed')}</PortalNotice>
        {back}
      </PortalFrame>
    )
  }
  const bid = rfx.bid
  const priceOf = new Map((bid?.lines ?? []).map((l) => [l.rfxLineId, l]))
  return (
    <PortalFrame organization={org.nameTh} title={title}>
      {one(q.saved) ? <PortalNotice tone="success">{t('rfx.notices.saved')}</PortalNotice> : null}
      {error ? <PortalNotice tone="danger">{rfxErrorText(t, error, one(q.reason), one(q.lines))}</PortalNotice> : null}
      <p>{en && rfx.titleEn ? rfx.titleEn : rfx.title}</p>
      <BidForm
        action={`${base}/api/rfx/bid`}
        fileAction={`${base}/api/rfx/file`}
        csrf={session.csrf}
        rfxEventId={rfx.id}
        rfi={rfi}
        bidId={bid?.id ?? null}
        version={bid?.version ?? null}
        sent={bid?.status === 'SUBMITTED'}
        allowPartial={rfx.allowPartialBids}
        vatInclusiveAllowed={rfx.vatInclusiveAllowed}
        priceIncludesVat={bid?.priceIncludesVat ?? false}
        vatRateBp={rfx.vatRateBp}
        lines={rfx.lines.map((l) => {
          const mine = priceOf.get(l.id)
          return {
            id: l.id,
            lineNo: l.lineNo,
            description: en && l.descriptionEn ? l.descriptionEn : l.description,
            quantity: l.quantity,
            uom: en && l.uomEn ? l.uomEn : l.uom,
            unitPrice: mine?.unitPrice ?? '',
            notOffered: mine !== undefined && !mine.offered,
          }
        })}
        deliveryDays={bid?.deliveryDays === null || bid?.deliveryDays === undefined ? '' : String(bid.deliveryDays)}
        promisedDeliveryOn={bid?.promisedDeliveryOn ? bid.promisedDeliveryOn.toISOString().slice(0, 10) : ''}
        note={bid?.note ?? ''}
        files={bid?.files ?? []}
        words={wordsOf(t, rfx.bidValidityDays)}
      />
      {back}
    </PortalFrame>
  )
}
