import { randomUUID } from 'node:crypto'
import type { getTranslations } from 'next-intl/server'
import { PORTAL_AI_PATHS, type PortalAiReading } from '@/server/portal/queries-ai'
import { PortalButton, PortalNotice, portalCheckboxClass } from '@/ui/portal/frame'

// S7-14 (FR-AI-304 AC2 AC3 · BR-AI-30): beside the form, what the AI read off the supplier's documents — each value with
// the label "เติมโดย AI โปรดตรวจ", how sure the AI was, and a warning when a check found something; the fields that wait
// one by one are ticked by the person, the others can be taken together. Nothing is written until the person posts the
// form; a value not taken stays as typed. No account number is ever read (BR-AI-18).

type T = Awaited<ReturnType<typeof getTranslations<'portal'>>>
const DOC_TYPES = ['COMPANY_CERT', 'VAT_CERT', 'BANK_BOOK'] as const

export function AiReadingPanel({ t, readings, action, csrf, step, version }: { readonly t: T; readonly readings: readonly PortalAiReading[]; readonly action: string; readonly csrf: string; readonly step: string; readonly version: number }) {
  const open = readings.filter((r) => r.fields.some((f) => !f.confirmed))
  if (open.length === 0) return null
  return (
    <section aria-labelledby="ai-readings" className="flex flex-col gap-3 border-y border-line py-4">
      <h3 id="ai-readings" className="font-semibold">
        {t('apply.ai.title')}
      </h3>
      <p className="text-ink-muted">{t('apply.ai.intro')}</p>
      {open.map((r) => (
        <form key={r.agentActionId} method="post" action={action} className="flex flex-col gap-3">
          <input type="hidden" name="csrf" value={csrf} />
          <input type="hidden" name="key" value={randomUUID()} />
          <input type="hidden" name="step" value={step} />
          <input type="hidden" name="agentActionId" value={r.agentActionId} />
          {/* the application as this page showed it: a change made since (procurement on behalf) is CONFLICT_VERSION */}
          <input type="hidden" name="version" value={version} />
          <p className="font-medium">
            {r.documentTypeCode && (DOC_TYPES as readonly string[]).includes(r.documentTypeCode) ? t(`apply.ai.doc.${r.documentTypeCode as (typeof DOC_TYPES)[number]}`) : t('apply.ai.doc.OTHER')}
            {r.fileName ? ` · ${r.fileName}` : ''}
          </p>
          {r.documentChecks.map((code) => (
            <PortalNotice key={code} tone={code === 'BANK_UNKNOWN' ? 'warning' : 'danger'}>
              {t(`apply.ai.docCheck.${code}`)}
            </PortalNotice>
          ))}
          <ul className="flex flex-col gap-2">
            {r.fields
              .filter((f) => (PORTAL_AI_PATHS as readonly string[]).includes(f.path))
              .map((f) => (
                <li key={f.path} className="flex items-start gap-3">
                  {f.confirmed ? (
                    <span className="min-w-5" aria-hidden="true" />
                  ) : (
                    <input id={`take-${r.agentActionId}-${f.path}`} type="checkbox" name="take" value={f.path} className={portalCheckboxClass} />
                  )}
                  <label htmlFor={f.confirmed ? undefined : `take-${r.agentActionId}-${f.path}`} className="flex flex-col gap-0.5">
                    <span>
                      <span className="font-medium">{t(`apply.ai.field.${f.path as (typeof PORTAL_AI_PATHS)[number]}`)}</span>
                      {': '}
                      {f.path === 'isVatRegistered' ? (f.value === 'true' ? t('apply.ai.yes') : t('apply.ai.no')) : f.value}
                    </span>
                    <span className="text-ink-muted">
                      {f.confirmed ? t('apply.ai.taken') : `${t('apply.ai.byAi')} · ${t('apply.ai.confidence', { percent: f.confidencePercent })}${f.mustConfirm ? ` · ${t('apply.ai.mustConfirm')}` : ''}`}
                    </span>
                    {f.check && !f.confirmed ? <PortalNotice tone={f.check === 'FAIL' ? 'danger' : 'warning'}>{t(`apply.ai.check.${f.check}`)}</PortalNotice> : null}
                  </label>
                </li>
              ))}
          </ul>
          <div className="flex flex-col gap-2 sm:flex-row">
            <PortalButton type="submit" variant="secondary">
              {t('apply.ai.takeTicked')}
            </PortalButton>
            {r.fields.some((f) => !f.mustConfirm && !f.confirmed) ? (
              <PortalButton type="submit" name="rest" value="1" variant="secondary">
                {t('apply.ai.takeRest')}
              </PortalButton>
            ) : null}
          </div>
        </form>
      ))}
    </section>
  )
}
