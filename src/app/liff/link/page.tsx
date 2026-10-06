import { getLocale, getTranslations } from 'next-intl/server'
import type { ReactNode } from 'react'
import { getMyLineLink, previewLineLinkCode } from '@/server/services/line-link'
import { liffFacts } from '@/server/services/liff'
import { formatDateTime } from '@/ui/format'
import { LiffContent, LiffFrame } from '@/ui/liff/frame'
import { LiffGate } from '@/ui/liff/liff-gate'
import { LinkedMember, LinkRefused, LinkSignedOut, LinkThisLine, LinkWithCode } from '@/ui/liff/link-flow'
import { LIFF_RICH } from '@/ui/liff/rich'
import { toActionFailure } from '@/ui/tasks/outcome'
import { liffPage, memberName, type LiffPage } from '../_lib/session'
import { checkThisLineAction, linkThisLineAction, unlinkLineAction } from './actions'

export async function generateMetadata() {
  const t = await getTranslations('liff.link')
  return { title: t('title') }
}

// /liff/link (§9.2, FR-LINE-001, ADR-049): linking this LINE account to a BCS account, and unlinking it from LINE.
//  - ?code=… (AC1): whose account the code links — read on the server without a session (the code is the credential, as
//    an e-mail action link is; organization and member name only) — then the link on the person's tap, never on load. A
//    code that no longer works says why; a member whose account is linked already is shown that link instead of being
//    sent for a new code (the gate signs a LINE account in quietly first, to know).
//  - no code, no session (AC2): the gate signs in with LINE; not linked → e-mail, password and 2FA inside LIFF.
//  - a web session (that sign-in) of a member who is not linked: confirm, and the member is linked to this LINE.
//  - linked: which LINE account that is — this one, another one — from the page's own ID token (LinkedMember), the
//    way to the tasks, and unlinking (AC3).
export default async function LiffLinkPage({ searchParams }: { searchParams: Promise<{ code?: string | string[] }> }) {
  const { code: raw } = await searchParams
  const code = typeof raw === 'string' && raw !== '' ? raw : null
  const [t, locale, page] = await Promise.all([getTranslations('liff.link'), getLocale(), liffPage()])
  const { linkCodeMinutes } = liffFacts()
  const frame = (content: ReactNode) => <LiffFrame title={t('title')}>{content}</LiffFrame>

  /** What a member sees: their link (which LINE account it is is told in the page), or the confirm to link this one */
  const forMember = async (member: Extract<LiffPage, { kind: 'member' }>, notice: string | null): Promise<{ linked: boolean; screen: ReactNode }> => {
    const name = memberName(member.member, locale)
    const link = await getMyLineLink(member.ctx)
    if (!link.ok) {
      return {
        linked: false,
        screen: (
          <LiffContent>
            <LinkRefused refusal={toActionFailure(link.error)} codeMinutes={linkCodeMinutes} />
          </LiffContent>
        ),
      }
    }
    if (!link.data.linked || !link.data.linkedAt) {
      return {
        linked: false,
        screen: <LinkThisLine memberName={name} organizationName={member.member.organizationName} codeMinutes={linkCodeMinutes} link={linkThisLineAction} />,
      }
    }
    return {
      linked: true,
      screen: (
        <LinkedMember
          memberName={name}
          organizationName={member.member.organizationName}
          since={formatDateTime(locale, link.data.linkedAt)}
          session={member.session}
          codeMinutes={linkCodeMinutes}
          notice={notice}
          check={checkThisLineAction}
          unlink={unlinkLineAction}
          link={linkThisLineAction}
        />
      ),
    }
  }

  if (code) {
    const preview = await previewLineLinkCode({ code })
    if (preview.ok) {
      return frame(
        <LinkWithCode
          code={code}
          preview={{
            organizationName: preview.data.organizationName,
            memberNameTh: preview.data.memberNameTh,
            memberNameEn: preview.data.memberNameEn,
            expiresAt: formatDateTime(locale, preview.data.expiresAt),
          }}
          codeMinutes={linkCodeMinutes}
        />,
      )
    }
    // A code that no longer works, opened by a member whose account is linked already (often the code they just used)
    if (page.kind === 'member') {
      const theirs = await forMember(page, t('codeNotNeeded'))
      if (theirs.linked) return frame(theirs.screen)
    }
    return frame(
      <LiffContent>
        {page.kind === 'signed-out' ? <LiffGate mode="optional" state="signed-out" /> : null}
        <p>{t.rich('intro', LIFF_RICH)}</p>
        <LinkRefused refusal={toActionFailure(preview.error)} codeMinutes={linkCodeMinutes} />
      </LiffContent>,
    )
  }

  if (page.kind === 'signed-out') return frame(<LinkSignedOut />)
  if (page.kind !== 'member') {
    return frame(
      <LiffContent>
        <LiffGate mode="link" state={page.kind} />
      </LiffContent>,
    )
  }
  return frame((await forMember(page, null)).screen)
}
