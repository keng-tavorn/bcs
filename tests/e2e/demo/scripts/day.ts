import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { E2E_DB } from '../../../support/e2e-env'

// Run by the demo scenes (tests/e2e/demo, through support.ts) against the demo e2e database only: what the people of the
// day do outside the screens, through the services as the runbook has it, and what a scene reads back from the
// database. Prints JSON on its last line; amounts are satang as strings.
//   prepare <code>:<lineUserId>…  the day's phones (docs/DEMO_RUNBOOK.md §1 items 3 and 4): both rich menus made as
//                              `pnpm line:richmenu` makes them, then each member linked to their LINE account with a link
//                              code spent with an ID token of the fake LINE server, as /settings/line and /liff/link do.
//                              A member linked to that account already is left alone
//   deliver <code> [subjectId] what the notification job does with the member's pending notices (about one document
//                              when given): deliverNotification of each, so LINE cards reach the fake LINE server
//   request <number>           a request as the database has it: amounts, budget line, site, its route and tasks (who
//                              holds each, for whom, from which position, when it was decided) with their decisions'
//                              events (when, channel, by and for whom, DOA reference), the channels of its own events,
//                              the kinds of its files
//   latest <code> <netSatang>  the same for the latest request that member sent of that amount before VAT, or null
//   defaults <code> <type>     what a new form of that type fills in for the member (BR-FORM-02): the budget line of
//                              their latest sent request of the type, the site of the latest request they started
//   budget <lineCode>          what is left on a budget line (BudgetLineBalance), and what is held on it
//   doa                        the DOA version in effect: code, number, amount basis and stepUpThreshold
//   counts                     how many requests were sent, approval tasks made and notifications written so far
//   channel                    the organization's LINE channel: its key (the webhook path) and LIFF ID
//   history <ref>              the request the demo history made for a row of sheet Demo_History (its draft's events
//                              carry the row's key, D-01), as `request` has it, with its open task's wait in business
//                              hours until now and whether it is past its due time
//   po <requestNumber>         the latest PO that orders a request's lines: supplier, site, amounts, lines with their
//                              source request lines and the prices paid before for the same item (FR-P2P-003 AC1), its
//                              route and decisions, the PDF it was sent with, its receipts with their photos, and the
//                              notices about it with the page each one opens
//   board <code>               the open approval tasks a member holds, as the board counts them (FR-VIS-001 AC3): how
//                              many, how many past their due time, and their waits in business minutes until now
//   budgets                    every budget line with its planned amount and its balance
//   kpi <from> <to>            the decisions of the Thai days from..to (YYYY-MM-DD) and their share on LINE or LIFF per
//                              kind of document (G-5, §11.4)
// To the demo project of playwright.config.ts every file of tests/e2e/demo is a test file, which Playwright loads to
// collect its tests: this one does its work only when tsx runs it, and loads the app's modules only then.

const LINE_USER_ID = /^U[0-9a-f]{32}$/

async function main(command: string | undefined, args: readonly string[]): Promise<unknown> {
  if (new URL(process.env.DATABASE_URL ?? 'postgresql://x/none').pathname !== `/${E2E_DB}`) throw new Error('the demo day scene runs in the e2e database only')
  const [{ systemClock }, { makeCtx }, { prisma }, { deliverNotification }, { loadInputWorkbook }, { openLineChannel }, { issueLineLinkCode, linkLineAccount }] = await Promise.all([
    import('@/lib/clock'),
    import('@/server/context'),
    import('@/server/db/client'),
    import('@/server/notifications/deliver'),
    import('@/server/seed/workbook'),
    import('@/server/services/line-channel'),
    import('@/server/services/line-link'),
  ])
  // Business time: the app's clock, the one the notification job, the seed of the history and the server read. The
  // business clock of the e2e run (docs/sub-specs/D.md "นาฬิกาธุรกิจของ e2e") is not built yet; once that clock is this
  // one, the script follows it with no change
  const now = () => systemClock.now()
  const workbook = await loadInputWorkbook()
  const orgCode = workbook.keyValues('Org').get('code')?.value
  if (!orgCode) throw new Error('the Org sheet names no organization code')
  const org = await prisma.organization.findUniqueOrThrow({ where: { code: orgCode }, select: { id: true, code: true } })

  const memberOf = async (code: string) => {
    const member = await prisma.member.findFirst({ where: { organizationId: org.id, employeeCode: code }, select: { id: true, displayNameTh: true } })
    if (!member) throw new Error(`the organization ${org.code} has no member ${code}`)
    return member
  }

  const channelOf = () =>
    prisma.lineChannelConfig.findUniqueOrThrow({ where: { organizationId: org.id }, select: { channelKey: true, liffId: true, richMenuLinkedId: true, active: true } })

  /** Both rich menus of the organization's LINE account, made once per run as `pnpm line:richmenu` does (the fake starts empty) */
  async function richMenus(): Promise<string> {
    const stored = await channelOf()
    if (stored.richMenuLinkedId) return stored.richMenuLinkedId
    const { runLineRichMenu } = await import('../../../../scripts/line-richmenu')
    const run = await runLineRichMenu({ org: org.code })
    if (!run.ok) throw new Error(`the rich menus were not made: ${run.problem}`)
    return run.report.linkedId
  }

  /** Links the member to the LINE account as the LIFF link page does: a code issued on the web, spent with an ID token */
  async function link(code: string, lineUserId: string): Promise<'LINKED' | 'ALREADY'> {
    const member = await memberOf(code)
    const live = await prisma.channelIdentity.findFirst({ where: { organizationId: org.id, memberId: member.id, channel: 'LINE', unlinkedAt: null }, select: { externalUserId: true } })
    if (live?.externalUserId === lineUserId) return 'ALREADY'
    if (live) throw new Error(`${code} is linked to another LINE account`)
    // Business time for the command; the code's lifetime is a security timer (docs/sub-specs/D.md: always real time), so
    // the service's own default decides it rather than the scene's clock
    const ctx = makeCtx({ organizationId: org.id, actor: { type: 'USER', memberId: member.id }, channel: 'WEB', now: now() })
    const issued = await issueLineLinkCode(ctx)
    if (!issued.ok) throw new Error(`no link code for ${code}: ${issued.error.code}`)
    const answer = await fetch(`${process.env.LINE_API_BASE_URL}/__fake/id-token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sub: lineUserId, aud: process.env.LINE_LIFF_CHANNEL_ID }),
    })
    if (!answer.ok) throw new Error(`the fake LINE server gave no ID token: ${answer.status}`)
    const { idToken } = (await answer.json()) as { idToken: string }
    // The link code is a secret of this test database: only the refusal's code is ever printed
    const linked = await linkLineAccount({ code: issued.data.code, idToken }, { sender: null, requestId: randomUUID() })
    if (!linked.ok) throw new Error(`${code} was not linked: ${linked.error.code}`)
    return 'LINKED'
  }

  async function prepare(pairs: readonly string[]) {
    const people = pairs.map((pair) => {
      const [code = '', lineUserId = ''] = pair.split(':')
      if (!/^[a-z0-9_]{2,40}$/.test(code) || !LINE_USER_ID.test(lineUserId)) throw new Error(`prepare takes <code>:<LINE user id>, not ${pair}`)
      return { code, lineUserId }
    })
    const linkedMenuId = await richMenus()
    const linked: string[] = []
    const already: string[] = []
    for (const person of people) ((await link(person.code, person.lineUserId)) === 'LINKED' ? linked : already).push(person.code)
    const channel = await channelOf()
    return { channelKey: channel.channelKey, liffId: channel.liffId, active: channel.active, linkedMenuId, linked, already }
  }

  async function deliver(code: string, subjectId: string | undefined) {
    const member = await memberOf(code)
    const pending = await prisma.notification.findMany({
      where: { organizationId: org.id, recipientMemberId: member.id, status: 'PENDING', urgency: 'IMMEDIATE', ...(subjectId ? { subjectId } : {}) },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true, templateKey: true, subjectId: true },
    })
    const delivered = []
    for (const n of pending) {
      const outcome = await deliverNotification(org.id, n.id, now(), { openChannel: openLineChannel })
      delivered.push({ id: n.id, templateKey: n.templateKey, subjectId: n.subjectId, outcome })
    }
    return delivered
  }

  const satang = (value: bigint | null | undefined) => (value === null || value === undefined ? null : value.toString())

  async function requestFacts(where: { number?: string; id?: string }) {
    const r = await prisma.request.findFirst({
      where: { organizationId: org.id, ...where },
      select: {
        id: true,
        number: true,
        status: true,
        title: true,
        priceIncludesVat: true,
        netSatang: true,
        vatSatang: true,
        grossSatang: true,
        submittedAt: true,
        requestType: { select: { code: true } },
        requester: { select: { employeeCode: true } },
        chargedDepartment: { select: { code: true } },
        budgetLine: { select: { code: true } },
        deliverySite: { select: { code: true } },
        lines: { orderBy: { lineNo: 'asc' }, select: { description: true } },
        currentRoute: {
          select: {
            ruleCode: true,
            escalatedFromRuleCode: true,
            amountBasis: true,
            amountSatang: true,
            doaVersion: { select: { id: true, code: true, versionNo: true } },
            steps: {
              orderBy: { stepNo: 'asc' },
              select: {
                stepNo: true,
                tasks: {
                  orderBy: { assignedAt: 'asc' },
                  select: {
                    id: true,
                    status: true,
                    decision: true,
                    channel: true,
                    assignedAt: true,
                    dueAt: true,
                    decidedAt: true,
                    resolvedFrom: true,
                    assignee: { select: { employeeCode: true } },
                    principal: { select: { employeeCode: true } },
                  },
                },
              },
            },
          },
        },
      },
    })
    if (!r) return null
    const tasks = r.currentRoute?.steps.flatMap((s) => s.tasks.map((t) => ({ ...t, stepNo: s.stepNo }))) ?? []
    const decided = await prisma.event.findMany({
      where: { organizationId: org.id, type: 'approval_task.decided', aggregateType: 'ApprovalTask', aggregateId: { in: tasks.map((t) => t.id) } },
      select: { aggregateId: true, occurredAt: true, channel: true, actorMemberId: true, onBehalfOfMemberId: true, doaVersionId: true, doaRuleCode: true, data: true },
    })
    // The members the decisions name, by their codes
    const named = [...new Set(decided.flatMap((e) => [e.actorMemberId, e.onBehalfOfMemberId]).filter((id): id is string => id !== null))]
    const codes = new Map((await prisma.member.findMany({ where: { organizationId: org.id, id: { in: named } }, select: { id: true, employeeCode: true } })).map((m) => [m.id, m.employeeCode] as const))
    const codeOf = (id: string | null) => (id === null ? null : (codes.get(id) ?? id))
    const own = await prisma.event.findMany({ where: { organizationId: org.id, aggregateType: 'Request', aggregateId: r.id }, select: { type: true, channel: true }, orderBy: { seq: 'asc' } })
    const files = await prisma.fileLink.findMany({ where: { organizationId: org.id, subjectType: 'Request', subjectId: r.id }, select: { kind: true } })
    return {
      id: r.id,
      number: r.number,
      status: r.status,
      title: r.title,
      requestType: r.requestType.code,
      requester: r.requester.employeeCode,
      chargedDept: r.chargedDepartment.code,
      budgetLine: r.budgetLine?.code ?? null,
      site: r.deliverySite?.code ?? null,
      priceIncludesVat: r.priceIncludesVat,
      net: satang(r.netSatang),
      vat: satang(r.vatSatang),
      gross: satang(r.grossSatang),
      submittedAt: r.submittedAt?.toISOString() ?? null,
      route: r.currentRoute
        ? {
            ruleCode: r.currentRoute.ruleCode,
            escalatedFromRuleCode: r.currentRoute.escalatedFromRuleCode,
            amountBasis: r.currentRoute.amountBasis,
            amount: satang(r.currentRoute.amountSatang),
            doa: { versionId: r.currentRoute.doaVersion.id, code: r.currentRoute.doaVersion.code, versionNo: r.currentRoute.doaVersion.versionNo },
          }
        : null,
      lines: r.lines.map((l) => l.description),
      tasks: tasks.map((t) => {
        const event = decided.find((e) => e.aggregateId === t.id)
        const data = (event?.data ?? {}) as { stepUpGrantId?: unknown }
        return {
          id: t.id,
          stepNo: t.stepNo,
          status: t.status,
          assignee: t.assignee.employeeCode,
          principal: t.principal?.employeeCode ?? null,
          resolvedFrom: t.resolvedFrom,
          decision: t.decision,
          channel: t.channel,
          assignedAt: t.assignedAt.toISOString(),
          dueAt: t.dueAt?.toISOString() ?? null,
          decidedAt: t.decidedAt?.toISOString() ?? null,
          decided: event
            ? {
                at: event.occurredAt.toISOString(),
                channel: event.channel,
                by: codeOf(event.actorMemberId),
                onBehalfOf: codeOf(event.onBehalfOfMemberId),
                doaVersionId: event.doaVersionId,
                doaRuleCode: event.doaRuleCode,
                stepUp: typeof data.stepUpGrantId === 'string',
              }
            : null,
        }
      }),
      events: own.map((e) => ({ type: e.type, channel: e.channel })),
      files: files.map((f) => f.kind),
    }
  }

  async function latest(code: string, net: string) {
    const member = await memberOf(code)
    const found = await prisma.request.findFirst({
      where: { organizationId: org.id, requesterMemberId: member.id, netSatang: BigInt(net), submittedAt: { not: null } },
      orderBy: { submittedAt: 'desc' },
      select: { id: true },
    })
    return found ? requestFacts({ id: found.id }) : null
  }

  /**
   * The facts BR-FORM-02 fills a new form from: the budget line of the member's latest request of the type that was sent,
   * and the delivery site of the latest request they started (any type, a draft included) — the lines and sites of the
   * demo organization are all in use, so these are what the form starts with
   */
  async function defaults(code: string, type: string) {
    const member = await memberOf(code)
    const sent = await prisma.request.findFirst({
      where: { organizationId: org.id, requesterMemberId: member.id, requestType: { code: type }, submittedAt: { not: null }, budgetLineId: { not: null } },
      orderBy: { submittedAt: 'desc' },
      select: { budgetLine: { select: { code: true } } },
    })
    const started = await prisma.request.findFirst({
      where: { organizationId: org.id, requesterMemberId: member.id, deliverySiteId: { not: null } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { deliverySite: { select: { code: true } } },
    })
    return { budgetLine: sent?.budgetLine?.code ?? null, site: started?.deliverySite?.code ?? null }
  }

  async function budget(code: string) {
    const line = await prisma.budgetLine.findFirst({ where: { organizationId: org.id, code }, select: { id: true } })
    if (!line) throw new Error(`no budget line ${code}`)
    const balance = await prisma.budgetLineBalance.findUniqueOrThrow({ where: { budgetLineId: line.id }, select: { availableSatang: true, reservedSatang: true, committedSatang: true, actualSatang: true } })
    return { code, available: satang(balance.availableSatang), reserved: satang(balance.reservedSatang), committed: satang(balance.committedSatang), actual: satang(balance.actualSatang) }
  }

  async function doa() {
    const at = now()
    const version = await prisma.doaVersion.findFirst({
      where: { organizationId: org.id, status: 'PUBLISHED', effectiveFrom: { lte: at }, OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }] },
      orderBy: { effectiveFrom: 'desc' },
      select: { id: true, code: true, versionNo: true, amountBasis: true, stepUpThresholdSatang: true },
    })
    if (!version) throw new Error('no DOA version in effect')
    return { id: version.id, code: version.code, versionNo: version.versionNo, amountBasis: version.amountBasis, stepUpThreshold: satang(version.stepUpThresholdSatang) }
  }

  async function counts() {
    return {
      submitted: await prisma.request.count({ where: { organizationId: org.id, submittedAt: { not: null } } }),
      tasks: await prisma.approvalTask.count({ where: { organizationId: org.id } }),
      notifications: await prisma.notification.count({ where: { organizationId: org.id } }),
    }
  }

  // ---------- scenes 7, 8 and 9: the PO, the receipt, the board, the budget lines, the KPI ----------

  /** The organization's business calendar (business hours and holidays), as the board and the SLA read it */
  async function calendarOf() {
    const [{ forTenant }, { loadBusinessCalendar }] = await Promise.all([import('@/server/db/tenant'), import('@/server/doa/policy')])
    return forTenant(org.id).$transaction((tx) => loadBusinessCalendar(tx, org.id))
  }

  const codeOfMember = async (ids: ReadonlyArray<string | null>) => {
    const wanted = [...new Set(ids.filter((id): id is string => id !== null))]
    const found = await prisma.member.findMany({ where: { organizationId: org.id, id: { in: wanted } }, select: { id: true, employeeCode: true } })
    const codes = new Map(found.map((m) => [m.id, m.employeeCode ?? m.id] as const))
    return (id: string | null) => (id === null ? null : (codes.get(id) ?? id))
  }

  async function historyRequest(ref: string) {
    if (!/^H\d{2,3}$/.test(ref)) throw new Error(`history takes a ref of sheet Demo_History, not ${ref}`)
    // Every event of a step of the history carries the step's key as its requestId (src/server/services/demo-history)
    const drafted = await prisma.event.findFirst({ where: { organizationId: org.id, aggregateType: 'Request', requestId: `demo-history:${ref}:draft` }, select: { aggregateId: true } })
    if (!drafted) return null
    const facts = await requestFacts({ id: drafted.aggregateId })
    if (!facts) return null
    const at = now()
    const calendar = await calendarOf()
    const { businessMinutesBetween } = await import('@/core/sla')
    const open = facts.tasks.find((t) => t.status === 'OPEN') ?? null
    return {
      ...facts,
      waiting: open
        ? { taskId: open.id, waitedMinutes: businessMinutesBetween(new Date(open.assignedAt), at, calendar), overdue: open.dueAt !== null && new Date(open.dueAt) < at }
        : null,
    }
  }

  /** The route of a document with its tasks and their decisions' events, as `request` gives a request's */
  async function routeFacts(routeId: string | null) {
    if (!routeId) return null
    const route = await prisma.approvalRoute.findUniqueOrThrow({
      where: { id: routeId },
      select: {
        ruleCode: true,
        amountBasis: true,
        amountSatang: true,
        doaVersion: { select: { id: true, code: true, versionNo: true } },
        steps: {
          orderBy: { stepNo: 'asc' },
          select: {
            stepNo: true,
            tasks: {
              orderBy: { assignedAt: 'asc' },
              select: { id: true, status: true, decision: true, channel: true, resolvedFrom: true, assignedAt: true, dueAt: true, decidedAt: true, assignee: { select: { employeeCode: true } }, principal: { select: { employeeCode: true } } },
            },
          },
        },
      },
    })
    const tasks = route.steps.flatMap((s) => s.tasks.map((t) => ({ ...t, stepNo: s.stepNo })))
    const decided = await prisma.event.findMany({
      where: { organizationId: org.id, type: 'approval_task.decided', aggregateType: 'ApprovalTask', aggregateId: { in: tasks.map((t) => t.id) } },
      select: { aggregateId: true, occurredAt: true, channel: true, actorMemberId: true, onBehalfOfMemberId: true, doaVersionId: true, doaRuleCode: true, data: true },
    })
    const codeOf = await codeOfMember(decided.flatMap((e) => [e.actorMemberId, e.onBehalfOfMemberId]))
    return {
      ruleCode: route.ruleCode,
      amountBasis: route.amountBasis,
      amount: satang(route.amountSatang),
      doa: { versionId: route.doaVersion.id, code: route.doaVersion.code, versionNo: route.doaVersion.versionNo },
      tasks: tasks.map((t) => {
        const event = decided.find((e) => e.aggregateId === t.id)
        const data = (event?.data ?? {}) as { stepUpGrantId?: unknown }
        return {
          id: t.id,
          stepNo: t.stepNo,
          status: t.status,
          assignee: t.assignee.employeeCode,
          principal: t.principal?.employeeCode ?? null,
          resolvedFrom: t.resolvedFrom,
          decision: t.decision,
          channel: t.channel,
          assignedAt: t.assignedAt.toISOString(),
          dueAt: t.dueAt?.toISOString() ?? null,
          decidedAt: t.decidedAt?.toISOString() ?? null,
          decided: event
            ? {
                at: event.occurredAt.toISOString(),
                channel: event.channel,
                by: codeOf(event.actorMemberId),
                onBehalfOf: codeOf(event.onBehalfOfMemberId),
                doaVersionId: event.doaVersionId,
                doaRuleCode: event.doaRuleCode,
                stepUp: typeof data.stepUpGrantId === 'string',
              }
            : null,
        }
      }),
    }
  }

  /** "the same item" of the price history (FR-P2P-003 AC1): the category, and the description with spaces collapsed, case folded */
  const sameItem = (category: string | null, description: string) => `${category ?? ''}|${description.trim().replace(/\s+/g, ' ').toLowerCase()}`
  /** A PO's statuses once it is approved: the prices it ordered at count as paid */
  const ORDERED = ['APPROVED', 'SENT', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED'] as const

  async function poFacts(requestNumber: string) {
    const request = await prisma.request.findFirst({ where: { organizationId: org.id, number: requestNumber }, select: { id: true } })
    if (!request) throw new Error(`no request ${requestNumber}`)
    const po = await prisma.purchaseOrder.findFirst({
      where: { organizationId: org.id, lines: { some: { sources: { some: { requestLine: { requestId: request.id } } } } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: {
        id: true,
        number: true,
        status: true,
        kind: true,
        urgency: true,
        netSatang: true,
        vatSatang: true,
        grossSatang: true,
        vatRateBp: true,
        submittedAt: true,
        approvedAt: true,
        sentAt: true,
        sentToEmail: true,
        currentRouteId: true,
        supplier: { select: { code: true, nameTh: true, email: true } },
        deliverySite: { select: { code: true } },
        createdBy: { select: { employeeCode: true } },
        pdfFile: { select: { fileName: true, mimeType: true, sha256: true, sizeBytes: true } },
        lines: {
          orderBy: { lineNo: 'asc' },
          select: {
            id: true,
            lineNo: true,
            description: true,
            categoryCode: true,
            quantity: true,
            uom: true,
            unitPriceSatang: true,
            netSatang: true,
            receivedQuantity: true,
            budgetLine: { select: { code: true } },
            sources: { orderBy: { createdAt: 'asc' }, select: { quantity: true, requestLine: { select: { lineNo: true, requestId: true, request: { select: { number: true } } } } } },
          },
        },
      },
    })
    if (!po) return null
    // The requests it orders, with who asked from which department
    const ordering = await prisma.request.findMany({
      where: { organizationId: org.id, id: { in: [...new Set(po.lines.flatMap((l) => l.sources.map((s) => s.requestLine.requestId)))] } },
      orderBy: { number: 'asc' },
      select: { number: true, title: true, requester: { select: { employeeCode: true } }, requesterDepartment: { select: { code: true } } },
    })
    // The prices paid before for the same item: lines of other POs once approved, newest first, three at most
    const earlier = await prisma.poLine.findMany({
      where: { organizationId: org.id, poId: { not: po.id }, po: { status: { in: [...ORDERED] }, approvedAt: { not: null } }, OR: po.lines.map((l) => ({ categoryCode: l.categoryCode })) },
      select: { categoryCode: true, description: true, unitPriceSatang: true, po: { select: { number: true, approvedAt: true } } },
    })
    const receipts = await prisma.goodsReceipt.findMany({
      where: { organizationId: org.id, poId: po.id },
      orderBy: [{ receivedAt: 'asc' }, { number: 'asc' }],
      select: { id: true, number: true, status: true, deliveryNoteNo: true, receiver: { select: { employeeCode: true } }, lines: { select: { poLineId: true, receivedQuantity: true, acceptedQuantity: true, rejectedQuantity: true } } },
    })
    const posted = await prisma.event.findMany({ where: { organizationId: org.id, type: 'gr.posted', aggregateId: { in: receipts.map((r) => r.id) } }, select: { aggregateId: true, channel: true } })
    const photoLinks = await prisma.fileLink.findMany({ where: { organizationId: org.id, subjectType: 'GoodsReceipt', subjectId: { in: receipts.map((r) => r.id) } }, select: { subjectId: true, kind: true, fileId: true } })
    const photoFiles = await prisma.fileObject.findMany({ where: { organizationId: org.id, id: { in: photoLinks.map((l) => l.fileId) } }, select: { id: true, fileName: true, mimeType: true, sizeBytes: true } })
    const own = await prisma.event.findMany({ where: { organizationId: org.id, aggregateType: 'PurchaseOrder', aggregateId: po.id }, orderBy: { seq: 'asc' }, select: { type: true, channel: true, actorMemberId: true } })
    const notices = await prisma.notification.findMany({
      where: { organizationId: org.id, subjectId: po.id },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { templateKey: true, urgency: true, status: true, data: true, subjectType: true, subjectId: true, recipientMemberId: true },
    })
    const codeOf = await codeOfMember([...own.map((e) => e.actorMemberId), ...notices.map((n) => n.recipientMemberId)])
    const { renderNotification } = await import('@/server/notifications/templates')
    return {
      id: po.id,
      number: po.number,
      status: po.status,
      kind: po.kind,
      urgency: po.urgency,
      supplier: po.supplier,
      site: po.deliverySite?.code ?? null,
      createdBy: po.createdBy?.employeeCode ?? null,
      net: satang(po.netSatang),
      vat: satang(po.vatSatang),
      gross: satang(po.grossSatang),
      vatRateBp: po.vatRateBp,
      submittedAt: po.submittedAt?.toISOString() ?? null,
      approvedAt: po.approvedAt?.toISOString() ?? null,
      sentAt: po.sentAt?.toISOString() ?? null,
      sentToEmail: po.sentToEmail,
      pdf: po.pdfFile,
      requests: ordering.map((r) => ({ number: r.number, title: r.title, requester: r.requester.employeeCode, department: r.requesterDepartment.code })),
      lines: po.lines.map((l) => ({
        id: l.id,
        lineNo: l.lineNo,
        description: l.description,
        categoryCode: l.categoryCode,
        quantity: l.quantity.toString(),
        uom: l.uom,
        unitPrice: satang(l.unitPriceSatang),
        net: satang(l.netSatang),
        received: l.receivedQuantity.toString(),
        budgetLine: l.budgetLine.code,
        sources: l.sources.map((s) => ({ requestNumber: s.requestLine.request.number, lineNo: s.requestLine.lineNo, quantity: s.quantity.toString() })),
        earlierPrices: earlier
          .filter((e) => sameItem(e.categoryCode, e.description) === sameItem(l.categoryCode, l.description))
          .sort((a, b) => b.po.approvedAt!.getTime() - a.po.approvedAt!.getTime() || (b.po.number ?? '').localeCompare(a.po.number ?? '', 'en', { numeric: true }))
          .slice(0, 3)
          .map((e) => ({ poNumber: e.po.number, approvedAt: e.po.approvedAt!.toISOString(), unitPrice: satang(e.unitPriceSatang) })),
      })),
      route: await routeFacts(po.currentRouteId),
      events: own.map((e) => ({ type: e.type, channel: e.channel, by: codeOf(e.actorMemberId) })),
      receipts: receipts.map((r) => ({
        number: r.number,
        status: r.status,
        receiver: r.receiver.employeeCode,
        deliveryNoteNo: r.deliveryNoteNo,
        channel: posted.find((e) => e.aggregateId === r.id)?.channel ?? null,
        lines: r.lines.map((g) => ({ poLineId: g.poLineId, received: g.receivedQuantity.toString(), accepted: g.acceptedQuantity.toString(), rejected: g.rejectedQuantity.toString() })),
        photos: photoLinks
          .filter((p) => p.subjectId === r.id)
          .map((p) => {
            const file = photoFiles.find((f) => f.id === p.fileId)
            return { kind: p.kind, fileName: file?.fileName ?? null, mimeType: file?.mimeType ?? null, sizeBytes: file?.sizeBytes ?? null }
          }),
      })),
      notices: notices.map((n) => ({
        recipient: codeOf(n.recipientMemberId),
        templateKey: n.templateKey,
        urgency: n.urgency,
        status: n.status,
        data: n.data,
        href: renderNotification(n, 'th').href,
      })),
    }
  }

  async function board(code: string) {
    const member = await memberOf(code)
    const at = now()
    const calendar = await calendarOf()
    const { businessMinutesBetween } = await import('@/core/sla')
    const held = await prisma.approvalTask.findMany({
      where: { organizationId: org.id, assigneeMemberId: member.id, status: { in: ['OPEN', 'INFO_REQUESTED'] } },
      orderBy: { assignedAt: 'asc' },
      select: { id: true, status: true, assignedAt: true, dueAt: true, step: { select: { route: { select: { subjectType: true, subjectId: true } } } } },
    })
    const tasks = held.map((t) => ({
      id: t.id,
      status: t.status,
      subjectType: t.step.route.subjectType,
      subjectId: t.step.route.subjectId,
      assignedAt: t.assignedAt.toISOString(),
      dueAt: t.dueAt?.toISOString() ?? null,
      waitedMinutes: businessMinutesBetween(t.assignedAt, at, calendar),
      overdue: t.status === 'OPEN' && t.dueAt !== null && t.dueAt < at,
    }))
    const open = tasks.filter((t) => t.status === 'OPEN')
    const ages = open.map((t) => t.waitedMinutes)
    return {
      memberId: member.id,
      name: member.displayNameTh,
      open: open.length,
      waiting: tasks.length - open.length,
      overdue: open.filter((t) => t.overdue).length,
      oldestMinutes: ages.length ? Math.max(...ages) : 0,
      averageMinutes: ages.length ? Math.round(ages.reduce((a, b) => a + b, 0) / ages.length) : 0,
      tasks,
    }
  }

  async function budgets() {
    const lines = await prisma.budgetLine.findMany({
      where: { organizationId: org.id },
      orderBy: { code: 'asc' },
      select: {
        code: true,
        nameTh: true,
        plannedSatang: true,
        department: { select: { code: true, nameTh: true } },
        fiscalYear: { select: { code: true } },
        balance: { select: { availableSatang: true, reservedSatang: true, committedSatang: true, actualSatang: true } },
      },
    })
    return lines.map((l) => ({
      code: l.code,
      nameTh: l.nameTh,
      department: l.department.code,
      fiscalYear: l.fiscalYear.code,
      planned: satang(l.plannedSatang),
      available: satang(l.balance?.availableSatang ?? 0n),
      reserved: satang(l.balance?.reservedSatang ?? 0n),
      committed: satang(l.balance?.committedSatang ?? 0n),
      actual: satang(l.balance?.actualSatang ?? 0n),
    }))
  }

  const DAY = /^\d{4}-\d{2}-\d{2}$/
  const MS_PER_DAY = 24 * 60 * 60 * 1000

  /**
   * G-5 of the Thai days from..to as §11.4 counts it: the approval_task.decided events of the period — from the start of
   * `from` to the end of `to` in Thai time, as the KPI page turns its days into a period (periodOf of
   * src/server/services/reports) — those made in the LINE chat or in LIFF over all of them, per kind of document (a
   * request is a PURCHASE_REQUEST)
   */
  async function kpi(from: string, to: string) {
    if (!DAY.test(from) || !DAY.test(to)) throw new Error('kpi <from YYYY-MM-DD> <to YYYY-MM-DD>')
    const start = new Date(`${from}T00:00:00+07:00`)
    const end = new Date(new Date(`${to}T00:00:00+07:00`).getTime() + MS_PER_DAY)
    const decided = await prisma.event.findMany({
      where: { organizationId: org.id, type: 'approval_task.decided', occurredAt: { gte: start, lt: end } },
      orderBy: { seq: 'asc' },
      select: { aggregateId: true, channel: true, data: true },
    })
    const decisions = decided.map((d) => {
      const subjectType = String((d.data as { subjectType?: unknown }).subjectType ?? '')
      return { taskId: d.aggregateId, channel: d.channel, kind: subjectType === 'REQUEST' ? 'PURCHASE_REQUEST' : subjectType, onLine: d.channel === 'LINE_CHAT' || d.channel === 'LIFF' }
    })
    const byKind: Record<string, { numerator: number; denominator: number }> = {}
    for (const d of decisions) {
      byKind[d.kind] ??= { numerator: 0, denominator: 0 }
      byKind[d.kind]!.denominator++
      if (d.onLine) byKind[d.kind]!.numerator++
    }
    return { from, to, total: { numerator: decisions.filter((d) => d.onLine).length, denominator: decisions.length }, byKind, decisions }
  }

  try {
    switch (command) {
      case 'prepare':
        return await prepare(args)
      case 'deliver':
        if (!args[0]) throw new Error('deliver <code> [subjectId]')
        return await deliver(args[0], args[1])
      case 'request':
        if (!args[0]) throw new Error('request <number>')
        return await requestFacts({ number: args[0] })
      case 'latest':
        if (!args[0] || !/^\d+$/.test(args[1] ?? '')) throw new Error('latest <code> <netSatang>')
        return await latest(args[0], args[1]!)
      case 'defaults':
        if (!args[0] || !args[1]) throw new Error('defaults <code> <requestType>')
        return await defaults(args[0], args[1])
      case 'budget':
        if (!args[0]) throw new Error('budget <lineCode>')
        return await budget(args[0])
      case 'doa':
        return await doa()
      case 'counts':
        return await counts()
      case 'channel': {
        const channel = await channelOf()
        return { channelKey: channel.channelKey, liffId: channel.liffId }
      }
      case 'history':
        if (!args[0]) throw new Error('history <ref>')
        return await historyRequest(args[0])
      case 'po':
        if (!args[0]) throw new Error('po <requestNumber>')
        return await poFacts(args[0])
      case 'board':
        if (!args[0]) throw new Error('board <code>')
        return await board(args[0])
      case 'budgets':
        return await budgets()
      case 'kpi':
        return await kpi(args[0] ?? '', args[1] ?? '')
      default:
        throw new Error(`unknown demo day command ${command ?? '(none)'}`)
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
