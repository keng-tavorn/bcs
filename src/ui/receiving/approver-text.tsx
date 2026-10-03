'use client'

import { useTranslations } from 'next-intl'
import { nameIn, type ApproverView } from './types'

// Who approves a variance that is kept (DOA rule GR_VARIANCE, BR-GR-03), named before anything is posted (§9.9
// principle 3): the person, whom they act for, their position and the rule — or why keeping it is not possible now:
// damaged goods beyond what is still to come go back, or the DOA names nobody.

export function ApproverText({ approver, locale }: { approver: ApproverView; locale: string }) {
  const t = useTranslations('receiving.approver')
  if (approver.kind === 'BLOCKED') return <span className="text-base text-danger md:text-sm">{approver.code === 'BEYOND_ORDER' ? t('beyondOrder') : t('blocked')}</span>
  const name = nameIn(locale, approver.name) || t('unknown')
  const position = nameIn(locale, approver.position)
  const department = nameIn(locale, approver.department)
  const role = position && department ? t('roleIn', { position, department }) : position
  const who = approver.actingFor ? t('acting', { name, principal: nameIn(locale, approver.actingFor) }) : name
  return <span className="text-base text-ink-muted md:text-sm">{role ? t('withRole', { who, role, rule: approver.ruleCode }) : t('plain', { who, rule: approver.ruleCode })}</span>
}
