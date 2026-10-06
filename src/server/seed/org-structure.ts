import { systemCtx } from '@/server/context'
import { forTenant } from '@/server/db/tenant'
import { ruleJson } from '@/server/doa/snapshot'
import { appendEvents, type EventDraft } from '@/server/events/append'
import type { DemoUser } from './demo-org'
import { loadSeedForms, type SeedForm } from './forms'
import { doaSnapshot, parseDoa, parseHolidays, parseOrgStructure, parseRequestTypes } from './sheets'
import type { InputWorkbook } from './workbook'

// Organization structure and DOA of the demo organization (spec Appendix A, S2-15): sheets Departments, Positions, DOA,
// DOA_Policy, RequestTypes and Holidays of docs/inputs/BCS_inputs_v1_demo.xlsx, after the members exist (S1-13).
// Local and staging only (prisma/seed.ts checks APP_ENV): the demo seed is the one place outside the customer's own
// 4-eyes flow that may publish a DOA version and assign position holders (NG-12). Running again adds nothing: rows and
// their events are created only when missing.

export interface OrgStructureInput {
  readonly structure: ReturnType<typeof parseOrgStructure>
  readonly doa: ReturnType<typeof parseDoa>
  readonly requestTypes: ReturnType<typeof parseRequestTypes>
  readonly holidays: ReturnType<typeof parseHolidays>
  /** The form of each request type (prisma/seed/forms.yaml) */
  readonly forms: ReadonlyMap<string, SeedForm>
}

export function parseOrgStructureInput(workbook: InputWorkbook): OrgStructureInput {
  const requestTypes = parseRequestTypes(workbook)
  const forms = loadSeedForms()
  const missing = requestTypes.filter((t) => !forms.has(t.code)).map((t) => t.code)
  if (missing.length) throw new Error(`RequestTypes: no form in prisma/seed/forms.yaml for ${missing.join(', ')}`)
  return { structure: parseOrgStructure(workbook), doa: parseDoa(workbook), requestTypes, holidays: parseHolidays(workbook), forms }
}

export interface OrgStructureReport {
  readonly departments: number
  readonly positions: number
  readonly assignments: number
  readonly doaVersions: number
  readonly requestTypes: number
  readonly forms: number
  readonly holidays: number
}

/** Departments parents first, so every parent exists before its children. */
function parentsFirst<T extends { code: string; parent: string | null }>(departments: readonly T[]): T[] {
  const placed = new Set<string>()
  const ordered: T[] = []
  while (ordered.length < departments.length) {
    const next = departments.filter((d) => !placed.has(d.code) && (d.parent === null || placed.has(d.parent)))
    if (next.length === 0) throw new Error('Departments: the parent links do not form one tree')
    for (const d of next) {
      ordered.push(d)
      placed.add(d.code)
    }
  }
  return ordered
}

export async function seedOrgStructure(organizationId: string, users: readonly DemoUser[], input: OrgStructureInput, now: Date): Promise<OrgStructureReport> {
  const ctx = systemCtx(organizationId, now, 'seed')
  const version = doaSnapshot(input.doa, 'seed')
  // Holders start with the DOA version, so requests the demo dates back (Demo_History) find their approvers
  const holdersFrom = version.effectiveFrom

  return forTenant(organizationId).$transaction(async (tx) => {
    const events: EventDraft[] = []
    const report = { departments: 0, positions: 0, assignments: 0, doaVersions: 0, requestTypes: 0, forms: 0, holidays: 0 }

    // 1. Departments (one tree, root first)
    const departmentIds = new Map<string, string>()
    for (const d of parentsFirst(input.structure.departments)) {
      let row = await tx.department.findFirst({ where: { code: d.code }, select: { id: true } })
      if (!row) {
        const parentId = d.parent === null ? null : departmentIds.get(d.parent)!
        row = await tx.department.create({ data: { organizationId, code: d.code, nameTh: d.nameTh, parentId, kind: d.kind }, select: { id: true } })
        events.push({ type: 'department.created', aggregateType: 'Department', aggregateId: row.id, data: { code: d.code, parentId, via: 'SEED' } })
        report.departments++
      }
      departmentIds.set(d.code, row.id)
    }
    const rootId = departmentIds.get(input.structure.departments.find((d) => d.parent === null)!.code)!

    // 2. Positions (catalog rows; their holders are the events)
    const positionIds = new Map<string, { id: string; scope: 'DEPARTMENT' | 'ORG' }>()
    for (const p of input.structure.positions) {
      let row = await tx.position.findFirst({ where: { code: p.code }, select: { id: true } })
      if (!row) {
        row = await tx.position.create({ data: { organizationId, code: p.code, nameTh: p.nameTh, scope: p.scope }, select: { id: true } })
        report.positions++
      }
      positionIds.set(p.code, { id: row.id, scope: p.scope })
    }

    // 3. Members' main department and the positions they hold (Users sheet: "DM@CON;VP@OPS")
    for (const user of users) {
      const member = await tx.member.findFirst({ where: { employeeCode: user.code }, select: { id: true, primaryDepartmentId: true } })
      if (!member) throw new Error(`Users: ${user.code} has no member yet (run the S1-13 seed first)`)
      const departmentId = departmentIds.get(user.department)
      if (!departmentId) throw new Error(`Users: ${user.code} belongs to unknown department ${user.department}`)
      if (member.primaryDepartmentId === null) await tx.member.update({ where: { id: member.id }, data: { primaryDepartmentId: departmentId } })
      for (const held of user.positions) {
        const [positionCode, departmentCode] = held.split('@') as [string, string]
        const position = positionIds.get(positionCode)
        const heldIn = departmentIds.get(departmentCode)
        if (!position || !heldIn) throw new Error(`Users: ${user.code} holds ${held}, which is not in Positions and Departments`)
        // Organization-wide positions belong to the root department (§6.2)
        const assignmentDepartment = position.scope === 'ORG' ? rootId : heldIn
        const current = await tx.positionAssignment.findFirst({ where: { positionId: position.id, departmentId: assignmentDepartment, validTo: null }, select: { memberId: true } })
        if (current) {
          if (current.memberId !== member.id) throw new Error(`Users: ${held} already has another holder`)
          continue
        }
        const row = await tx.positionAssignment.create({
          data: { organizationId, positionId: position.id, departmentId: assignmentDepartment, memberId: member.id, validFrom: holdersFrom },
          select: { id: true },
        })
        events.push({
          type: 'position.assigned',
          aggregateType: 'PositionAssignment',
          aggregateId: row.id,
          data: { positionCode, departmentId: assignmentDepartment, memberId: member.id, validFrom: holdersFrom.toISOString(), via: 'SEED' },
        })
        report.assignments++
      }
    }

    // 4. DOA version 1 as published, with its rules (BR-DOA-08 lint runs on it in pnpm verify)
    const existingVersion = await tx.doaVersion.findFirst({ where: { code: version.code, versionNo: version.versionNo }, select: { id: true } })
    if (!existingVersion) {
      const policy = input.doa.policy
      const row = await tx.doaVersion.create({
        data: {
          organizationId,
          code: version.code,
          versionNo: version.versionNo,
          status: 'PUBLISHED',
          effectiveFrom: version.effectiveFrom,
          amountBasis: version.amountBasis,
          selfApprovalPolicy: version.selfApprovalPolicy,
          collapseDuplicateApprovers: version.collapseDuplicateApprovers,
          stepUpThresholdSatang: policy.stepUpThreshold,
          escalationPolicy: { remindPct: policy.remindPct, escalateAfterBusinessHours: policy.escalateAfterBusinessHours },
          sodPolicy: { approverMayReceive: policy.approverMayReceive, requesterMayReceive: policy.requesterMayReceive },
          publishedAt: now,
        },
        select: { id: true },
      })
      for (const rule of version.rules) {
        const json = ruleJson(rule)
        await tx.doaRule.create({
          data: { organizationId, doaVersionId: row.id, code: rule.code, documentType: json.documentType, priority: rule.priority, when: json.when, steps: json.steps, descriptionTh: rule.descriptionTh ?? null },
        })
      }
      events.push({
        type: 'doa_version.published',
        aggregateType: 'DoaVersion',
        aggregateId: row.id,
        data: { code: version.code, versionNo: version.versionNo, effectiveFrom: version.effectiveFrom.toISOString(), via: 'SEED', rules: version.rules.length },
      })
      report.doaVersions++
    }

    // 5. Request types of the catalog, each with version 1 of its form published
    for (const [i, t] of input.requestTypes.entries()) {
      let type = await tx.requestType.findFirst({ where: { code: t.code }, select: { id: true, currentFormVersionId: true } })
      if (!type) {
        type = await tx.requestType.create({
          data: { organizationId, code: t.code, nameTh: t.nameTh, descriptionTh: t.descriptionTh, documentType: t.documentType, active: t.active, sortOrder: i + 1 },
          select: { id: true, currentFormVersionId: true },
        })
        report.requestTypes++
      }
      if (type.currentFormVersionId) continue
      const form = await tx.formVersion.create({
        data: { organizationId, requestTypeId: type.id, versionNo: 1, schema: input.forms.get(t.code)! as object, status: 'PUBLISHED', publishedAt: now },
        select: { id: true },
      })
      await tx.requestType.update({ where: { id: type.id }, data: { currentFormVersionId: form.id } })
      events.push({ type: 'form_version.published', aggregateType: 'FormVersion', aggregateId: form.id, data: { requestTypeCode: t.code, versionNo: 1, via: 'SEED' } })
      report.forms++
    }

    // 6. Holidays of the business calendar (BR-SLA, P0-12: the real calendar comes from the customer)
    const added: string[] = []
    for (const h of input.holidays) {
      const date = new Date(`${h.date}T00:00:00Z`)
      if (await tx.holiday.findFirst({ where: { date }, select: { id: true } })) continue
      await tx.holiday.create({ data: { organizationId, date, nameTh: h.nameTh } })
      added.push(h.date)
    }
    if (added.length) events.push({ type: 'holiday.imported', aggregateType: 'Organization', aggregateId: organizationId, data: { dates: added, via: 'SEED' } })
    report.holidays = added.length

    await appendEvents(tx, ctx, events)
    return report
  })
}
