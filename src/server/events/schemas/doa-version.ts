import { z } from 'zod'
import { defineEvents } from '../registry'

// DOA version events (spec §10.2 "doa_version"). The rules themselves are on DoaVersion and DoaRule; events name the
// version. The demo seed publishes version 1 directly (Appendix A, local and staging only; NG-12).

const version = { code: z.string().min(1), versionNo: z.number().int().positive() }

defineEvents('DoaVersion', {
  'doa_version.published': {
    schema: z.object({ ...version, effectiveFrom: z.iso.datetime({ offset: true }), via: z.enum(['SEED', 'APPROVAL']), rules: z.number().int().positive() }),
  },
})
