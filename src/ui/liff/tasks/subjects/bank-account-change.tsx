import { getTranslations } from 'next-intl/server'
import { AttachmentList } from '@/ui/request-view/attachments'
import { LiffSection } from '../../content'

// The LIFF summary of an approval task on a bank account change (S9-06, BR-SUP-06, BR-SUP-07, ADR-052): the request's
// number and kind, whose account, the account in force and the one proposed side by side — masked, the whole numbers
// only through bankAccount.reveal on the web — the call to the number in the register, and the proofs, opened through
// the task as every LIFF file is (each opening logged, file-policy.ts). The approval takes the PIN every time.

interface LiffAccount {
  readonly bankName: string | null
  readonly bankCode: string
  readonly accountNoMasked: string
  readonly accountName: string
}

export interface LiffBankAccountChangeView {
  readonly number: string | null
  readonly kind: 'ADD' | 'REPLACE' | 'CLOSE'
  readonly supplier: { readonly code: string; readonly nameTh: string } | null
  readonly target: LiffAccount | null
  readonly proposed: LiffAccount | null
  readonly reason: string
  readonly callVerifiedAt: string | null
  readonly callVerificationNote: string | null
  readonly proofs: ReadonlyArray<{ readonly fileId: string; readonly fileName: string }>
  readonly contactChangedRecently: boolean
  readonly sharedAccount: boolean
}

const accountText = (a: LiffAccount) => `${a.bankName ?? a.bankCode} ${a.accountNoMasked} · ${a.accountName}`

export async function LiffBankAccountChangeSummary({ change, openFile }: { change: LiffBankAccountChangeView | null; openFile: (fileId: string) => Promise<string | null> }) {
  if (!change) return null
  const t = await getTranslations('payRun.bankChange')
  const rows = [
    { label: t('number'), value: change.number ?? '-' },
    { label: t('kind'), value: t(`kindValue.${change.kind}`) },
    { label: t('owner'), value: change.supplier ? `${change.supplier.code} · ${change.supplier.nameTh}` : t('company') },
    ...(change.target ? [{ label: t('target'), value: accountText(change.target) }] : []),
    ...(change.proposed ? [{ label: t('proposed'), value: accountText(change.proposed) }] : []),
    { label: t('reason'), value: change.reason },
    { label: t('call'), value: change.callVerifiedAt ? (change.callVerificationNote ?? '-') : t('noCall') },
  ]
  return (
    <>
      {change.contactChangedRecently || change.sharedAccount ? (
        <div className="flex flex-col gap-1 rounded-md border border-warn bg-warn-bg p-3 text-warn-ink">
          {change.contactChangedRecently ? <p>{t('contactChanged')}</p> : null}
          {change.sharedAccount ? <p>{t('sharedAccount')}</p> : null}
        </div>
      ) : null}
      <LiffSection id="bank-account-change-summary" title={t('heading')}>
        <dl className="flex flex-col gap-3">
          {rows.map((r) => (
            <div key={r.label} className="flex flex-col">
              <dt className="text-ink-muted">{r.label}</dt>
              <dd className="tabular break-words text-ink">{r.value}</dd>
            </div>
          ))}
        </dl>
      </LiffSection>
      {change.proofs.length ? (
        <LiffSection id="bank-account-change-proofs" title={t('proofs')}>
          <AttachmentList open={openFile} files={change.proofs.map((p) => ({ fileId: p.fileId, fileName: p.fileName, detail: t('proofDetail') }))} />
        </LiffSection>
      ) : null}
    </>
  )
}
