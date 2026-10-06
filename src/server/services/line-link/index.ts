// Linking a member's LINE account and the rich menus (S5-04, FR-LINE-001, FR-LINE-004, §9.2, §9.5, D-02):
//  - link.ts: the one-time code (self.lineLink), its read-only preview for the LIFF page, POST /api/liff/link (code +
//    LIFF ID token → command line.link), the member's own link status
//  - unlink.ts: command line.unlink (workspace, LIFF) and the lineLink revoker of a deactivation
//  - follow.ts: a linked member's follow sets their rich menu again (registered with the webhook's follow hooks)
//  - rich-menu.ts: the menu of one LINE user after a link, an unlink or a follow (at once, and job line-rich-menu)
//  - rich-menu-replace.ts: making both menus at LINE and storing them (pnpm line:richmenu, the admin screen)

export { LINE_RICH_MENU_FOLLOW_HOOK, restoreRichMenuOnFollow } from './follow'
export {
  getMyLineLink,
  issueLineLinkCode,
  LINE_LINK_ATTEMPTS_MAX,
  linkLineAccount,
  linkLineCommand,
  previewLineLinkCode,
  type LineLinkCodeDto,
  type LineLinkedDto,
  type LineLinkPreviewDto,
  type LineLinkResult,
  type LinkLineAccountOptions,
  type LinkLineAccountRequest,
  type MyLineLinkDto,
  type PreviewLineLinkCodeRequest,
} from './link'
export { LINE_LINK_REFUSALS, lineLinkRefusal, type LineLinkRefusal } from './refusals'
export { LINE_RICH_MENU_SYNC_ROUNDS, runLineRichMenuSync, switchLineRichMenuNow, syncLineRichMenu, type LineRichMenuSyncOutcome } from './rich-menu'
export {
  readLineRichMenuImages,
  replaceLineRichMenus,
  storeLineRichMenusCommand,
  type LineRichMenuImages,
  type LineRichMenusReplaced,
  type StoredLineRichMenus,
} from './rich-menu-replace'
export { unlinkLineCommand, unlinkLineOnDeactivation, unlinkMyLine, type LineUnlinkReason, type LineUnlinkResult } from './unlink'
