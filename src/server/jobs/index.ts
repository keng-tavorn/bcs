import { doaVersionActivate } from './doa-version-activate'
import { draftExpiry } from './draft-expiry'
import { orgAuthorityApply } from './org-authority-apply'
import { outboxSweeper } from './outbox-sweeper'

// Every Inngest function served at /api/inngest (spec §4.6). One file per function; add it here.
export const functions = [outboxSweeper, orgAuthorityApply, doaVersionActivate, draftExpiry]
