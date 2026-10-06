import { getLocale, getTranslations } from 'next-intl/server'
import { listLiffAdministrators, liffFacts } from '@/server/services/liff'
import { LIFF_HELP_PATH, LIFF_HOME_PATH, LIFF_LINK_PATH } from '@/ui/liff/bootstrap'
import { LiffContent, LiffFrame, LiffSection } from '@/ui/liff/frame'
import { LiffIcon, type LiffIconName } from '@/ui/liff/icons'
import { LiffLanguageSwitch } from '@/ui/liff/language-switch'
import { LiffGate } from '@/ui/liff/liff-gate'
import { LiffLink } from '@/ui/liff/liff-link'
import { LIFF_RICH } from '@/ui/liff/rich'
import { setLocaleAction } from '../../_lib/locale-actions'
import { liffHref } from '../_lib/links'
import { liffPage } from '../_lib/session'

export async function generateMetadata() {
  const t = await getTranslations('liff.help')
  return { title: t('title') }
}

/** The LINKED rich menu of §9.5, in its order, with the LIFF page each button opens */
const MENU: ReadonlyArray<{ readonly key: 'request' | 'tasks' | 'track' | 'help'; readonly icon: LiffIconName; readonly href: string }> = [
  { key: 'request', icon: 'shoppingCart', href: liffHref('/requests/new') ?? LIFF_HOME_PATH },
  { key: 'tasks', icon: 'clipboardCheck', href: LIFF_HOME_PATH },
  { key: 'track', icon: 'packageSearch', href: liffHref('/requests') ?? LIFF_HOME_PATH },
  { key: 'help', icon: 'circleHelp', href: LIFF_HELP_PATH },
]

/** A link that looks like the primary button: the one next step of a visitor who is not linked */
const PRIMARY_LINK_CLASS =
  'inline-flex h-11 w-full items-center justify-center rounded-md bg-primary px-4 font-medium text-primary-foreground underline-offset-4 transition-colors duration-150 hover:underline'
const MENU_LINK_CLASS = 'inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline'

// /liff/help (§9.4): how BCS works in LINE — the menu buttons (§9.5), approving in the chat and the PIN for amounts at or
// above the organization's threshold (FR-AUTH-005), unlinking (FR-LINE-001 AC3) — and whom to contact. It opens for
// anyone, linked or not (the UNLINKED menu has a Help button too): the general part needs no session and shows no data,
// and a visitor who is not linked gets the way to link first. The administrators' names come from the member's
// organization (listLiffAdministrators) and only with a member session; the gate signs in quietly with LINE first and
// stays on this page when it cannot.
// TODO(decision): names only — whether the help page may also show the administrators' work e-mail or phone (PDPA) is
// the user's decision, listed in the unit's report; until then §9.4's "ช่องทางติดต่อผู้ดูแล" is met by names alone.
export default async function LiffHelpPage() {
  const [t, tApp, locale, page] = await Promise.all([getTranslations('liff.help'), getTranslations('app'), getLocale(), liffPage()])
  const facts = liffFacts()
  const admins = page.kind === 'member' ? await listLiffAdministrators(page.ctx) : null
  const collator = new Intl.Collator(locale === 'en' ? 'en' : 'th')
  const adminNames = admins?.ok
    ? admins.data.map((a) => (locale === 'en' && a.nameEn ? a.nameEn : a.nameTh)).sort((a, b) => collator.compare(a, b))
    : []
  const member = page.kind === 'member'
  return (
    <LiffFrame title={t('title')}>
      <LiffContent>
        {member ? null : <LiffGate mode="optional" state={page.kind} />}
        <p>{t('intro')}</p>

        {member ? null : (
          <LiffSection id="help-link" title={t('linkHeading')}>
            <p>{t.rich('linkBody', LIFF_RICH)}</p>
            <LiffLink href={LIFF_LINK_PATH} className={PRIMARY_LINK_CLASS}>
              {t('linkNow')}
            </LiffLink>
          </LiffSection>
        )}

        <LiffSection id="help-menu" title={t('menuHeading')}>
          <p className="text-ink-muted">{t.rich('menuIntro', LIFF_RICH)}</p>
          <ul className="flex flex-col">
            {MENU.map(({ key, icon, href }) => (
              <li key={key} className="flex items-start gap-3 border-b border-line py-3 last:border-b-0">
                <LiffIcon name={icon} className={member && key !== 'help' ? 'mt-3 text-primary' : 'mt-1 text-primary'} />
                <div className="flex flex-col">
                  {member && key !== 'help' ? (
                    <LiffLink href={href} className={MENU_LINK_CLASS}>
                      {t(`menu.${key}.label`)}
                    </LiffLink>
                  ) : (
                    <span className="font-medium">{t(`menu.${key}.label`)}</span>
                  )}
                  <span className="text-ink-muted">{t(`menu.${key}.body`)}</span>
                </div>
              </li>
            ))}
          </ul>
          <p className="text-ink-muted">{t('menuUnlinked')}</p>
        </LiffSection>

        <LiffSection id="help-approve" title={t('approveHeading')}>
          <p>{t.rich('approveBody', { ...LIFF_RICH, length: facts.pinLength })}</p>
          <p>{t('pinBody', { limit: facts.pinFailureLimit, minutes: facts.pinLockMinutes })}</p>
        </LiffSection>

        <LiffSection id="help-unlink" title={t('unlinkHeading')}>
          <p>{t('unlinkBody')}</p>
          {member ? <LiffLink href={LIFF_LINK_PATH}>{t('unlinkLink')}</LiffLink> : null}
        </LiffSection>

        <LiffSection id="help-contact" title={t('contactHeading')}>
          {member ? (
            <>
              <p>{t('contactBody', { organization: page.member.organizationName })}</p>
              {adminNames.length > 0 ? (
                <ul className="flex flex-col gap-1">
                  {adminNames.map((name, i) => (
                    <li key={`${i}:${name}`} className="font-medium">
                      {name}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-ink-muted">{t('contactNone')}</p>
              )}
            </>
          ) : (
            <p className="text-ink-muted">{t('contactSignedOut')}</p>
          )}
        </LiffSection>

        <div className="border-t border-line pt-5">
          <LiffLanguageSwitch
            current={locale}
            label={t('language')}
            options={[
              { value: 'th', name: tApp('language.th') },
              { value: 'en', name: tApp('language.en') },
            ]}
            action={setLocaleAction}
          />
        </div>
      </LiffContent>
    </LiffFrame>
  )
}
