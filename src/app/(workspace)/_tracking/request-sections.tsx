import { getTranslations } from 'next-intl/server'
import type { FieldValueDto, RequestViewDto, RouteStepDto } from '@/server/queries/requests'
import { AttachmentList } from '@/ui/request-view/attachments'
import { DoaRef } from '@/ui/request-view/doa-ref'
import { Amounts, Facts, Section, type Fact } from '@/ui/request-view/facts'
import { LineList } from '@/ui/request-view/lines'
import { StateLine, type StateKind } from '@/ui/request-view/status'
import { StepApprovers } from '@/ui/request-view/step-approvers'
import { BYTES_PER_KIB } from '@/lib/constants'
import { day, doaHref, doaRefText, expectedText, fileKind, memberName, money, nameIn, roleText, routeSentence, when, type Locale } from './present'

// The body of a request as both the request page and the decision page show it (§9.9 principle 5: amount before VAT,
// VAT, the budget and its state, the DOA rule with why the route goes where it goes, the lines, the details, the
// attachments and the questions — all on one screen). Flat sections separated by rules; no cards.

/**
 * Who asked, for which department, when and how urgently. The decision page names the requester, the department and
 * the type in its heading already, so it shows only the rest (`brief`), keeping the amounts high on a phone.
 */
export async function RequestFacts({ view, locale, brief = false }: { view: RequestViewDto; locale: Locale; brief?: boolean }) {
  const t = await getTranslations('requestView')
  const items: Fact[] = [
    ...(brief
      ? []
      : [
          { label: t('facts.type'), value: nameIn(locale, view.requestType.name) },
          { label: t('facts.requester'), value: memberName(locale, view.requester) },
          ...(view.requesterDepartment ? [{ label: t('facts.requesterDepartment'), value: nameIn(locale, view.requesterDepartment.name) }] : []),
        ]),
    ...(view.chargedDepartment && view.chargedDepartment.id !== view.requesterDepartment?.id ? [{ label: t('facts.chargedDepartment'), value: nameIn(locale, view.chargedDepartment.name) }] : []),
    view.submittedAt ? { label: t('facts.submitted'), value: when(locale, view.submittedAt) } : { label: t('facts.created'), value: when(locale, view.createdAt) },
    ...(view.neededBy ? [{ label: t('facts.neededBy'), value: day(locale, view.neededBy) }] : []),
    { label: t('facts.urgency'), value: view.urgency === 'URGENT' ? t('facts.urgent') : t('facts.normal') },
  ]
  return <Facts items={items} className="grid-cols-2 lg:grid-cols-3" />
}

function budgetState(view: RequestViewDto): { kind: StateKind; key: 'stateReserved' | 'stateCommitted' | 'stateReleased' | 'stateNone' } {
  const b = view.budget
  if (b && b.committedSatang > 0n) return { kind: 'done', key: 'stateCommitted' }
  if (b && b.reservedSatang > 0n) return { kind: 'done', key: 'stateReserved' }
  if (view.status === 'REJECTED' || view.status === 'CANCELLED') return { kind: 'closed', key: 'stateReleased' }
  return { kind: 'draft', key: 'stateNone' }
}

function stepState(step: RouteStepDto): { kind: StateKind; key: 'WAITING' | 'ACTIVE' | 'QUESTION' | 'APPROVE' | 'RETURN' | 'REJECT' | 'CANCELLED' | 'DONE' } {
  if (step.decision === 'APPROVE') return { kind: 'done', key: 'APPROVE' }
  if (step.decision === 'RETURN') return { kind: 'returned', key: 'RETURN' }
  if (step.decision === 'REJECT') return { kind: 'rejected', key: 'REJECT' }
  if (step.status === 'ACTIVE') return step.taskStatus === 'INFO_REQUESTED' ? { kind: 'question', key: 'QUESTION' } : { kind: 'waiting', key: 'ACTIVE' }
  if (step.status === 'WAITING') return { kind: 'due', key: 'WAITING' }
  if (step.status === 'CANCELLED') return { kind: 'closed', key: 'CANCELLED' }
  return { kind: 'done', key: 'DONE' }
}

/**
 * `doaLinks`: the reader may open the DOA version the route cites (canOpenDoaVersion); otherwise the reference is text.
 */
export async function RequestSections({ view, locale, openFile, doaLinks }: { view: RequestViewDto; locale: Locale; openFile: (fileId: string) => Promise<string | null>; doaLinks: boolean }) {
  const [t, tl] = await Promise.all([getTranslations('requestView'), getTranslations('timeline')])
  const value = (v: Exclude<FieldValueDto, { kind: 'MONEY' }>): string => {
    switch (v.kind) {
      case 'TEXT':
        return v.text
      case 'NAME':
        return nameIn(locale, v.name)
      case 'OPTIONS':
        return v.options.map((o) => (o.label ? nameIn(locale, o.label) : o.value)).join(', ')
      case 'BOOLEAN':
        return v.value ? t('details.yes') : t('details.no')
      case 'DATE':
        return day(locale, v.date)
      case 'COUNT':
        return t('details.items', { count: v.count })
    }
  }
  // Amounts of the form read like the other money of the page: right-aligned in tabular digits (§9.9 principle 6)
  const fieldLabel = (f: RequestViewDto['fields'][number]) => (f.label ? nameIn(locale, f.label) : f.id)
  const moneyFields = view.fields.flatMap((f) => (f.value.kind === 'MONEY' ? [{ label: fieldLabel(f), value: money(f.value.satang) }] : []))
  const otherFields = view.fields.flatMap((f) => (f.value.kind === 'MONEY' ? [] : [{ label: fieldLabel(f), value: <span className="whitespace-pre-line">{value(f.value)}</span> }]))
  const budget = budgetState(view)
  const lineSum = view.lines.reduce((sum, l) => sum + l.netSatang, 0n)
  const kb = (bytes: number) => new Intl.NumberFormat(locale === 'en' ? 'en' : 'th').format(Math.max(1, Math.ceil(bytes / BYTES_PER_KIB)))

  const purchase = view.documentType === 'PURCHASE_REQUEST'

  return (
    <div className="flex flex-col gap-6">
      {/* A new-supplier request has no amount, budget or lines (OQ-23) */}
      {purchase ? (
        <div className="grid gap-6 md:grid-cols-2">
          <Section id="amounts" title={t('amounts.title')}>
            {view.totals ? (
              <>
                <Amounts
                  heading={t('amounts.unit')}
                  unit={t('amounts.currency')}
                  rows={[
                    { label: t('amounts.net'), value: money(view.totals.netSatang) },
                    { label: view.totals.vatRateBp !== null ? t('amounts.vat', { rate: view.totals.vatRateBp / 100 }) : t('amounts.vatPlain'), value: money(view.totals.vatSatang) },
                    { label: t('amounts.gross'), value: money(view.totals.grossSatang), total: true },
                  ]}
                />
                <p className="text-base text-ink-muted md:text-sm">{view.totals.priceIncludesVat ? t('amounts.includesVat') : t('amounts.excludesVat')}</p>
              </>
            ) : (
              <>
                {view.lines.length ? <Amounts heading={t('amounts.unit')} unit={t('amounts.currency')} rows={[{ label: t('amounts.lineSum'), value: money(lineSum), total: true }]} /> : null}
                <p className="text-ink-muted">{t('amounts.notYet')}</p>
              </>
            )}
          </Section>

          <Section id="budget" title={t('budget.title')}>
            {view.budget ? (
              <>
                <Facts
                  className="sm:grid-cols-1"
                  items={[
                    { label: t('budget.line'), value: `${view.budget.code} · ${view.budget.name}` },
                    {
                      label: t('budget.state'),
                      value: (
                        <span className="flex flex-col">
                          <StateLine kind={budget.kind}>{t(`budget.${budget.key}`)}</StateLine>
                          {view.budget.status !== 'OPEN' ? <StateLine kind="closed">{t(`budget.lineStatus.${view.budget.status}`)}</StateLine> : null}
                        </span>
                      ),
                    },
                  ]}
                />
                {view.budget.reservedSatang > 0n || view.budget.committedSatang > 0n ? (
                  <Amounts
                    heading={t('amounts.unit')}
                    unit={t('amounts.currency')}
                    rows={[
                      ...(view.budget.reservedSatang > 0n ? [{ label: t('budget.reserved'), value: money(view.budget.reservedSatang) }] : []),
                      ...(view.budget.committedSatang > 0n ? [{ label: t('budget.committed'), value: money(view.budget.committedSatang) }] : []),
                    ]}
                  />
                ) : null}
              </>
            ) : (
              <p className="text-ink-muted">{t('budget.none')}</p>
            )}
          </Section>
        </div>
      ) : null}

      <Section id="route" title={t('route.title')}>
        {view.route ? (
          <div className="flex flex-col gap-3">
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="text-ink-muted">{t('route.rule')}</span>
              <DoaRef label={doaRefText(tl, view.route.doa)} href={doaLinks ? doaHref(view.route.doa.versionId) : null} />
            </p>
            <div className="flex flex-col gap-1">
              <h3 className="font-medium text-ink">{t('route.why')}</h3>
              <p className="break-words text-ink">{routeSentence(t, tl, locale, view.route, 'REQUEST')}</p>
            </div>
            {view.route.routeNo > 1 ? <p className="text-base text-ink-muted md:text-sm">{t('route.round', { no: view.route.routeNo })}</p> : null}
            <ol className="flex flex-col divide-y divide-line border-t border-line">
              {view.route.steps.map((step) => {
                const state = stepState(step)
                const who = step.approver ? memberName(locale, step.approver) : expectedText(locale, step.expected)
                const role = roleText(t, locale, step.role)
                // BR-SLA-04: the band above joined the step past its escalation time; its decision keeps the route's rule
                const escalated = step.escalation === 'CO_ASSIGNED' ? t('route.escalated') : undefined
                return (
                  <li key={step.stepNo} className="flex flex-col gap-1 py-2.5 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
                    {/* An escalated step waits for its co-assignee too: everyone who may decide it (BR-SLA-04, NEW-46) */}
                    {step.open && step.open.length > 1 ? (
                      <StepApprovers
                        title={t('route.step', { no: step.stepNo })}
                        approvers={step.open.map((o, i) => ({
                          key: o.taskId,
                          name: i === 0 ? memberName(locale, o.approver) : t('route.orApprover', { name: memberName(locale, o.approver) }),
                          role: roleText(t, locale, o.role) || undefined,
                          actingFor: o.onBehalfOf ? t('actingFor', { name: memberName(locale, o.onBehalfOf) }) : undefined,
                        }))}
                        mark={escalated}
                        note={t('route.firstDecides')}
                      />
                    ) : (
                      <div className="min-w-0">
                        <p className="font-medium text-ink">
                          {t('route.step', { no: step.stepNo })}
                          {who ? ` · ${who}` : ''}
                        </p>
                        {role ? <p className="text-ink-muted">{role}</p> : null}
                        {step.onBehalfOf ? <p className="text-ink-muted">{t('actingFor', { name: memberName(locale, step.onBehalfOf) })}</p> : null}
                        {escalated ? <p className="text-base text-ink-muted md:text-sm">{escalated}</p> : null}
                      </div>
                    )}
                    <StateLine kind={state.kind} className="shrink-0">
                      {t(`route.stepState.${state.key}`)}
                    </StateLine>
                  </li>
                )
              })}
            </ol>
          </div>
        ) : (
          <p className="text-ink-muted">{view.documentType === 'SUPPLIER_REQUEST' ? t('route.none') : t('route.notYet')}</p>
        )}
      </Section>

      {purchase || view.lines.length ? (
        <Section id="lines" title={t('lines.title')}>
          {view.lines.length ? (
            <LineList
              labels={{ description: t('lines.description'), quantity: t('lines.quantity'), unitPrice: t('lines.unitPrice'), amount: t('lines.amount') }}
              lines={view.lines.map((l) => ({
                key: String(l.lineNo),
                description: l.description,
                quantity: t('lines.qty', { quantity: l.quantity, uom: l.uom }),
                unitPrice: money(l.unitPriceSatang),
                amount: money(l.netSatang),
                notes: [...(l.vatable ? [] : [t('lines.noVat')]), ...(l.serviceEndDate ? [t('lines.serviceEnd', { date: day(locale, l.serviceEndDate) })] : [])],
              }))}
            />
          ) : (
            <p className="text-ink-muted">{t('lines.none')}</p>
          )}
        </Section>
      ) : null}

      {view.fields.length || view.quotations.length ? (
        <Section id="details" title={t('details.title')}>
          {otherFields.length ? <Facts className="sm:grid-cols-1" items={otherFields} /> : null}
          {moneyFields.length ? <Amounts heading={t('amounts.unit')} unit={t('amounts.currency')} rows={moneyFields} /> : null}
          {view.quotations.length ? (
            <div className="flex flex-col gap-2">
              <h3 className="font-medium text-ink">{t('quotes.title')}</h3>
              <ul className="flex flex-col divide-y divide-line border-t border-line">
                {view.quotations.map((q, i) => (
                  <li key={`${q.supplierName}-${i}`} className="flex flex-col gap-1 py-2.5 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
                    <div className="min-w-0">
                      <p className="break-words text-ink">{q.supplierName}</p>
                      {q.isSelected ? <StateLine kind="done">{t('quotes.selected')}</StateLine> : null}
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="tabular text-ink">{q.includesVat ? t('quotes.includesVat', { amount: money(q.amountSatang) }) : t('quotes.excludesVat', { amount: money(q.amountSatang) })}</p>
                      {q.includesVat ? <p className="tabular text-base text-ink-muted md:text-sm">{t('quotes.beforeVat', { amount: money(q.netSatang) })}</p> : null}
                    </div>
                  </li>
                ))}
              </ul>
              {view.nonLowestQuoteReason ? <Facts className="sm:grid-cols-1" items={[{ label: t('quotes.nonLowest'), value: view.nonLowestQuoteReason }]} /> : null}
            </div>
          ) : null}
        </Section>
      ) : null}

      <Section id="files" title={t('files.title')}>
        {view.attachments.length ? (
          <AttachmentList
            open={openFile}
            files={view.attachments.map((f) => ({
              fileId: f.fileId,
              fileName: f.fileName,
              detail: `${t(`files.kind.${fileKind(f.kind)}`)} · ${t('files.size', { size: kb(f.sizeBytes) })}`,
            }))}
          />
        ) : (
          <p className="text-ink-muted">{t('files.none')}</p>
        )}
      </Section>

      {view.infoRequests.length ? (
        <Section id="questions" title={t('questions.title')}>
          <ul className="flex flex-col divide-y divide-line border-t border-line">
            {view.infoRequests.map((q) => (
              <li key={q.id} className="flex flex-col gap-1.5 py-3">
                <p className="break-words whitespace-pre-line text-ink">{q.question}</p>
                <p className="text-base text-ink-muted md:text-sm">{t('questions.asked', { name: memberName(locale, q.askedBy), time: when(locale, q.askedAt) })}</p>
                {q.answer && q.answeredAt ? (
                  <blockquote className="border-l-2 border-line pl-3">
                    <p className="break-words whitespace-pre-line text-ink">{q.answer}</p>
                    <p className="text-base text-ink-muted md:text-sm">{t('questions.answered', { name: memberName(locale, q.answeredBy), time: when(locale, q.answeredAt) })}</p>
                  </blockquote>
                ) : q.noLongerNeeded ? (
                  // The task that asked was closed: the other approver of the step decided first (BR-SLA-04), or the route ended
                  <StateLine kind="closed">{t(`questions.noLongerNeeded.${q.noLongerNeeded}`)}</StateLine>
                ) : (
                  <StateLine kind="question">{t('questions.waiting')}</StateLine>
                )}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
    </div>
  )
}
