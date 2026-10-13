import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import type { WorkflowTaskDto } from '@/server/queries/tasks'
import { Facts, Section } from '@/ui/request-view/facts'
import { day, memberName, type Locale } from './present'

// The body of a WORKFLOW_VERSION task (S6 · FR-WF-103 AC3): what the approver publishes — the version, from when, why,
// who sent it and how many reviewer rules it has — and the way to its page, where its approver reads the rules, the
// comparison with the version in effect and the checks, and tries a document out on both (read only). Decided on the
// web only, approved or rejected with the PIN (BR-WF-12).

const linkClass = 'inline-flex min-h-11 items-center font-medium text-primary underline underline-offset-4 hover:no-underline'

export async function WorkflowSubject({ workflow, locale, pageLink = true }: { workflow: WorkflowTaskDto; locale: Locale; pageLink?: boolean }) {
  const t = await getTranslations('tasks.workflow')
  return (
    <Section id="workflow" title={t('title')}>
      <div className="flex flex-col gap-4">
        <Facts
          items={[
            { label: t('version'), value: t('versionValue', { code: workflow.code, version: workflow.versionNo }) },
            { label: t('effective'), value: day(locale, workflow.effectiveFrom) },
            { label: t('rules'), value: t('rulesValue', { count: workflow.rules }) },
            { label: t('submittedBy'), value: workflow.submittedBy ? memberName(locale, workflow.submittedBy) : '-' },
            { label: t('reason'), value: <span className="whitespace-pre-line">{workflow.changeReason ?? '-'}</span> },
          ]}
        />
        <p className="text-ink-muted">{t('webOnly')}</p>
        {pageLink ? (
          <Link href={`/admin/workflows/${workflow.versionId}`} className={linkClass}>
            {t('open')}
          </Link>
        ) : null}
      </div>
    </Section>
  )
}
