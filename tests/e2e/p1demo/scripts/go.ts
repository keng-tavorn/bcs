import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { E2E_DB } from '../../../support/e2e-env'

// Run by the BCS Go scenes of phase 1 (P1-08 scenes 2 and 7, tests/e2e/p1demo/support.ts script()) against the run's
// e2e database only, on SIMEC — the organization of sheet Org of the phase-1 workbook: what happens outside the screens of
// the app, through the services, and what a scene reads back (as tests/e2e/s17-scene.ts does for the twin of S17-16).
// Prints JSON on its last line.
//   push-device <code> <scene>           what "รับแจ้งเตือนในแอป" does in BCS Go once FCM gave the phone its token: the device
//                                        registered (labelled with the scene's expectJson.passkeyDeviceLabel, read from
//                                        sheet Demo_Script_P1) and push turned on, on channel APP — a browser has no FCM
//   deliver-push <code> <requestId> <templateKey>
//                                        plays job notification-deliver (e2e has no Inngest) for the member's pending
//                                        notices of that template about a task of the request; with PUSH_PROVIDER=fake in
//                                        this process they go to the fake FCM of the run
//   grant <taskId>                       the method of the step-up grant the task's decision used (the assignee's, for the
//                                        task's document, used)
//   receipts <poId>                      the PO's status and its receipts: number, status, captured offline or not, the
//                                        quantities received (2 decimals), the photos, the channel of gr.posted
//   copies <code>                        how many POs the member's phone would keep for receiving offline now (the
//                                        service /go/receive prepares them with)

async function main(command: string | undefined, args: readonly string[]): Promise<unknown> {
  if (new URL(process.env.DATABASE_URL ?? 'postgresql://x/none').pathname !== `/${E2E_DB}`) throw new Error('the BCS Go scene runs in the e2e database only')
  const [{ systemClock }, { makeCtx }, { prisma }, { INPUT_WORKBOOKS, loadInputWorkbook }] = await Promise.all([
    import('@/lib/clock'),
    import('@/server/context'),
    import('@/server/db/client'),
    import('@/server/seed/workbook'),
  ])
  const workbook = await loadInputWorkbook(INPUT_WORKBOOKS.p1)
  const orgCode = workbook.keyValues('Org').get('code')?.value
  if (!orgCode) throw new Error('the Org sheet names no organization code')
  const org = await prisma.organization.findUniqueOrThrow({ where: { code: orgCode }, select: { id: true } })

  const memberOf = async (code: string) => {
    const member = await prisma.member.findFirst({ where: { organizationId: org.id, employeeCode: code }, select: { id: true } })
    if (!member) throw new Error(`the organization ${orgCode} has no member ${code}`)
    return { id: member.id, ctx: (channel: 'WEB' | 'APP') => makeCtx({ organizationId: org.id, actor: { type: 'USER', memberId: member.id }, channel, now: systemClock.now() }) }
  }

  /** What the scene's row of Demo_Script_P1 expects (its expectJson) */
  const expectOf = (scene: string): Record<string, unknown> => {
    const row = workbook.table('Demo_Script_P1').find((r) => Number(r.values.scene) === Number(scene))
    if (!row) throw new Error(`Demo_Script_P1 has no scene ${scene}`)
    return JSON.parse(row.values.expectJson ?? '{}') as Record<string, unknown>
  }

  async function pushDevice(code: string, scene: string) {
    const [{ registerPushDevice }, { updateNotificationPrefs }] = await Promise.all([import('@/server/services/push-devices'), import('@/server/services/self/notification-prefs')])
    const label = expectOf(scene).passkeyDeviceLabel
    if (typeof label !== 'string' || !label) throw new Error(`Demo_Script_P1 scene ${scene}: expectJson has no passkeyDeviceLabel`)
    const member = await memberOf(code)
    // FCM's token form; a secret of this test database only, never printed on failure
    const token = `p1demo-${randomUUID().replaceAll('-', '')}:APA91b${randomUUID().replaceAll('-', '')}`
    const registered = await registerPushDevice(member.ctx('APP'), { token, platform: 'ANDROID', appVersion: '0.1.0', deviceLabel: label }, { idempotencyKey: randomUUID(), sender: null })
    if (!registered.ok) throw new Error(`push_device.register refused: ${registered.error.code}`)
    const turnedOn = await updateNotificationPrefs(member.ctx('APP'), { appPush: true }, { idempotencyKey: randomUUID(), sender: null })
    if (!turnedOn.ok && turnedOn.error.details?.reason !== 'NO_CHANGE') throw new Error(`push was not turned on: ${turnedOn.error.code}`)
    return { deviceId: registered.data.deviceId, token }
  }

  async function deliverPush(code: string, requestId: string, templateKey: string) {
    const { deliverNotification } = await import('@/server/notifications/deliver')
    const member = await memberOf(code)
    const tasks = await prisma.approvalTask.findMany({ where: { organizationId: org.id, assigneeMemberId: member.id, step: { route: { subjectType: 'REQUEST', subjectId: requestId } } }, select: { id: true } })
    const notices = await prisma.notification.findMany({
      where: { organizationId: org.id, recipientMemberId: member.id, templateKey, status: 'PENDING' },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true, data: true },
    })
    const mine = notices.filter((n) => tasks.some((t) => (n.data as { taskId?: unknown }).taskId === t.id))
    if (mine.length === 0) throw new Error(`${code} has no pending ${templateKey} notice about a task of the request: scene 1 must leave it undelivered`)
    const outcomes = []
    for (const n of mine) outcomes.push(await deliverNotification(org.id, n.id, systemClock.now()))
    return { outcomes }
  }

  async function grant(taskId: string) {
    const task = await prisma.approvalTask.findFirstOrThrow({
      where: { organizationId: org.id, id: taskId },
      select: { assigneeMemberId: true, step: { select: { route: { select: { subjectType: true, subjectId: true } } } } },
    })
    const used = await prisma.stepUpGrant.findFirst({
      where: { organizationId: org.id, memberId: task.assigneeMemberId, subjectType: task.step.route.subjectType, subjectId: task.step.route.subjectId, usedAt: { not: null } },
      orderBy: { usedAt: 'desc' },
      select: { method: true },
    })
    return { method: used?.method ?? null }
  }

  async function receipts(poId: string) {
    const order = await prisma.purchaseOrder.findFirstOrThrow({ where: { organizationId: org.id, id: poId }, select: { status: true } })
    const rows = await prisma.goodsReceipt.findMany({
      where: { organizationId: org.id, poId },
      orderBy: { createdAt: 'asc' },
      select: { id: true, number: true, status: true, offlineCapturedAt: true, lines: { select: { receivedQuantity: true } } },
    })
    const out = []
    for (const gr of rows) {
      const photos = await prisma.fileLink.count({ where: { organizationId: org.id, subjectType: 'GoodsReceipt', subjectId: gr.id, kind: 'PHOTO' } })
      const posted = await prisma.event.findFirst({ where: { organizationId: org.id, aggregateId: gr.id, type: 'gr.posted' }, select: { channel: true } })
      out.push({ number: gr.number, status: gr.status, offline: gr.offlineCapturedAt !== null, quantities: gr.lines.map((l) => l.receivedQuantity.toFixed(2)), photos, channel: posted?.channel ?? null })
    }
    return { status: order.status, receipts: out }
  }

  async function copies(code: string) {
    const { prepareOfflineCopies } = await import('@/server/services/receiving/offline-copies')
    const member = await memberOf(code)
    const prepared = await prepareOfflineCopies(member.ctx('APP'))
    if (!prepared.ok) throw new Error(`the offline copies were refused: ${prepared.error.code}`)
    return { count: prepared.data.copies.length, numbers: prepared.data.copies.map((c) => c.number), truncated: prepared.data.truncated }
  }

  try {
    switch (command) {
      case 'push-device':
        if (!args[0] || !/^\d+$/.test(args[1] ?? '')) throw new Error('push-device <code> <scene>')
        return await pushDevice(args[0], args[1]!)
      case 'deliver-push':
        if (!args[0] || !args[1] || !args[2]) throw new Error('deliver-push <code> <requestId> <templateKey>')
        return await deliverPush(args[0], args[1], args[2])
      case 'grant':
        if (!args[0]) throw new Error('grant <taskId>')
        return await grant(args[0])
      case 'receipts':
        if (!args[0]) throw new Error('receipts <poId>')
        return await receipts(args[0])
      case 'copies':
        if (!args[0]) throw new Error('copies <code>')
        return await copies(args[0])
      default:
        throw new Error(`unknown BCS Go scene command ${command ?? '(none)'}`)
    }
  } finally {
    await prisma.$disconnect()
  }
}

const ranByTsx = process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (ranByTsx) {
  const [command, ...args] = process.argv.slice(2)
  console.log(JSON.stringify(await main(command, args)))
}
