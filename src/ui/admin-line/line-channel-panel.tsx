'use client'

import { CircleAlert, CircleCheck, CircleMinus, CirclePause, CircleX } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { useState, type FormEvent, type InputHTMLAttributes, type ReactNode } from 'react'
import { settle } from '../admin-settings/outcome'
import { Button } from '../form/button'
import { Field } from '../form/field'
import { useHydrated } from '../form/hydrated'
import { Notice } from '../form/notice'
import { Panel } from '../page/page'
import { useSubmissionKey } from '../form/submission-key'
import { CopyButton } from '../settings-line/copy-button'
import { Switch } from '../settings-notifications/switch'
import { draftOf, isDirty, saveInputOf, type LineChannelDraft } from './draft'
import {
  commonLineErrorKey,
  isLineChannelField,
  richMenuErrorKey,
  type ConnectionTestOutcome,
  type LineChannelField,
  type LineChannelView,
  type ReplaceRichMenusAction,
  type SaveLineChannelAction,
  type SecretStatusView,
  type TestLineConnectionAction,
} from './types'

// The organization's LINE channel on /admin/line (FR-ADM-006 AC2 AC3, §9.2, §9.5), for an ORG_ADMIN:
//  - the values from LINE Developers Console, saved with the version the page showed: a save in between is refused
//    (CONFLICT_VERSION) and the page then shows what is saved now, with the reason;
//  - the channel secret and the access token are write-only: the page knows only whether each is set (ADR-045 item 2),
//    the fields start empty and are emptied again after every answer; empty keeps what is saved;
//  - the webhook URL to copy into LINE, the connection test (each check PASS or FAIL with the fix in words) and the button
//    that makes both rich menus again. The test and the menus use what is saved, so they wait while the form has
//    changes that are not saved yet, and say why;
//  - one thing at a time: while a save, the test or the rich menus run, the form and the other buttons wait. The rich
//    menus raise the settings' version, so a save sent meanwhile would be refused as someone else's (CONFLICT_VERSION),
//    and each answer replaces the form with what is saved;
//  - nothing is sent before the page's script runs: Save waits for hydration and the form posts (src/ui/form/hydrated.ts),
//    so the secret and the token can never end up in the page's address; the test and the menus wait for it too, since
//    a click before it would do nothing.
// Wide screens: the form on the left, the webhook URL, the test and the rich menus on the right; phones: one column.

type Message = { readonly tone: 'success' | 'info' | 'warning' | 'danger'; readonly lines: readonly string[] }

export function LineChannelPanel({
  initial,
  testSeconds,
  save,
  test,
  replaceMenus,
}: {
  initial: LineChannelView
  /** The connection test's time budget in seconds, for its description */
  testSeconds: number
  save: SaveLineChannelAction
  test: TestLineConnectionAction
  replaceMenus: ReplaceRichMenusAction
}) {
  const t = useTranslations('lineSettings')
  const tCommon = useTranslations('adminSettings')
  const hydrated = useHydrated()
  const saveKey = useSubmissionKey()
  const menusKey = useSubmissionKey()
  const [view, setView] = useState(initial)
  const [draft, setDraft] = useState<LineChannelDraft>(() => draftOf(initial))
  const [saving, setSaving] = useState(false)
  const [saveMessage, setSaveMessage] = useState<Message | null>(null)
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<LineChannelField, string>>>({})
  const [testing, setTesting] = useState(false)
  const [report, setReport] = useState<ConnectionTestOutcome | null>(null)
  const [making, setMaking] = useState(false)
  const [menusMessage, setMenusMessage] = useState<Message | null>(null)

  const dirty = isDirty(draft, view)
  // One thing at a time (see above): nothing else starts while one of the three runs, nor before the page runs its script
  const busy = saving || testing || making
  const waiting = busy || !hydrated
  // Why the test or the menus cannot run yet, each in its own words
  const unsavedReason = dirty ? t('unsaved') : null
  const testBlocked = !view.configured ? t('test.notConfigured') : unsavedReason
  const menusBlocked = !view.configured ? t('richMenus.errors.NOT_CONFIGURED') : unsavedReason

  /** What is saved now becomes the page's: the form starts again from it (secrets empty) and an old test report goes */
  function adopt(next: LineChannelView) {
    setView(next)
    setDraft(draftOf(next))
    setReport(null)
  }

  const set = <K extends keyof LineChannelDraft>(key: K, value: LineChannelDraft[K]) => {
    setDraft((d) => ({ ...d, [key]: value }))
    setFieldErrors((e) => ({ ...e, [key]: undefined }))
  }

  async function onSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    setSaveMessage(null)
    setFieldErrors({})
    setSaving(true)
    const answer = await settle(save(saveInputOf(draft, view.version), saveKey.key))
    setSaving(false)
    // No answer: it may or may not be saved, and the page says so; the same key goes with a retry, so it runs at most once
    if (!answer) return setSaveMessage({ tone: 'warning', lines: [t('noAnswer')] })
    saveKey.next()
    if (answer.ok) {
      adopt(answer.view)
      return setSaveMessage({ tone: 'success', lines: [t('saved')] })
    }
    // Someone saved in between: the page now shows what is saved, and says so
    if (answer.code === 'CONFLICT_VERSION') {
      if (answer.view) adopt(answer.view)
      return setSaveMessage({ tone: 'danger', lines: [t('conflict')] })
    }
    // The typed secrets are never kept after an answer (write-only)
    setDraft((d) => ({ ...d, channelSecret: '', channelAccessToken: '' }))
    if (answer.code === 'VALIDATION_FAILED') {
      if (answer.reason === 'NO_CHANGE') {
        // What was sent is what is saved (at the version shown): the form shows it as saved, without stray spaces
        setDraft(draftOf(view))
        return setSaveMessage({ tone: 'info', lines: [t('refused.NO_CHANGE')] })
      }
      if (answer.reason === 'PROVIDER_IN_USE') return setFieldErrors({ providerId: t('refused.PROVIDER_IN_USE', { linked: answer.linked ?? 0 }) })
      if (isLineChannelField(answer.field) && answer.field !== 'active') {
        const field = answer.field
        return setFieldErrors({ [field]: answer.reason === 'REQUIRED' ? t('refused.REQUIRED', { field: t(`fields.${field}`) }) : t(`invalid.${field}`) })
      }
      return setSaveMessage({ tone: 'danger', lines: [t('invalid.other')] })
    }
    setSaveMessage({ tone: 'danger', lines: [tCommon(`errors.${commonLineErrorKey(answer)}`, { requestId: answer.requestId ?? '-' })] })
  }

  async function onTest() {
    if (busy) return
    setTesting(true)
    setReport(null)
    const answer = await settle(test())
    setTesting(false)
    setReport(answer ?? { ok: false, code: 'FAILED' })
  }

  async function onMakeMenus() {
    if (busy) return
    setMaking(true)
    setMenusMessage(null)
    const answer = await settle(replaceMenus(menusKey.key))
    setMaking(false)
    // No answer: the menus may or may not be made; the same key goes with a retry
    if (!answer) return setMenusMessage({ tone: 'warning', lines: [t('richMenus.noAnswer')] })
    menusKey.next()
    if (answer.ok) {
      // The menus are stored with a new version of the settings: the form takes it (it had no changes when the run
      // started, see menusBlocked, and could not get any while it ran, see busy)
      adopt(answer.view)
      const lines = [t('richMenus.done'), t('richMenus.relinked', { count: answer.relinked })]
      if (answer.relinkRefused > 0) lines.push(t('richMenus.relinkRefused', { count: answer.relinkRefused }))
      if (answer.relinkFailed > 0) lines.push(t('richMenus.relinkFailed', { count: answer.relinkFailed }))
      if (!answer.defaultSet) lines.push(t('richMenus.defaultNotSet'))
      return setMenusMessage({ tone: answer.relinkFailed > 0 || !answer.defaultSet ? 'warning' : 'success', lines })
    }
    if (answer.view) adopt(answer.view)
    const key = richMenuErrorKey(answer)
    setMenusMessage({
      tone: 'danger',
      lines: [key ? t(`richMenus.errors.${key}`, { status: answer.status ?? '-' }) : tCommon(`errors.${commonLineErrorKey(answer)}`, { requestId: answer.requestId ?? '-' })],
    })
  }

  return (
    <div className="flex flex-col gap-4 lg:gap-6">
      <ChannelState view={view} />

      <div className="flex flex-col gap-4 lg:grid lg:grid-cols-[minmax(0,1fr)_26rem] lg:items-start lg:gap-6">
        <Panel title={t('formTitle')} id="line-form">
          {/* method="post": a submission before hydration never puts the values in the address (see the top) */}
          <form method="post" onSubmit={onSave} className="flex flex-col gap-5" noValidate>
            {saveMessage ? <MessageNotice message={saveMessage} /> : null}
            {/* While anything runs the values wait: its answer replaces them with what is saved */}
            <fieldset disabled={busy} className="flex min-w-0 flex-col gap-5">
              <Field
                id="line-provider"
                name="providerId"
                label={t('fields.providerId')}
                hint={t('hints.providerId')}
                value={draft.providerId}
                onChange={(e) => set('providerId', e.currentTarget.value)}
                maxLength={64}
                autoComplete="off"
                spellCheck={false}
                error={fieldErrors.providerId}
              />
              <Field
                id="line-messaging-channel"
                name="messagingChannelId"
                label={t('fields.messagingChannelId')}
                hint={t('hints.messagingChannelId')}
                value={draft.messagingChannelId}
                onChange={(e) => set('messagingChannelId', e.currentTarget.value)}
                inputMode="numeric"
                maxLength={20}
                autoComplete="off"
                error={fieldErrors.messagingChannelId}
              />
              <SecretField
                id="line-channel-secret"
                name="channelSecret"
                label={t('fields.channelSecret')}
                status={view.channelSecret}
                where={t('secret.channelSecretWhere')}
                value={draft.channelSecret}
                onValue={(v) => set('channelSecret', v)}
                maxLength={64}
                error={fieldErrors.channelSecret}
              />
              <SecretField
                id="line-access-token"
                name="channelAccessToken"
                label={t('fields.channelAccessToken')}
                status={view.channelAccessToken}
                where={t('secret.channelAccessTokenWhere')}
                value={draft.channelAccessToken}
                onValue={(v) => set('channelAccessToken', v)}
                error={fieldErrors.channelAccessToken}
              />
              <Field
                id="line-liff-id"
                name="liffId"
                label={t('fields.liffId')}
                hint={t('hints.liffId')}
                value={draft.liffId}
                onChange={(e) => set('liffId', e.currentTarget.value)}
                maxLength={64}
                autoComplete="off"
                spellCheck={false}
                error={fieldErrors.liffId}
              />
              <Field
                id="line-liff-channel"
                name="liffChannelId"
                label={t('fields.liffChannelId')}
                hint={t('hints.liffChannelId')}
                value={draft.liffChannelId}
                onChange={(e) => set('liffChannelId', e.currentTarget.value)}
                inputMode="numeric"
                maxLength={20}
                autoComplete="off"
                error={fieldErrors.liffChannelId}
              />
              <Switch
                id="line-active"
                name="active"
                label={t('fields.active')}
                stateLabel={draft.active ? t('switch.on') : t('switch.off')}
                hint={t('hints.active')}
                checked={draft.active}
                onChange={(e) => set('active', e.currentTarget.checked)}
              />
            </fieldset>
            <Button type="submit" disabled={waiting} className="self-start">
              {saving ? t('saving') : t('save')}
            </Button>
          </form>
        </Panel>

        <div className="flex flex-col gap-4 lg:gap-6">
          <Panel title={t('fields.webhookUrl')} id="line-webhook">
            {view.webhookUrl ? (
              <>
                <p className="text-base break-all md:text-sm">{view.webhookUrl}</p>
                <CopyButton value={view.webhookUrl} label={t('copy')} copiedLabel={t('copied')} failedLabel={t('copyFailed')} />
                <p className="text-base text-ink-muted md:text-sm">{t('webhookUrlHint')}</p>
              </>
            ) : (
              <p className="text-ink-muted">{t('webhookUrlNotYet')}</p>
            )}
          </Panel>

          <Panel title={t('test.title')} id="line-test">
            <p className="text-ink-muted">{t('test.intro', { seconds: testSeconds })}</p>
            <Button variant="secondary" onClick={onTest} disabled={waiting || testBlocked !== null} aria-describedby={testBlocked ? 'line-test-blocked' : undefined} className="self-start">
              {testing ? t('test.running') : t('test.button')}
            </Button>
            {testBlocked ? (
              <p id="line-test-blocked" className="text-base text-ink-muted md:text-sm">
                {testBlocked}
              </p>
            ) : null}
            {report ? <TestReport report={report} /> : null}
          </Panel>

          <Panel title={t('richMenus.title')} id="line-menus">
            <p className="flex items-center gap-2 font-medium">
              {view.richMenus ? <CircleCheck className="size-5 shrink-0 text-primary" aria-hidden="true" /> : <CircleMinus className="size-5 shrink-0 text-ink-muted" aria-hidden="true" />}
              <span>{view.richMenus ? t('richMenus.stored') : t('richMenus.notStored')}</span>
            </p>
            <p className="text-ink-muted">{t('richMenus.intro')}</p>
            <Button variant="secondary" onClick={onMakeMenus} disabled={waiting || menusBlocked !== null} aria-describedby={menusBlocked ? 'line-menus-blocked' : undefined} className="self-start">
              {making ? t('richMenus.running') : t('richMenus.button')}
            </Button>
            {menusBlocked ? (
              <p id="line-menus-blocked" className="text-base text-ink-muted md:text-sm">
                {menusBlocked}
              </p>
            ) : null}
            {menusMessage ? <MessageNotice message={menusMessage} /> : null}
          </Panel>
        </div>
      </div>
    </div>
  )
}

/** Whether LINE is in use, in words with an icon (never colour alone) */
function ChannelState({ view }: { view: LineChannelView }) {
  const t = useTranslations('lineSettings')
  const [Icon, tone, text] = !view.configured
    ? [CircleMinus, 'text-ink-muted', t('state.notConfigured')]
    : view.active
      ? [CircleCheck, 'text-primary', t('state.active')]
      : [CirclePause, 'text-warn', t('state.inactive')]
  return (
    <p className="flex items-start gap-2 font-medium">
      <Icon className={`mt-1 size-5 shrink-0 ${tone}`} aria-hidden="true" />
      <span>{text}</span>
    </p>
  )
}

function MessageNotice({ message }: { message: Message }) {
  return (
    <Notice tone={message.tone}>
      {message.lines.map((line) => (
        <p key={line}>{line}</p>
      ))}
    </Notice>
  )
}

/**
 * A write-only secret: whether one is saved is said beside the label (and read out with the field); the field itself
 * starts empty and never holds the saved value, which the page does not have.
 */
function SecretField({
  id,
  label,
  status,
  where,
  value,
  onValue,
  error,
  ...input
}: {
  id: string
  label: string
  status: SecretStatusView
  where: string
  value: string
  onValue: (value: string) => void
  error?: string
} & Pick<InputHTMLAttributes<HTMLInputElement>, 'name' | 'maxLength'>) {
  const t = useTranslations('lineSettings')
  const statusId = `${id}-status`
  const hintId = `${id}-hint`
  const errorId = `${id}-error`
  let state: ReactNode
  if (!status.set) {
    state = (
      <>
        <CircleMinus className="size-4 shrink-0 text-ink-muted" aria-hidden="true" />
        <span>{t('secret.notSet')}</span>
      </>
    )
  } else if (!status.readable) {
    state = (
      <>
        <CircleX className="size-4 shrink-0 text-danger" aria-hidden="true" />
        <span>{t('secret.unreadable')}</span>
      </>
    )
  } else {
    state = (
      <>
        <CircleCheck className="size-4 shrink-0 text-primary" aria-hidden="true" />
        <span>{t('secret.set')}</span>
      </>
    )
  }
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <label htmlFor={id} className="font-medium text-ink">
          {label}
        </label>
        <p id={statusId} className="flex items-center gap-1.5 text-base md:text-sm">
          {state}
        </p>
      </div>
      <input
        id={id}
        // Masked while typed (shoulder surfing)
        type="password"
        value={value}
        onChange={(e) => onValue(e.currentTarget.value)}
        // Not a password of anybody's account, and never offered to the browser's password manager: "new-password" would
        // offer a generated password here and, once the fields are emptied after the save, offer to store
        // "<channel id> / <channel secret>" in a synced password manager (ADR-045 item 2: no character of it is shown
        // again). Chrome and Firefox ignore "off" on a password field when they offer to save one, so the field says it
        // holds a one-time code — a code, not a password, to the browsers' password managers — with the opt-outs of
        // 1Password, LastPass, Bitwarden and Dashlane, as the PIN fields do (src/ui/settings-pin/new-pin-field.tsx)
        autoComplete="one-time-code"
        data-1p-ignore=""
        data-lpignore="true"
        data-bwignore="true"
        data-form-type="other"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        aria-invalid={error ? true : undefined}
        aria-describedby={[statusId, hintId, error ? errorId : null].filter(Boolean).join(' ')}
        className="h-11 w-full rounded-md border border-input bg-bg px-3 text-base text-ink aria-[invalid=true]:border-danger"
        {...input}
      />
      <p id={hintId} className="text-base text-ink-muted md:text-sm">
        {where} · {status.set ? t('secret.keep') : t('secret.first')}
      </p>
      {error ? (
        <p id={errorId} className="flex items-start gap-1.5 text-base text-danger md:text-sm">
          <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>{error}</span>
        </p>
      ) : null}
    </div>
  )
}

/** The connection test's answer: the summary, then each check with PASS or FAIL in words and what to do */
function TestReport({ report }: { report: ConnectionTestOutcome }) {
  const t = useTranslations('lineSettings')
  const tCommon = useTranslations('adminSettings')
  if (!report.ok) {
    const text = report.code === 'NOT_FOUND' ? t('test.notConfigured') : tCommon(`errors.${commonLineErrorKey(report)}`, { requestId: report.requestId ?? '-' })
    return <Notice tone="danger">{text}</Notice>
  }
  const failed = report.checks.filter((c) => !c.passed).length
  return (
    <div className="flex flex-col gap-3">
      <Notice tone={report.passed ? 'success' : 'warning'}>{report.passed ? t('test.passed') : t('test.failed', { count: failed })}</Notice>
      <ul aria-label={t('test.results')} className="flex flex-col divide-y divide-line border-y border-line">
        {report.checks.map((check) => (
          <li key={check.id} className="flex flex-col gap-1 py-3">
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
              <p className="font-medium">{check.title}</p>
              <p className={`flex items-center gap-1.5 font-medium ${check.passed ? 'text-primary' : 'text-danger'}`}>
                {check.passed ? <CircleCheck className="size-4 shrink-0" aria-hidden="true" /> : <CircleX className="size-4 shrink-0" aria-hidden="true" />}
                <span>{check.passed ? t('status.PASS') : t('status.FAIL')}</span>
              </p>
            </div>
            {/* The fixes quote URLs: a long one breaks anywhere rather than widening the page */}
            <p className="text-base text-ink-muted wrap-anywhere md:text-sm">{check.message}</p>
          </li>
        ))}
      </ul>
    </div>
  )
}
