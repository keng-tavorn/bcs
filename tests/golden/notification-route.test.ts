import { describe, expect, it } from 'vitest'
import { planDelivery, pushAnswerAction, pushMessage, type PushAnswer } from '@/core/notification-route'
import { LINE_TEMPLATES } from '@/server/notifications/line-templates'
import { pushTitleOf } from '@/server/notifications/push-message'
import { renderNotification } from '@/server/notifications/templates'
import { loadYaml } from './doa-fixtures'

// tests/golden/notification-route.yaml (spec §7.20, S17-10): which channels an IMMEDIATE notification goes by
// (BR-NOTI-05, OQ-165), what its push says on a locked screen (BR-NOTI-06), and what each device's answer means
// (BR-NOTI-07). The push title is the one deliverNotification uses (pushTitleOf, messages/src/<locale>/push.json) and
// the path the template's own link.

type Data = Record<string, unknown>
interface Case {
  id: string
  title?: string
  input: {
    template?: string
    urgency?: 'IMMEDIATE' | 'DIGEST'
    data?: Data
    lineLinked?: boolean
    lineActive?: boolean
    lineReachable?: boolean
    appPush?: boolean
    activeDevices?: number
    bcsGo?: boolean
    locale?: 'th' | 'en'
    answers?: PushAnswer[]
  }
  expect: { channels?: string[]; digest?: boolean; push?: { title?: string; body?: string | null; data?: Data }; absent?: string[]; actions?: string[] }
}

const suite = loadYaml<{ cases: Case[] }>('notification-route.yaml')

function run(c: Case): unknown {
  const i = c.input
  if (i.answers) return { actions: i.answers.map(pushAnswerAction) }
  const data = i.data ?? {}
  if (i.locale) {
    const rendered = renderNotification({ templateKey: i.template!, data, subjectType: null, subjectId: null }, i.locale)
    const message = pushMessage({ title: pushTitleOf(i.template!, i.locale), data, path: rendered.href })
    // Only what the case names: a template without its own link has no path to compare
    const push: Data = { title: message.title, body: message.body }
    if (c.expect.push?.data) push.data = message.data
    return { push, text: JSON.stringify(message) }
  }
  return planDelivery(
    { templateKey: i.template!, data, urgency: i.urgency ?? 'IMMEDIATE' },
    { lineLinked: i.lineLinked ?? false, lineActive: i.lineActive ?? true, lineReachable: i.lineReachable ?? true, appPush: i.appPush ?? false, activeDevices: i.activeDevices ?? 0, bcsGo: i.bcsGo ?? true },
    LINE_TEMPLATES,
  )
}

describe('golden notification-route.yaml', () => {
  it('has cases', () => expect(suite.cases.length).toBeGreaterThan(0))
  for (const c of suite.cases) {
    it(`[${c.id}] ${c.title ?? ''}`.trim(), () => {
      const got = run(c) as { channels?: string[]; digest?: boolean; push?: Data; text?: string; actions?: string[] }
      if (c.expect.actions) expect(got.actions).toEqual(c.expect.actions)
      if (c.expect.channels) expect({ channels: got.channels, ...(c.expect.digest !== undefined ? { digest: got.digest } : {}) }).toEqual({ channels: c.expect.channels, ...(c.expect.digest !== undefined ? { digest: c.expect.digest } : {}) })
      if (c.expect.push) expect(got.push).toEqual(c.expect.push)
      for (const word of c.expect.absent ?? []) expect(got.text, word).not.toContain(word)
    })
  }
})
