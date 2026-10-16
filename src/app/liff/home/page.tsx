import { Suspense, type ReactNode } from 'react'
import { getLocale, getTranslations } from 'next-intl/server'
import { logger } from '@/lib/logger'
import { isAllowed } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { homeApprovals, homeFollowing, homeTodo } from '@/server/services/home'
import { LIFF_BASE_PATH } from '@/ui/liff/bootstrap'
import { LiffContent, LiffFrame, LiffSection } from '@/ui/liff/frame'
import { LiffGate } from '@/ui/liff/liff-gate'
import { LiffApprovalsList, LiffFollowingList, LiffHomeEmpty, LiffHomeError, LiffTodoList } from '@/ui/liff/home/home-parts'
import { FOLLOWING_HREF, firstName, type HomeT } from '../../(workspace)/_tracking/home-present'
import { localeOf, type Locale } from '../../(workspace)/_tracking/present'
import { liffPrincipalOf } from '../requests/_lib/principal'
import { liffPage } from '../_lib/session'
import { liffApprovals, liffFollowingRows, liffHomeDestination, liffTodoRows } from './present'

export async function generateMetadata() {
  const t = await getTranslations('liffHome')
  return { title: t('title') }
}

// /liff/home, the home page in LINE (FR-LINE-302 · BR-LINE-18 · ADR-167 · §9.4): "สิ่งที่ต้องทำ" "รอฉันอนุมัติ" and
// "ที่ฉันติดตาม" of the web home for the same member at the same moment — the same services (homeTodo homeApprovals
// homeFollowing) over the same queries, so the numbers are the web's (AC1) — rendered on the server, each part loading
// and failing on its own behind its own Suspense (AC3), its rows opening LIFF pages where there are some and the web
// outside LINE otherwise (AC2). "งานอนุมัติทันเวลา" stays on the web (its links are the summary's). Without a member
// session the gate signs in with LINE first and shows nothing (AC4); /liff sends a linked member here.

type Texts = { readonly t: HomeT; readonly tl: Awaited<ReturnType<typeof getTranslations<'liffHome'>>>; readonly locale: Locale }

/** A part's body, or its error inside the part with a way to try again (AC3) */
async function guarded(texts: Texts, title: string, body: () => Promise<ReactNode>): Promise<ReactNode> {
  try {
    return await body()
  } catch (error) {
    logger.error({ err: error, part: title }, 'a LIFF home part could not load')
    const { tl } = texts
    return <LiffHomeError title={tl('error.title', { part: title })} hint={tl('error.hint')} retry={tl('error.retry')} />
  }
}

async function TodoPart({ ctx, texts, canRequest }: { ctx: Ctx; texts: Texts; canRequest: boolean }) {
  const { t, tl } = texts
  const title = t('cards.todo')
  const body = await guarded(texts, title, async () => {
    const result = await homeTodo(ctx)
    if (!result.ok) throw new Error(result.error.code)
    const { rows, openTasks } = result.data
    if (rows.length === 0 && openTasks > 0) return <p className="text-ink-muted">{tl('noneUrgent')}</p>
    if (rows.length === 0) {
      return (
        <LiffHomeEmpty
          title={t('todo.empty')}
          hint={t('todo.emptyHint')}
          start={canRequest ? { href: `${LIFF_BASE_PATH}/requests/new`, label: t('todo.start') } : null}
          mine={{ href: `${LIFF_BASE_PATH}/track`, label: t('todo.myRequests') }}
        />
      )
    }
    return <LiffTodoList rows={liffTodoRows(t, result.data)} label={t('todo.list')} webHint={tl('webHint')} />
  })
  return (
    <LiffSection id="liff-home-todo" title={title}>
      {body}
    </LiffSection>
  )
}

async function ApprovalsPart({ ctx, texts }: { ctx: Ctx; texts: Texts }) {
  const { t, tl, locale } = texts
  const title = t('cards.approvals')
  const body = await guarded(texts, title, async () => {
    const [result, tt, tv] = await Promise.all([homeApprovals(ctx), getTranslations('tasks'), getTranslations('requestView')])
    if (!result.ok) throw new Error(result.error.code)
    const data = liffApprovals(t, tt, tv, locale, result.data)
    return (
      <LiffApprovalsList
        data={data}
        labels={{
          list: t('approvals.listAll'),
          summary: tl('approvalsSummary', { count: data.count, overdue: data.overdue, info: data.info }),
          empty: t('approvals.empty'),
          all: data.count > 0 ? { href: `${LIFF_BASE_PATH}/tasks`, text: t('approvals.seeAll', { count: data.count }) } : null,
        }}
      />
    )
  })
  return (
    <LiffSection id="liff-home-approvals" title={title}>
      {body}
    </LiffSection>
  )
}

async function FollowingPart({ ctx, texts }: { ctx: Ctx; texts: Texts }) {
  const { t, tl, locale } = texts
  const title = t('cards.following')
  const body = await guarded(texts, title, async () => {
    const [result, tv] = await Promise.all([homeFollowing(ctx), getTranslations('requestView')])
    if (!result.ok) throw new Error(result.error.code)
    const f = result.data
    if (f.total === 0) return <p className="text-ink-muted">{t('following.empty')}</p>
    return (
      <LiffFollowingList
        rows={liffFollowingRows(tv, locale, f)}
        labels={{
          list: t('following.list'),
          summary: t('following.summary', { total: f.total, open: f.open }),
          status: tl('status'),
          now: tl('now'),
          webHint: tl('webHint'),
          all: { to: liffHomeDestination(FOLLOWING_HREF), text: t('following.all') },
        }}
      />
    )
  })
  return (
    <LiffSection id="liff-home-following" title={title}>
      {body}
    </LiffSection>
  )
}

/** What a part shows while it loads: its title and a line that says so */
function Loading({ id, title, text }: { id: string; title: string; text: string }) {
  return (
    <LiffSection id={id} title={title}>
      <p role="status" className="text-ink-muted">
        {text}
      </p>
    </LiffSection>
  )
}

export default async function LiffHomePage() {
  const [page, t, tl, locale] = await Promise.all([liffPage(), getTranslations('home'), getTranslations('liffHome'), getLocale().then(localeOf)])
  if (page.kind !== 'member') {
    return (
      <LiffFrame title={tl('title')}>
        <LiffContent>
          <LiffGate mode="member" state={page.kind} />
        </LiffContent>
      </LiffFrame>
    )
  }
  const texts: Texts = { t, tl, locale }
  // The start of a request is offered to members who may make one (request.create, FR-INT-010), as on the web home
  const canRequest = isAllowed(await liffPrincipalOf(page.member.id), 'request.create')
  const name = firstName(locale === 'en' && page.member.displayNameEn ? page.member.displayNameEn : page.member.displayNameTh)
  const loading = (id: string, title: string) => <Loading id={id} title={title} text={t('loading', { card: title })} />
  return (
    <LiffFrame title={tl('title')}>
      <LiffContent>
        <p className="text-ink-muted">{tl('greeting', { name })}</p>
        <Suspense fallback={loading('liff-home-todo', t('cards.todo'))}>
          <TodoPart ctx={page.ctx} texts={texts} canRequest={canRequest} />
        </Suspense>
        <Suspense fallback={loading('liff-home-approvals', t('cards.approvals'))}>
          <ApprovalsPart ctx={page.ctx} texts={texts} />
        </Suspense>
        <Suspense fallback={loading('liff-home-following', t('cards.following'))}>
          <FollowingPart ctx={page.ctx} texts={texts} />
        </Suspense>
      </LiffContent>
    </LiffFrame>
  )
}
