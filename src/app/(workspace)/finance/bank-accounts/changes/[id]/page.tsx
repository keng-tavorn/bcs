import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getLocale, getTranslations } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { memberPrincipal } from '@/server/authz'
import { getTaskAccess } from '@/server/queries/tasks'
import { getBankAccountChange, getBankAccountChangeActivity, type BankAccountChangeDto, type BankChangeHistoryDto } from '@/server/services/bank-accounts/view'
import { ChangeStatusBadge } from '@/ui/bank-accounts/badges'
import { CancelChange } from '@/ui/bank-accounts/cancel-change'
import { ChangeDecision } from '@/ui/bank-accounts/change-decision'
import { DraftEditor } from '@/ui/bank-accounts/draft-editor'
import { BANK_CODES, BANK_REASONS } from '@/ui/bank-accounts/outcome'
import { RevealNumbers } from '@/ui/bank-accounts/reveal'
import { DocBody, DocHeader } from '@/ui/document/doc-header'
import { HistoryTable, type HistoryRowView } from '@/ui/document/history-table'
import { SummaryList } from '@/ui/document/rail'
import { Notice } from '@/ui/form/notice'
import { Page, PageHeader, Panel } from '@/ui/page/page'
import { AttachmentList } from '@/ui/request-view/attachments'
import { Facts } from '@/ui/request-view/facts'
import { Toaster } from '@/ui/shadcn/sonner'
import { completeUploadAction, downloadUrlAction, requestUploadAction } from '../../../../../_lib/file-actions'
import { getSession } from '../../../../../_lib/session'
import { taskRight } from '../../../../_tracking/access'
import { localeOf, when, type Locale } from '../../../../_tracking/present'
import { decideTaskAction } from '../../../../tasks/actions'
import { attachProofAction, cancelChangeAction, detachProofAction, recordCallAction, revealChangeAction, submitChangeAction, updateChangeAction } from '../../actions'
import { accountText, bankChoiceText, changeOwnerText, personName, templateText, type BankT } from '../../present'

// A request to change a bank account (S9-09, docs/sub-specs/S9.md "หน้าจอ", FR-PAY-102 AC7 AC8, BR-SUP-06, BR-DOA-25):
// the account it replaces or closes and the one it proposes side by side, masked, with "ดูเลขเต็ม" for FINANCE and the
// request's approver (each opening logged by the service); the reason and the call to the number in the register; the
// papers (downloaded under the same rule, file-policy.ts); its status and history. Its proposer edits the draft, attaches
// and takes off papers, records the call, sends it, and cancels it (a draft or one waiting); the approver decides it in
// the decision bar with the PIN every time — on the web or in LIFF, never from a chat button. For bankAccount.view and
// the request's approvers, with module PAY: the views check both before anything is read; every command checks again.

const linkClass = 'inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline'
const one = (value: string | string[] | undefined): string | null => (typeof value === 'string' ? value : null)

type TimelineT = Awaited<ReturnType<typeof getTranslations<'timeline'>>>

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const t = await getTranslations('bankAccount.detail')
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  // The title names the request only for those who may open it
  const change = ctx ? await getBankAccountChange(ctx, { changeId: id }) : null
  return { title: change?.ok && change.data.number ? t('metaTitle', { number: change.data.number }) : t('metaTitleDraft') }
}

/** A notice the proposal form left in the address (?notice=…&problem=…): only words of this page, never free text */
function formNotice(t: BankT, notice: string | null, problem: string | null) {
  if (notice === 'saved') return <Notice tone="success">{t('detail.notice.saved')}</Notice>
  if (notice === 'sent') return <Notice tone="success">{t('detail.notice.sent')}</Notice>
  if (notice !== 'incomplete') return null
  const [group, code] = (problem ?? '').split('.')
  const known = (group === 'reason' && (BANK_REASONS as readonly string[]).includes(code ?? '')) || (group === 'code' && (BANK_CODES as readonly string[]).includes(code ?? ''))
  const words = known ? t(`errors.${problem as 'code.OTHER'}`) : t('errors.code.OTHER')
  return (
    <Notice tone="warning">
      <p>{t('detail.notice.incomplete')}</p>
      <p>{words}</p>
    </Notice>
  )
}

/** One account of the request, masked: the one in force it replaces or closes, or the one proposed */
function AccountBlock({ title, account, empty, t }: { title: string; account: { bankName: string | null; bankCode: string; accountNoMasked: string; accountName: string; branchName: string | null; accountType: 'CURRENT' | 'SAVINGS' | null; template?: string | null } | null; empty: string; t: BankT }) {
  return (
    <section aria-label={title} className="flex min-w-0 flex-col gap-2 rounded-md border border-line p-3">
      <h3 className="font-semibold text-ink">{title}</h3>
      {account ? (
        <Facts
          columns="one"
          items={[
            { label: t('detail.bank'), value: account.bankName ?? account.bankCode },
            { label: t('detail.number'), value: <span className="tabular">{account.accountNoMasked}</span> },
            { label: t('detail.name'), value: account.accountName },
            ...(account.branchName ? [{ label: t('detail.branch'), value: account.branchName }] : []),
            ...(account.accountType ? [{ label: t('detail.type'), value: t(`form.accountTypes.${account.accountType}`) }] : []),
            ...(account.template !== undefined ? [{ label: t('payers.template'), value: templateText(t, account.template) }] : []),
          ]}
        />
      ) : (
        <p className="text-ink-muted">{empty}</p>
      )}
    </section>
  )
}

const DECISION_EVENTS: ReadonlySet<string> = new Set(['approval_task.decided', 'bank_account_change.returned', 'bank_account_change.rejected', 'bank_account_change.approved'])
const HISTORY_FIELDS = ['bankCode', 'accountNo', 'accountName', 'branchName', 'accountType', 'reason', 'callVerification', 'proof'] as const

function eventText(t: BankT, e: BankChangeHistoryDto, kind: BankAccountChangeDto['kind']): string {
  switch (e.type) {
    case 'bank_account_change.drafted':
      return t('history.drafted')
    case 'bank_account_change.updated': {
      const fields = e.fields.filter((f): f is (typeof HISTORY_FIELDS)[number] => (HISTORY_FIELDS as readonly string[]).includes(f)).map((f) => t(`history.field.${f}`))
      return fields.length ? t('history.updated', { fields: fields.join(', ') }) : t('history.updatedPlain')
    }
    case 'bank_account_change.submitted':
      return t('history.submitted')
    case 'bank_account_change.cancelled':
      return t('history.cancelled')
    case 'bank_account_change.returned':
      return t('history.returned')
    case 'bank_account_change.rejected':
      return t('history.rejected')
    case 'bank_account_change.approved':
      return kind === 'CLOSE' ? t('history.approvedClose') : t('history.approved')
    case 'approval_task.decided':
      return e.decision === 'APPROVE' || e.decision === 'RETURN' || e.decision === 'REJECT' ? t(`history.decided.${e.decision}`) : t('history.other')
    default:
      return t('history.other')
  }
}

function historyRows(t: BankT, tl: TimelineT, locale: Locale, change: BankAccountChangeDto, history: readonly BankChangeHistoryDto[]): HistoryRowView[] {
  return history.map((e) => ({
    key: e.id,
    kind: DECISION_EVENTS.has(e.type) ? 'DECISION' : 'DOCUMENT',
    when: when(locale, e.at),
    actor: e.actor ? personName(locale, e.actor) : tl('system'),
    ...(e.onBehalfOf ? { onBehalfOf: tl('onBehalfOf', { name: personName(locale, e.onBehalfOf) }) } : {}),
    event: eventText(t, e, change.kind),
    ...(e.note ? { note: e.note } : {}),
    channel: tl(`channel.${e.channel as 'WEB'}`),
  }))
}

export default async function BankAccountChangePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { id } = await params
  const state = await getSession()
  const ctx = ctxFromSession(state, 'WEB', systemClock.now())
  if (!ctx || state.kind !== 'member') return null
  const [t, tl, th, locale] = await Promise.all([getTranslations('bankAccount'), getTranslations('timeline'), getTranslations('document.history'), getLocale().then(localeOf)])
  const [changeResult, activityResult] = await Promise.all([getBankAccountChange(ctx, { changeId: id }), getBankAccountChangeActivity(ctx, { changeId: id })])
  if (!changeResult.ok || !activityResult.ok) {
    const code = !changeResult.ok ? changeResult.error.code : !activityResult.ok ? activityResult.error.code : ''
    if (code === 'NOT_FOUND') notFound()
    return (
      <Page>
        <PageHeader title={t('detail.forbiddenTitle')} />
        <div className="flex max-w-2xl flex-col gap-4">
          <Notice tone="warning">{code === 'MODULE_DISABLED' ? t('list.moduleOff') : t('detail.forbiddenHint')}</Notice>
          <Link href="/" className={linkClass}>
            {t('list.home')}
          </Link>
        </div>
      </Page>
    )
  }
  const c = changeResult.data
  const a = activityResult.data
  const query = await searchParams
  // The decision bar: an open approval task of this request that the reader may decide (approval.decide, BR-DLG-04)
  const access = a.openTaskId ? await getTaskAccess(ctx, a.openTaskId) : null
  const decide = access && access.status === 'OPEN' && taskRight(memberPrincipal(state.member.id, state.roles), access) === 'DECIDE' ? access : null
  const draft = c.status === 'DRAFT' && a.isProposer
  const cancellable = a.isProposer && (c.status === 'DRAFT' || c.status === 'PENDING_APPROVAL')
  const owner = changeOwnerText(t, locale, { ownerKind: c.ownerKind, supplier: c.supplier })
  const number = c.number ?? t('detail.draftNumber')
  const label = `${number} ${t(`kind.${c.kind}`)} ${owner}`
  const statusBadge = <ChangeStatusBadge status={c.status} label={t(`status.${c.status}`)} />
  const target = c.target ? { ...c.target, template: c.ownerKind === 'ORGANIZATION' ? c.target.fileTemplateCode : undefined } : null
  const proposedText = c.proposed ? accountText({ code: null, bankName: c.proposed.bankName, bankCode: c.proposed.bankCode, accountNoMasked: c.proposed.accountNoMasked, accountName: c.proposed.accountName }) : null
  const summary = [
    { label: t('detail.owner'), value: owner },
    { label: t('detail.proposer'), value: personName(locale, a.proposer) },
    { label: t('detail.submitted'), value: c.submittedAt ? when(locale, c.submittedAt) : t('list.notSubmitted') },
    ...(c.status === 'PENDING_APPROVAL' && a.waitingFor.length ? [{ label: t('detail.waitingFor'), value: a.waitingFor.map((p) => personName(locale, p)).join(', ') }] : []),
    ...(c.decidedAt && c.status !== 'DRAFT' ? [{ label: t('detail.decided'), value: when(locale, c.decidedAt) }] : []),
  ]
  const call = c.callVerifiedAt ? { when: t('detail.callAt', { time: when(locale, c.callVerifiedAt) }), note: c.callVerificationNote ?? '' } : null
  const revealRows = [
    ...(c.target ? [{ key: 'targetAccountNo' as const, label: t('detail.wholeOld') }] : []),
    ...(c.proposed ? [{ key: 'accountNo' as const, label: t('detail.wholeNew') }] : []),
  ]

  return (
    <div className={decide ? 'flex flex-col gap-6 pb-[calc(var(--task-bar-space,14rem)_+_1rem)] xl:pb-0' : 'flex flex-col gap-6'}>
      <DocHeader
        back={{ href: '/finance/bank-accounts?tab=open', label: t('detail.back') }}
        number={number}
        title={t('detail.title', { kind: t(`kind.${c.kind}`), owner })}
        badges={statusBadge}
        actions={null}
        summary={summary}
        compactBadge={statusBadge}
        notices={
          <>
            {formNotice(t, one(query.notice), one(query.problem))}
            {draft && c.number ? <Notice tone="warning">{t('detail.returnedHint')}</Notice> : null}
            {c.sharedAccount ? <Notice tone="warning">{t('detail.sharedAccount')}</Notice> : null}
            {c.contactChangedRecently ? <Notice tone="warning">{t('detail.contactChanged')}</Notice> : null}
            {c.status === 'APPROVED' && c.applied?.activatedAt ? <Notice tone="success">{t('detail.applied', { time: when(locale, c.applied.activatedAt) })}</Notice> : null}
          </>
        }
      />

      <DocBody
        main={
          <>
            <Panel id="bank-change-accounts" title={t('detail.accountsTitle')}>
              <div className="grid gap-3 md:grid-cols-2">
                <AccountBlock title={t('detail.old')} account={target} empty={t('detail.noOld')} t={t} />
                <AccountBlock title={t('detail.new')} account={c.proposed} empty={t('detail.noNew')} t={t} />
              </div>
              <p className="text-base text-ink-muted md:text-sm">{t('detail.maskedNote')}</p>
              {c.canReveal && revealRows.length ? <RevealNumbers reveal={revealChangeAction} input={{ changeId: c.id }} rows={revealRows} /> : null}
            </Panel>

            <Panel id="bank-change-reason" title={t('detail.reasonTitle')}>
              <Facts
                columns="one"
                items={[
                  { label: t('detail.reason'), value: <span className="whitespace-pre-line">{c.reason}</span> },
                  {
                    label: t('detail.call'),
                    value: call ? (
                      <span className="flex flex-col">
                        <span>{call.when}</span>
                        <span className="whitespace-pre-line">{call.note}</span>
                      </span>
                    ) : (
                      <span className="text-ink-muted">{t('detail.noCall')}</span>
                    ),
                  },
                ]}
              />
            </Panel>

            {draft ? (
              <Panel id="bank-change-draft" title={t('draft.title')}>
                <p className="text-ink-muted">{t('draft.hint')}</p>
                <DraftEditor
                  changeId={c.id}
                  version={c.version}
                  kind={c.kind}
                  ownerKind={c.ownerKind}
                  proposed={c.proposed}
                  reason={c.reason}
                  banks={a.banks.map((b) => ({ value: b.code, label: bankChoiceText(b) }))}
                  proofs={c.proofs}
                  call={call}
                  supplierPhone={a.supplierPhone}
                  actions={{
                    update: updateChangeAction,
                    attach: attachProofAction,
                    detach: detachProofAction,
                    recordCall: recordCallAction,
                    submit: submitChangeAction,
                    requestUpload: requestUploadAction,
                    completeUpload: completeUploadAction,
                    openFile: downloadUrlAction,
                  }}
                />
              </Panel>
            ) : (
              <Panel id="bank-change-proofs" title={t('detail.proofsTitle')}>
                {c.proofs.length === 0 ? (
                  <p className="text-ink-muted">{t('detail.noProofs')}</p>
                ) : c.canReveal ? (
                  <AttachmentList open={downloadUrlAction} files={c.proofs.map((p) => ({ fileId: p.fileId, fileName: p.fileName, detail: t('detail.proofDetail') }))} />
                ) : (
                  <>
                    <ul className="flex flex-col divide-y divide-line border-y border-line">
                      {c.proofs.map((p) => (
                        <li key={p.fileId} className="py-2 break-all text-ink">
                          {p.fileName}
                        </li>
                      ))}
                    </ul>
                    <p className="text-base text-ink-muted md:text-sm">{t('detail.proofsHidden')}</p>
                  </>
                )}
              </Panel>
            )}

            <Panel id="bank-change-history" title={t('detail.historyTitle')}>
              <HistoryTable
                rows={historyRows(t, tl, locale, c, a.history)}
                labels={{
                  table: t('detail.historyTitle'),
                  filter: th('filter'),
                  all: th('all'),
                  kinds: { DECISION: th('kinds.DECISION'), DOCUMENT: th('kinds.DOCUMENT'), QUESTION: th('kinds.QUESTION'), GOODS: th('kinds.GOODS') },
                  columns: { when: th('columns.when'), actor: th('columns.actor'), event: th('columns.event'), channel: th('columns.channel') },
                  empty: th('empty'),
                }}
              />
            </Panel>
          </>
        }
        rail={
          <>
            {decide ? (
              <ChangeDecision
                taskId={decide.taskId}
                label={label}
                kind={c.kind}
                locale={locale}
                facts={[
                  { label: t('detail.owner'), value: owner },
                  ...(c.target ? [{ label: t('detail.old'), value: accountText(c.target) }] : []),
                  ...(proposedText ? [{ label: t('detail.new'), value: proposedText }] : []),
                ]}
                decide={decideTaskAction}
              />
            ) : null}
            <Panel title={t('detail.statusTitle')} id="bank-change-status">
              <SummaryList
                label={t('detail.statusTitle')}
                items={[
                  { label: t('detail.status'), value: statusBadge },
                  ...(c.status === 'PENDING_APPROVAL' ? [{ label: t('detail.waitingFor'), value: a.waitingFor.length ? a.waitingFor.map((p) => personName(locale, p)).join(', ') : '-' }] : []),
                  { label: t('detail.stepUp'), value: t('detail.stepUpValue') },
                ]}
              />
              {cancellable ? <CancelChange changeId={c.id} version={c.version} cancel={cancelChangeAction} /> : null}
            </Panel>
          </>
        }
      />
      <Toaster position="top-center" />
    </div>
  )
}
