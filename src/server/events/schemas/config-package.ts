import { z } from 'zod'
import { defineEvents } from '../registry'

// Configuration packages (S6-21 · BR-UAT-02 BR-UAT-03): exported from an organization (its sandbox, usually) and
// imported as drafts — the counts of each part and the package's checksum; the drafts have events of their own.
const counts = { forms: z.number().int().nonnegative(), workflows: z.number().int().nonnegative(), doa: z.number().int().nonnegative(), catalog: z.number().int().nonnegative() }
defineEvents('ConfigPackage', {
  'config_package.exported': { schema: z.object({ checksum: z.string().regex(/^[0-9a-f]{64}$/), sections: z.array(z.enum(['FORMS', 'WORKFLOW', 'DOA', 'CATALOG'])).min(1), ...counts }) },
  'config_package.imported': { schema: z.object({ checksum: z.string().regex(/^[0-9a-f]{64}$/), from: z.string().min(1), ...counts }) },
})
