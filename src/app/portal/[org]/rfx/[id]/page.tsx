import { randomUUID } from 'node:crypto'
import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { amountToSatang } from '@/core/money/dto'
import { formatSatang } from '@/core/money/format'
import { RFX_QUESTION_MAX } from '@/lib/constants'
import { portalRfx } from '@/server/portal/queries-rfx'
import { isUuid } from '@/server/queries/requests'
import { primaryLinkClass, textareaClass } from '@/ui/liff/requests/classes'
import { PortalButton, PortalFrame, PortalNotice, portalInputClass } from '@/ui/portal/frame'
import { MarkViewed } from '@/ui/portal/mark-viewed'
import { one, pageOrg, pageSession, Unavailable, type SearchParams } from '../../_lib/page'
import { contactLocale, dateTimeOf, dayOf, remainingText, rfxErrorText, rfxKindOf, textIn } from '../_lib/words'

// /portal/[org]/rfx/[id] (S10-07 · FR-SRC-202 AC1 · BR-RFX-04 · BR-FORM-11 · INV-RFX-01): one RFx the contact is invited to,
// in the contact's language (the English text when the RFx has it) — its kind and the contact's state, the close with the
// time left, the cutoff of questions and the revision; the lines, the RFx's documents (opened by a POST), the
// amendments; the contact's own bid; the questions answered to everyone and its own, with the form to ask until the
// cutoff; and what the contact can do: bid (or change and send again), withdraw, decline, or see the result. The page
// writes nothing on its GET: MarkViewed POSTs portal.rfx.view once after it loads. The contact of an application reads
// and asks, and is told it can bid once approved (OQ-202).

const OPEN_STATES = new Set(['NOT_SUBMITTED', 'DRAFT', 'SUBMITTED', 'RECONFIRM'])
const linkClass = 'text-primary underline underline-offset-4'
const baht = (amount: string) => formatSatang(amountToSatang(amount))

export default async function PortalRfxPage({ params, searchParams }: { params: Promise<{ org: string; id: string }>; searchParams: SearchParams }) {
  const { org: orgCode, id } = await params
  const org = await pageOrg(orgCode)
  if (!org) return <Unavailable />
  const session = await pageSession(org)
  if (!session) redirect(`/portal/${org.code}/login`)
  if (!isUuid(id)) redirect(`/portal/${org.code}/rfx?error=NOT_FOUND`)
  const { ctx } = session.state
  const locale = contactLocale(session.state.contact)
  const [t, q, rfx] = await Promise.all([getTranslations({ locale, namespace: 'portal' }), searchParams, portalRfx(ctx, id)])
  if (!rfx) redirect(`/portal/${org.code}/rfx?error=NOT_FOUND`)
  const base = `/portal/${org.code}`
  const number = rfx.number ?? t('rfx.list.noNumber')
  const open = OPEN_STATES.has(rfx.portalStatus)
  const rfi = rfx.kind === 'RFI'
  const remaining = open ? remainingText(t, rfx.closesAt, ctx.now) : null
  const mayAsk = open && rfx.questionCutoffAt !== null && ctx.now.getTime() < rfx.questionCutoffAt.getTime()
  const sent = rfx.bid?.status === 'SUBMITTED'
  const mayDecline = open && !sent && (rfx.inviteStatus === 'INVITED' || rfx.inviteStatus === 'VIEWED')
  const error = one(q.error)
  const notice = (['sent', 'saved', 'withdrawn', 'declined', 'asked'] as const).find((k) => one(q[k]))
  const bidLabel = rfi ? t('rfx.detail.answerRfi') : rfx.portalStatus === 'DRAFT' ? t('rfx.detail.continueBid') : sent ? t('rfx.detail.editBid') : t('rfx.detail.bid')

  return (
    <PortalFrame organization={org.nameTh} title={`${number} ${textIn(locale, rfx.title, rfx.titleEn)}`}>
      {rfx.inviteStatus === 'INVITED' ? <MarkViewed action={`${base}/api/rfx/respond`} csrf={session.csrf} rfxEventId={rfx.id} /> : null}
      {notice ? <PortalNotice tone="success">{t(`rfx.notices.${notice}`)}</PortalNotice> : null}
      {error ? <PortalNotice tone="danger">{rfxErrorText(t, error, one(q.reason), one(q.lines))}</PortalNotice> : null}
      <p>{t('rfx.detail.kindAndStatus', { kind: t(`rfx.kind.${rfxKindOf(rfx.kind)}`), status: t(`rfx.status.${rfx.portalStatus}`) })}</p>
      <div className="flex flex-col gap-1">
        {rfx.closesAt ? <p className="tabular">{t('rfx.detail.closesAt', { date: dateTimeOf(locale, rfx.closesAt) })}</p> : null}
        <p className="font-medium">{remaining ?? t('rfx.detail.closed')}</p>
        {rfx.questionCutoffAt ? <p className="tabular text-ink-muted">{t('rfx.detail.questionCutoff', { date: dateTimeOf(locale, rfx.questionCutoffAt) })}</p> : null}
        <p className="text-ink-muted">{t('rfx.detail.revision', { n: rfx.revisionNo })}</p>
      </div>
      {rfx.portalStatus === 'RECONFIRM' ? <PortalNotice tone="warning">{t('rfx.detail.reconfirm')}</PortalNotice> : null}
      {open && rfx.bidder === 'APPLICATION' ? <PortalNotice tone="info">{t('rfx.detail.applicationWaits')}</PortalNotice> : null}
      {open && rfx.bidder === 'NOT_ACTIVE' ? <PortalNotice tone="info">{t('rfx.detail.notActive')}</PortalNotice> : null}

      <section aria-labelledby="description" className="flex flex-col gap-2">
        <h2 id="description" className="text-lg font-semibold">
          {t('rfx.detail.description')}
        </h2>
        <p className="whitespace-pre-line">{textIn(locale, rfx.description, rfx.descriptionEn)}</p>
      </section>

      {rfi ? null : (
        <section aria-labelledby="lines" className="flex flex-col gap-2 border-t border-line pt-5">
          <h2 id="lines" className="text-lg font-semibold">
            {t('rfx.detail.lines')}
          </h2>
          {/* NG-9 · BR-FORM-11: baht only, never converted */}
          <p className="text-ink-muted">{t('rfx.detail.pricesInBaht')}</p>
          <ol className="flex flex-col divide-y divide-line border-y border-line">
            {rfx.lines.map((l) => (
              <li key={l.id} className="flex flex-col gap-1 py-3">
                <span className="font-medium">
                  {l.lineNo}. {textIn(locale, l.description, l.descriptionEn)}
                </span>
                <span className="tabular">{t('rfx.detail.line', { quantity: l.quantity, uom: textIn(locale, l.uom, l.uomEn) })}</span>
                {l.requiredDeliveryOn ? <span className="tabular text-ink-muted">{t('rfx.detail.requiredBy', { date: dayOf(locale, l.requiredDeliveryOn) })}</span> : null}
              </li>
            ))}
          </ol>
        </section>
      )}

      <section aria-labelledby="files" className="flex flex-col gap-2 border-t border-line pt-5">
        <h2 id="files" className="text-lg font-semibold">
          {t('rfx.detail.files')}
        </h2>
        {rfx.files.length ? (
          <ul className="flex flex-col gap-2">
            {rfx.files.map((f) => (
              <li key={f.id}>
                {/* a five-minute link from a POST (BR-PORTAL ข้อ 07), never a GET that writes the download's event */}
                <form method="post" action={`${base}/api/rfx/file`}>
                  <input type="hidden" name="csrf" value={session.csrf} />
                  <input type="hidden" name="rfxEventId" value={rfx.id} />
                  <input type="hidden" name="fileId" value={f.id} />
                  <input type="hidden" name="action" value="download" />
                  <PortalButton type="submit" variant="link">
                    {t('rfx.detail.download', { name: f.fileName })}
                  </PortalButton>
                </form>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-ink-muted">{t('rfx.detail.noFiles')}</p>
        )}
      </section>

      {rfx.amendments.length ? (
        <section aria-labelledby="amendments" className="flex flex-col gap-2 border-t border-line pt-5">
          <h2 id="amendments" className="text-lg font-semibold">
            {t('rfx.detail.amendments')}
          </h2>
          <ul className="flex flex-col gap-2">
            {rfx.amendments.map((a) => (
              <li key={a.revisionNo}>{t('rfx.detail.amendment', { n: a.revisionNo, date: dayOf(locale, a.createdAt), summary: textIn(locale, a.summary, a.summaryEn) })}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {rfx.bid && rfx.bid.status !== 'WITHDRAWN' ? (
        <section aria-labelledby="your-bid" className="flex flex-col gap-1 border-t border-line pt-5">
          <h2 id="your-bid" className="text-lg font-semibold">
            {t('rfx.detail.yourBid')}
          </h2>
          {rfx.bid.status === 'DRAFT' ? <p>{t('rfx.detail.bidDraft')}</p> : null}
          {rfx.bid.submittedAt && rfx.bid.status !== 'DRAFT' ? <p className="tabular">{t('rfx.detail.bidSent', { count: rfx.bid.submitCount, date: dateTimeOf(locale, rfx.bid.submittedAt) })}</p> : null}
          {sent && !rfi ? <p className="tabular">{t('rfx.detail.bidAmounts', { net: baht(rfx.bid.net), vat: baht(rfx.bid.vat), gross: baht(rfx.bid.gross) })}</p> : null}
          {sent && rfx.bid.validUntil ? <p className="tabular text-ink-muted">{t('rfx.detail.bidValidUntil', { date: dayOf(locale, rfx.bid.validUntil) })}</p> : null}
        </section>
      ) : null}

      <section aria-labelledby="actions" className="flex flex-col gap-3 border-t border-line pt-5">
        <h2 id="actions" className="sr-only">
          {t('rfx.bid.actions')}
        </h2>
        {open && rfx.bidder === 'SUPPLIER' ? (
          <a href={`${base}/rfx/${rfx.id}/bid`} className={primaryLinkClass}>
            {bidLabel}
          </a>
        ) : null}
        {open ? null : (
          <a href={`${base}/rfx/${rfx.id}/result`} className={primaryLinkClass}>
            {t('rfx.detail.result')}
          </a>
        )}
        {open && sent ? (
          <form method="post" action={`${base}/api/rfx/bid`} className="flex flex-col gap-1">
            <input type="hidden" name="csrf" value={session.csrf} />
            <input type="hidden" name="rfxEventId" value={rfx.id} />
            <input type="hidden" name="action" value="withdraw" />
            <input type="hidden" name="key" value={randomUUID()} />
            <PortalButton type="submit" variant="danger">
              {t('rfx.detail.withdraw')}
            </PortalButton>
            <p className="text-sm text-ink-muted">{t('rfx.detail.withdrawHint')}</p>
          </form>
        ) : null}
        {mayDecline ? (
          <form method="post" action={`${base}/api/rfx/respond`} className="flex flex-col gap-2">
            <input type="hidden" name="csrf" value={session.csrf} />
            <input type="hidden" name="rfxEventId" value={rfx.id} />
            <input type="hidden" name="action" value="decline" />
            <input type="hidden" name="key" value={randomUUID()} />
            <label htmlFor="reason" className="font-medium">
              {t('rfx.detail.declineReason')}
            </label>
            <input id="reason" name="reason" maxLength={500} className={portalInputClass} />
            <PortalButton type="submit" variant="danger">
              {t('rfx.detail.decline')}
            </PortalButton>
            <p className="text-sm text-ink-muted">{t('rfx.detail.declineHint')}</p>
          </form>
        ) : null}
      </section>

      <section aria-labelledby="questions" className="flex flex-col gap-3 border-t border-line pt-5">
        <h2 id="questions" className="text-lg font-semibold">
          {t('rfx.questions.title')}
        </h2>
        {rfx.questions.length ? (
          <ul className="flex flex-col divide-y divide-line border-y border-line">
            {rfx.questions.map((x) => (
              <li key={x.id} className="flex flex-col gap-1 py-3">
                {x.mine ? <span className="text-sm text-ink-muted">{t('rfx.questions.mine')}</span> : null}
                <span className="whitespace-pre-line">{x.question}</span>
                <span className="whitespace-pre-line text-ink-muted">{x.answer ? t('rfx.questions.answer', { answer: x.answer }) : t('rfx.questions.waiting')}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-ink-muted">{t('rfx.questions.empty')}</p>
        )}
        {mayAsk ? (
          <form method="post" action={`${base}/api/rfx/respond`} className="flex flex-col gap-2">
            <input type="hidden" name="csrf" value={session.csrf} />
            <input type="hidden" name="rfxEventId" value={rfx.id} />
            <input type="hidden" name="action" value="ask" />
            <input type="hidden" name="key" value={randomUUID()} />
            <label htmlFor="question" className="font-medium">
              {t('rfx.questions.question')}
            </label>
            <textarea id="question" name="question" required maxLength={RFX_QUESTION_MAX} aria-describedby="question-hint" className={textareaClass} />
            <p id="question-hint" className="text-sm text-ink-muted">
              {t('rfx.questions.hint')}
            </p>
            <PortalButton type="submit" variant="secondary">
              {t('rfx.questions.send')}
            </PortalButton>
          </form>
        ) : open ? (
          <p className="text-ink-muted">{t('rfx.questions.cutoffPassed')}</p>
        ) : null}
      </section>

      <a href={`${base}/rfx`} className={linkClass}>
        {t('rfx.detail.back')}
      </a>
    </PortalFrame>
  )
}
