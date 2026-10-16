import { lintWorkflowVersion, type ReviewerSpec, type WorkflowCondition, type WorkflowRuleSnapshot } from '@/core/workflow'
import { systemCtx } from '@/server/context'
import { forTenant } from '@/server/db/tenant'
import { loadOrgSnapshot } from '@/server/doa/policy'
import { appendEvents } from '@/server/events/append'
import { loadRequestTypeFields } from '@/server/workflow/policy'
import { ConditionJson, workflowRuleJson } from '@/server/workflow/snapshot'
import type { InputWorkbook } from './workbook'

// The parallel reviewers of the phase-1 organization (S6-04, FR-WF-103 AC4): version 1 of its workflow from sheet
// Workflow_Reviewers of docs/inputs/BCS_inputs_p1.xlsx, published from the start of its DOA version 1, as the seed
// publishes that version (local and staging only; NG-12). The demo workbook has no such sheet and gets no workflow.
// Whatever cannot be read exactly stops the seed with a Thai message naming the row.

const SHEET = 'Workflow_Reviewers'
const MINUTES_PER_HOUR = 60

export interface WorkflowSeedInput {
  readonly code: string
  readonly rules: ReadonlyArray<WorkflowRuleSnapshot & { readonly descriptionTh: string | null }>
}

/** null when the workbook has no Workflow_Reviewers sheet (the demo workbook) */
export function parseWorkflowReviewers(workbook: InputWorkbook, orgCode: string): WorkflowSeedInput | null {
  if (!workbook.hasSheet(SHEET)) return null
  const rules = workbook.table(SHEET).map(({ row, values }, i): WorkflowRuleSnapshot & { descriptionTh: string | null } => {
    const at = `ชีต ${SHEET} แถว ${row}`
    const need = (key: string) => {
      const v = values[key]
      if (!v) throw new Error(`${at}: ช่อง ${key} ว่าง`)
      return v
    }
    let when: WorkflowCondition
    try {
      when = ConditionJson.parse(JSON.parse(values.whenJson ?? '{}'))
    } catch (error) {
      throw new Error(`${at}: whenJson อ่านเป็นเงื่อนไขไม่ได้ (${(error as Error).message.split('\n')[0]})`)
    }
    const mode = need('mode')
    if (mode !== 'ALL' && mode !== 'ANY') throw new Error(`${at}: mode ต้องเป็น ALL หรือ ANY`)
    const hours = Number(need('slaBusinessHours'))
    if (!Number.isInteger(hours) || hours <= 0) throw new Error(`${at}: slaBusinessHours ต้องเป็นจำนวนเต็มบวก`)
    const fallback: ReviewerSpec | null = values.fallbackPosition && values.fallbackDepartment ? { kind: 'POSITION_AT', position: values.fallbackPosition, department: values.fallbackDepartment } : null
    return {
      code: need('ruleCode'),
      requestTypeCodes: [need('requestType')],
      when,
      reviewers: [{ kind: 'POSITION_AT', position: need('reviewerPosition'), department: need('reviewerDepartment') }],
      fallback,
      mode,
      quorumCount: null,
      slaBusinessMinutes: hours * MINUTES_PER_HOUR,
      sortOrder: i,
      descriptionTh: values.descriptionTh ?? null,
    }
  })
  return { code: `WF-${orgCode}`, rules }
}

/**
 * Version 1 of the workflow, PUBLISHED from when DOA version 1 of the organization starts; safe to run again. It must
 * pass the lint of BR-WF-11 against the organization and its forms, or the seed stops.
 */
export async function seedWorkflow(organizationId: string, input: WorkflowSeedInput, now: Date): Promise<{ readonly created: boolean; readonly rules: number }> {
  const ctx = systemCtx(organizationId, now, 'seed')
  return forTenant(organizationId).$transaction(async (tx) => {
    if (await tx.workflowVersion.findFirst({ where: { code: input.code, versionNo: 1 }, select: { id: true } })) return { created: false, rules: input.rules.length }
    const doa = await tx.doaVersion.findFirst({ where: { versionNo: 1, status: { in: ['PUBLISHED', 'SUPERSEDED'] } }, orderBy: { effectiveFrom: 'asc' }, select: { effectiveFrom: true } })
    const effectiveFrom = doa?.effectiveFrom ?? now
    const lint = lintWorkflowVersion(
      { id: 'seed', code: input.code, versionNo: 1, status: 'DRAFT', effectiveFrom, effectiveTo: null, rules: input.rules },
      await loadOrgSnapshot(tx),
      await loadRequestTypeFields(tx),
      now,
    )
    if (lint.errors.length) throw new Error(`ชีต ${SHEET}: ${input.code} ฉบับ 1 ไม่ผ่านการตรวจ ${lint.errors.map((e) => `${e.code} (${e.rule})`).join(', ')}`)
    const version = await tx.workflowVersion.create({
      data: { organizationId, code: input.code, versionNo: 1, status: 'PUBLISHED', effectiveFrom, publishedAt: now, changeReason: 'ฉบับตั้งต้นจากชีต Workflow_Reviewers (ข้อมูลสังเคราะห์ระยะ 1)' },
      select: { id: true },
    })
    for (const rule of input.rules) {
      const json = workflowRuleJson(rule)
      await tx.workflowRule.create({
        data: {
          organizationId,
          workflowVersionId: version.id,
          code: rule.code,
          requestTypeCodes: [...rule.requestTypeCodes],
          when: json.when,
          reviewers: json.reviewers,
          ...(json.fallback ? { fallback: json.fallback } : {}),
          mode: rule.mode,
          quorumCount: rule.quorumCount,
          slaBusinessMinutes: rule.slaBusinessMinutes,
          descriptionTh: rule.descriptionTh,
          sortOrder: rule.sortOrder,
        },
      })
    }
    await appendEvents(tx, ctx, [
      {
        type: 'workflow_version.published',
        aggregateType: 'WorkflowVersion',
        aggregateId: version.id,
        data: { code: input.code, versionNo: 1, effectiveFrom: effectiveFrom.toISOString(), via: 'SEED', rules: input.rules.length },
      },
    ])
    return { created: true, rules: input.rules.length }
  })
}
