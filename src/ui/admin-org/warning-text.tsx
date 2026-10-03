'use client'

import { useLocale, useTranslations } from 'next-intl'
import { nameIn, type Named } from './names'
import { warningParts } from './warnings'

// The sentence of one warning the proposer ticks before sending (BR-DOA-08 (ข)(ฉ), BR-DOA-17), from its key.
export function WarningText({
  warningKey,
  positions = [],
  departments = [],
}: {
  warningKey: string
  positions?: ReadonlyArray<Named & { readonly code: string }>
  departments?: ReadonlyArray<Named & { readonly code: string }>
}) {
  const t = useTranslations('adminOrg.warnings')
  const locale = useLocale()
  const parts = warningParts(warningKey)
  switch (parts.code) {
    case 'POSITION_VACANT': {
      const position = positions.find((p) => p.code === parts.positionCode)
      const department = departments.find((d) => d.code === parts.departmentCode)
      return (
        <span>
          {t('POSITION_VACANT', {
            position: position ? `${nameIn(locale, position)} (${parts.positionCode})` : parts.positionCode,
            department: department ? nameIn(locale, department) : parts.departmentCode,
          })}
        </span>
      )
    }
    case 'DOA_LINT_VACANT_POSITION':
    case 'DOA_LINT_MEMBER_APPROVER':
      return <span>{t(parts.code, { rule: parts.rule })}</span>
    case 'OTHER':
      return <span>{t('OTHER', { key: parts.key })}</span>
  }
}
