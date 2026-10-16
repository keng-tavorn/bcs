import { getLocale, getTranslations } from 'next-intl/server'
import { getMyChatIntake, listMyOpenChatIntakes } from '@/server/queries/chat-intake'
import { chatIntakeAiView } from '@/server/services/chat-intake'
import { listMyOpenDrafts, listRequestCatalog } from '@/server/queries/request-form'
import { formatDateTime } from '@/ui/format'
import { LiffContent, LiffFrame, LiffSection } from '@/ui/liff/frame'
import { LiffGate } from '@/ui/liff/liff-gate'
import { LiffLink } from '@/ui/liff/liff-link'
import { LiffNotice } from '@/ui/liff/notice'
import { LiffCatalog } from '@/ui/liff/requests/catalog'
import { LiffChatIntakePanel } from '@/ui/liff/requests/chat-intake'
import { liffHref } from '../../../_lib/links'
import { liffPage } from '../../../_lib/session'
import { dismissChatIntakeAction, draftFromChatAction } from '../../actions'
import { LIFF_FORM_PATHS, liffDraftHref } from '../../_lib/form'
import { screenOf } from '../../_lib/principal'

export async function generateMetadata() {
  const t = await getTranslations('request.catalog')
  return { title: t('title') }
}

/** How many of the requester's own drafts the catalogue offers to go on with (as on the web) */
const OPEN_DRAFTS_SHOWN = 5
/** How many open chat drafts the page offers when opened without one (BR-LINE-15) */
const CHAT_DRAFTS_SHOWN = 5

// /liff/requests/new (§9.4 "แคตตาล็อกและฟอร์มแบบย่อ", the rich menu's "ขอซื้อ": FR-INT-001 AC3, FR-LINE-004 AC2): the one
// door every request starts from in LINE — the request types the organization switched on, each saying when to use it,
// with a search (FR-INT-001 AC1 AC2); a type opens its short form (../[type]/page.tsx). The requester's drafts and
// returned requests are here too, from whichever device they began on (FR-INT-006 AC2). The same queries as the
// workspace's catalogue. A member only: without a session the gate signs in with LINE first.
// S17-07 (FR-LINE-301 AC4 · BR-LINE-12, BR-LINE-15): ?intake=<id> — the button the chat answered with — shows that chat
// draft of the member's (anyone else's is not found) for them to pick a type and make the request draft; without it the
// member's open chat drafts are offered above the types, the way back when the chat's button did not come. Opening the
// page never makes a draft: only the button does (chat_intake.draft).
export default async function LiffNewRequestPage({ searchParams }: { searchParams: Promise<{ intake?: string | string[] }> }) {
  const [t, tl, tc, locale, page, query] = await Promise.all([
    getTranslations('request.catalog'),
    getTranslations('liffRequests.catalog'),
    getTranslations('liffChat'),
    getLocale(),
    liffPage(),
    searchParams,
  ])
  if (page.kind !== 'member') {
    return (
      <LiffFrame title={t('title')}>
        <LiffContent>
          <LiffGate mode="member" state={page.kind} />
        </LiffContent>
      </LiffFrame>
    )
  }
  const screen = screenOf(locale)
  const intakeId = typeof query.intake === 'string' ? query.intake : null
  const [types, drafts, intake, chats] = await Promise.all([
    listRequestCatalog(page.ctx, screen),
    intakeId ? Promise.resolve([]) : listMyOpenDrafts(page.ctx, screen, OPEN_DRAFTS_SHOWN),
    intakeId ? getMyChatIntake(page.ctx, intakeId) : Promise.resolve(null),
    intakeId ? Promise.resolve([]) : listMyOpenChatIntakes(page.ctx, CHAT_DRAFTS_SHOWN),
  ])
  if (intake?.ok) {
    const view = intake.data
    // S17-08: the AI's reading of it, when there is one (none with AI off: the form works on alone, AC6)
    const ai = view.status === 'OPEN' ? await chatIntakeAiView(page.ctx, view.id, screen) : null
    return (
      <LiffFrame title={tc('pageTitle')} back={{ href: LIFF_FORM_PATHS.catalog, label: tc('toCatalog') }}>
        <LiffContent>
          <LiffChatIntakePanel
            intake={{ ...view, requestHref: view.requestId ? liffDraftHref(view.requestId) : null }}
            types={types}
            catalogHref={LIFF_FORM_PATHS.catalog}
            ai={ai?.ok ? ai.data : { status: 'NONE' }}
            draft={draftFromChatAction}
            dismiss={dismissChatIntakeAction}
          />
        </LiffContent>
      </LiffFrame>
    )
  }
  const track = liffHref('/requests')
  return (
    <LiffFrame title={t('title')}>
      <LiffContent>
        {intake && !intake.ok ? <LiffNotice tone="warning">{tc('notFound')}</LiffNotice> : null}
        {chats.length > 0 ? (
          <LiffSection id="liff-chat-drafts" title={tc('listHeading')}>
            <ul className="flex flex-col divide-y divide-line border-y border-line">
              {chats.map((c) => (
                <li key={c.id} className="flex flex-col gap-0.5 py-2">
                  <LiffLink href={`${LIFF_FORM_PATHS.catalog}?intake=${c.id}`}>{c.proposedTitle || tc('untitled')}</LiffLink>
                  <span className="text-ink-muted">{tc('listLine', { messages: c.messageCount, images: c.imageCount, time: formatDateTime(locale, c.lastMessageAt) })}</span>
                </li>
              ))}
            </ul>
          </LiffSection>
        ) : null}
        <p>{t('intro')}</p>
        <LiffCatalog types={types} formBase={LIFF_FORM_PATHS.catalog} />
        <LiffSection id="liff-drafts" title={t('draftsTitle')}>
          {drafts.length === 0 ? (
            <p className="text-ink-muted">{t('draftsEmpty')}</p>
          ) : (
            <ul className="flex flex-col divide-y divide-line border-y border-line">
              {drafts.map((d) => (
                <li key={d.id} className="flex flex-col gap-0.5 py-2">
                  <LiffLink href={liffDraftHref(d.id)}>{t('continue', { title: d.title })}</LiffLink>
                  <span className="text-ink-muted">
                    {t('draftLine', { type: d.typeName, status: d.status === 'RETURNED' ? t('statusReturned') : t('statusDraft'), time: formatDateTime(locale, d.updatedAt) })}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </LiffSection>
        {track ? <LiffLink href={track}>{tl('track')}</LiffLink> : null}
      </LiffContent>
    </LiffFrame>
  )
}
