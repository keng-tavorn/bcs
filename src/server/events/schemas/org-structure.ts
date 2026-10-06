import { z } from 'zod'
import { defineEvents } from '../registry'

// Organization structure events (spec §10.2 "โครงองค์กร"). Data holds ids and codes only.

defineEvents('Department', {
  'department.created': { schema: z.object({ code: z.string().min(1), parentId: z.uuid().nullable(), via: z.enum(['SEED', 'ADMIN']) }) },
  'department.updated': { schema: z.object({ code: z.string().min(1), changed: z.array(z.string().min(1)).min(1) }) },
})

defineEvents('PositionAssignment', {
  'position.assigned': {
    schema: z.object({ positionCode: z.string().min(1), departmentId: z.uuid(), memberId: z.uuid(), validFrom: z.iso.datetime({ offset: true }), via: z.enum(['SEED', 'ADMIN', 'ORG_AUTHORITY_CHANGE']) }),
  },
  'position.unassigned': { schema: z.object({ positionCode: z.string().min(1), departmentId: z.uuid(), memberId: z.uuid(), validTo: z.iso.datetime({ offset: true }) }) },
})

// Cost centers change at once with admin.orgStructure.editBasic (FR-ADM-002 AC1, NEW-14)
defineEvents('CostCenter', {
  'cost_center.created': { schema: z.object({ code: z.string().min(1), departmentId: z.uuid() }) },
  'cost_center.updated': { schema: z.object({ code: z.string().min(1), changed: z.array(z.string().min(1)).min(1) }) },
})

defineEvents('Organization', {
  // Holidays of a calendar import: the dates added, one event per import (FR-ADM-003)
  'holiday.imported': { schema: z.object({ dates: z.array(z.iso.date()).min(1), via: z.enum(['SEED', 'ADMIN']) }) },
})
