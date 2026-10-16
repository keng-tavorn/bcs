import { z } from 'zod'
import { defineEvents } from '../registry'

// Organization events (spec §10.2). Organizations are created by PLATFORM_ADMIN, or by the demo seed in
// local/staging/preview only (Appendix A).
const moduleKey = z.enum(['CORE', 'PAY', 'SUPPLIER', 'SOURCING', 'RISK', 'CONTRACTS', 'AI', 'INTEGRATION', 'DOA_EVERYWHERE', 'BCS_GO'])

/** Fields of LineChannelConfig an organization sets (FR-ADM-006 AC2) and the rich menus `pnpm line:richmenu` stores (§9.5) */
export const LINE_CHANNEL_SETTING_FIELDS = [
  'providerId',
  'messagingChannelId',
  'channelSecret',
  'channelAccessToken',
  'liffId',
  'liffChannelId',
  'active',
  'richMenuLinkedId',
  'richMenuUnlinkedId',
] as const
export type LineChannelSettingField = (typeof LINE_CHANNEL_SETTING_FIELDS)[number]

defineEvents('Organization', {
  'organization.created': {
    schema: z.object({ code: z.string().min(1), via: z.enum(['SEED', 'PLATFORM_ADMIN']), contractSignatoryMemberId: z.uuid().nullable() }),
  },
  // The reason of every change is a Comment on the organization (§4.11 rule 1, BR-AUTH-08); the event points to it, so
  // the history keeps each reason while OrgModule holds only the latest (§6.2: the change history lives in Event)
  'organization.module_enabled': { schema: z.object({ module: moduleKey, contractRef: z.string().min(1), reasonCommentId: z.uuid() }) },
  'organization.module_disabled': { schema: z.object({ module: moduleKey, contractRef: z.string().min(1), reasonCommentId: z.uuid() }) },
  // S6-21 (FR-PLT-101 · BR-UAT-01 BR-UAT-04): a UAT sandbox of this organization, made empty by the BCS team under the contract
  'organization.sandbox_created': { schema: z.object({ sandboxOrganizationId: z.uuid(), code: z.string().min(1), contractRef: z.string().min(1), reasonCommentId: z.uuid() }) },
  // One section of Organization.settings saved (FR-PLT-001 AC2); the values are on the row, the event names the section.
  // lineChannel is the organization's LINE channel (LineChannelConfig, FR-ADM-006 AC2): `changed` names the fields that
  // changed and never holds a value, because two of them are secrets (encrypted on the row, NFR-SEC-09)
  // lineRichMenu: the two rich menus of §9.5 made at LINE and stored on LineChannelConfig (S5-04, pnpm line:richmenu);
  // `replaced` says menus made before were taken down. The menu ids are on the row.
  'organization.settings_updated': {
    schema: z.union([
      z.object({ section: z.enum(['businessCalendar', 'numbering']) }),
      z.strictObject({ section: z.literal('lineChannel'), created: z.boolean(), changed: z.array(z.enum(LINE_CHANNEL_SETTING_FIELDS)).min(1) }),
      z.strictObject({ section: z.literal('lineRichMenu'), replaced: z.boolean() }),
    ]),
  },
})
