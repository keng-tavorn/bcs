'use client'

import { CircleAlert, CircleCheck, Info } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useEffect, useRef, useState } from 'react'
import { Button } from '../form/button'
import { Notice } from '../form/notice'
import { useSubmissionKey } from '../form/submission-key'
import { checkboxClass, Choices, describedBy, inputClass, Labelled, textareaClass } from '../request-form/controls'
import { Stepper } from '../request-form/stepper'
import { UploadButton, type UploadActions } from '../request-form/upload-button'
import { BRANCH_CODE, formatTaxId, HEAD_OFFICE, looksLikeEmail, normalizeCode, optionalText, SUPPLIER_CODE, SUPPLIER_LIMITS, TAX_ID_INPUT_MAX, taxIdState } from './model'
import { NEW_SUPPLIER_STEPS, supplierErrorKey, supplierFailureStep, type NewSupplierStep, type SupplierFailure, type SupplierOutcome } from './outcome'
import type { NewSupplierInput, RegistryCheckView } from './types'

// Adding a supplier (S4-02, FR-SUP-001 AC1–AC3, §7.15): three real steps, so no step holds more than five fields
// (§9.9). 1) Identity: Thai or foreign; the 13-digit tax id is checked as it is typed (BR-TAXID-01, core/thai) and,
// with its branch, looked up at the Revenue Department and DBD (an individual at the Revenue Department only, BR-SUP-02);
// when they cannot confirm the supplier, the user confirms with a company certificate or ภ.พ.20 (BR-SUP-03). 2) The
// supplier's details, filled from the registries for the user to check and change. 3) Codes and contacts, a summary,
// and "บันทึกผู้ขาย" — the server checks everything again, and the registries too (BR-SUP-01).

export interface NewSupplierActions extends UploadActions {
  readonly check: (input: { taxId: string; branchCode: string }) => Promise<SupplierOutcome<{ check: RegistryCheckView }>>
  readonly create: (input: NewSupplierInput, idempotencyKey: string) => Promise<SupplierOutcome<{ supplierId: string }>>
}

interface Details {
  readonly nameTh: string
  readonly nameEn: string
  readonly address: string
  /** '' until chosen (or filled from the Revenue Department) */
  readonly vat: '' | 'Y' | 'N'
  readonly category: string
}

interface Codes {
  readonly code: string
  readonly express: string
  readonly email: string
  readonly phone: string
}

/** What a lookup filled in from the registries */
type Filled = Pick<Details, 'nameTh' | 'address' | 'vat'>

type IdentityNeed = 'taxId' | 'branch' | 'lookup' | 'stale' | 'existing' | 'proof'

/** A proof file, kept with the tax id and branch it was attached for: another number asks for its own (BR-SUP-03) */
interface Proof {
  readonly key: string
  readonly fileId: string
  readonly fileName: string
}

/** An action that did not answer (a dropped connection, a server fault): the user is told and may try again (§9.9 rule 7) */
const NO_ANSWER: SupplierFailure = { ok: false, code: 'FAILED' }

const linkClass = 'inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline'

export function NewSupplierForm({ actions, suggestedCode, stub }: { actions: NewSupplierActions; suggestedCode: string | null; stub: boolean }) {
  const t = useTranslations('suppliers.new')
  const tf = useTranslations('suppliers.fields')
  const te = useTranslations('suppliers.errors')
  const router = useRouter()
  const submission = useSubmissionKey()
  const headingRef = useRef<HTMLHeadingElement>(null)

  const [step, setStep] = useState<NewSupplierStep>('identity')
  const [reached, setReached] = useState(0)
  const [foreign, setForeign] = useState(false)
  const [taxIdText, setTaxIdText] = useState('')
  const [branch, setBranch] = useState(HEAD_OFFICE)
  const [check, setCheck] = useState<{ key: string; view: RegistryCheckView } | null>(null)
  const [checking, setChecking] = useState(false)
  const [checkError, setCheckError] = useState<SupplierFailure | null>(null)
  const [attached, setAttached] = useState<Proof | null>(null)
  const [details, setDetails] = useState<Details>({ nameTh: '', nameEn: '', address: '', vat: '', category: '' })
  const [codes, setCodes] = useState<Codes>({ code: suggestedCode ?? '', express: '', email: '', phone: '' })
  const [showErrors, setShowErrors] = useState<Record<NewSupplierStep, boolean>>({ identity: false, details: false, codes: false })
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<SupplierFailure | null>(null)
  /** The values the last lookup filled in, to tell them from what the user typed */
  const filled = useRef<Filled | null>(null)
  // The value is read in the event handler: React clears the event's currentTarget once the handler returns
  const setCode = (patch: Partial<Codes>) => setCodes((c) => ({ ...c, ...patch }))

  // Moving between steps: the new step's heading takes focus, so keyboard and screen reader users start at its top
  const first = useRef(true)
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    headingRef.current?.focus()
    headingRef.current?.scrollIntoView({ block: 'start' })
  }, [step])

  const tax = taxIdState(taxIdText)
  const branchOk = BRANCH_CODE.test(branch)
  const key = tax.kind === 'valid' ? `${tax.taxId}|${branch}` : null
  const current = check && check.key === key ? check.view : null
  const proposal = current?.proposal ?? null
  // The proof counts only for the number and branch it was attached for
  const proof = attached && attached.key === key ? attached : null

  /** What still stops the identity step, first thing first */
  function identityNeed(): IdentityNeed | null {
    if (foreign) return null
    if (tax.kind !== 'valid') return 'taxId'
    if (!branchOk) return 'branch'
    if (!check) return 'lookup'
    if (!current) return 'stale'
    if (current.existing) return 'existing'
    if (current.proposal.outcome !== 'FOUND' && !proof) return 'proof'
    return null
  }
  const detailsNeed = (): 'name' | 'vat' | null => (!details.nameTh.trim() ? 'name' : details.vat === '' ? 'vat' : null)
  const codeError = (): string | undefined => (!codes.code.trim() ? tf('missingCode') : !SUPPLIER_CODE.test(normalizeCode(codes.code)) ? tf('badCode') : undefined)
  const emailError = (): string | undefined => (codes.email.trim() && !looksLikeEmail(codes.email) ? tf('badEmail') : undefined)

  const index = NEW_SUPPLIER_STEPS.indexOf(step)
  const steps = NEW_SUPPLIER_STEPS.map((id) => ({ id, label: t(`steps.${id}`) }))

  function goTo(next: NewSupplierStep) {
    const target = NEW_SUPPLIER_STEPS.indexOf(next)
    if (target > index) {
      // Forward only past a complete step; the reason shows where the user is
      const blocked = step === 'identity' ? identityNeed() : step === 'details' ? detailsNeed() : null
      if (blocked) {
        setShowErrors((s) => ({ ...s, [step]: true }))
        return
      }
    }
    setReached((r) => Math.max(r, target))
    setStep(next)
  }

  async function lookup() {
    // A number that cannot be looked up says why at its field; what the lookup finds speaks for itself
    if (tax.kind !== 'valid' || !branchOk) return setShowErrors((s) => ({ ...s, identity: true }))
    setChecking(true)
    setCheckError(null)
    let outcome: SupplierOutcome<{ check: RegistryCheckView }>
    try {
      outcome = await actions.check({ taxId: tax.taxId, branchCode: branch })
    } catch {
      outcome = NO_ANSWER
    } finally {
      setChecking(false)
    }
    if (!outcome.ok) return setCheckError(outcome)
    setCheck({ key: `${outcome.check.proposal.taxId}|${outcome.check.proposal.branchCode}`, view: outcome.check })
    const p = outcome.check.proposal
    // FR-SUP-001 AC1: the registries' values fill the next step, where the user checks and may change them. What an
    // earlier lookup (of another number) filled in and nobody changed goes with it; what the user typed stays.
    const prior = filled.current
    const next: Filled | null = p.outcome === 'FOUND' ? { nameTh: p.nameTh ?? '', address: p.address ?? '', vat: p.isVatRegistered === null ? '' : p.isVatRegistered ? 'Y' : 'N' } : null
    filled.current = next
    setDetails((d) => {
      const kept: Details = prior ? { ...d, nameTh: d.nameTh === prior.nameTh ? '' : d.nameTh, address: d.address === prior.address ? '' : d.address, vat: d.vat === prior.vat ? '' : d.vat } : d
      return next ? { ...kept, nameTh: next.nameTh || kept.nameTh, address: next.address || kept.address, vat: next.vat || kept.vat } : kept
    })
  }

  async function save() {
    setShowErrors({ identity: true, details: true, codes: true })
    setSaveError(null)
    const need = identityNeed()
    if (need) return setStep('identity')
    if (detailsNeed()) return setStep('details')
    if (codeError() || emailError()) return
    const input: NewSupplierInput = {
      code: normalizeCode(codes.code),
      nameTh: details.nameTh.trim(),
      nameEn: optionalText(details.nameEn),
      taxId: foreign || tax.kind !== 'valid' ? null : tax.taxId,
      branchCode: foreign ? HEAD_OFFICE : branch,
      isVatRegistered: details.vat === 'Y',
      isForeign: foreign,
      email: optionalText(codes.email),
      phone: optionalText(codes.phone),
      address: optionalText(details.address),
      category: optionalText(details.category),
      expressVendorCode: optionalText(codes.express),
      registry: foreign ? null : proposal?.outcome === 'FOUND' ? { check: 'LOOKUP' } : proof ? { check: 'MANUAL', proofFileId: proof.fileId } : null,
    }
    setSaving(true)
    let outcome: SupplierOutcome<{ supplierId: string }>
    try {
      outcome = await actions.create(input, submission.key)
      // An answer came: the next save is a new command. Without one the key stays, so trying again cannot add twice
      submission.next()
    } catch {
      outcome = NO_ANSWER
    }
    if (outcome.ok) {
      // The button stays busy while the supplier's page opens
      router.push(`/suppliers/${outcome.supplierId}?created=1`)
      return
    }
    setSaving(false)
    setSaveError(outcome)
  }

  const errorText = (f: SupplierFailure) => te(supplierErrorKey(f), { code: f.existingCode ?? '-', requestId: f.requestId ?? '-' })
  const saveStep = saveError ? supplierFailureStep(supplierErrorKey(saveError)) : null

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      {stub ? (
        <Notice tone="info">
          <p>{t('stubMode')}</p>
        </Notice>
      ) : null}
      <Stepper steps={steps} current={step} onSelect={goTo} label={t('steps.label')} canOpen={(id) => NEW_SUPPLIER_STEPS.indexOf(id) <= reached} />

      <section aria-labelledby="supplier-step" className="flex flex-col gap-6">
        <h2 id="supplier-step" ref={headingRef} tabIndex={-1} className="text-xl font-semibold outline-none">
          {t('steps.heading', { n: index + 1, total: NEW_SUPPLIER_STEPS.length, name: t(`steps.${step}`) })}
        </h2>

        {step === 'identity' ? (
          <IdentityStep
            foreign={foreign}
            onForeign={(f) => {
              setForeign(f)
              if (f && details.vat === '') setDetails((d) => ({ ...d, vat: 'N' }))
            }}
            taxIdText={taxIdText}
            onTaxId={setTaxIdText}
            branch={branch}
            onBranch={setBranch}
            showErrors={showErrors.identity}
            need={identityNeed()}
            checking={checking}
            checkError={checkError ? errorText(checkError) : null}
            onLookup={() => void lookup()}
            current={current}
            proof={proof}
            onProof={(file) => {
              if (key) setAttached({ key, fileId: file.fileId, fileName: file.fileName })
            }}
            uploads={{ requestUpload: actions.requestUpload, completeUpload: actions.completeUpload }}
          />
        ) : null}

        {step === 'details' ? <DetailsStep details={details} onChange={setDetails} showErrors={showErrors.details} proposal={proposal} foreign={foreign} /> : null}

        {step === 'codes' ? (
          <div className="flex flex-col gap-6">
            <Labelled id="supplier-code" label={tf('code')} requiredText={tf('required')} hint={tf('codeHint')} error={showErrors.codes ? codeError() : undefined}>
              <input
                id="supplier-code"
                name="code"
                className={`${inputClass} max-w-xs`}
                value={codes.code}
                maxLength={40}
                autoCapitalize="characters"
                required
                aria-required
                aria-invalid={showErrors.codes && codeError() ? true : undefined}
                aria-describedby={describedBy('supplier-code', true, Boolean(showErrors.codes && codeError()))}
                onChange={(e) => setCode({ code: e.currentTarget.value.toUpperCase() })}
              />
            </Labelled>
            <Labelled id="supplier-express" label={tf('express')} hint={tf('expressHint')}>
              <input
                id="supplier-express"
                name="expressVendorCode"
                className={`${inputClass} max-w-xs`}
                value={codes.express}
                maxLength={SUPPLIER_LIMITS.expressVendorCode}
                aria-describedby={describedBy('supplier-express', true, false)}
                onChange={(e) => setCode({ express: e.currentTarget.value })}
              />
            </Labelled>
            <Labelled id="supplier-email" label={tf('email')} hint={tf('emailHint')} error={showErrors.codes ? emailError() : undefined}>
              <input
                id="supplier-email"
                name="email"
                type="email"
                inputMode="email"
                autoComplete="off"
                className={inputClass}
                value={codes.email}
                maxLength={SUPPLIER_LIMITS.email}
                aria-invalid={showErrors.codes && emailError() ? true : undefined}
                aria-describedby={describedBy('supplier-email', true, Boolean(showErrors.codes && emailError()))}
                onChange={(e) => setCode({ email: e.currentTarget.value })}
              />
            </Labelled>
            <Labelled id="supplier-phone" label={tf('phone')}>
              <input id="supplier-phone" name="phone" type="tel" inputMode="tel" className={`${inputClass} max-w-xs`} value={codes.phone} maxLength={SUPPLIER_LIMITS.phone} onChange={(e) => setCode({ phone: e.currentTarget.value })} />
            </Labelled>

            <section aria-labelledby="supplier-summary" className="flex flex-col gap-3 border-t border-line pt-5">
              <h3 id="supplier-summary" className="text-lg font-semibold">
                {t('summary.title')}
              </h3>
              <dl className="grid grid-cols-1 gap-y-1 sm:grid-cols-[12rem_minmax(0,1fr)] sm:gap-x-6">
                <dt className="text-ink-muted">{t('summary.name')}</dt>
                <dd className="mb-2 break-words sm:mb-0">{details.nameTh.trim() || t('summary.noName')}</dd>
                {!foreign ? (
                  <>
                    <dt className="text-ink-muted">{t('summary.taxId')}</dt>
                    <dd className="tabular mb-2 sm:mb-0">{tax.kind === 'valid' ? formatTaxId(tax.taxId) : t('summary.noTaxId')}</dd>
                    <dt className="text-ink-muted">{t('summary.branch')}</dt>
                    <dd className="mb-2 sm:mb-0">{branch === HEAD_OFFICE ? t('branchHead') : t('branchNumber', { code: branch })}</dd>
                  </>
                ) : null}
                <dt className="text-ink-muted">{t('summary.method')}</dt>
                <dd className="break-words">
                  {foreign ? t('summary.methodForeign') : proposal?.outcome === 'FOUND' ? t('summary.methodLookup') : proof ? t('summary.methodManual', { name: proof.fileName }) : t('summary.methodMissing')}
                </dd>
              </dl>
            </section>

            <div className="flex flex-col gap-3">
              {saveError ? (
                <Notice tone="danger">
                  <p>{errorText(saveError)}</p>
                  {saveError.supplierId ? (
                    <Link href={`/suppliers/${saveError.supplierId}`} className={linkClass}>
                      {t('result.openExisting', { code: saveError.existingCode ?? '' })}
                    </Link>
                  ) : null}
                  {saveStep && saveStep !== 'codes' ? (
                    <Button variant="link" onClick={() => setStep(saveStep)}>
                      {t('goTo', { step: t(`steps.${saveStep}`) })}
                    </Button>
                  ) : null}
                </Notice>
              ) : null}
              <Button className="self-start" onClick={() => void save()} disabled={saving} aria-describedby="supplier-save-after">
                {saving ? t('saving') : t('save')}
              </Button>
              <p id="supplier-save-after" className="text-base text-ink-muted md:text-sm">
                {foreign ? t('saveAfterForeign') : t('saveAfter')}
              </p>
            </div>
          </div>
        ) : null}
      </section>

      <div className="flex flex-col-reverse gap-3 border-t border-line pt-6 sm:flex-row sm:justify-between">
        {index > 0 ? (
          <Button variant="secondary" onClick={() => goTo(NEW_SUPPLIER_STEPS[index - 1]!)}>
            {t('steps.back', { name: t(`steps.${NEW_SUPPLIER_STEPS[index - 1]!}`) })}
          </Button>
        ) : (
          <span />
        )}
        {index < NEW_SUPPLIER_STEPS.length - 1 ? <Button onClick={() => goTo(NEW_SUPPLIER_STEPS[index + 1]!)}>{t('steps.next', { name: t(`steps.${NEW_SUPPLIER_STEPS[index + 1]!}`) })}</Button> : null}
      </div>
    </div>
  )
}

function IdentityStep(props: {
  foreign: boolean
  onForeign: (foreign: boolean) => void
  taxIdText: string
  onTaxId: (text: string) => void
  branch: string
  onBranch: (text: string) => void
  showErrors: boolean
  need: IdentityNeed | null
  checking: boolean
  checkError: string | null
  onLookup: () => void
  current: RegistryCheckView | null
  proof: { fileId: string; fileName: string } | null
  onProof: (file: { fileId: string; fileName: string }) => void
  uploads: UploadActions
}) {
  const t = useTranslations('suppliers.new')
  const tf = useTranslations('suppliers.fields')
  const { foreign, taxIdText, branch, showErrors, need, current } = props
  const tax = taxIdState(taxIdText)
  // The check digit shows at once once 13 digits are in; a missing number once the user tried to go on
  const taxError = tax.kind === 'checksum' ? t('taxIdChecksum') : tax.kind === 'shape' ? t('taxIdShape') : showErrors && need === 'taxId' ? t('needs.taxId') : undefined
  const taxHint = tax.kind === 'valid' ? (tax.juristic ? t('taxIdJuristic') : t('taxIdIndividual')) : tax.kind === 'typing' ? t('taxIdTyping', { digits: tax.digits }) : t('taxIdHint')
  const branchError = !BRANCH_CODE.test(branch) && (showErrors || branch.length >= 5) ? t('branchInvalid') : undefined
  const outcome = current?.proposal.outcome
  return (
    <div className="flex flex-col gap-6">
      <Choices id="supplier-kind" legend={t('kind')}>
        <label className="flex min-h-11 items-center gap-3">
          <input type="radio" name="supplier-kind" className={checkboxClass} checked={!foreign} onChange={() => props.onForeign(false)} />
          <span>{t('kindThai')}</span>
        </label>
        <label className="flex min-h-11 items-center gap-3">
          <input type="radio" name="supplier-kind" className={checkboxClass} checked={foreign} onChange={() => props.onForeign(true)} />
          <span>{t('kindForeign')}</span>
        </label>
      </Choices>

      {foreign ? (
        <Notice tone="info">
          <p>{t('foreignNote')}</p>
        </Notice>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_12rem]">
            <Labelled id="supplier-tax-id" label={t('taxId')} requiredText={tf('required')} hint={taxHint} error={taxError}>
              <input
                id="supplier-tax-id"
                name="taxId"
                className={`${inputClass} tabular`}
                inputMode="numeric"
                autoComplete="off"
                value={taxIdText}
                maxLength={TAX_ID_INPUT_MAX}
                required
                aria-required
                aria-invalid={taxError ? true : undefined}
                aria-describedby={describedBy('supplier-tax-id', true, Boolean(taxError))}
                onChange={(e) => props.onTaxId(e.currentTarget.value)}
              />
            </Labelled>
            <Labelled id="supplier-branch" label={t('branch')} requiredText={tf('required')} hint={t('branchHint')} error={branchError}>
              <input
                id="supplier-branch"
                name="branchCode"
                className={`${inputClass} tabular`}
                inputMode="numeric"
                autoComplete="off"
                value={branch}
                maxLength={5}
                required
                aria-required
                aria-invalid={branchError ? true : undefined}
                aria-describedby={describedBy('supplier-branch', true, Boolean(branchError))}
                onChange={(e) => props.onBranch(e.currentTarget.value.trim())}
              />
            </Labelled>
          </div>
          <div className="flex flex-col gap-2">
            <Button variant="secondary" className="self-start" onClick={props.onLookup} disabled={props.checking}>
              {props.checking ? t('lookingUp') : current ? t('lookupAgain') : t('lookup')}
            </Button>
            {props.checkError ? <Notice tone="danger">{props.checkError}</Notice> : null}
          </div>

          <section aria-labelledby="registry-result" aria-live="polite" className="flex flex-col gap-3">
            <h3 id="registry-result" className="text-lg font-semibold">
              {t('result.title')}
            </h3>
            {current ? <RegistryResult view={current} /> : <p className="text-ink-muted">{need === 'stale' ? t('needs.stale') : t('result.none')}</p>}
          </section>

          {outcome && outcome !== 'FOUND' && !current?.existing ? (
            <section aria-labelledby="registry-proof" className="flex flex-col gap-3">
              <h3 id="registry-proof" className="text-lg font-semibold">
                {t('proof.title')}
              </h3>
              <p className="text-ink">{t('proof.intro')}</p>
              {props.proof ? (
                <p className="flex items-start gap-2">
                  <CircleCheck className="mt-1 size-4 shrink-0 text-primary" aria-hidden="true" />
                  <span className="break-words">{t('proof.attached', { name: props.proof.fileName })}</span>
                </p>
              ) : null}
              <UploadButton label={props.proof ? t('proof.replace') : t('proof.upload')} actions={props.uploads} onUploaded={(f) => props.onProof(f)} />
            </section>
          ) : null}
        </>
      )}

      {showErrors && need && need !== 'taxId' && need !== 'branch' ? (
        <p role="alert" className="flex items-start gap-2 font-medium text-danger">
          <CircleAlert className="mt-1 size-4 shrink-0" aria-hidden="true" />
          <span>{t(`needs.${need}`)}</span>
        </p>
      ) : null}
    </div>
  )
}

/** What the registries said (FR-SUP-001 AC1), in label–value pairs; a supplier already in the register says so */
function RegistryResult({ view }: { view: RegistryCheckView }) {
  const t = useTranslations('suppliers.new')
  const p = view.proposal
  const sources = p.sources.includes('STUB') ? t('result.sourceStub') : p.sources.map((s) => (s === 'RD' ? t('result.sourceRd') : t('result.sourceDbd'))).join(t('result.sourceJoin'))
  return (
    <div className="flex flex-col gap-3">
      {view.existing ? (
        <Notice tone="warning">
          <p>{t('result.existing', { code: view.existing.code, name: view.existing.nameTh })}</p>
          <Link href={`/suppliers/${view.existing.id}`} className={linkClass}>
            {t('result.openExisting', { code: view.existing.code })}
          </Link>
        </Notice>
      ) : null}
      {p.outcome === 'FOUND' ? (
        <>
          <p className="flex items-start gap-2 text-ink">
            <CircleCheck className="mt-1 size-4 shrink-0 text-primary" aria-hidden="true" />
            <span>{view.existing ? t('result.foundExisting') : t('result.found')}</span>
          </p>
          <dl className="grid grid-cols-1 gap-y-1 border-l-4 border-info bg-surface px-3 py-2 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-x-6">
            <dt className="text-ink-muted">{t('result.name')}</dt>
            <dd className="mb-2 font-medium break-words sm:mb-0">{p.nameTh}</dd>
            <dt className="text-ink-muted">{t('result.address')}</dt>
            <dd className="mb-2 break-words sm:mb-0">{p.address ?? t('result.noData')}</dd>
            <dt className="text-ink-muted">{t('result.branch')}</dt>
            <dd className="mb-2 sm:mb-0">{p.branchCode === HEAD_OFFICE ? t('branchHead') : t('branchNumber', { code: p.branchCode })}</dd>
            <dt className="text-ink-muted">{t('result.vat')}</dt>
            <dd className="mb-2 sm:mb-0">{p.isVatRegistered === null ? t('result.vatUnknown') : p.isVatRegistered ? t('result.vatYes') : t('result.vatNo')}</dd>
            <dt className="text-ink-muted">{t('result.juristic')}</dt>
            <dd className="mb-2 sm:mb-0">{p.juristicStatus ?? (p.individual ? t('result.juristicIndividual') : t('result.noData'))}</dd>
            <dt className="text-ink-muted">{t('result.source')}</dt>
            <dd>{sources}</dd>
          </dl>
        </>
      ) : (
        <Notice tone="warning">
          <p>{p.outcome === 'UNAVAILABLE' ? t('result.unavailable') : t('result.notFound')}</p>
          {p.sources.length === 0 && p.individual ? <p>{t('result.individualRdOnly')}</p> : null}
        </Notice>
      )}
      {p.individual && p.outcome === 'FOUND' ? (
        <p className="flex items-start gap-2 text-ink">
          <Info className="mt-1 size-4 shrink-0 text-info" aria-hidden="true" />
          <span>{t('result.individualRdOnly')}</span>
        </p>
      ) : null}
    </div>
  )
}

function DetailsStep({ details, onChange, showErrors, proposal, foreign }: { details: Details; onChange: (next: Details) => void; showErrors: boolean; proposal: RegistryCheckView['proposal'] | null; foreign: boolean }) {
  const t = useTranslations('suppliers.new')
  const tf = useTranslations('suppliers.fields')
  const set = (patch: Partial<Details>) => onChange({ ...details, ...patch })
  const found = proposal?.outcome === 'FOUND' ? proposal : null
  const nameError = showErrors && !details.nameTh.trim() ? tf('missingName') : undefined
  const vatError = showErrors && details.vat === '' ? tf('missingVat') : undefined
  return (
    <div className="flex flex-col gap-6">
      {found ? (
        <p className="flex items-start gap-2 text-ink">
          <Info className="mt-1 size-4 shrink-0 text-info" aria-hidden="true" />
          <span>{t('filledFromRegistry')}</span>
        </p>
      ) : null}
      <Labelled id="supplier-name" label={tf('nameTh')} requiredText={tf('required')} hint={found?.nameTh ? tf('fromRegistry', { value: found.nameTh }) : tf('nameThHint')} error={nameError}>
        <input
          id="supplier-name"
          name="nameTh"
          className={inputClass}
          value={details.nameTh}
          maxLength={SUPPLIER_LIMITS.name}
          required
          aria-required
          aria-invalid={nameError ? true : undefined}
          aria-describedby={describedBy('supplier-name', true, Boolean(nameError))}
          onChange={(e) => set({ nameTh: e.currentTarget.value })}
        />
      </Labelled>
      <Labelled id="supplier-name-en" label={tf('nameEn')}>
        <input id="supplier-name-en" name="nameEn" className={inputClass} value={details.nameEn} maxLength={SUPPLIER_LIMITS.name} onChange={(e) => set({ nameEn: e.currentTarget.value })} />
      </Labelled>
      <Labelled id="supplier-address" label={tf('address')} hint={found?.address ? tf('fromRegistry', { value: found.address }) : tf('addressHint')}>
        <textarea
          id="supplier-address"
          name="address"
          className={textareaClass}
          value={details.address}
          maxLength={SUPPLIER_LIMITS.address}
          aria-describedby={describedBy('supplier-address', true, false)}
          onChange={(e) => set({ address: e.currentTarget.value })}
        />
      </Labelled>
      <Choices
        id="supplier-vat"
        legend={tf('vat')}
        requiredText={tf('required')}
        hint={found && found.isVatRegistered !== null ? tf('vatFromRegistry', { status: found.isVatRegistered ? tf('vatYes') : tf('vatNo') }) : foreign ? tf('vatForeignHint') : undefined}
        error={vatError}
      >
        <label className="flex min-h-11 items-center gap-3">
          <input type="radio" name="supplier-vat" className={checkboxClass} checked={details.vat === 'Y'} onChange={() => set({ vat: 'Y' })} />
          <span>{tf('vatYes')}</span>
        </label>
        <label className="flex min-h-11 items-center gap-3">
          <input type="radio" name="supplier-vat" className={checkboxClass} checked={details.vat === 'N'} onChange={() => set({ vat: 'N' })} />
          <span>{tf('vatNo')}</span>
        </label>
      </Choices>
      <Labelled id="supplier-category" label={tf('category')} hint={tf('categoryHint')}>
        <input
          id="supplier-category"
          name="category"
          className={inputClass}
          value={details.category}
          maxLength={SUPPLIER_LIMITS.category}
          aria-describedby={describedBy('supplier-category', true, false)}
          onChange={(e) => set({ category: e.currentTarget.value })}
        />
      </Labelled>
    </div>
  )
}
