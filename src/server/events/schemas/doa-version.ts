import { z } from 'zod'
import { defineEvents } from '../registry'

// DOA version events (spec §10.2 "doa_version"). The rules themselves are on DoaVersion and DoaRule; events name the
// version. The demo seed publishes version 1 directly (Appendix A, local and staging only; NG-12).

const version = { code: z.string().min(1), versionNo: z.number().int().positive() }

defineEvents('DoaVersion', {
  'doa_version.drafted': { schema: z.object({ ...version, via: z.enum(['YAML', 'COPY']), rules: z.number().int().positive() }) },
  // initialPackageHolders: the holders sent with the first version to the contract signatory (BR-DOA-19)
  'doa_version.submitted': {
    schema: z.object({ ...version, warningsAcknowledged: z.number().int().nonnegative(), routeId: z.uuid(), initialPackageHolders: z.number().int().positive().optional() }),
  },
  'doa_version.superseded': { schema: z.object({ ...version, supersededBy: z.uuid() }) },
  'doa_version.rejected': { schema: z.object({ ...version, reasonCommentId: z.uuid() }) },
  'doa_version.published': {
    schema: z.object({ ...version, effectiveFrom: z.iso.datetime({ offset: true }), via: z.enum(['SEED', 'APPROVAL']), rules: z.number().int().positive() }),
  },
})
