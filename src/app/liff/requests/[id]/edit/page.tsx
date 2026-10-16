import { getLocale, getTranslations } from 'next-intl/server'
import type { ReactNode } from 'react'
import { chatIntakeIdOfRequest } from '@/server/queries/chat-intake'
import { getRequestAccess, isUuid } from '@/server/queries/requests'
import { getRequestForEdit } from '@/server/services/requests/form-view'
import { LIFF_HOME_PATH } from '@/ui/liff/bootstrap'
import { LiffContent, LiffFrame } from '@/ui/liff/frame'
import { LiffGate } from '@/ui/liff/liff-gate'
import { LiffLink } from '@/ui/liff/liff-link'
import { LiffNotice } from '@/ui/liff/notice'
import { LiffAiConfirm, type LiffAiConfirmItem } from '@/ui/liff/requests/ai-confirm'
import { LiffRequestForm } from '@/ui/liff/requests/request-form'
import { liffFormStart } from '@/ui/liff/requests/start'
import { editRefusal } from '../../../../(workspace)/_tracking/access'
import { liffPage } from '../../../_lib/session'
import { confirmAiValuesAction } from '../../actions'
import { LIFF_FORM_ACTIONS, LIFF_FORM_PATHS, liffRequestHref } from '../../_lib/form'
import { liffPrincipalOf, screenOf } from '../../_lib/principal'

export async function generateMetadata() {
  const t = await getTranslations('requestForm.page')
  return { title: t('metaEdit') }
}

// /liff/requests/[id]/edit: a draft or a returned request, for its requester to go on with in LINE (FR-INT-006 AC2: the
// same draft on any device; FR-INT-009 AC2: change a returned request and send it again). The same data as the
// workspace's edit page (getRequestForEdit: only the requester, only while it is a draft or returned) in the short form
// of LIFF. The address the form gives a new draft once its first save made it (../../new/[type]). Refused, the page says
// why in the web edit page's words and leads on (§9.9 rule 7): a request sent or cancelled to its page; a reader who is
// not its requester to its page when they may open it (the request page's own check, editRefusal), and to LIFF's home
// when they may not — never to a page that refuses them again; the requester whose account may no longer edit to their
// administrator.
export default async function LiffEditRequestPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const [t, tl, locale, page] = await Promise.all([getTranslations('requestForm.page'), getTranslations('liffRequests.form'), getLocale(), liffPage()])
  const back = { href: LIFF_FORM_PATHS.catalog, label: tl('backToCatalog') }
  if (page.kind !== 'member') {
    return (
      <LiffFrame title={t('metaEdit')} back={back}>
        <LiffContent>
          <LiffGate mode="member" state={page.kind} />
        </LiffContent>
      </LiffFrame>
    )
  }
  const screen = screenOf(locale)
  const result = isUuid(id) ? await getRequestForEdit(page.ctx, id, screen) : ({ ok: false, error: { code: 'NOT_FOUND' } } as const)
  if (!result.ok) {
    const refused = (title: string, tone: 'info' | 'warning', body: string, link: ReactNode) => (
      <LiffFrame title={title} back={back}>
        <LiffContent>
          <LiffNotice tone={tone}>{body}</LiffNotice>
          {link}
        </LiffContent>
      </LiffFrame>
    )
    const openRequest = <LiffLink href={liffRequestHref(id)}>{t('openRequest')}</LiffLink>
    if (result.error.code === 'INVALID_STATE_TRANSITION') {
      // The service names the status: a cancelled request says so, as it may never have been sent (DRAFT → CANCELLED,
      // §6.4). A request sent or cancelled is where it should be: information, as the web's edit page says it (--info).
      // Reloading the form right after sending opens this page, as the form's address became the draft's on its first save
      const cancelled = 'details' in result.error && result.error.details?.status === 'CANCELLED'
      return refused(cancelled ? t('cancelledTitle') : t('sentTitle'), 'info', cancelled ? t('cancelled') : t('sent'), openRequest)
    }
    if (result.error.code === 'FORBIDDEN') {
      // Not this account's to edit: who is reading decides what the page says and where it leads (editRefusal)
      const access = await getRequestAccess(page.ctx, id)
      const refusal = access ? editRefusal(await liffPrincipalOf(page.member.id), access) : ({ who: 'NONE', canOpen: false } as const)
      return refused(
        refusal.who === 'REQUESTER' ? t('lostEditTitle') : t('notYoursTitle'),
        'warning',
        refusal.who === 'REQUESTER' ? t('lostEdit') : refusal.who === 'VIEWER' ? t('viewOnly') : t('noAccess'),
        refusal.canOpen ? openRequest : <LiffLink href={LIFF_HOME_PATH}>{t('home')}</LiffLink>,
      )
    }
    return refused(tl('notFoundTitle'), 'warning', tl('notFound'), <LiffLink href={LIFF_FORM_PATHS.catalog}>{t('toCatalog')}</LiffLink>)
  }
  const data = result.data
  // S17-07 (BR-LINE-12): a draft made from the chat leads back to what was typed there, kept as a reference until purged
  const chatIntakeId = await chatIntakeIdOfRequest(page.ctx, id)
  const tc = await getTranslations('liffChat')
  const backTo = chatIntakeId ? { href: `${LIFF_FORM_PATHS.catalog}?intake=${chatIntakeId}`, label: tc('backToChat') } : back
  // S17-08 (BR-AI-16 BR-AI-17): values the AI put in that wait to be confirmed one by one, before the request can be sent
  const review = data.draft?.intakeAi ?? null
  // Exactly what request.submit would count (AI_REVIEW_PENDING): a value the requester changed no longer waits
  const waiting: LiffAiConfirmItem[] = review ? (review.pendingPaths ?? []).map((p) => aiItem(tc, p, review.proposed[p] ?? null)) : []
  return (
    <LiffFrame title={t(data.draft?.status === 'RETURNED' ? 'returnedTitle' : 'draftTitle', { type: data.type.name })} back={backTo}>
      {review && data.draft ? (
        <LiffAiConfirm
          requestId={data.draft.requestId}
          agentActionId={review.agentActionId}
          items={waiting}
          words={{ heading: tc('review.heading'), badge: tc('ai.badge'), intro: tc('review.intro'), confirm: tc('review.confirm'), working: tc('review.working'), failed: tc('review.failed') }}
          confirm={confirmAiValuesAction}
        />
      ) : null}
      <LiffRequestForm data={data} start={liffFormStart(data)} locale={screen} actions={LIFF_FORM_ACTIONS} paths={LIFF_FORM_PATHS} />
    </LiffFrame>
  )
}

const AI_LINE = /^lines\.(\d+)\.(description|quantity|uom|unitPrice)$/
type ChatWords = Awaited<ReturnType<typeof getTranslations<'liffChat'>>>

/** A value of the AI that waits, in words: what it is, and the value itself unless it was picked from a list */
function aiItem(tc: ChatWords, path: string, value: string | null): LiffAiConfirmItem {
  const line = AI_LINE.exec(path)
  if (line) {
    const no = Number(line[1]) + 1
    const field = line[2]
    const label =
      field === 'description' ? tc('review.line.description', { no }) : field === 'quantity' ? tc('review.line.quantity', { no }) : field === 'uom' ? tc('review.line.uom', { no }) : tc('review.line.unitPrice', { no })
    return { path, label, value }
  }
  if (path === 'deliverySiteId') return { path, label: tc('review.path.deliverySiteId'), value: null }
  if (path === 'suggestedSupplierId') return { path, label: tc('review.path.suggestedSupplierId'), value: null }
  if (path === 'requestTypeCode') return { path, label: tc('review.path.requestTypeCode'), value: null }
  return { path, label: path === 'title' ? tc('review.path.title') : tc('review.path.other'), value }
}
