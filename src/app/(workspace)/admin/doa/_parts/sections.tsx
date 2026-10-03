import { CircleCheck, CircleMinus, CirclePlus, Scale, TriangleAlert } from 'lucide-react'
import Link from 'next/link'
import type { ReactNode } from 'react'
import { Notice } from '@/ui/form/notice'
import type { VersionDiff } from '@/server/services/doa/diff'
import type { BoundarySideView, BoundaryTableView, CompareView, RuleView } from '@/server/services/doa/view'
import type { DoaT, DoaWords } from './words'

// Sections of a DOA version's page: the rule-by-rule diff (with the version before it, FR-DOA-001 AC3, or with the
// version it replaces, FR-DOA-009 AC1), the positions that gain or lose authority, and the boundary table — of the
// version beside the version it replaces, or of the version alone when there is none (FR-DOA-009 AC3, BR-DOA-08 (ช)).
// When the two versions read amounts on different bases, both comparisons say so first. Lists, not cards; every change
// is said in words, with an icon where it helps, never by colour alone (NFR-A11Y-03). Wide screens get columns, phones
// a stacked list.

export function Section({ id, title, children }: { id: string; title: ReactNode; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="flex scroll-mt-4 flex-col gap-3">
      <h2 id={`${id}-title`} className="text-xl font-semibold">
        {title}
      </h2>
      {children}
    </section>
  )
}

/** Policies, then changed, added and removed rules, as one list */
export function DiffList({ diff, before, after, t, words }: { diff: VersionDiff; before: readonly RuleView[]; after: readonly RuleView[]; t: DoaT; words: DoaWords }) {
  const ruleOf = (rules: readonly RuleView[], code: string) => rules.find((r) => r.code === code)
  const field = (f: VersionDiff['changed'][number]['fields'][number], r: RuleView) =>
    f === 'band' ? words.band(r.band) : f === 'approver' ? words.rulesApprover(r) : f === 'sla' ? words.rulesSla(r) : f === 'priority' ? String(r.priority) : words.documentType(r.documentType)
  const ruleLine = (r: RuleView) => t('detail.ruleLine', { documentType: words.documentType(r.documentType), band: words.band(r.band), approver: words.rulesApprover(r) })
  return (
    <ul className="flex flex-col divide-y divide-line border-y border-line">
      {diff.policy.map((p) => (
        <li key={`policy-${p.field}`} className="flex flex-col gap-0.5 py-3">
          <p className="font-medium">{t('detail.diffPolicy', { field: t(`detail.policy.${p.field}`) })}</p>
          <p className="text-ink-muted">{t('detail.beforeAfter', { before: words.policyText(p.field, p.before), after: words.policyText(p.field, p.after) })}</p>
        </li>
      ))}
      {diff.changed.map((c) => {
        const old = ruleOf(before, c.code)
        const now = ruleOf(after, c.code)
        return (
          <li key={`changed-${c.code}`} className="flex flex-col gap-0.5 py-3">
            <p className="font-medium">{t('detail.diffChanged', { rule: c.code })}</p>
            {old && now
              ? c.fields.map((f) => (
                  <p key={f} className="tabular text-ink-muted">
                    {t('detail.diffField', { field: t(`detail.ruleFields.${f}`), change: t('detail.beforeAfter', { before: field(f, old), after: field(f, now) }) })}
                  </p>
                ))
              : null}
          </li>
        )
      })}
      {diff.added.map((code) => {
        const r = ruleOf(after, code)
        return (
          <li key={`added-${code}`} className="flex flex-col gap-0.5 py-3">
            <p className="font-medium">{t('detail.diffAdded', { rule: code })}</p>
            {r ? <p className="tabular text-ink-muted">{ruleLine(r)}</p> : null}
          </li>
        )
      })}
      {diff.removed.map((code) => {
        const r = ruleOf(before, code)
        return (
          <li key={`removed-${code}`} className="flex flex-col gap-0.5 py-3">
            <p className="font-medium">{t('detail.diffRemoved', { rule: code })}</p>
            {r ? <p className="tabular text-ink-muted">{ruleLine(r)}</p> : null}
          </li>
        )
      })}
    </ul>
  )
}

export const diffIsEmpty = (d: VersionDiff) => d.policy.length + d.added.length + d.removed.length + d.changed.length === 0

/** A phrase that must not break across lines (Thai segmentation can split "มีผลอยู่" mid-word) */
export const keepTogether = (chunks: ReactNode) => <span className="whitespace-nowrap">{chunks}</span>

/** The version a draft is compared with, as the comparisons name it */
export interface Baseline {
  readonly name: string
  /** Approved for later and in effect just before this version starts, rather than in effect now */
  readonly next: boolean
  /**
   * In effect before this version and ended since (with `next`): the approver's page of a version already published
   * reads the version it replaced in the past tense
   */
  readonly replaced?: boolean
}

/**
 * The two versions read amounts on different bases: the same number is a different document in each (BR-DOA-02). The
 * try-out link (`simulateHref`) only for a reader who may open it; null leaves it out, never a link to a refusal.
 */
function BasisNotice({ basis, simulateHref, t }: { basis: NonNullable<CompareView['basis']>; simulateHref: string | null; t: DoaT }) {
  return (
    <Notice tone="warning">
      <p>{t('detail.basisNotice', { before: t(`detail.policy.${basis.before}`), after: t(`detail.policy.${basis.after}`) })}</p>
      {simulateHref ? (
        <Link href={simulateHref} className="inline-flex min-h-11 items-center font-medium text-primary underline underline-offset-4 hover:no-underline">
          {t('detail.basisSimulate')}
        </Link>
      ) : null}
    </Notice>
  )
}

/** Who gains or loses authority, by document type and amount band (FR-DOA-009 AC1) */
export function AuthorityList({ compare, baseline, simulateHref, t, words }: { compare: CompareView; baseline: Baseline; simulateHref: string | null; t: DoaT; words: DoaWords }) {
  const intro = baseline.replaced ? 'detail.authorityIntroReplaced' : baseline.next ? 'detail.authorityIntroNext' : 'detail.authorityIntro'
  return (
    <>
      <p className="text-base text-ink-muted md:text-sm">{t.rich(intro, { name: baseline.name, now: keepTogether })}</p>
      {compare.basis ? <BasisNotice basis={compare.basis} simulateHref={simulateHref} t={t} /> : null}
      {compare.authority.length === 0 ? (
        <p className="border-y border-line py-3">{compare.basis ? t('detail.authorityNoneBasis') : t('detail.authorityNone')}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-line border-y border-line">
          {compare.authority.map((c, i) => (
            <li key={`${c.change}-${c.documentType}-${c.band?.gt ?? '-'}-${i}`} className="grid gap-1 py-3 md:grid-cols-[9rem_minmax(0,1fr)] md:gap-x-4">
              <p className="inline-flex items-center gap-1.5 font-medium">
                {c.change === 'GAIN' ? <CirclePlus className="size-4 shrink-0 text-primary" aria-hidden="true" /> : <CircleMinus className="size-4 shrink-0 text-danger" aria-hidden="true" />}
                {c.change === 'GAIN' ? t('detail.authorityGain') : t('detail.authorityLose')}
              </p>
              <div className="flex min-w-0 flex-col gap-0.5">
                <p className="font-medium">{words.approver(c.approver)}</p>
                <p className="tabular text-ink-muted">
                  {t('detail.authorityLine', { documentType: words.documentType(c.documentType), band: c.band ? words.band({ gt: c.band.gt, lte: c.band.lte }) : t('detail.authorityNoAmount') })}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}

const COMPARE_GRID = 'md:grid-cols-[9rem_minmax(0,1fr)_minmax(0,1fr)_8.5rem]'
const OWN_GRID = 'md:grid-cols-[9rem_minmax(0,1fr)]'

/**
 * The boundary table: every band edge and 0.01 above it, with the rule and approvers that apply — of this version beside
 * the version it replaces (every edge of either, and whether the approver changes there), or of this version alone.
 */
export function BoundaryCompare({
  tables,
  baseline,
  basis,
  simulateHref,
  t,
  words,
}: {
  tables: readonly BoundaryTableView[]
  baseline: Baseline | null
  basis: CompareView['basis']
  simulateHref: string | null
  t: DoaT
  words: DoaWords
}) {
  const grid = baseline ? COMPARE_GRID : OWN_GRID
  // The version's name stays on one line in its column's header: "(DOA-DEMO ฉบับ 1)", never "(DOA-DEMO ฉบับ" over "1)"
  const before = baseline ? t.rich(baseline.next ? 'detail.boundaryHeaders.beforeNext' : 'detail.boundaryHeaders.before', { name: baseline.name, keep: keepTogether }) : ''
  // Each cell says which version it is in short, so the two columns line up on phones; the header names the version
  const beforeShort = baseline?.next ? t('detail.boundaryHeaders.beforeShortNext') : t('detail.boundaryHeaders.beforeShort')
  const after = baseline ? t('detail.boundaryHeaders.after') : t('detail.boundaryHeaders.own')
  const side = (label: string, s: BoundarySideView | null) => (
    <div className="flex min-w-0 flex-col">
      {/* Two versions side by side need their names on phones; one version alone does not ("ใช้ข้อ …" says it) */}
      <span className={baseline ? 'text-base text-ink-muted md:sr-only' : 'sr-only'}>{label}</span>
      {s === null ? null : s.ruleCode ? (
        <>
          <span className="font-medium">{t('detail.boundaryRule', { rule: s.ruleCode })}</span>
          <span className="break-words">{s.approvers.map(words.approverShort).join(', ')}</span>
        </>
      ) : (
        <span>{t('detail.boundaryNone')}</span>
      )}
    </div>
  )
  const result = (changed: boolean) =>
    basis ? (
      <>
        <Scale className="size-4 shrink-0 text-warn" aria-hidden="true" />
        <span className="font-medium">{t('detail.boundaryBasis')}</span>
      </>
    ) : changed ? (
      <>
        <TriangleAlert className="size-4 shrink-0 text-warn" aria-hidden="true" />
        <span className="font-medium">{t('detail.boundaryChanged')}</span>
      </>
    ) : (
      <>
        <CircleCheck className="size-4 shrink-0 text-ink-muted" aria-hidden="true" />
        <span className="text-ink-muted">{t('detail.boundarySame')}</span>
      </>
    )
  return (
    <>
      <p className="text-base text-ink-muted md:text-sm">{baseline ? t('detail.boundaryCompareIntro') : t('detail.boundaryIntro')}</p>
      {basis ? <BasisNotice basis={basis} simulateHref={simulateHref} t={t} /> : null}
      {tables.map((b) => (
        <div key={b.documentType} className="flex flex-col gap-1">
          <h3 className="text-lg font-semibold">{words.documentType(b.documentType)}</h3>
          <div className={`hidden border-b border-line pb-2 text-sm font-medium text-ink-muted md:grid md:gap-x-4 ${grid}`} aria-hidden="true">
            <span className="text-right">{t('detail.boundaryHeaders.amount')}</span>
            {baseline ? <span>{before}</span> : null}
            <span>{after}</span>
            {baseline ? <span>{t('detail.boundaryHeaders.result')}</span> : null}
          </div>
          <ul aria-label={words.documentType(b.documentType)} className="flex flex-col divide-y divide-line border-b border-line">
            {b.rows.map((row) => (
              <li key={row.amount} className={`grid gap-x-4 gap-y-1.5 py-2.5 md:items-baseline ${baseline ? 'grid-cols-2' : 'grid-cols-1'} ${grid}`}>
                <p className={`flex justify-between gap-4 md:col-span-1 md:block md:text-right ${baseline ? 'col-span-2' : ''}`}>
                  <span className="shrink-0 text-ink-muted md:sr-only">{t('detail.boundaryHeaders.amount')}</span>
                  <span className="tabular font-semibold md:font-normal">{t('detail.boundaryAmount', { amount: words.money(row.amount) })}</span>
                </p>
                {baseline ? side(beforeShort, row.before) : null}
                {side(after, row.after)}
                {baseline ? <p className="col-span-2 inline-flex items-center gap-1.5 md:col-span-1">{result(row.changed)}</p> : null}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </>
  )
}

