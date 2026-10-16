'use client'

import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useState } from 'react'
import { settle } from '../admin-settings/outcome'
import { appVersionOfAgent, inBcsGoApp, requestPushToken, storedPushDevice, storePushDevice } from '../bcs-go/native'
import { Button } from '../form/button'
import { useHydrated } from '../form/hydrated'
import { Notice } from '../form/notice'
import { useSubmissionKey } from '../form/submission-key'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../shadcn/table'
import { Switch } from './switch'
import { digestErrorKey, type AppPushActions, type PushDeviceView } from './types'

// "Notifications in the BCS Go app" (S17-10, FR-PLT-301 AC1 AC2, OQ-165, BR-NOTI-08). Turning it on happens in the app:
// the phone is asked for notifications, its push token is registered as the member's own device, and only then the
// setting goes on — so it is never on without a device that receives. In a browser it can be turned off (a lost phone)
// but not on. Off means the old way, LINE then e-mail, never silence; approval tasks still arrive at once. The table
// lists the member's devices in use; ending one is the member's own and takes effect at once (FCM stops at the next
// notification). The page reloads its list after a change.

type Result = { readonly tone: 'success' | 'warning' | 'danger'; readonly text: string }

export function AppPushPanel({ initial, devices, actions }: { initial: boolean; devices: readonly PushDeviceView[]; actions: AppPushActions }) {
  const t = useTranslations('notificationSettings')
  const router = useRouter()
  const hydrated = useHydrated()
  const submission = useSubmissionKey()
  const [on, setOn] = useState(initial)
  const [pending, setPending] = useState(false)
  const [result, setResult] = useState<Result | null>(null)
  const inApp = hydrated && inBcsGoApp()
  const thisDevice = hydrated ? storedPushDevice() : null

  const failure = (code: string, requestId?: string) => t(`errors.${digestErrorKey({ ok: false, code })}`, { requestId: requestId ?? '-' })

  async function turnOn() {
    const token = await requestPushToken()
    if (!token.ok) return setResult({ tone: 'warning', text: t(`appPush.token.${token.reason}`) })
    const appVersion = appVersionOfAgent(navigator.userAgent)
    if (!appVersion) return setResult({ tone: 'warning', text: t('appPush.token.NOT_IN_APP') })
    const registered = await settle(actions.register({ token: token.token, platform: token.platform, appVersion }, submission.key))
    if (!registered) return setResult({ tone: 'warning', text: t('errors.NO_ANSWER') })
    if (!registered.ok) return setResult({ tone: 'danger', text: registered.code === 'MODULE_DISABLED' ? t('appPush.moduleOff') : failure(registered.code, registered.requestId) })
    storePushDevice(registered.deviceId)
    return save(true)
  }

  async function save(next: boolean) {
    const answer = await settle(actions.save(next, submission.key))
    if (!answer) return setResult({ tone: 'warning', text: t('errors.NO_ANSWER') })
    submission.next()
    if (!answer.ok) return setResult({ tone: 'danger', text: failure(answer.code, answer.requestId) })
    setOn(answer.appPush)
    setResult({ tone: 'success', text: answer.appPush ? t('appPush.turnedOn') : t('appPush.turnedOff') })
    router.refresh()
  }

  async function change(next: boolean) {
    setResult(null)
    setPending(true)
    try {
      await (next ? turnOn() : save(false))
    } finally {
      setPending(false)
    }
  }

  async function revoke(deviceId: string) {
    setResult(null)
    setPending(true)
    const answer = await settle(actions.revoke(deviceId, submission.key))
    setPending(false)
    if (!answer) return setResult({ tone: 'warning', text: t('errors.NO_ANSWER') })
    submission.next()
    if (!answer.ok && answer.code !== 'NOT_FOUND' && answer.code !== 'INVALID_STATE_TRANSITION') return setResult({ tone: 'danger', text: failure(answer.code, answer.requestId) })
    if (deviceId === thisDevice) storePushDevice(null)
    setResult({ tone: 'success', text: t('appPush.deviceEnded') })
    router.refresh()
  }

  return (
    <div className="flex flex-col gap-4">
      <Switch
        id="app-push"
        label={t('appPush.label')}
        stateLabel={pending ? t('digest.saving') : on ? t('digest.on') : t('digest.off')}
        hint={inApp || on ? t('appPush.hint') : t('appPush.hintBrowser')}
        checked={on}
        disabled={pending || !hydrated || (!on && !inApp)}
        onChange={(event) => change(event.currentTarget.checked)}
      />
      {result ? <Notice tone={result.tone}>{result.text}</Notice> : null}
      {devices.length > 0 ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('appPush.devices.device')}</TableHead>
              <TableHead>{t('appPush.devices.registeredAt')}</TableHead>
              <TableHead>{t('appPush.devices.lastSeenAt')}</TableHead>
              <TableHead>
                <span className="sr-only">{t('appPush.devices.actions')}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {devices.map((d) => (
              <TableRow key={d.id}>
                <TableCell>
                  <span className="flex flex-col">
                    <span className="font-medium text-ink">{d.label}</span>
                    {d.id === thisDevice ? <span className="text-ink-muted">{t('appPush.devices.thisPhone')}</span> : null}
                  </span>
                </TableCell>
                <TableCell>{d.registeredAt}</TableCell>
                <TableCell>{d.lastSeenAt}</TableCell>
                <TableCell className="text-right">
                  <Button variant="secondary" disabled={pending || !hydrated} onClick={() => revoke(d.id)}>
                    {t('appPush.devices.end')}
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : (
        <p className="text-ink-muted">{t('appPush.devices.none')}</p>
      )}
    </div>
  )
}
