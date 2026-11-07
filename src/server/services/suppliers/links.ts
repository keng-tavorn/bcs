import { MS_PER_DAY, MS_PER_MINUTE } from '@/lib/constants'
import { getEnv } from '@/lib/env'
import { newId } from '@/lib/ids'
import { supplierSettingsOf } from '@/lib/org-settings'
import type { TenantTx } from '@/server/db/tenant'
import { newSecret, sha256Hex } from '@/server/crypto/portal'

// One-time links of the portal (BR-PORTAL ข้อ 01): a random token whose sha256 is kept, never the token; used once by a
// POST (the GET of the link only shows a page). LOGIN lives supplier.loginLinkMinutes; a link e-mailed for work later
// (INVITATION, DOCUMENT_REQUEST and what S10 S11 append) lives supplier.inviteLinkDays.

export type LinkPurpose = 'INVITATION' | 'LOGIN' | 'DOCUMENT_REQUEST'

export interface IssuedLink {
  readonly linkId: string
  /** The token to put in the e-mail; never stored */
  readonly token: string
  readonly url: string
  readonly expiresAt: Date
}

/** The page of a link: /portal/<org>/link/<token> */
export const linkUrl = (orgCode: string, token: string): string => `${getEnv().APP_URL.replace(/\/$/, '')}/portal/${orgCode}/link/${token}`

export async function issuePortalLink(
  tx: TenantTx,
  input: {
    readonly organizationId: string
    readonly orgCode: string
    readonly contactId: string
    readonly purpose: LinkPurpose
    readonly now: Date
    readonly applicationId?: string | null
    readonly supplierId?: string | null
    readonly createdById?: string | null
  },
): Promise<IssuedLink> {
  const org = await tx.organization.findUniqueOrThrow({ where: { id: input.organizationId }, select: { settings: true } })
  const settings = supplierSettingsOf(org.settings)
  const lifeMs = input.purpose === 'LOGIN' ? settings.loginLinkMinutes * MS_PER_MINUTE : settings.inviteLinkDays * MS_PER_DAY
  const token = newSecret()
  const linkId = newId()
  const expiresAt = new Date(input.now.getTime() + lifeMs)
  await tx.portalInviteLink.create({
    data: {
      id: linkId,
      organizationId: input.organizationId,
      contactId: input.contactId,
      purpose: input.purpose,
      tokenHash: sha256Hex(token),
      expiresAt,
      applicationId: input.applicationId ?? null,
      supplierId: input.supplierId ?? null,
      createdById: input.createdById ?? null,
    },
  })
  return { linkId, token, url: linkUrl(input.orgCode, token), expiresAt }
}
