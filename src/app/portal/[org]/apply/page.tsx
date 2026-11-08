import type { ReactNode } from 'react'
import { randomUUID } from 'node:crypto'
import { redirect } from 'next/navigation'
import { getLocale, getTranslations } from 'next-intl/server'
import { listPortalAiReadings } from '@/server/portal/queries-ai'
import { getPortalApplication, getPortalHome, listPortalContacts, PORTAL_APPLY_STEPS, type PortalApplicationView, type PortalApplyStep } from '@/server/portal/queries'
import { AiReadingPanel } from './ai-panel'
import { PortalButton, PortalField, PortalFrame, PortalNotice, PortalSteps, portalCheckboxClass, portalInputClass, portalPrimaryLinkClass, portalTextareaClass } from '@/ui/portal/frame'
import { one, pageOrg, pageSession, portalNav, Unavailable, type SearchParams } from '../_lib/page'

// /portal/[org]/apply (S7-08 · ADR-184 · BR-SUP ข้อ 08 ถึง ข้อ 11 · FR-SUP-101 FR-SUP-102): the application in six steps —
// company, tax, contacts, bank account, documents, check and send — each a short server form (at most 8 fields) that
// posts to /api/application and comes back on the next step. The account number never comes back to the page: its
// last four only. A submitted application shows where it stands. Works the same with AI off (EG-1).

type T = Awaited<ReturnType<typeof getTranslations<'portal'>>>

const ERRORS = ['APPLICATION_INCOMPLETE', 'VALIDATION_FAILED', 'TAXID_CHECKSUM', 'DUPLICATE_SUPPLIER', 'DUPLICATE_REASON_REQUIRED', 'CONFLICT_VERSION', 'INVALID_STATE_TRANSITION', 'ACCOUNT', 'FORBIDDEN', 'AI_REVIEW_PENDING', 'AI_NOTHING_TAKEN'] as const
const CLOSED = ['SUBMITTED', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'EXPIRED', 'CANCELLED'] as const
const WARNINGS = ['SAME_TAXID_OTHER_BRANCH', 'DUPLICATE_NAME', 'DUPLICATE_EMAIL'] as const
const FIELD_WORDS = ['nameTh', 'taxId', 'branchCode', 'address', 'contact'] as const
const DOC_STATES = ['NONE', 'SCANNING', 'PENDING', 'VERIFIED', 'REJECTED', 'INFECTED'] as const

const isStep = (v: string | undefined): v is PortalApplyStep => (PORTAL_APPLY_STEPS as readonly string[]).includes(v ?? '')

export default async function PortalApplyPage({ params, searchParams }: { params: Promise<{ org: string }>; searchParams: SearchParams }) {
  const org = await pageOrg((await params).org)
  if (!org) return <Unavailable />
  const session = await pageSession(org)
  if (!session) redirect(`/portal/${org.code}/login`)
  const { ctx } = session.state
  const [t, locale, q, app, home] = await Promise.all([getTranslations('portal'), getLocale(), searchParams, getPortalApplication(ctx), getPortalHome(ctx)])
  if (home.privacyNoticeDue) redirect(`/portal/${org.code}`)
  if (!app) redirect(`/portal/${org.code}/home`)
  const nav = portalNav(org.code, t, 'apply', 'APPLICATION')
  const frame = { organization: org.nameTh, title: t('apply.title'), nav, navLabel: t('nav.label') }
  if (!app.editable) {
    const status = (CLOSED as readonly string[]).includes(app.status) ? (app.status as (typeof CLOSED)[number]) : null
    return (
      <PortalFrame {...frame}>
        {one(q.sent) ? <PortalNotice tone="success">{t('apply.closed.SUBMITTED', { number: app.number ?? '' })}</PortalNotice> : status ? <PortalNotice tone="info">{t(`apply.closed.${status}`, { number: app.number ?? '' })}</PortalNotice> : null}
      </PortalFrame>
    )
  }
  const step: PortalApplyStep = isStep(one(q.step)) ? (one(q.step) as PortalApplyStep) : 'company'
  const at = PORTAL_APPLY_STEPS.indexOf(step)
  const error = one(q.error)
  const known = error && (ERRORS as readonly string[]).includes(error) ? (error as (typeof ERRORS)[number]) : null
  const base = `/portal/${org.code}/apply`
  const steps = PORTAL_APPLY_STEPS.map((s, i) => ({ key: s, label: t(`apply.steps.${s}`), href: i === at ? null : `${base}?step=${s}`, current: i === at }))
  const formId = `apply-${step}`
  const hidden = (
    <>
      <input type="hidden" name="csrf" value={session.csrf} />
      <input type="hidden" name="key" value={randomUUID()} />
      <input type="hidden" name="step" value={step} />
      <input type="hidden" name="version" value={app.version} />
    </>
  )
  const back = at > 0 ? (
    <a href={`${base}?step=${PORTAL_APPLY_STEPS[at - 1]}`} className="inline-flex min-h-11 items-center justify-center text-primary underline underline-offset-4 hover:no-underline">
      {t('apply.back')}
    </a>
  ) : null
  const actions =
    step === 'review' ? (
      <>
        <PortalButton type="submit" form={formId}>
          {t('apply.review.submit', { organization: org.nameTh })}
        </PortalButton>
        {back}
      </>
    ) : step === 'documents' ? (
      <>
        <a href={`${base}?step=review`} className={portalPrimaryLinkClass}>
          {t('apply.steps.review')}
        </a>
        {back}
      </>
    ) : (
      <>
        <PortalButton type="submit" form={formId}>
          {t('apply.saveNext')}
        </PortalButton>
        {back}
      </>
    )
  return (
    <PortalFrame {...frame} actions={actions} actionsLabel={t(`apply.steps.${step}`)}>
      <PortalSteps label={t('apply.stepsLabel')} caption={t('apply.stepOf', { n: at + 1, total: PORTAL_APPLY_STEPS.length })} steps={steps} />
      {app.returnReason ? <PortalNotice tone="warning">{t('apply.returned', { reason: app.returnReason })}</PortalNotice> : null}
      {known ? <PortalNotice tone="danger">{t(`apply.errors.${known}`)}</PortalNotice> : error ? <PortalNotice tone="danger">{t('errors.FAILED')}</PortalNotice> : null}
      <h2 className="text-lg font-semibold">{t(`apply.steps.${step}`)}</h2>
      {one(q.ai) === 'taken' ? <PortalNotice tone="success">{t('apply.ai.done')}</PortalNotice> : null}
      {/* S7-14: what the AI read off the documents, beside the fields it fills (company · tax) and the documents */}
      {step === 'company' || step === 'tax' || step === 'documents' ? <AiReadingPanel t={t} readings={await listPortalAiReadings(ctx)} action={`/portal/${org.code}/api/application/ai`} csrf={session.csrf} step={step} version={app.version} /> : null}
      {step === 'company' ? <CompanyStep t={t} app={app} formId={formId} action={`/portal/${org.code}/api/application`} hidden={hidden} /> : null}
      {step === 'tax' ? <TaxStep t={t} app={app} formId={formId} action={`/portal/${org.code}/api/application`} hidden={hidden} /> : null}
      {step === 'contact' ? <ContactStep t={t} organization={org.nameTh} formId={formId} action={`/portal/${org.code}/api/profile`} csrf={session.csrf} locale={home.contact.locale} contacts={await listPortalContacts(ctx)} me={ctx.actor.type === 'SUPPLIER' ? ctx.actor.supplierContactId : ''} /> : null}
      {step === 'bank' ? <BankStep t={t} app={app} formId={formId} action={`/portal/${org.code}/api/application`} hidden={hidden} /> : null}
      {step === 'documents' ? <DocumentsStep t={t} app={app} locale={locale} action={`/portal/${org.code}/api/documents`} csrf={session.csrf} sent={Boolean(one(q.sent))} /> : null}
      {step === 'review' ? <ReviewStep t={t} app={app} locale={locale} base={base} formId={formId} action={`/portal/${org.code}/api/application/submit`} csrf={session.csrf} /> : null}
    </PortalFrame>
  )
}

interface StepProps {
  readonly t: T
  readonly app: PortalApplicationView
  readonly formId: string
  readonly action: string
  readonly hidden: ReactNode
}

function CompanyStep({ t, app, formId, action, hidden }: StepProps) {
  const f = app.fields
  return (
    <form id={formId} method="post" action={action} className="flex flex-col gap-4">
      {hidden}
      <p className="text-ink-muted">{t('apply.company.intro')}</p>
      <PortalField id="nameTh" label={t('apply.company.nameTh')} required requiredLabel={t('apply.required')}>
        <input id="nameTh" name="nameTh" required maxLength={200} defaultValue={f.nameTh} className={portalInputClass} />
      </PortalField>
      <PortalField id="nameEn" label={t('apply.company.nameEn')}>
        <input id="nameEn" name="nameEn" maxLength={200} defaultValue={f.nameEn ?? ''} className={portalInputClass} />
      </PortalField>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 font-medium">{t('apply.company.payeeType')}</legend>
        {(['JURISTIC', 'INDIVIDUAL', 'FOREIGN'] as const).map((p) => (
          <label key={p} className="flex min-h-11 items-center gap-3">
            <input type="radio" name="payeeType" value={p} defaultChecked={f.payeeType === p} className={portalCheckboxClass} />
            {t(`apply.company.payee.${p}`)}
          </label>
        ))}
      </fieldset>
      <PortalField id="address" label={t('apply.company.address')} required requiredLabel={t('apply.required')}>
        <textarea id="address" name="address" maxLength={500} defaultValue={f.address ?? ''} className={portalTextareaClass} />
      </PortalField>
      <PortalField id="phone" label={t('apply.company.phone')}>
        <input id="phone" name="phone" type="tel" autoComplete="tel" maxLength={40} defaultValue={f.phone ?? ''} className={portalInputClass} />
      </PortalField>
      <PortalField id="email" label={t('apply.company.email')}>
        <input id="email" name="email" type="email" autoComplete="email" maxLength={254} defaultValue={f.email ?? ''} className={portalInputClass} />
      </PortalField>
      <PortalField id="category" label={t('apply.company.category')}>
        <input id="category" name="category" maxLength={100} defaultValue={f.category ?? ''} className={portalInputClass} />
      </PortalField>
    </form>
  )
}

function TaxStep({ t, app, formId, action, hidden }: StepProps) {
  const f = app.fields
  const foreign = f.payeeType === 'FOREIGN'
  return (
    <form id={formId} method="post" action={action} className="flex flex-col gap-4">
      {hidden}
      <p className="text-ink-muted">{t('apply.tax.intro')}</p>
      {foreign ? (
        <PortalNotice tone="info">{t('apply.tax.foreign')}</PortalNotice>
      ) : (
        <PortalField id="taxId" label={t('apply.tax.taxId')} hint={t('apply.tax.taxIdHint')} required requiredLabel={t('apply.required')}>
          <input id="taxId" name="taxId" inputMode="numeric" maxLength={20} defaultValue={f.taxId ?? ''} aria-describedby="taxId-hint" className={portalInputClass} />
        </PortalField>
      )}
      <PortalField id="branchCode" label={t('apply.tax.branchCode')} hint={t('apply.tax.branchHint')} required requiredLabel={t('apply.required')}>
        <input id="branchCode" name="branchCode" inputMode="numeric" pattern="[0-9]{5}" maxLength={5} required defaultValue={f.branchCode} aria-describedby="branchCode-hint" className={portalInputClass} />
      </PortalField>
      <label className="flex min-h-11 items-center gap-3">
        <input type="checkbox" name="isVatRegistered" value="1" defaultChecked={f.isVatRegistered} className={portalCheckboxClass} />
        {t('apply.tax.vat')}
      </label>
    </form>
  )
}

function ContactStep({ t, organization, formId, action, csrf, locale, contacts, me }: { readonly t: T; readonly organization: string; readonly formId: string; readonly action: string; readonly csrf: string; readonly locale: string; readonly contacts: Awaited<ReturnType<typeof listPortalContacts>>; readonly me: string }) {
  return (
    <form id={formId} method="post" action={action} className="flex flex-col gap-4">
      <input type="hidden" name="csrf" value={csrf} />
      <input type="hidden" name="key" value={randomUUID()} />
      <input type="hidden" name="action" value="locale" />
      <input type="hidden" name="next" value="apply-bank" />
      <p className="text-ink-muted">{t('apply.contact.intro', { organization })}</p>
      <ul className="flex flex-col divide-y divide-line border-y border-line">
        {contacts.map((c) => (
          <li key={c.id} className="flex flex-col gap-0.5 py-3">
            <span className="font-medium">
              {c.nameTh}
              {c.id === me ? ` (${t('apply.contact.you')})` : ''}
            </span>
            {c.roleLabel ? <span className="text-ink-muted">{c.roleLabel}</span> : null}
            {c.isPrimary ? <span className="text-ink-muted">{t('apply.contact.primary')}</span> : null}
          </li>
        ))}
      </ul>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 font-medium">{t('apply.contact.language')}</legend>
        {(['th', 'en'] as const).map((l) => (
          <label key={l} className="flex min-h-11 items-center gap-3" lang={l}>
            <input type="radio" name="locale" value={l} defaultChecked={locale === l} className={portalCheckboxClass} />
            {t(`apply.contact.${l}`)}
          </label>
        ))}
      </fieldset>
    </form>
  )
}

function BankStep({ t, app, formId, action, hidden }: StepProps) {
  const f = app.fields
  return (
    <form id={formId} method="post" action={action} className="flex flex-col gap-4" autoComplete="off">
      {hidden}
      <p className="text-ink-muted">{t('apply.bank.intro')}</p>
      <PortalField id="bankCode" label={t('apply.bank.bankCode')}>
        <select id="bankCode" name="bankCode" defaultValue={f.bankCode ?? ''} className={portalInputClass}>
          <option value="">{t('apply.bank.choose')}</option>
          {app.banks.map((b) => (
            <option key={b.code} value={b.code}>
              {b.nameTh} ({b.shortName})
            </option>
          ))}
        </select>
      </PortalField>
      <PortalField id="accountNo" label={t('apply.bank.accountNo')} hint={f.accountNoLast4 ? t('apply.bank.accountNoKept', { last4: f.accountNoLast4 }) : undefined}>
        <input id="accountNo" name="accountNo" inputMode="numeric" maxLength={40} defaultValue="" aria-describedby={f.accountNoLast4 ? 'accountNo-hint' : undefined} className={portalInputClass} />
      </PortalField>
      <PortalField id="accountName" label={t('apply.bank.accountName')}>
        <input id="accountName" name="accountName" maxLength={200} defaultValue={f.accountName ?? ''} className={portalInputClass} />
      </PortalField>
      <PortalField id="bankBranch" label={t('apply.bank.bankBranch')}>
        <input id="bankBranch" name="bankBranch" maxLength={100} defaultValue={f.bankBranch ?? ''} className={portalInputClass} />
      </PortalField>
    </form>
  )
}

function DocumentsStep({ t, app, locale, action, csrf, sent }: { readonly t: T; readonly app: PortalApplicationView; readonly locale: string; readonly action: string; readonly csrf: string; readonly sent: boolean }) {
  return (
    <div className="flex flex-col gap-4">
      <p className="text-ink-muted">{t('apply.documents.intro')}</p>
      {sent ? <PortalNotice tone="success">{t('apply.saved')}</PortalNotice> : null}
      <ul className="flex flex-col divide-y divide-line border-y border-line">
        {app.documents.map((d) => {
          const name = locale === 'en' ? d.nameEn : d.nameTh
          const state = (DOC_STATES as readonly string[]).includes(d.state) ? d.state : 'NONE'
          const id = `doc-${d.code}`
          return (
            <li key={d.code} className="flex flex-col gap-3 py-4">
              <div className="flex flex-col gap-0.5">
                <h3 className="font-medium">{name}</h3>
                <span className="text-ink-muted">{d.required ? t('apply.documents.required') : t('apply.documents.optional')}</span>
                <span>{t(`apply.documents.state.${state}`, { reason: d.reason ?? '' })}</span>
              </div>
              <form method="post" action={action} encType="multipart/form-data" className="flex flex-col gap-3">
                <input type="hidden" name="csrf" value={csrf} />
                <input type="hidden" name="key" value={randomUUID()} />
                <input type="hidden" name="next" value="apply" />
                <input type="hidden" name="documentTypeCode" value={d.code} />
                <PortalField id={`${id}-file`} label={t('apply.documents.file')}>
                  <input id={`${id}-file`} name="file" type="file" required accept="application/pdf,image/*" className="text-base" />
                </PortalField>
                <PortalField id={`${id}-issued`} label={t('apply.documents.issuedOn')}>
                  <input id={`${id}-issued`} name="issuedOn" type="date" required className={portalInputClass} />
                </PortalField>
                <PortalField id={`${id}-expires`} label={d.expiresRequired ? t('apply.documents.expiresOnRequired') : t('apply.documents.expiresOn')} required={d.expiresRequired} requiredLabel={t('apply.required')}>
                  <input id={`${id}-expires`} name="expiresOn" type="date" required={d.expiresRequired} className={portalInputClass} />
                </PortalField>
                <PortalButton type="submit" variant="secondary">
                  {state === 'NONE' ? t('apply.documents.send', { type: name }) : t('apply.documents.sendNew', { type: name })}
                </PortalButton>
              </form>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function ReviewStep({ t, app, locale, base, formId, action, csrf }: { readonly t: T; readonly app: PortalApplicationView; readonly locale: string; readonly base: string; readonly formId: string; readonly action: string; readonly csrf: string }) {
  const f = app.fields
  const typeName = (code: string) => {
    const d = app.documents.find((x) => x.code === code)
    return d ? (locale === 'en' ? d.nameEn : d.nameTh) : code
  }
  const missingWord = (m: string) =>
    m.startsWith('document:') ? t('apply.review.document', { type: typeName(m.slice('document:'.length)) }) : (FIELD_WORDS as readonly string[]).includes(m) ? t(`apply.review.field.${m as (typeof FIELD_WORDS)[number]}`) : m
  const rows: Array<{ step: PortalApplyStep; items: Array<[string, string]> }> = [
    { step: 'company', items: [[t('apply.company.nameTh'), f.nameTh], [t('apply.company.payeeType'), t(`apply.company.payee.${f.payeeType as 'JURISTIC'}`)], [t('apply.company.address'), f.address ?? '-']] },
    { step: 'tax', items: [[t('apply.tax.taxId'), f.taxId ?? '-'], [t('apply.tax.branchCode'), f.branchCode]] },
    { step: 'bank', items: [[t('apply.bank.accountNo'), f.accountNoLast4 ? `•••• ${f.accountNoLast4}` : t('apply.review.notAccount')]] },
  ]
  return (
    <form id={formId} method="post" action={action} className="flex flex-col gap-5">
      <input type="hidden" name="csrf" value={csrf} />
      <input type="hidden" name="key" value={randomUUID()} />
      <input type="hidden" name="version" value={app.version} />
      <p className="text-ink-muted">{t('apply.review.intro')}</p>
      {rows.map((r) => (
        <section key={r.step} aria-labelledby={`review-${r.step}`} className="flex flex-col gap-2 border-t border-line pt-3">
          <h3 id={`review-${r.step}`} className="font-medium">
            {t(`apply.steps.${r.step}`)}
          </h3>
          <dl className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-x-3 gap-y-1">
            {r.items.map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-ink-muted">{k}</dt>
                <dd className="break-words">{v}</dd>
              </div>
            ))}
          </dl>
          <a href={`${base}?step=${r.step}`} className="inline-flex min-h-11 items-center text-primary underline underline-offset-4 hover:no-underline">
            {t('apply.review.edit', { step: t(`apply.steps.${r.step}`) })}
          </a>
        </section>
      ))}
      <section aria-labelledby="review-missing" className="flex flex-col gap-2 border-t border-line pt-3">
        <h3 id="review-missing" className="font-medium">
          {app.missing.length ? t('apply.review.missingTitle') : t('apply.review.missingNone')}
        </h3>
        {app.missing.length ? (
          <ul className="list-disc pl-5">
            {app.missing.map((m) => (
              <li key={m}>{missingWord(m)}</li>
            ))}
          </ul>
        ) : null}
      </section>
      {app.warnings.length ? (
        <section aria-labelledby="review-warnings" className="flex flex-col gap-3 border-t border-line pt-3">
          <h3 id="review-warnings" className="font-medium">
            {t('apply.review.warningsTitle')}
          </h3>
          <p className="text-ink-muted">{t('apply.review.warningsIntro')}</p>
          {app.warnings.map((w) => {
            const code = (WARNINGS as readonly string[]).includes(w.code) ? (w.code as (typeof WARNINGS)[number]) : null
            if (!code) return null
            return (
              <PortalField key={code} id={`reason-${code}`} label={`${t(`apply.review.warning.${code}`)} · ${t('apply.review.reason')}`}>
                <textarea id={`reason-${code}`} name={`reason.${code}`} maxLength={500} defaultValue={w.reason ?? ''} className={portalTextareaClass} />
              </PortalField>
            )
          })}
        </section>
      ) : null}
    </form>
  )
}
