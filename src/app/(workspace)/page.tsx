import Link from 'next/link'
import { Suspense, type ReactNode } from 'react'
import { getLocale, getTranslations } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { FOLLOW_UP_PATH } from '@/lib/follow-up'
import { logger } from '@/lib/logger'
import { ctxFromSession } from '@/server/auth/session'
import { isAllowed, memberPrincipal } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { homeSuggestions } from '@/server/services/assistants/suggestions'
import { homeApprovals, homeFollowing, homeOnTime, homeTodo } from '@/server/services/home'
import { AssistantNote } from '@/ui/assistants/assistant-note'
import { DismissButton } from '@/ui/assistants/dismiss-button'
import { ApprovalsTabs } from '@/ui/home/approvals-tabs'
import { CardError } from '@/ui/home/card-error'
import { FollowingRows, HomeCard, HomeCardSkeleton, OnTimeRows } from '@/ui/home/home-cards'
import { HomeHero } from '@/ui/home/home-hero'
import { TodoList } from '@/ui/home/todo-list'
import { Button } from '@/ui/shadcn/button'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from '@/ui/shadcn/empty'
import { ItemGroup } from '@/ui/shadcn/item'
import { intakeAiFor } from '../_lib/ai-read'
import { completeUploadAction, requestUploadAction } from '../_lib/file-actions'
import { getSession } from '../_lib/session'
import { dismissAssistantAction } from './_shell/assistant-actions'
import { assistantNotes } from './_tracking/assistant-present'
import { approvalsView, firstName, FOLLOWING_HREF, followingView, onTimeView, todoView, type HomeT } from './_tracking/home-present'
import { localeOf } from './_tracking/present'

export async function generateMetadata() {
  const t = await getTranslations('home')
  return { title: t('title') }
}

// Home, "งานของฉัน" (spec §9.10 "หน้าแรก", FR-VIS-006, §9.9 principle 1): the greeting with the search field and three
// chips on the page's white, then the cards on --surface — on wide screens two columns, the left 7/12 "สิ่งที่ต้องทำ" then
// "รอฉันอนุมัติ", the right 5/12 "ผู้ช่วยเจอให้คุณ" (NEW-121) then "งานอนุมัติทันเวลา" then "ที่ฉันติดตาม"; under 1024 px one
// column in the order to do, the assistants, waiting for me, following, on time. Each card loads on its own behind a
// skeleton and says in itself when it cannot (AC6), so the greeting — the largest text — paints first. The services
// decide what each member may see.

type Texts = { readonly t: HomeT; readonly locale: 'th' | 'en' }

/** One card's body, or its error inside the card (AC6) */
async function guarded(t: HomeT, title: string, body: () => Promise<ReactNode>): Promise<ReactNode> {
  try {
    return await body()
  } catch (error) {
    logger.error({ err: error, card: title }, 'a home card could not load')
    return <CardError title={t('error.title', { card: title })} hint={t('error.hint')} retry={t('error.retry')} />
  }
}

async function TodoCard({ ctx, texts, canRequest }: { ctx: Ctx; texts: Texts; canRequest: boolean }) {
  const { t } = texts
  const title = t('cards.todo')
  const body = await guarded(t, title, async () => {
    const result = await homeTodo(ctx)
    if (!result.ok) throw new Error(result.error.code)
    const { rows: todo, openTasks } = result.data
    // Nothing urgent, but tasks wait for a decision: they are in "รอฉันอนุมัติ" below
    if (todo.length === 0 && openTasks > 0) return <p className="text-ink-muted">{t('todo.noneUrgent')}</p>
    if (todo.length === 0) {
      // Nothing waits at all: the next steps the member can take (§9.9 principle 8)
      return (
        <Empty className="border-0 p-4">
          <EmptyHeader>
            <EmptyTitle className="text-base">{t('todo.empty')}</EmptyTitle>
            <EmptyDescription className="text-base md:text-sm">{t('todo.emptyHint')}</EmptyDescription>
          </EmptyHeader>
          <EmptyContent className="flex-row flex-wrap justify-center">
            {canRequest ? (
              <Button asChild className="min-h-11 lg:min-h-10">
                <Link href="/requests/new">{t('todo.start')}</Link>
              </Button>
            ) : null}
            <Button asChild variant="outline" className="min-h-11 lg:min-h-10">
              <Link href="/requests">{t('todo.myRequests')}</Link>
            </Button>
          </EmptyContent>
        </Empty>
      )
    }
    const rows = todoView(t, todo)
    return <TodoList rows={rows} label={t('todo.list')} more={t('todo.more', { count: rows.length })} less={t('todo.less')} />
  })
  return (
    <HomeCard id="home-todo" title={title}>
      {body}
    </HomeCard>
  )
}

async function ApprovalsCard({ ctx, texts }: { ctx: Ctx; texts: Texts }) {
  const { t, locale } = texts
  const title = t('cards.approvals')
  const body = await guarded(t, title, async () => {
    const [result, tt, tv] = await Promise.all([homeApprovals(ctx), getTranslations('tasks'), getTranslations('requestView')])
    if (!result.ok) throw new Error(result.error.code)
    return <ApprovalsTabs label={t('approvals.tabs')} tabs={approvalsView(t, tt, tv, locale, result.data)} />
  })
  return (
    <HomeCard id="home-approvals" title={title}>
      {body}
    </HomeCard>
  )
}

async function OnTimeCard({ ctx, texts }: { ctx: Ctx; texts: Texts }) {
  const { t } = texts
  const title = t('cards.onTime')
  const body = await guarded(t, title, async () => {
    const result = await homeOnTime(ctx)
    if (!result.ok) throw new Error(result.error.code)
    if (result.data.length === 0) return <p className="text-ink-muted">{t('onTime.empty')}</p>
    return <OnTimeRows rows={onTimeView(t, result.data)} label={t('onTime.list')} />
  })
  return (
    <HomeCard id="home-on-time" title={title}>
      {body}
    </HomeCard>
  )
}

/** The heading of the assistants' card, which takes the focus when one of its rows is set aside: it stays when the last one goes */
const ASSISTANT_CARD = 'home-assistant'

/** "ผู้ช่วยเจอให้คุณ" (AC7 AC8 · ADR-078): what the rules found for the member, five at most, each with one way on */
async function AssistantCard({ ctx, texts }: { ctx: Ctx; texts: Texts }) {
  const { t, locale } = texts
  const title = t('cards.assistant')
  const body = await guarded(t, title, async () => {
    const [result, tp] = await Promise.all([homeSuggestions(ctx), getTranslations('payRun.task')])
    if (!result.ok) throw new Error(result.error.code)
    const { items, total } = result.data
    if (items.length === 0) {
      return (
        <Empty className="border-0 p-4">
          <EmptyHeader>
            <EmptyTitle className="text-base">{t('assistant.empty')}</EmptyTitle>
            <EmptyDescription className="text-base md:text-sm">{t('assistant.emptyHint')}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )
    }
    return (
      <>
        <p className="text-base text-ink-muted md:text-sm">{t('assistant.intro')}</p>
        <ItemGroup aria-label={t('assistant.list')} className="gap-0">
          {assistantNotes(t, tp, locale, items).map((note) => (
            <AssistantNote
              key={note.key}
              note={note}
              dismiss={<DismissButton suggestionKey={note.key} label={t('assistant.dismissLabel', { title: note.title })} text={t('assistant.dismiss')} failed={t('assistant.dismissFailed')} focusAfter={ASSISTANT_CARD} dismiss={dismissAssistantAction} />}
            />
          ))}
        </ItemGroup>
        {total > items.length ? <p className="text-base text-ink-muted md:text-sm">{t('assistant.shown', { shown: items.length, total })}</p> : null}
        {/* NEW-124: the follow-up assistant lists every such task with why it waits, and drafts a nudge */}
        {items.some((s) => s.kind === 'FOLLOW_OVERDUE' || s.kind === 'FOLLOW_DUE_SOON') ? (
          <Link href={FOLLOW_UP_PATH} className="inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline">
            {t('assistant.followUps')}
          </Link>
        ) : null}
      </>
    )
  })
  return (
    <HomeCard id={ASSISTANT_CARD} title={title}>
      {body}
    </HomeCard>
  )
}

async function FollowingCard({ ctx, texts }: { ctx: Ctx; texts: Texts }) {
  const { t, locale } = texts
  const title = t('cards.following')
  const body = await guarded(t, title, async () => {
    const [result, tv] = await Promise.all([homeFollowing(ctx), getTranslations('requestView')])
    if (!result.ok) throw new Error(result.error.code)
    const f = result.data
    if (f.total === 0) return <p className="text-ink-muted">{t('following.empty')}</p>
    return (
      <>
        <p className="font-medium text-ink">{t('following.summary', { total: f.total, open: f.open })}</p>
        <FollowingRows rows={followingView(tv, locale, f)} label={t('following.list')} all={{ href: FOLLOWING_HREF, text: t('following.all') }} />
      </>
    )
  })
  return (
    <HomeCard id="home-following" title={title}>
      {body}
    </HomeCard>
  )
}

export default async function HomePage() {
  const state = await getSession()
  if (state.kind !== 'member') return null
  const ctx = ctxFromSession(state, 'WEB', systemClock.now())
  if (!ctx) return null
  const [t, tSearch, locale] = await Promise.all([getTranslations('home'), getTranslations('shell.search'), getLocale().then(localeOf)])
  const texts: Texts = { t, locale }
  const name = firstName(locale === 'en' && state.member.displayNameEn ? state.member.displayNameEn : state.member.displayNameTh)
  // The chip opens the same door as the shell's button, for the same members (request.create, FR-INT-010)
  const canRequest = isAllowed(memberPrincipal(state.member.id, state.roles), 'request.create')
  // The box "บอกสิ่งที่อยากได้" (NEW-120) takes the search field's place when the Intake Agent serves this member now
  const intake = canRequest ? await intakeAiFor(ctx) : undefined
  const skeleton = (id: string, title: string) => <HomeCardSkeleton id={id} title={title} loading={t('loading', { card: title })} />

  return (
    <div className="flex flex-col gap-6">
      <HomeHero
        canRequest={canRequest}
        {...(intake ? { intake: { actions: intake, uploads: { requestUpload: requestUploadAction, completeUpload: completeUploadAction } } } : {})}
        texts={{
          greeting: t('greeting', { name }),
          search: t('search'),
          shortcutMac: tSearch('shortcutMac'),
          shortcutOther: tSearch('shortcutOther'),
          chips: { label: t('chips.label'), mine: t('chips.mine'), newRequest: t('chips.newRequest'), suppliers: t('chips.suppliers') },
        }}
      />
      <div className="-mx-4 bg-surface px-4 py-4 lg:mx-0 lg:rounded-lg lg:p-6">
        {/* Two columns from 1024 px; under it the columns dissolve (contents) and the cards stand in one column in the
            order of §9.10: to do, the assistants, waiting for me, following, on time */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-12 lg:gap-6">
          <div className="contents lg:col-span-7 lg:flex lg:min-w-0 lg:flex-col lg:gap-6">
            <div className="order-1 min-w-0 lg:order-none">
              <Suspense fallback={skeleton('home-todo', t('cards.todo'))}>
                <TodoCard ctx={ctx} texts={texts} canRequest={canRequest} />
              </Suspense>
            </div>
            <div className="order-3 min-w-0 lg:order-none">
              <Suspense fallback={skeleton('home-approvals', t('cards.approvals'))}>
                <ApprovalsCard ctx={ctx} texts={texts} />
              </Suspense>
            </div>
          </div>
          <div className="contents lg:col-span-5 lg:flex lg:min-w-0 lg:flex-col lg:gap-6">
            <div className="order-2 min-w-0 lg:order-none">
              <Suspense fallback={skeleton('home-assistant', t('cards.assistant'))}>
                <AssistantCard ctx={ctx} texts={texts} />
              </Suspense>
            </div>
            <div className="order-5 min-w-0 lg:order-none">
              <Suspense fallback={skeleton('home-on-time', t('cards.onTime'))}>
                <OnTimeCard ctx={ctx} texts={texts} />
              </Suspense>
            </div>
            <div className="order-4 min-w-0 lg:order-none">
              <Suspense fallback={skeleton('home-following', t('cards.following'))}>
                <FollowingCard ctx={ctx} texts={texts} />
              </Suspense>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
